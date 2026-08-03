import Stripe from "stripe";
import crypto from "crypto";

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return null;
  }

  return new Stripe(secretKey);
}

function safePasswordMatches(
  suppliedPassword,
  configuredPassword
) {
  if (
    typeof suppliedPassword !== "string" ||
    typeof configuredPassword !== "string" ||
    suppliedPassword.length === 0 ||
    configuredPassword.length === 0
  ) {
    return false;
  }

  const suppliedBuffer =
    Buffer.from(suppliedPassword, "utf8");

  const configuredBuffer =
    Buffer.from(configuredPassword, "utf8");

  if (
    suppliedBuffer.length !==
    configuredBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    suppliedBuffer,
    configuredBuffer
  );
}

function isAuthorized(req) {
  const configuredPassword =
    process.env.ADMIN_PASSWORD;

  const suppliedHeader =
    req.headers["x-admin-password"];

  const suppliedPassword =
    Array.isArray(suppliedHeader)
      ? suppliedHeader[0]
      : suppliedHeader;

  return safePasswordMatches(
    suppliedPassword,
    configuredPassword
  );
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

async function getShippingDescription(
  stripe,
  session
) {
  const shippingRate =
    session.shipping_cost?.shipping_rate;

  if (!shippingRate) {
    return "";
  }

  if (
    typeof shippingRate === "object" &&
    shippingRate.display_name
  ) {
    return shippingRate.display_name;
  }

  if (typeof shippingRate !== "string") {
    return "";
  }

  try {
    const rate =
      await stripe.shippingRates.retrieve(
        shippingRate
      );

    return rate.display_name || shippingRate;
  } catch (error) {
    console.warn(
      "Unable to retrieve shipping rate:",
      shippingRate,
      error.message
    );

    return shippingRate;
  }
}

async function formatOrder(stripe, session) {
  const [lineItems, shippingMethod] =
    await Promise.all([
      stripe.checkout.sessions.listLineItems(
        session.id,
        {
          limit: 100
        }
      ),

      getShippingDescription(stripe, session)
    ]);

  return {
    id: session.id,

    date: new Date(
      session.created * 1000
    ).toISOString(),

    customer_name:
      getShippingName(session),

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
        session.total_details
          ?.amount_shipping || 0
      ) / 100,

    shipping_method: shippingMethod,

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

      quantity:
        Number(item.quantity || 1),

      price:
        Number(item.amount_total || 0) / 100
    }))
  };
}

async function listCompletedSessions(stripe) {
  const sessions = [];
  let startingAfter;

  /*
   * Load up to 300 recent Checkout Sessions.
   * Stripe returns newest sessions first.
   */
  while (sessions.length < 300) {
    const page =
      await stripe.checkout.sessions.list({
        limit: 100,

        ...(startingAfter
          ? {
              starting_after: startingAfter
            }
          : {})
      });

    sessions.push(...page.data);

    if (
      !page.has_more ||
      page.data.length === 0
    ) {
      break;
    }

    startingAfter =
      page.data[page.data.length - 1].id;
  }

  return sessions.filter(session =>
    session.status === "complete" &&
    (
      session.payment_status === "paid" ||
      session.payment_status ===
        "no_payment_required"
    )
  );
}

async function getOrders(stripe) {
  const sessions =
    await listCompletedSessions(stripe);

  /*
   * Process orders in small groups so a large order
   * history does not send too many Stripe requests
   * simultaneously.
   */
  const orders = [];
  const batchSize = 10;

  for (
    let index = 0;
    index < sessions.length;
    index += batchSize
  ) {
    const batch =
      sessions.slice(index, index + batchSize);

    const formattedBatch =
      await Promise.all(
        batch.map(session =>
          formatOrder(stripe, session)
        )
      );

    orders.push(...formattedBatch);
  }

  return orders;
}

async function updateOrder(
  stripe,
  req,
  res
) {
  const {
    id,
    shipped,
    tracking
  } = req.body || {};

  if (
    typeof id !== "string" ||
    !id.startsWith("cs_") ||
    id.length > 255
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

  if (
    tracking !== undefined &&
    typeof tracking !== "string"
  ) {
    return res.status(400).json({
      error: "Invalid tracking number."
    });
  }

  const safeTracking =
    typeof tracking === "string"
      ? tracking.trim().slice(0, 100)
      : "";

  const existingSession =
    await stripe.checkout.sessions.retrieve(
      id
    );

  const isPaid =
    existingSession.status === "complete" &&
    (
      existingSession.payment_status === "paid" ||
      existingSession.payment_status ===
        "no_payment_required"
    );

  if (!isPaid) {
    return res.status(409).json({
      error:
        "This checkout is not a completed paid order."
    });
  }

  await stripe.checkout.sessions.update(id, {
    metadata: {
      ...(existingSession.metadata || {}),

      shipped:
        shipped ? "true" : "false",

      tracking: safeTracking
    }
  });

  return res.status(200).json({
    success: true
  });
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "private, no-store, max-age=0"
  );

  res.setHeader("Pragma", "no-cache");

  const stripe = getStripe();

  if (!stripe) {
    console.error(
      "STRIPE_SECRET_KEY is not configured."
    );

    return res.status(500).json({
      error:
        "Order service is not configured."
    });
  }

  if (!process.env.ADMIN_PASSWORD) {
    console.error(
      "ADMIN_PASSWORD is not configured."
    );

    return res.status(500).json({
      error:
        "Admin access is not configured."
    });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({
      error: "Unauthorized."
    });
  }

  try {
    if (req.method === "GET") {
      const orders = await getOrders(stripe);

      return res.status(200).json(orders);
    }

    if (req.method === "POST") {
      return updateOrder(
        stripe,
        req,
        res
      );
    }

    res.setHeader("Allow", ["GET", "POST"]);

    return res.status(405).json({
      error: "Method not allowed."
    });
  } catch (error) {
    console.error("Order API error:", error);

    return res.status(500).json({
      error:
        "Unable to process orders right now."
    });
  }
}
