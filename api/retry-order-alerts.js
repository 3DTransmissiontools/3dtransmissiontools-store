import { timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import {
  claimDueOrderAlerts,
  markOrderAlertFailed
} from "../lib/order-alert-outbox.js";
import { sendPaidOrderAlert } from "./stripe-webhook.js";

function hasValidCronAuthorization(req, secret) {
  const headerValue = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const expected = `Bearer ${secret}`;

  if (typeof headerValue !== "string") return false;

  const receivedBuffer = Buffer.from(headerValue);
  const expectedBuffer = Buffer.from(expected);

  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export async function retryDueOrderAlerts(
  stripe,
  {
    claimDue = claimDueOrderAlerts,
    markFailed = markOrderAlertFailed,
    notify = sendPaidOrderAlert,
    logger = console
  } = {}
) {
  const alerts = await claimDue(10);
  const results = [];

  for (const alert of alerts) {
    try {
      const session = await stripe.checkout.sessions.retrieve(
        alert.stripe_session_id
      );
      const result = await notify(stripe, session, {
        eventId: alert.stripe_event_id
      });

      results.push({
        stripeSessionId: alert.stripe_session_id,
        sent: result.sent
      });
    } catch (error) {
      logger.error("Paid order email retry failed before delivery.", {
        eventId: alert.stripe_event_id,
        stripeSessionId: alert.stripe_session_id,
        error: error instanceof Error ? error.message : String(error)
      });

      try {
        await markFailed(alert.stripe_session_id, error);
      } catch (recordError) {
        logger.error("Paid order email retry failure could not be recorded.", {
          eventId: alert.stripe_event_id,
          stripeSessionId: alert.stripe_session_id,
          error: recordError instanceof Error
            ? recordError.message
            : String(recordError)
        });
      }

      results.push({
        stripeSessionId: alert.stripe_session_id,
        sent: false
      });
    }
  }

  return results;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({
      ok: false,
      code: "METHOD_NOT_ALLOWED",
      error: "Method not allowed."
    });
  }

  const cronSecret = process.env.CRON_SECRET?.trim();

  if (!cronSecret) {
    return res.status(500).json({
      ok: false,
      code: "CRON_NOT_CONFIGURED",
      error: "Order-alert retries are not configured."
    });
  }

  if (!hasValidCronAuthorization(req, cronSecret)) {
    return res.status(401).json({
      ok: false,
      code: "UNAUTHORIZED",
      error: "Unauthorized."
    });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();

  if (!stripeSecretKey) {
    return res.status(500).json({
      ok: false,
      code: "STRIPE_NOT_CONFIGURED",
      error: "Stripe is not configured."
    });
  }

  try {
    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: "2026-02-25.clover"
    });
    const results = await retryDueOrderAlerts(stripe);

    return res.status(200).json({
      ok: true,
      processed: results.length,
      sent: results.filter(result => result.sent).length,
      failed: results.filter(result => !result.sent).length
    });
  } catch (error) {
    console.error("Order-alert retry job failed:", error);
    return res.status(500).json({
      ok: false,
      code: "RETRY_JOB_FAILED",
      error: "Order-alert retry job failed."
    });
  }
}

