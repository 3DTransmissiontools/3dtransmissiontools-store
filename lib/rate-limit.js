import crypto from "crypto";
import { getSql } from "./database.js";
import { getClientAddress } from "./site-security.js";

function getRateLimitSecret() {
  const secret = process.env.RATE_LIMIT_SECRET?.trim();

  if (!secret || secret.length < 32) {
    throw new Error("RATE_LIMIT_SECRET must contain at least 32 characters.");
  }

  return secret;
}

function getHashedKey(req, scope) {
  return crypto
    .createHmac("sha256", getRateLimitSecret())
    .update(`${scope}:${getClientAddress(req)}`)
    .digest("hex");
}

export async function enforceRateLimit(
  req,
  scope,
  limit,
  windowSeconds
) {
  const sql = getSql();
  const key = getHashedKey(req, scope);
  const rows = await sql`
    SELECT allowed, retry_after_seconds
    FROM consume_rate_limit(
      ${key},
      ${limit},
      ${windowSeconds}
    )
  `;

  return {
    allowed: Boolean(rows[0]?.allowed),
    retryAfter: Math.max(
      1,
      Number(rows[0]?.retry_after_seconds || windowSeconds)
    )
  };
}

export async function clearRateLimit(req, scope) {
  const sql = getSql();
  const key = getHashedKey(req, scope);

  await sql`DELETE FROM rate_limits WHERE key = ${key}`;
}
