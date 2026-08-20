import Stripe from "stripe";
import {
  attachCheckoutSession,
  InventoryError,
  releaseInventory,
  reserveInventory
} from "../lib/inventory.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import {
  getConfiguredSiteUrl,
  isValidProductId,
  validateSameOrigin
} from "../lib/site-security.js";

const STORE_ID = "3dtransmissiontools-store";
const CHECKOUT_SECONDS = 31 * 60;
const RESERVATION_GRACE_SECONDS = 15 * 60;

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;

  return new Stripe(secretKey, {
    apiVersion: "2026-02-25.clover"
  });
}

function getRequestedQuantity(value) {
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 99
    ? quantity
    : null;
}

export function getUniqueCartItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    return null;
  }

  const combinedItems = new Map();

  for (const item of items) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const quantity = getRequestedQuantity(item?.quantity);

    if (!isValidProductId(id) || quantity === null) return null;

    const combinedQuantity = (combinedItems.get(id) || 0) + quantity;
    if (!Number.isSafeInteger(combinedQuantity) || combinedQuantity > 99) {
      return null;
    }

    combinedItems.set(id, combinedQuantity);
  }

  return Array.from(combinedItems, ([id, quantity]) => ({ id, quantity }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function getGroundShippingAmount(totalWeightOz) {
  if (totalWeightOz <= 16) return 595;
  if (totalWeightOz <= 32) return 895;
  if (totalWeightOz <= 48) return 1195;
  if (totalWeightOz <= 64) return 1495;
  return 1895;
}

function getPriorityShippingAmount(totalWeightOz) {
  if (totalWeightOz <= 16) return 1095;
  if (totalWeightOz <= 32) return 1495;
  if (totalWeightOz <= 48) return 1895;
  if (totalWeightOz <= 64) return 2495;
  return 3295;
}

function createShippingOption(displayName, amount, minimum, maximum) {
  return {
    shipping_rate_data: {
      type: "fixed_amount",
      fixed_amount: { amount, currency: "usd" },
      display_name: displayName,
      delivery_estimate: {
        minimum: { unit: "business_day", value: minimum },
        maximum: { unit: "business_day", value: maximum }
      }
    }
  };
}

function sendRateLimitResponse(res, retryAfter) {
  res.setHeader("Retry-After", String(retryAfter));
  return res.status(429).json({
    error: "Too many checkout attempts. Please try again shortly."
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!validateSameOrigin(req)) {
    return res.status(403).json({ error: "Request origin is not allowed." });
  }

  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({
      error: "Checkout is temporarily unavailable."
    });
  }

  let reservationId;
  let stripeSession;

  try {
    const rateLimit = await enforceRateLimit(req, "checkout", 10, 60);
    if (!rateLimit.allowed) {
      return sendRateLimitResponse(res, rateLimit.retryAfter);
    }

    const cartItems = getUniqueCartItems(req.body?.items);
    if (!cartItems) {
      return res.status(400).json({
        error: "Your cart contains an invalid item."
      });
    }

    const checkoutExpiresAt =
      Math.floor(Date.now() / 1000) + CHECKOUT_SECONDS;
    const reservationExpiresAt = new Date(
      (checkoutExpiresAt + RESERVATION_GRACE_SECONDS) * 1000
    );

    const reservation = await reserveInventory(
      cartItems,
      reservationExpiresAt
    );
    reservationId = reservation.reservationId;

    let totalWeightOz = 0;
    const lineItems = reservation.items.map(item => {
      const quantity = Number(item.quantity);
      const weightOz = Number(item.weight_oz);
      const unitAmount = Number(item.unit_amount);

      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        !Number.isFinite(weightOz) ||
        weightOz <= 0 ||
        !Number.isSafeInteger(unitAmount) ||
        unitAmount < 1
      ) {
        throw new Error("Reserved product data is invalid.");
      }

      totalWeightOz += weightOz * quantity;

      return {
        price_data: {
          currency: "usd",
          unit_amount: unitAmount,
          product_data: {
            name: String(item.name || "Product"),
            metadata: { product_id: String(item.id) }
          }
        },
        quantity
      };
    });

    const groundShipping = createShippingOption(
      "USPS Ground Advantage",
      getGroundShippingAmount(totalWeightOz),
      3,
      6
    );
    const priorityShipping = createShippingOption(
      "USPS Priority Mail",
      getPriorityShippingAmount(totalWeightOz),
      1,
      3
    );
    const shippingOptions = req.body?.preferredShippingMethod === "priority"
      ? [priorityShipping, groundShipping]
      : [groundShipping, priorityShipping];
    const siteUrl = getConfiguredSiteUrl();

    stripeSession = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      customer_creation: "always",
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: ["US"] },
      shipping_options: shippingOptions,
      expires_at: checkoutExpiresAt,
      metadata: {
        store_id: STORE_ID,
        reservation_id: reservationId,
        shipped: "false",
        tracking: "",
        package_weight_oz: String(totalWeightOz)
      },
      success_url:
        `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/cart.html`
    });

    if (!stripeSession.url) {
      throw new Error("Stripe did not return a Checkout URL.");
    }

    await attachCheckoutSession(
      reservationId,
      stripeSession.id,
      reservationExpiresAt
    );

    return res.status(200).json({ url: stripeSession.url });
  } catch (error) {
    if (stripeSession?.id) {
      try {
        await stripe.checkout.sessions.expire(stripeSession.id);
      } catch (expireError) {
        console.error("Unable to expire failed Checkout session:", expireError);
      }
    }

    if (reservationId) {
      try {
        await releaseInventory(reservationId);
      } catch (releaseError) {
        console.error("Unable to release failed reservation:", releaseError);
      }
    }

    if (error instanceof InventoryError) {
      const status = error.code === "INVALID_CART" ? 400 : 409;
      return res.status(status).json({ error: error.message });
    }

    console.error("Stripe checkout error:", error);
    return res.status(500).json({
      error: "Unable to start checkout right now."
    });
  }
}
