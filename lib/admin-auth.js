import crypto from "crypto";
import { validateSameOrigin } from "./site-security.js";

const COOKIE_NAME = "admin_session";
const SESSION_SECONDS = 15 * 60;

function getAdminSessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET?.trim();

  if (!secret || secret.length < 32) {
    throw new Error(
      "ADMIN_SESSION_SECRET must contain at least 32 characters."
    );
  }

  return secret;
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(payload) {
  return crypto
    .createHmac("sha256", getAdminSessionSecret())
    .update(payload)
    .digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = crypto.createHash("sha256").update(String(left)).digest();
  const rightBuffer = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (typeof header !== "string") return {};

  return Object.fromEntries(
    header.split(";").map(part => {
      const separator = part.indexOf("=");
      if (separator < 0) return [part.trim(), ""];
      return [
        part.slice(0, separator).trim(),
        part.slice(separator + 1).trim()
      ];
    })
  );
}

export function passwordMatches(suppliedPassword) {
  const configuredPassword = process.env.ADMIN_PASSWORD;

  if (
    typeof suppliedPassword !== "string" ||
    typeof configuredPassword !== "string" ||
    suppliedPassword.length < 12 ||
    configuredPassword.length < 12
  ) {
    return false;
  }

  return safeEqual(suppliedPassword, configuredPassword);
}

export function createAdminSessionCookie(now = Date.now()) {
  const payload = encode(
    JSON.stringify({
      exp: Math.floor(now / 1000) + SESSION_SECONDS,
      nonce: crypto.randomBytes(16).toString("hex")
    })
  );

  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";

  return `${COOKIE_NAME}=${payload}.${sign(payload)}; ` +
    `Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly;${secure} ` +
    "SameSite=Strict";
}

export function clearAdminSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly;${secure} ` +
    "SameSite=Strict";
}

export function hasValidAdminSession(req, now = Date.now()) {
  const token = parseCookies(req)[COOKIE_NAME];

  if (typeof token !== "string") return false;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  if (!safeEqual(signature, sign(payload))) return false;

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    return (
      Number.isInteger(data.exp) &&
      data.exp > Math.floor(now / 1000)
    );
  } catch {
    return false;
  }
}

export function authorizeAdminRequest(req, { stateChanging = false } = {}) {
  return (
    hasValidAdminSession(req) &&
    (!stateChanging || validateSameOrigin(req))
  );
}
