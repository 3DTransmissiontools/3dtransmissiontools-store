const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function getConfiguredSiteUrl() {
  const configuredValue = process.env.SITE_URL?.trim();

  if (!configuredValue) {
    throw new Error("SITE_URL is not configured.");
  }

  let siteUrl;

  try {
    siteUrl = new URL(configuredValue);
  } catch {
    throw new Error("SITE_URL is invalid.");
  }

  const isLocalDevelopment =
    process.env.NODE_ENV !== "production" &&
    siteUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(siteUrl.hostname);

  if (siteUrl.protocol !== "https:" && !isLocalDevelopment) {
    throw new Error("SITE_URL must use HTTPS.");
  }

  if (
    siteUrl.username ||
    siteUrl.password ||
    siteUrl.search ||
    siteUrl.hash ||
    (siteUrl.pathname !== "/" && siteUrl.pathname !== "")
  ) {
    throw new Error("SITE_URL must be an HTTPS origin without a path.");
  }

  return siteUrl.origin;
}

export function isValidProductId(value) {
  return (
    typeof value === "string" &&
    PRODUCT_ID_PATTERN.test(value)
  );
}

export function isAllowedMediaUrl(value, type = "image") {
  if (typeof value !== "string" || value.length > 2048) return false;

  if (/^\/[A-Za-z0-9_./-]+$/.test(value) && !value.includes("..")) {
    return true;
  }

  if (type !== "image") return false;

  try {
    const mediaUrl = new URL(value);
    return (
      mediaUrl.protocol === "https:" &&
      mediaUrl.hostname === "i.ebayimg.com" &&
      !mediaUrl.username &&
      !mediaUrl.password
    );
  } catch {
    return false;
  }
}

export function validateSameOrigin(req) {
  const origin = req.headers.origin;

  if (typeof origin !== "string") {
    return false;
  }

  try {
    return new URL(origin).origin === getConfiguredSiteUrl();
  } catch {
    return false;
  }
}

export function getClientAddress(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor;

  if (typeof firstForwarded === "string") {
    const address = firstForwarded.split(",")[0].trim();
    if (address) return address.slice(0, 128);
  }

  return String(req.socket?.remoteAddress || "unknown").slice(0, 128);
}
