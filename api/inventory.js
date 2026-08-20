import { authorizeAdminRequest } from "../lib/admin-auth.js";
import {
  addRestock,
  listAdminInventory,
  parseRestockRequest
} from "../lib/admin-inventory.js";
import { enforceRateLimit } from "../lib/rate-limit.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");

  if (!process.env.ADMIN_SESSION_SECRET) {
    console.error("ADMIN_SESSION_SECRET is not configured.");
    return res.status(500).json({
      error: "Admin access is not configured."
    });
  }

  const stateChanging = req.method !== "GET";

  if (!authorizeAdminRequest(req, { stateChanging })) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    const rateLimit = await enforceRateLimit(
      req,
      stateChanging ? "admin-inventory-write" : "admin-inventory-read",
      stateChanging ? 20 : 60,
      60
    );

    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfter));
      return res.status(429).json({
        error: "Too many requests. Please try again shortly."
      });
    }

    if (req.method === "GET") {
      return res.status(200).json(await listAdminInventory());
    }

    if (req.method === "POST") {
      const input = parseRestockRequest(req.body);

      if (input.error) {
        return res.status(400).json({ error: input.error });
      }

      const product = await addRestock(input.id, input.quantity);

      if (!product) {
        return res.status(404).json({
          error: "That product is not active or could not be found."
        });
      }

      return res.status(200).json({
        success: true,
        product
      });
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    console.error("Inventory admin API error:", error);
    return res.status(500).json({
      error: "Unable to update inventory right now."
    });
  }
}

