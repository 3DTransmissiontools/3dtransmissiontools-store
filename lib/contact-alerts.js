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
  const to = env.CONTACT_ALERT_EMAIL?.trim();
  const from = env.CONTACT_FROM_EMAIL?.trim();

  if (!apiKey || !to || !from) return null;
  if (!apiKey.startsWith("re_") || !EMAIL_PATTERN.test(to)) return null;

  return { apiKey, to, from };
}

export function buildContactAlert(message) {
  const orderReference = message.orderReference || "Not provided";
  const subject = `New contact message: ${message.subject}`;
  const text = [
    "A customer left a new message on 3DTransmissionTools.com.",
    "",
    `Name: ${message.name}`,
    `Email: ${message.email}`,
    `Subject: ${message.subject}`,
    `Order number: ${orderReference}`,
    "",
    message.message,
    "",
    "Open the Store Admin dashboard to manage this message:",
    "https://3dtransmissiontools.com/admin-orders.html"
  ].join("\n");

  const html = `
    <h1>New customer message</h1>
    <p><strong>Name:</strong> ${escapeHtml(message.name)}</p>
    <p><strong>Email:</strong> ${escapeHtml(message.email)}</p>
    <p><strong>Subject:</strong> ${escapeHtml(message.subject)}</p>
    <p><strong>Order number:</strong> ${escapeHtml(orderReference)}</p>
    <p><strong>Message:</strong></p>
    <p>${escapeHtml(message.message).replaceAll("\n", "<br>")}</p>
    <p><a href="https://3dtransmissiontools.com/admin-orders.html">Open Store Admin</a></p>
  `.trim();

  return { subject, text, html };
}

export async function sendContactAlert(
  message,
  { env = process.env, fetchImpl = globalThis.fetch } = {}
) {
  const config = getAlertConfig(env);

  if (!config) return { sent: false, reason: "not-configured" };
  if (typeof fetchImpl !== "function") {
    throw new Error("Email transport is unavailable.");
  }

  const alert = buildContactAlert(message);
  const response = await fetchImpl(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `contact-message-${message.id}`
    },
    body: JSON.stringify({
      from: config.from,
      to: [config.to],
      reply_to: message.email,
      subject: alert.subject,
      text: alert.text,
      html: alert.html
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Email provider rejected the alert (${response.status}): ${details.slice(0, 300)}`);
  }

  return { sent: true };
}
