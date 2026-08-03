import Stripe from "stripe";
import fs from "fs";
import path from "path";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return jsonResponse(
        { error: "Method not allowed" },
        405
      );
    }

    const signature = request.headers.get("stripe-signature");

    if (!signature) {
      return jsonResponse(
        { error: "Missing Stripe-Signature header" },
        400
      );
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      console.error("STRIPE_SECRET_KEY is not configured.");

      return jsonResponse(
        { error: "Stripe secret key is not configured" },
        500
      );
    }

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error("STRIPE_WEBHOOK_SECRET is not configured.");

      return jsonResponse(
        { error: "Stripe webhook secret is not configured" },
        500
      );
    }

    let event;

    try {
      /*
       * Stripe must receive the exact, unmodified request body.
       * request.text() reads the raw body before JSON parsing.
       */
      const rawBody = await request.text();

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

      return jsonResponse(
        {
          error: `Webhook signature verification failed: ${error.message}`
        },
        400
      );
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const lineItems = await stripe.checkout.sessions.listLineItems(
          session.id,
          {
            limit: 100
          }
        );

        const items = lineItems.data.map(item => ({
          name: item.description || "Item",
          quantity: item.quantity || 1,
          price: Number(item.amount_total || 0) / 100
        }));

        const order = {
          id: session.id,
          date: new Date().toISOString(),
          customer_email: session.customer_details?.email || "",
          amount_total: Number(session.amount_total || 0) / 100,
          tax: Number(session.total_details?.amount_tax || 0) / 100,
          shipping_method:
            session.shipping_cost?.shipping_rate || "unknown",
          shipping_address:
            session.customer_details?.address || {},
          payment_status:
            session.payment_status || "unknown",
          items,
          shipped: false,
          tracking: ""
        };

        const ordersFile = path.join(
          process.cwd(),
          "api",
          "orders-data.json"
        );

        let orders = [];

        if (fs.existsSync(ordersFile)) {
          const fileContents = fs
            .readFileSync(ordersFile, "utf8")
            .trim();

          if (fileContents) {
            orders = JSON.parse(fileContents);
          }
        }

        /*
         * Stripe can retry webhook events.
         * This prevents the same checkout session from being saved twice.
         */
        const orderAlreadyExists = orders.some(
          existingOrder => existingOrder.id === order.id
        );

        if (!orderAlreadyExists) {
          orders.unshift(order);

          fs.writeFileSync(
            ordersFile,
            JSON.stringify(orders, null, 2),
            "utf8"
          );

          console.log("Order saved:", order.id);
        } else {
          console.log("Duplicate order ignored:", order.id);
        }
      } else {
        console.log("Unhandled Stripe event:", event.type);
      }

      return jsonResponse({
        received: true
      });
    } catch (error) {
      console.error("Webhook processing failed:", error);

      return jsonResponse(
        {
          error: "Webhook processing failed"
        },
        500
      );
    }
  }
};
