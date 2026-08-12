// /api/private-chat
//
// Handles every private 1:1 chat operation server-side: send a
// message, list a student's conversations, read a conversation's
// messages, and (admin-only) list every conversation for monitoring.
//
// Message content is encrypted at rest with AES-256-GCM using a key
// only this server holds -- it is never sent to the client and never
// stored anywhere else. This is NOT true end-to-end encryption: the
// server can decrypt. That's deliberate -- the admin panel needs to
// be able to review a conversation when necessary, and real E2EE
// (only the two participants ever holding a key) is fundamentally
// incompatible with that requirement.
//
// private_conversations / private_messages carry zero RLS policies
// for authenticated/anon -- this function, using the Supabase service
// role key, is the only thing that can ever read or write them. A
// direct client-side query against either table always comes back
// empty/denied, by design.

import crypto from "crypto";

const SUPABASE_ANON_KEY = "sb_publishable_4J_RxGdtTL8Uip1cn6XCVg_kdOTcyK8";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { access_token, action } = req.body || {};
  if (!access_token || !action) {
    return res.status(400).json({ error: "Missing access_token or action" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  const encryptionKeyHex = process.env.PRIVATE_CHAT_ENCRYPTION_KEY;

  if (!supabaseUrl || !supabaseServiceKey || !encryptionKeyHex) {
    return res.status(500).json({ error: "Server not configured" });
  }
  const encryptionKey = Buffer.from(encryptionKeyHex, "hex");
  if (encryptionKey.length !== 32) {
    return res.status(500).json({ error: "Server misconfigured: encryption key must be 32 bytes" });
  }

  const serviceHeaders = {
    apikey: supabaseServiceKey,
    Authorization: `Bearer ${supabaseServiceKey}`,
    "Content-Type": "application/json"
  };

  function encryptContent(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      auth_tag: authTag.toString("base64")
    };
  }

  function decryptRow(row) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(row.iv, "base64"));
      decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, "base64")),
        decipher.final()
      ]);
      return plaintext.toString("utf8");
    } catch (err) {
      return "[Could not decrypt this message]";
    }
  }

  try {
    // 1. Who is calling this? Validate the access_token ourselves --
    //    never trust a client-supplied user id.
    const callerRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${access_token}`, apikey: SUPABASE_ANON_KEY }
    });
    if (!callerRes.ok) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }
    const caller = await callerRes.json();
    const callerId = caller.id;

    // 2. Load the caller's own profile (admin status, ban status, name)
    //    server-side -- a client-supplied "I'm an admin" flag is never
    //    trusted.
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${callerId}&select=is_admin,chat_banned,full_name,avatar_url`,
      { headers: serviceHeaders }
    );
    const profileRows = await profileRes.json();
    const callerProfile = (profileRows && profileRows[0]) || {};
    const isAdmin = !!callerProfile.is_admin;

    // ---- list: every conversation the caller is a participant of ----
    if (action === "list") {
      const convRes = await fetch(
        `${supabaseUrl}/rest/v1/private_conversations?or=(participant_a.eq.${callerId},participant_b.eq.${callerId})&order=created_at.desc`,
        { headers: serviceHeaders }
      );
      const conversations = (await convRes.json()) || [];

      const otherIds = conversations.map(function (c) {
        return c.participant_a === callerId ? c.participant_b : c.participant_a;
      });

      let othersById = {};
      if (otherIds.length) {
        const othersRes = await fetch(
          `${supabaseUrl}/rest/v1/profiles?id=in.(${otherIds.join(",")})&select=id,full_name,avatar_url,is_admin`,
          { headers: serviceHeaders }
        );
        const othersRows = (await othersRes.json()) || [];
        othersRows.forEach(function (p) { othersById[p.id] = p; });
      }

      // One batched read-state query for every conversation, instead of
      // one per conversation -- last_read_at per (conversation, caller).
      let readsByConv = {};
      const convIds = conversations.map(function (c) { return c.id; });
      if (convIds.length) {
        const readsRes = await fetch(
          `${supabaseUrl}/rest/v1/private_message_reads?conversation_id=in.(${convIds.join(",")})&user_id=eq.${callerId}&select=conversation_id,last_read_at`,
          { headers: serviceHeaders }
        );
        const readsRows = (await readsRes.json()) || [];
        readsRows.forEach(function (r) { readsByConv[r.conversation_id] = r.last_read_at; });
      }

      const result = [];
      for (const c of conversations) {
        const otherId = c.participant_a === callerId ? c.participant_b : c.participant_a;
        const other = othersById[otherId] || {};
        const lastMsgRes = await fetch(
          `${supabaseUrl}/rest/v1/private_messages?conversation_id=eq.${c.id}&select=sender_id,created_at&order=created_at.desc&limit=1`,
          { headers: serviceHeaders }
        );
        const lastMsgRows = (await lastMsgRes.json()) || [];
        const lastMsg = lastMsgRows[0] || null;
        const lastReadAt = readsByConv[c.id];
        // Unread means: the newest message wasn't sent by the caller
        // themself, and it's newer than the caller's last read marker
        // for this conversation (or they've never read it at all).
        const unread = !!lastMsg && lastMsg.sender_id !== callerId &&
          (!lastReadAt || new Date(lastMsg.created_at) > new Date(lastReadAt));
        result.push({
          conversation_id: c.id,
          other_user_id: otherId,
          other_name: other.is_admin ? "Global Market School" : (other.full_name || "Student"),
          other_avatar_url: other.is_admin ? null : (other.avatar_url || null),
          last_message_at: (lastMsg && lastMsg.created_at) || c.created_at,
          unread: unread
        });
      }
      result.sort(function (a, b) { return new Date(b.last_message_at) - new Date(a.last_message_at); });

      return res.status(200).json({ conversations: result });
    }

    // ---- mark_read: caller has seen a conversation up to now ----
    if (action === "mark_read") {
      const { conversation_id } = req.body || {};
      if (!conversation_id) {
        return res.status(400).json({ error: "Missing conversation_id" });
      }

      const convRes = await fetch(
        `${supabaseUrl}/rest/v1/private_conversations?id=eq.${conversation_id}`,
        { headers: serviceHeaders }
      );
      const convRows = await convRes.json();
      const conversation = convRows && convRows[0];
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      const isParticipant = conversation.participant_a === callerId || conversation.participant_b === callerId;
      if (!isParticipant) {
        return res.status(403).json({ error: "Not authorized" });
      }

      await fetch(`${supabaseUrl}/rest/v1/private_message_reads?on_conflict=conversation_id,user_id`, {
        method: "POST",
        headers: { ...serviceHeaders, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          conversation_id: conversation_id,
          user_id: callerId,
          last_read_at: new Date().toISOString()
        })
      });

      return res.status(200).json({ marked_read: true });
    }

    // ---- send: encrypt + insert a message, finding-or-creating the conversation ----
    if (action === "send") {
      if (callerProfile.chat_banned) {
        return res.status(403).json({ error: "You are restricted from chat features" });
      }

      const { recipient_id, content } = req.body || {};
      const trimmed = (content || "").trim();
      if (!recipient_id || !trimmed) {
        return res.status(400).json({ error: "Missing recipient_id or content" });
      }
      if (trimmed.length > 2000) {
        return res.status(400).json({ error: "Message is too long" });
      }
      if (recipient_id === callerId) {
        return res.status(400).json({ error: "Cannot message yourself" });
      }

      const a = callerId < recipient_id ? callerId : recipient_id;
      const b = callerId < recipient_id ? recipient_id : callerId;

      let conversationId = null;
      const findRes = await fetch(
        `${supabaseUrl}/rest/v1/private_conversations?participant_a=eq.${a}&participant_b=eq.${b}`,
        { headers: serviceHeaders }
      );
      const findRows = await findRes.json();
      if (findRows && findRows[0]) {
        conversationId = findRows[0].id;
      } else {
        const createRes = await fetch(`${supabaseUrl}/rest/v1/private_conversations`, {
          method: "POST",
          headers: { ...serviceHeaders, Prefer: "return=representation" },
          body: JSON.stringify({ participant_a: a, participant_b: b })
        });
        const createRows = await createRes.json();
        conversationId = createRows && createRows[0] && createRows[0].id;
      }

      if (!conversationId) {
        return res.status(500).json({ error: "Could not start conversation" });
      }

      const enc = encryptContent(trimmed);
      const insertMsgRes = await fetch(`${supabaseUrl}/rest/v1/private_messages`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({
          conversation_id: conversationId,
          sender_id: callerId,
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          auth_tag: enc.auth_tag
        })
      });
      if (!insertMsgRes.ok) {
        return res.status(500).json({ error: "Could not send message" });
      }

      return res.status(200).json({ sent: true, conversation_id: conversationId });
    }

    // ---- messages: decrypt + return one conversation's history ----
    // Authorized for either participant, or an admin reviewing it.
    if (action === "messages") {
      const { conversation_id } = req.body || {};
      if (!conversation_id) {
        return res.status(400).json({ error: "Missing conversation_id" });
      }

      const convRes = await fetch(
        `${supabaseUrl}/rest/v1/private_conversations?id=eq.${conversation_id}`,
        { headers: serviceHeaders }
      );
      const convRows = await convRes.json();
      const conversation = convRows && convRows[0];
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const isParticipant = conversation.participant_a === callerId || conversation.participant_b === callerId;
      if (!isParticipant && !isAdmin) {
        return res.status(403).json({ error: "Not authorized to view this conversation" });
      }

      const msgsRes = await fetch(
        `${supabaseUrl}/rest/v1/private_messages?conversation_id=eq.${conversation_id}&order=created_at.asc`,
        { headers: serviceHeaders }
      );
      const msgRows = (await msgsRes.json()) || [];

      const idsToLookup = isParticipant
        ? [conversation.participant_a, conversation.participant_b]
        : [conversation.participant_a, conversation.participant_b];
      const namesRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=in.(${idsToLookup.join(",")})&select=id,full_name,is_admin`,
        { headers: serviceHeaders }
      );
      const namesRows = (await namesRes.json()) || [];
      const namesById = {};
      namesRows.forEach(function (p) {
        namesById[p.id] = p.is_admin ? "Global Market School" : (p.full_name || "Student");
      });

      const messages = msgRows.map(function (m) {
        return {
          id: m.id,
          sender_id: m.sender_id,
          sender_name: namesById[m.sender_id] || "Student",
          content: decryptRow(m),
          created_at: m.created_at
        };
      });

      return res.status(200).json({
        messages: messages,
        conversation: {
          id: conversation.id,
          participant_a: conversation.participant_a,
          participant_b: conversation.participant_b,
          participant_a_name: namesById[conversation.participant_a] || "Student",
          participant_b_name: namesById[conversation.participant_b] || "Student"
        }
      });
    }

    // ---- admin_list: every conversation, admin-only, for the monitoring tab ----
    if (action === "admin_list") {
      if (!isAdmin) {
        return res.status(403).json({ error: "Admin access required" });
      }

      const convRes = await fetch(
        `${supabaseUrl}/rest/v1/private_conversations?order=created_at.desc`,
        { headers: serviceHeaders }
      );
      const conversations = (await convRes.json()) || [];

      const allIds = new Set();
      conversations.forEach(function (c) { allIds.add(c.participant_a); allIds.add(c.participant_b); });

      let namesById = {};
      if (allIds.size) {
        const profRes = await fetch(
          `${supabaseUrl}/rest/v1/profiles?id=in.(${Array.from(allIds).join(",")})&select=id,full_name,is_admin`,
          { headers: serviceHeaders }
        );
        const profRows = (await profRes.json()) || [];
        profRows.forEach(function (p) {
          namesById[p.id] = p.is_admin ? "Global Market School" : (p.full_name || "Student");
        });
      }

      const result = [];
      for (const c of conversations) {
        const countRes = await fetch(
          `${supabaseUrl}/rest/v1/private_messages?conversation_id=eq.${c.id}&select=id`,
          { headers: { ...serviceHeaders, Prefer: "count=exact" } }
        );
        const countHeader = countRes.headers.get("content-range");
        const messageCount = countHeader ? Number(countHeader.split("/")[1]) || 0 : 0;
        result.push({
          conversation_id: c.id,
          participant_a_name: namesById[c.participant_a] || "Student",
          participant_b_name: namesById[c.participant_b] || "Student",
          message_count: messageCount,
          created_at: c.created_at
        });
      }

      return res.status(200).json({ conversations: result });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
