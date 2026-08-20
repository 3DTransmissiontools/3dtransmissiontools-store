import Stripe from "stripe";
import {
  completeInventoryReservation,
  releaseInventory
} from "../lib/inventory.js";

const STORE_ID = "3dtransmissiontools-store";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const config = {
  api: { bodyParser: false }
};

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function getHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function getReservationId(session) {
  if (session.metadata?.store_id !== STORE_ID) return null;

  const reservationId = session.metadata?.reservation_id;
  return typeof reservationId === "string" && UUID_PATTERN.test(reservationId)
    ? reservationId
    : null;
}

function isPaid(session) {
  return (
    session.status === "complete" &&
    (
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required"
    )
  );
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({
      received: false,
      code: "METHOD_NOT_ALLOWED",
      error: "Method not allowed."
    });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();

  if (!stripeSecretKey || !webhookSecret) {
    return res.status(500).json({
      received: false,
      code: "WEBHOOK_NOT_CONFIGURED",
      error: "Stripe webhook is not configured."
    });
  }

  const signature = getHeaderValue(req.headers["stripe-signature"]);
  if (typeof signature !== "string" || !signature) {
    return res.status(400).json({
      received: false,
      code: "MISSING_SIGNATURE",
      error: "Missing Stripe-Signature header."
    });
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: "2026-02-25.clover"
  });

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      await readRawBody(req),
      signature,
      webhookSecret
    );
  } catch (error) {
    console.error("Webhook signature verification failed:", error?.message);
    return res.status(400).json({
      received: false,
      code: "SIGNATURE_VERIFICATION_FAILED",
      error: "Webhook signature verification failed."
    });
  }

  try {
    const sessionEventTypes = new Set([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired"
    ]);

    if (sessionEventTypes.has(event.type)) {
      const session = event.data.object;
      const reservationId = getReservationId(session);

      if (reservationId) {
        if (
          (event.type === "checkout.session.completed" ||
            event.type === "checkout.session.async_payment_succeeded") &&
          isPaid(session)
        ) {
          await completeInventoryReservation(
            reservationId,
            session.id,
            event.id,
            event.type
          );
        } else if (
          event.type === "checkout.session.expired" ||
          event.type === "checkout.session.async_payment_failed"
        ) {
          await releaseInventory(reservationId);
        }
      }
    }

    return res.status(200).json({
      received: true,
      event_type: event.type
    });
  } catch (error) {
    console.error("Webhook processing failed:", error);
    return res.status(500).json({
      received: false,
      code: "EVENT_PROCESSING_FAILED",
      error: "Webhook processing failed."
    });
  }
}
