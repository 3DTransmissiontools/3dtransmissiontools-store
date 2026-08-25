import { getSql } from "./database.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const contactSchemaClients = new WeakSet();

function cleanText(value, maximumLength) {
  return typeof value === "string"
    ? value.trim().slice(0, maximumLength)
    : "";
}

export function parseContactMessage(body) {
  if (cleanText(body?.website, 200)) return { spam: true };

  const name = cleanText(body?.name, 100);
  const email = cleanText(body?.email, 254).toLowerCase();
  const subject = cleanText(body?.subject, 120);
  const orderReference = cleanText(body?.order_reference, 80);
  const message = cleanText(body?.message, 3000);

  if (!name) return { error: "Enter your name." };

  if (!EMAIL_PATTERN.test(email) || /[\r\n]/.test(email)) {
    return { error: "Enter a valid email address." };
  }

  if (!subject) return { error: "Choose a subject." };

  if (message.length < 10) {
    return { error: "Enter a message containing at least 10 characters." };
  }

  return { name, email, subject, orderReference, message };
}

export function isValidContactMessageId(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

async function ensureContactSchema(sql) {
  if (contactSchemaClients.has(sql)) return;

  await sql`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
      email TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
      subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 120),
      order_reference TEXT NOT NULL DEFAULT ''
        CHECK (char_length(order_reference) <= 80),
      message TEXT NOT NULL CHECK (char_length(message) BETWEEN 10 AND 3000),
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'read')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS contact_messages_created_at_idx
    ON contact_messages (created_at DESC)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS contact_messages_new_idx
    ON contact_messages (created_at DESC)
    WHERE status = 'new'
  `;

  contactSchemaClients.add(sql);
}

export async function createContactMessage(input, sql = getSql()) {
  const contact = parseContactMessage(input);

  if (contact.error) throw new TypeError(contact.error);
  if (contact.spam) return null;

  await ensureContactSchema(sql);

  const rows = await sql`
    INSERT INTO contact_messages (
      name,
      email,
      subject,
      order_reference,
      message
    ) VALUES (
      ${contact.name},
      ${contact.email},
      ${contact.subject},
      ${contact.orderReference},
      ${contact.message}
    )
    RETURNING id, created_at
  `;

  return rows[0] || null;
}

export async function listContactMessages(sql = getSql()) {
  await ensureContactSchema(sql);

  return sql`
    SELECT
      id,
      name,
      email,
      subject,
      order_reference,
      message,
      status,
      created_at,
      updated_at
    FROM contact_messages
    ORDER BY created_at DESC
    LIMIT 200
  `;
}

export async function markContactMessageRead(id, sql = getSql()) {
  if (!isValidContactMessageId(id)) return null;

  await ensureContactSchema(sql);

  const rows = await sql`
    UPDATE contact_messages
    SET status = 'read', updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, status, updated_at
  `;

  return rows[0] || null;
}

