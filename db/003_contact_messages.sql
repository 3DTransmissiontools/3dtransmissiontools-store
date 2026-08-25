CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
);

CREATE INDEX IF NOT EXISTS contact_messages_created_at_idx
  ON contact_messages (created_at DESC);

CREATE INDEX IF NOT EXISTS contact_messages_new_idx
  ON contact_messages (created_at DESC)
  WHERE status = 'new';

