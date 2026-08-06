// /api/admin-disable-mfa
//
// Lets an admin force-remove a student's two-factor authentication --
// a rescue path for students who are locked out and either never saved
// their backup codes or have already used them all.
//
// This needs the Supabase service-role key for the same reason
// api/mfa-recover.js does: Supabase deliberately does not allow
// removing an MFA factor from a plain (AAL1) session via the client
// SDK, and there's no client-side way to remove *another* user's
// factor at all -- that's a privileged Admin API operation.
//
// The caller's own access token is validated and checked against
// profiles.is_admin server-side; a client-supplied "I'm an admin" flag
// is never trusted.

const SUPABASE_ANON_KEY = "sb_publishable_4J_RxGdtTL8Uip1cn6XCVg_kdOTcyK8";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ disabled: false, error: "Method not allowed" });
  }

  const { access_token, target_user_id } = req.body || {};

  if (!access_token || !target_user_id) {
    return res.status(400).json({ disabled: false, error: "Missing access_token or target_user_id" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ disabled: false, error: "Server not configured" });
  }

  const serviceHeaders = {
    apikey: supabaseServiceKey,
    Authorization: `Bearer ${supabaseServiceKey}`,
    "Content-Type": "application/json"
  };

  try {
    // 1. Who is calling this? Validate the access_token ourselves.
    const callerRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        apikey: SUPABASE_ANON_KEY
      }
    });

    if (!callerRes.ok) {
      return res.status(401).json({ disabled: false, error: "Invalid or expired session" });
    }

    const caller = await callerRes.json();

    // 2. Are they actually an admin? Check with the service role,
    //    never trust anything the client claims about itself.
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${caller.id}&select=is_admin`,
      { headers: serviceHeaders }
    );
    const profileRows = await profileRes.json();
    const isAdmin = profileRes.ok && Array.isArray(profileRows) && profileRows[0] && profileRows[0].is_admin;

    if (!isAdmin) {
      return res.status(403).json({ disabled: false, error: "Admin access required" });
    }

    // 3. Remove the target user's TOTP factor(s) via the Admin API.
    const targetUserRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${target_user_id}`, {
      headers: serviceHeaders
    });
    const targetUser = await targetUserRes.json();
    const factors = (targetUser && targetUser.factors) || [];

    for (const factor of factors) {
      await fetch(`${supabaseUrl}/auth/v1/admin/users/${target_user_id}/factors/${factor.id}`, {
        method: "DELETE",
        headers: serviceHeaders
      });
    }

    // 4. Clean up their now-orphaned backup codes too.
    await fetch(`${supabaseUrl}/rest/v1/mfa_backup_codes?user_id=eq.${target_user_id}`, {
      method: "DELETE",
      headers: serviceHeaders
    });

    return res.status(200).json({ disabled: true, factors_removed: factors.length });
  } catch (err) {
    return res.status(500).json({ disabled: false, error: "Could not disable 2FA. Please try again." });
  }
}
