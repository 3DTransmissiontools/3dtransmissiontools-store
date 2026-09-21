const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_ENDPOINT = "https://api.resend.com/emails";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getAlertConfig(env = process.env) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const to = (env.ORDER_ALERT_EMAIL || env.CONTACT_ALERT_EMAIL)?.trim();
  const from = (env.ORDER_FROM_EMAIL || env.CONTACT_FROM_EMAIL)?.trim();

  if (!apiKey || !to || !from) return null;
  if (!apiKey.startsWith("re_") || !EMAIL_PATTERN.test(to)) return null;

  return { apiKey, to, from };
}

function formatMoney(amount, currency = "usd") {
  const safeAmount = Number.isFinite(Number(amount)) ? Number(amount) : 0;

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: String(currency || "usd").toUpperCase()
    }).format(safeAmount / 100);
  } catch {
    return `$${(safeAmount / 100).toFixed(2)}`;
  }
}

function formatAddress(address = {}) {
  const cityLine = [address.city, address.state, address.postal_code]
    .filter(Boolean)
    .join(" ");

  return [
    address.line1,
    address.line2,
    cityLine,
    address.country
  ].filter(Boolean);
}

export function buildOrderAlert(order) {
  const customerName = order.customerName || "Customer";
  const subjectName = String(customerName)
    .replace(/[\r\n]+/g, " ")
    .slice(0, 100);
  const customerEmail = order.customerEmail || "Not provided";
  const total = formatMoney(order.amountTotal, order.currency);
  const addressLines = formatAddress(order.shippingAddress);
  const items = Array.isArray(order.items) ? order.items : [];
  const itemText = items.length
    ? items.map(item =>
        `${Number(item.quantity || 1)} × ${item.name || "Item"} — ` +
        formatMoney(item.amountTotal, order.currency)
      )
    : ["Item details unavailable"];
  const itemHtml = items.length
    ? items.map(item => `
        <li>${escapeHtml(Number(item.quantity || 1))} × ${escapeHtml(item.name || "Item")} — ${escapeHtml(formatMoney(item.amountTotal, order.currency))}</li>
      `).join("")
    : "<li>Item details unavailable</li>";
  const addressText = addressLines.length
    ? addressLines.join("\n")
    : "Not provided";
  const addressHtml = addressLines.length
    ? addressLines.map(escapeHtml).join("<br>")
    : "Not provided";
  const subject = `New paid order: ${total} — ${subjectName}`;
  const text = [
    "A new paid order was received on 3DTransmissionTools.com.",
    "",
    `Customer: ${customerName}`,
    `Email: ${customerEmail}`,
    `Order: ${order.id}`,
    `Total: ${total}`,
    "",
    "Items:",
    ...itemText,
    "",
    "Ship to:",
    addressText,
    "",
    "Open Store Admin to process this order:",
    "https://3dtransmissiontools.com/admin-orders.html"
  ].join("\n");
  const html = `
    <h1>New paid order</h1>
    <p><strong>Customer:</strong> ${escapeHtml(customerName)}</p>
    <p><strong>Email:</strong> ${escapeHtml(customerEmail)}</p>
    <p><strong>Order:</strong> ${escapeHtml(order.id)}</p>
    <p><strong>Total:</strong> ${escapeHtml(total)}</p>
    <p><strong>Items:</strong></p>
    <ul>${itemHtml}</ul>
    <p><strong>Ship to:</strong><br>${addressHtml}</p>
    <p><a href="https://3dtransmissiontools.com/admin-orders.html">Open Store Admin</a></p>
  `.trim();

  return { subject, text, html };
}

export async function sendOrderAlert(
  order,
  { env = process.env, fetchImpl = globalThis.fetch } = {}
) {
  const config = getAlertConfig(env);

  if (!config) return { sent: false, reason: "not-configured" };
  if (typeof fetchImpl !== "function") {
    throw new Error("Email transport is unavailable.");
  }

  const alert = buildOrderAlert(order);
  const payload = {
    from: config.from,
    to: [config.to],
    subject: alert.subject,
    text: alert.text,
    html: alert.html
  };

  if (EMAIL_PATTERN.test(order.customerEmail || "")) {
    payload.reply_to = order.customerEmail;
  }

  const response = await fetchImpl(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `new-order-${order.id}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Email provider rejected the order alert (${response.status}): ${details.slice(0, 300)}`
    );
  }

  return { sent: true };
}

