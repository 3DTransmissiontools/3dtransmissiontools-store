import {
  clearAdminSessionCookie,
  createAdminSessionCookie,
  hasValidAdminSession,
  passwordMatches
} from "../lib/admin-auth.js";
import { clearRateLimit, enforceRateLimit } from "../lib/rate-limit.js";
import { validateSameOrigin } from "../lib/site-security.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  if (req.method === "GET") {
    try {
      return res.status(200).json({ authenticated: hasValidAdminSession(req) });
    } catch (error) {
      console.error("Admin session configuration error:", error);
      return res.status(500).json({ error: "Admin access is not configured." });
    }
  }

  if (req.method === "DELETE") {
    if (!validateSameOrigin(req)) {
      return res.status(403).json({ error: "Request origin is not allowed." });
    }

    res.setHeader("Set-Cookie", clearAdminSessionCookie());
    return res.status(200).json({ authenticated: false });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST", "DELETE"]);
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!validateSameOrigin(req)) {
    return res.status(403).json({ error: "Request origin is not allowed." });
  }

  try {
    const rateLimit = await enforceRateLimit(req, "admin-login", 5, 15 * 60);

    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfter));
      return res.status(429).json({
        error: "Too many sign-in attempts. Try again later."
      });
    }

    if (!passwordMatches(req.body?.password)) {
      return res.status(401).json({ error: "Incorrect admin password." });
    }

    await clearRateLimit(req, "admin-login");
    res.setHeader("Set-Cookie", createAdminSessionCookie());
    return res.status(200).json({ authenticated: true });
  } catch (error) {
    console.error("Admin session error:", error);
    return res.status(500).json({ error: "Unable to sign in right now." });
  }
}
