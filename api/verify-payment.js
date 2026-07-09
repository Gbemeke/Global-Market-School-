export default async function handler(req, res) {
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
