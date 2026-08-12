// /api/verify-payment
//
// This runs on Vercel's server, not in the browser.
// It takes a Flutterwave transaction ID, asks Flutterwave directly
// "did this payment really succeed, and for the right amount?",
// and only returns { verified: true } if that is genuinely confirmed.
//
// The secret key below is read from Vercel's Environment Variables —
// it is never present in any file uploaded to GitHub, and never
// visible to anyone visiting the website.

export default async function handler(req, res) {
  // Allow the GitHub Pages-hosted site (a different domain from this
  // Vercel deployment) to call this function. Without this, browsers
  // block the request before it even reaches the code below.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ verified: false, error: "Method not allowed" });
  }

  const { transaction_id, expected_amount, expected_currency, user_id, tier, applied_signup_credit } = req.body || {};

  if (!transaction_id) {
    return res.status(400).json({ verified: false, error: "Missing transaction_id" });
  }

  const secretKey = process.env.FLW_SECRET_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!secretKey) {
    return res.status(500).json({ verified: false, error: "Server not configured" });
  }

  try {
    const response = await fetch(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      }
    );

    const result = await response.json();

    if (result.status !== "success" || !result.data) {
      return res.status(200).json({ verified: false, error: "Payment not confirmed" });
    }

    const tx = result.data;

    const amountOk =
      !expected_amount || Number(tx.amount) >= Number(expected_amount);
    const currencyOk =
      !expected_currency || tx.currency === expected_currency;
    const statusOk = tx.status === "successful";

    if (!(statusOk && amountOk && currencyOk)) {
      return res.status(200).json({ verified: false, error: "Verification mismatch" });
    }

    // Payment is genuinely verified. If we know which logged-in user
    // made this purchase, record it and unlock the right courses.
    if (user_id && tier && supabaseUrl && supabaseServiceKey) {
      const TIER_COURSES = {
        "Beginner": ["beginner-stock", "beginner-forex"],
        "Intermediate": ["beginner-stock", "beginner-forex", "intermediate-stock", "intermediate-forex"],
        "Advanced": ["beginner-stock", "beginner-forex", "intermediate-stock", "intermediate-forex", "advanced-stock", "advanced-forex"],
        "Elite": ["beginner-stock", "beginner-forex", "intermediate-stock", "intermediate-forex", "advanced-stock", "advanced-forex", "elite"],
        "Trade Group": ["beginner-stock", "beginner-forex", "intermediate-stock", "intermediate-forex", "advanced-stock", "advanced-forex", "elite", "trade-group"]
      };

      const supabaseHeaders = {
        "apikey": supabaseServiceKey,
        "Authorization": `Bearer ${supabaseServiceKey}`,
        "Content-Type": "application/json",
      };

      try {
        // 1. Record the transaction
        const txInsertRes = await fetch(`${supabaseUrl}/rest/v1/transactions`, {
          method: "POST",
          headers: { ...supabaseHeaders, "Prefer": "return=representation" },
          body: JSON.stringify({
            user_id: user_id,
            tier: tier,
            amount: tx.amount,
            currency: tx.currency,
            tx_ref: tx.tx_ref,
            flutterwave_transaction_id: String(tx.id),
            status: "successful"
          })
        });
        const txInserted = await txInsertRes.json();
        const transactionRecord = Array.isArray(txInserted) ? txInserted[0] : null;

        // 2. Unlock all courses for this tier, and everything below it
        const coursesToUnlock = TIER_COURSES[tier] || [];
        for (const courseKey of coursesToUnlock) {
          await fetch(`${supabaseUrl}/rest/v1/course_access?on_conflict=user_id,course_key`, {
            method: "POST",
            headers: { ...supabaseHeaders, "Prefer": "resolution=merge-duplicates" },
            body: JSON.stringify({
              user_id: user_id,
              course_key: courseKey,
              has_access: true,
              granted_by: "payment"
            })
          });
        }

        // 3. If this user was referred by someone, credit 10% commission
        const profileRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user_id}&select=referred_by,signup_course_credit`, {
          headers: supabaseHeaders
        });
        const profileData = await profileRes.json();
        const referredBy = profileData && profileData[0] ? profileData[0].referred_by : null;
        const realSignupCredit = profileData && profileData[0] ? Number(profileData[0].signup_course_credit || 0) : 0;

        if (referredBy && transactionRecord) {
          const commission = Number(tx.amount) * 0.10;
          await fetch(`${supabaseUrl}/rest/v1/referral_earnings`, {
            method: "POST",
            headers: supabaseHeaders,
            body: JSON.stringify({
              referrer_id: referredBy,
              referred_user_id: user_id,
              transaction_id: transactionRecord.id,
              commission_amount: commission,
              currency: tx.currency,
              paid_out: false
            })
          });

          // This purchase may be the buyer's referrer's 3rd successful
          // referral -- check eligibility and grant the $5 signup
          // referral bonus if so. The function itself re-checks
          // everything from real committed data, so this call is safe
          // to make on every referred purchase; it's a no-op otherwise.
          await fetch(`${supabaseUrl}/rest/v1/rpc/grant_signup_referral_bonus_if_eligible`, {
            method: "POST",
            headers: supabaseHeaders,
            body: JSON.stringify({ p_referrer_id: referredBy })
          });
        }

        // 4. Consume the buyer's own $5 signup course-purchase credit,
        // if any was applied at checkout. We never trust the client's
        // claimed amount alone -- only ever deduct up to what the
        // buyer's real, server-side balance actually holds.
        const claimedCredit = Number(applied_signup_credit) || 0;
        if (claimedCredit > 0 && realSignupCredit > 0) {
          const consumed = Math.min(realSignupCredit, claimedCredit);
          await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user_id}`, {
            method: "PATCH",
            headers: supabaseHeaders,
            body: JSON.stringify({ signup_course_credit: realSignupCredit - consumed })
          });
        }
      } catch (dbErr) {
        // Payment was genuinely verified even if the database update
        // hit a snag — we still tell the frontend it's verified, but
        // log this so it can be checked and fixed manually if needed.
        console.error("Database update after payment failed:", dbErr);
      }
    }

    return res.status(200).json({
      verified: true,
      tx_ref: tx.tx_ref,
      amount: tx.amount,
      currency: tx.currency,
      customer_email: tx.customer ? tx.customer.email : null,
    });
  } catch (err) {
    return res.status(500).json({ verified: false, error: "Verification failed" });
  }
}

