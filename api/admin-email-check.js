import { authorizeAdminRequest } from "../lib/admin-auth.js";
import { sendOrderAlert } from "../lib/order-alerts.js";
import { enforceRateLimit } from "../lib/rate-limit.js";

export function buildTestOrder(now = Date.now()) {
  return {
    id: `test-order-alert-${now}`,
    isTest: true,
    customerName: "Email delivery test",
    customerEmail: "",
    amountTotal: 0,
    currency: "usd",
    shippingAddress: {},
    items: [{
      name: "Test notification — no order was placed",
      quantity: 1,
      amountTotal: 0
    }]
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!authorizeAdminRequest(req, { stateChanging: true })) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  const rateLimit = await enforceRateLimit(req, "admin-email-test", 3, 60);

  if (!rateLimit.allowed) {
    res.setHeader("Retry-After", String(rateLimit.retryAfter));
    return res.status(429).json({
      error: "Too many test emails. Please try again shortly."
    });
  }

  try {
    const result = await sendOrderAlert(buildTestOrder());

    if (!result.sent) {
      return res.status(503).json({
        error: "Order email alerts are not configured."
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Test order alert failed:", error.message);
    return res.status(502).json({
      error: "Unable to send the test order email."
    });
  }
}

