// /api/mfa-recover
//
// Lets a student who has lost their authenticator device get back into
// their account using one of the backup codes they saved when they
// enabled two-factor authentication. A valid backup code removes their
// TOTP factor entirely (back to password-only login) -- they can
// re-enable 2FA with a new device afterward from their profile.
//
// This needs the Supabase service-role key because removing another
// factor is a privileged operation Supabase deliberately does not allow
// from a plain (AAL1) session -- by design, a stolen password alone
// should never be enough to turn off someone's 2FA. That's exactly why
// this can't be a client-side-only call, same reasoning as verify-payment.

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
    return res.status(405).json({ recovered: false, error: "Method not allowed" });
  }

  const { access_token, backup_code } = req.body || {};

  if (!access_token || !backup_code) {
    return res.status(400).json({ recovered: false, error: "Missing access_token or backup_code" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ recovered: false, error: "Server not configured" });
  }

  try {
    // 1. Who is this? Validate the access_token ourselves rather than
    //    trusting a client-supplied user id -- otherwise anyone could
    //    submit someone else's user id and try to guess their backup
    //    codes without ever knowing their password.
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        apikey: SUPABASE_ANON_KEY
      }
    });

    if (!userRes.ok) {
      return res.status(401).json({ recovered: false, error: "Invalid or expired session" });
    }

    const user = await userRes.json();
    const userId = user.id;

    // 2. Hash the submitted code the same way the browser did when it
    //    generated and stored these codes (SHA-256 hex, uppercased +
    //    trimmed first so a stray typo in case/whitespace still matches).
    const codeHash = crypto
      .createHash("sha256")
      .update(String(backup_code).trim().toUpperCase())
      .digest("hex");

    const serviceHeaders = {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      "Content-Type": "application/json"
    };

    // 3. Look for a matching, unused backup code for this user.
    const lookupRes = await fetch(
      `${supabaseUrl}/rest/v1/mfa_backup_codes?user_id=eq.${userId}&code_hash=eq.${codeHash}&used_at=is.null&select=id`,
      { headers: serviceHeaders }
    );
    const matches = await lookupRes.json();

    if (!lookupRes.ok || !Array.isArray(matches) || matches.length === 0) {
      return res.status(400).json({ recovered: false, error: "That backup code is invalid or has already been used." });
    }

    const codeRowId = matches[0].id;

    // 4. Mark this code used so it can't be replayed.
    await fetch(`${supabaseUrl}/rest/v1/mfa_backup_codes?id=eq.${codeRowId}`, {
      method: "PATCH",
      headers: serviceHeaders,
      body: JSON.stringify({ used_at: new Date().toISOString() })
    });

    // 5. Remove the user's TOTP factor(s) via the Admin API -- the
    //    privileged step that actually requires the service-role key.
    const adminUserRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      headers: serviceHeaders
    });
    const adminUser = await adminUserRes.json();
    const factors = (adminUser && adminUser.factors) || [];

    for (const factor of factors) {
      await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}/factors/${factor.id}`, {
        method: "DELETE",
        headers: serviceHeaders
      });
    }

    // 6. Clean up remaining unused backup codes -- they were only ever
    //    valid alongside the factor that was just removed.
    await fetch(`${supabaseUrl}/rest/v1/mfa_backup_codes?user_id=eq.${userId}`, {
      method: "DELETE",
      headers: serviceHeaders
    });

    return res.status(200).json({ recovered: true });
  } catch (err) {
    return res.status(500).json({ recovered: false, error: "Recovery failed. Please try again." });
  }
}
