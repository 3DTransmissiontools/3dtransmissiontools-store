import { authorizeAdminRequest } from "../lib/admin-auth.js";
import { sendContactAlert } from "../lib/contact-alerts.js";
import {
  createContactMessage,
  isValidContactMessageId,
  listContactMessages,
  markContactMessageRead,
  parseContactMessage
} from "../lib/contact-messages.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import { validateSameOrigin } from "../lib/site-security.js";

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
}

export default async function handler(req, res) {
  noStore(res);

  try {
    if (req.method === "GET") {
      if (!authorizeAdminRequest(req)) {
        return res.status(401).json({ error: "Unauthorized." });
      }

      return res.status(200).json(await listContactMessages());
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed." });
    }

    if (req.body?.action === "mark-read") {
      if (!authorizeAdminRequest(req, { stateChanging: true })) {
        return res.status(401).json({ error: "Unauthorized." });
      }

      const id = typeof req.body.id === "string" ? req.body.id : "";

      if (!isValidContactMessageId(id)) {
        return res.status(400).json({ error: "Invalid message ID." });
      }

      const message = await markContactMessageRead(id);

      if (!message) {
        return res.status(404).json({ error: "Message not found." });
      }

      return res.status(200).json({ success: true, message });
    }

    if (!validateSameOrigin(req)) {
      return res.status(403).json({ error: "Invalid request origin." });
    }

    const parsed = parseContactMessage(req.body);

    if (parsed.spam) {
      return res.status(201).json({ success: true });
    }

    const rateLimit = await enforceRateLimit(
      req,
      "contact-submit",
      5,
      60 * 60
    );

    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfter));
      return res.status(429).json({
        error: "Too many messages were sent. Please try again later."
      });
    }

    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    const savedMessage = await createContactMessage(req.body);

    try {
      await sendContactAlert({
        id: savedMessage.id,
        name: parsed.name,
        email: parsed.email,
        subject: parsed.subject,
        orderReference: parsed.orderReference,
        message: parsed.message
      });
    } catch (error) {
      console.error("Contact email alert failed:", error);
    }

    return res.status(201).json({ success: true });
  } catch (error) {
    console.error("Contact API failed:", error);
    return res.status(500).json({
      error: "Unable to send your message right now. Please try again later."
    });
  }
}
