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

  const { transaction_id, expected_amount, expected_currency } = req.body || {};

  if (!transaction_id) {
    return res.status(400).json({ verified: false, error: "Missing transaction_id" });
  }

  const secretKey = process.env.FLW_SECRET_KEY;

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

    if (statusOk && amountOk && currencyOk) {
      return res.status(200).json({
        verified: true,
        tx_ref: tx.tx_ref,
        amount: tx.amount,
        currency: tx.currency,
        customer_email: tx.customer ? tx.customer.email : null,
      });
    }

    return res.status(200).json({ verified: false, error: "Verification mismatch" });
  } catch (err) {
    return res.status(500).json({ verified: false, error: "Verification failed" });
  }
}
