import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);

    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({
      error: "Payment verification is unavailable."
    });
  }

  const sessionId = req.query.session_id;

  if (
    typeof sessionId !== "string" ||
    !sessionId.startsWith("cs_")
  ) {
    return res.status(400).json({
      error: "Invalid checkout session."
    });
  }

  try {
    const session =
      await stripe.checkout.sessions.retrieve(
        sessionId
      );

    const isPaid =
      session.status === "complete" &&
      (
        session.payment_status === "paid" ||
        session.payment_status ===
          "no_payment_required"
      );

    if (!isPaid) {
      return res.status(409).json({
        verified: false,
        error: "Payment has not been confirmed."
      });
    }

    return res.status(200).json({
      verified: true,
      order_id: session.id,
      customer_email:
        session.customer_details?.email ||
        session.customer_email ||
        "",
      amount_total:
        Number(session.amount_total || 0) / 100
    });
  } catch (error) {
    console.error(
      "Session verification failed:",
      error
    );

    return res.status(404).json({
      verified: false,
      error: "Checkout session was not found."
    });
  }
}
