import Stripe from "stripe";
import { enforceRateLimit } from "../lib/rate-limit.js";

const STORE_ID = "3dtransmissiontools-store";

function maskEmail(value) {
  if (typeof value !== "string") return "";

  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) return "";

  const localPart = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  return `${localPart.slice(0, 1)}***@${domain}`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed." });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    return res.status(500).json({
      error: "Payment verification is unavailable."
    });
  }

  const sessionId = req.query.session_id;
  if (
    typeof sessionId !== "string" ||
    !/^cs_(?:test_|live_)?[A-Za-z0-9]{20,255}$/.test(sessionId)
  ) {
    return res.status(400).json({ error: "Invalid checkout session." });
  }

  try {
    const rateLimit = await enforceRateLimit(req, "verify-session", 20, 60);
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfter));
      return res.status(429).json({ error: "Too many verification attempts." });
    }

    const stripe = new Stripe(secretKey, {
      apiVersion: "2026-02-25.clover"
    });
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const isPaid =
      session.metadata?.store_id === STORE_ID &&
      session.status === "complete" &&
      (
        session.payment_status === "paid" ||
        session.payment_status === "no_payment_required"
      );

    if (!isPaid) {
      return res.status(409).json({
        verified: false,
        error: "Payment has not been confirmed."
      });
    }

    const email =
      session.customer_details?.email ||
      session.customer_email ||
      "";

    return res.status(200).json({
      verified: true,
      order_id: session.id.slice(-12),
      customer_email_hint: maskEmail(email),
      amount_total: Number(session.amount_total || 0) / 100
    });
  } catch (error) {
    console.error("Session verification failed:", error);
    return res.status(404).json({
      verified: false,
      error: "Checkout session was not found."
    });
  }
}
