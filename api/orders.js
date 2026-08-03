import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function isAuthorized(req) {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const suppliedPassword = req.headers["x-admin-password"];

  if (!configuredPassword || !suppliedPassword) {
    return false;
  }

  return suppliedPassword === configuredPassword;
}

function getShippingAddress(session) {
  return (
    session.shipping_details?.address ||
    session.customer_details?.address ||
    {}
  );
}

function getShippingName(session) {
  return (
    session.shipping_details?.name ||
    session.customer_details?.name ||
    ""
  );
}

async function formatOrder(session) {
  const lineItems =
    await stripe.checkout.sessions.listLineItems(
      session.id,
      {
        limit: 100
      }
    );

  return {
    id: session.id,
    date: new Date(
      session.created * 1000
    ).toISOString(),

    customer_name: getShippingName(session),

    customer_email:
      session.customer_details?.email ||
      session.customer_email ||
      "",

    amount_total:
      Number(session.amount_total || 0) / 100,

    subtotal:
      Number(session.amount_subtotal || 0) / 100,

    tax:
      Number(
        session.total_details?.amount_tax || 0
      ) / 100,

    shipping_amount:
      Number(
        session.total_details?.amount_shipping || 0
      ) / 100,

    shipping_method:
      session.shipping_cost?.shipping_rate ||
      "",

    shipping_address:
      getShippingAddress(session),

    payment_status:
      session.payment_status || "unknown",

    shipped:
      session.metadata?.shipped === "true",

    tracking:
      session.metadata?.tracking || "",

    items: lineItems.data.map(item => ({
      name: item.description || "Item",
      quantity: Number(item.quantity || 1),
      price:
        Number(item.amount_total || 0) / 100
    }))
  };
}

async function getOrders() {
  const sessions =
    await stripe.checkout.sessions.list({
      limit: 100
    });

  const paidSessions = sessions.data.filter(
    session =>
      session.status === "complete" &&
      (
        session.payment_status === "paid" ||
        session.payment_status === "no_payment_required"
      )
  );

  return Promise.all(
    paidSessions.map(formatOrder)
  );
}

async function updateOrder(req, res) {
  const {
    id,
    shipped,
    tracking
  } = req.body || {};

  if (
    typeof id !== "string" ||
    !id.startsWith("cs_")
  ) {
    return res.status(400).json({
      error: "Invalid order ID."
    });
  }

  if (typeof shipped !== "boolean") {
    return res.status(400).json({
      error: "Invalid shipped status."
    });
  }

  const safeTracking =
    typeof tracking === "string"
      ? tracking.trim().slice(0, 100)
      : "";

  const existingSession =
    await stripe.checkout.sessions.retrieve(id);

  if (existingSession.status !== "complete") {
    return res.status(409).json({
      error: "This checkout is not complete."
    });
  }

  await stripe.checkout.sessions.update(id, {
    metadata: {
      ...existingSession.metadata,
      shipped: shipped ? "true" : "false",
      tracking: safeTracking
    }
  });

  return res.status(200).json({
    success: true
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY is not configured.");

    return res.status(500).json({
      error: "Order service is not configured."
    });
  }

  if (!process.env.ADMIN_PASSWORD) {
    console.error("ADMIN_PASSWORD is not configured.");

    return res.status(500).json({
      error: "Admin access is not configured."
    });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({
      error: "Unauthorized."
    });
  }

  try {
    if (req.method === "GET") {
      const orders = await getOrders();

      return res.status(200).json(orders);
    }

    if (req.method === "POST") {
      return updateOrder(req, res);
    }

    res.setHeader("Allow", ["GET", "POST"]);

    return res.status(405).json({
      error: "Method not allowed."
    });
  } catch (error) {
    console.error("Order API error:", error);

    return res.status(500).json({
      error: "Unable to process orders right now."
    });
  }
}
