import Stripe from "stripe";

export const config = {
  api: {
    bodyParser: false
  }
};

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk)
    );
  }

  return Buffer.concat(chunks);
}

function getHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
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

  const stripeSecretKey =
    process.env.STRIPE_SECRET_KEY;

  const webhookSecret =
    process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeSecretKey) {
    console.error(
      "Webhook configuration error: " +
      "STRIPE_SECRET_KEY is missing."
    );

    return res.status(500).json({
      received: false,
      code: "MISSING_STRIPE_SECRET_KEY",
      error: "Stripe secret key is not configured."
    });
  }

  if (!webhookSecret) {
    console.error(
      "Webhook configuration error: " +
      "STRIPE_WEBHOOK_SECRET is missing."
    );

    return res.status(500).json({
      received: false,
      code: "MISSING_WEBHOOK_SECRET",
      error: "Stripe webhook secret is not configured."
    });
  }

  const signature = getHeaderValue(
    req.headers["stripe-signature"]
  );

  if (
    typeof signature !== "string" ||
    signature.length === 0
  ) {
    console.error(
      "Webhook request did not contain " +
      "a Stripe-Signature header."
    );

    return res.status(400).json({
      received: false,
      code: "MISSING_SIGNATURE",
      error: "Missing Stripe-Signature header."
    });
  }

  let stripe;

  try {
    stripe = new Stripe(stripeSecretKey);
  } catch (error) {
    console.error(
      "Unable to initialize Stripe:",
      error
    );

    return res.status(500).json({
      received: false,
      code: "STRIPE_INITIALIZATION_FAILED",
      error: "Unable to initialize Stripe."
    });
  }

  let event;

  try {
    const rawBody = await readRawBody(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      webhookSecret
    );
  } catch (error) {
    console.error(
      "Webhook signature verification failed:",
      error?.message || error
    );

    return res.status(400).json({
      received: false,
      code: "SIGNATURE_VERIFICATION_FAILED",
      error: "Webhook signature verification failed."
    });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        console.log(
          "Checkout completed:",
          session.id
        );

        break;
      }

      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object;

        console.log(
          "Delayed payment succeeded:",
          session.id
        );

        break;
      }

      case "checkout.session.async_payment_failed": {
        const session = event.data.object;

        console.warn(
          "Delayed payment failed:",
          session.id
        );

        break;
      }

      default:
        console.log(
          "Unhandled Stripe event:",
          event.type
        );
    }

    return res.status(200).json({
      received: true,
      event_type: event.type
    });
  } catch (error) {
    console.error(
      "Webhook processing failed:",
      error
    );

    return res.status(500).json({
      received: false,
      code: "EVENT_PROCESSING_FAILED",
      error: "Webhook processing failed."
    });
  }
}
