import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);

    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY is not configured.");

    return res.status(500).json({
      error: "Stripe is not configured."
    });
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET is not configured.");

    return res.status(500).json({
      error: "Webhook is not configured."
    });
  }

  const signature = req.headers["stripe-signature"];

  if (!signature) {
    return res.status(400).json({
      error: "Missing Stripe-Signature header."
    });
  }

  let event;

  try {
    const rawBody = await readRawBody(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error(
      "Webhook signature verification failed:",
      error.message
    );

    return res.status(400).json({
      error: "Webhook signature verification failed."
    });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        console.log(
          "Checkout completed:",
          session.id,
          session.customer_details?.email || ""
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
      received: true
    });
  } catch (error) {
    console.error("Webhook processing failed:", error);

    return res.status(500).json({
      error: "Webhook processing failed."
    });
  }
}
