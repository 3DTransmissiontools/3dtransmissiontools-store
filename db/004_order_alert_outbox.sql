CREATE TABLE IF NOT EXISTS order_alert_outbox (
  stripe_session_id TEXT PRIMARY KEY,
  stripe_event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS order_alert_outbox_due_idx
  ON order_alert_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

CREATE OR REPLACE FUNCTION complete_inventory_reservation(
  p_reservation_id UUID,
  p_stripe_session_id TEXT,
  p_event_id TEXT,
  p_event_type TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  inserted_event TEXT;
BEGIN
  INSERT INTO stripe_events (
    event_id,
    event_type,
    reservation_id,
    stripe_session_id
  ) VALUES (
    p_event_id,
    p_event_type,
    p_reservation_id,
    p_stripe_session_id
  )
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id INTO inserted_event;

  IF inserted_event IS NULL THEN
    RETURN FALSE;
  END IF;

  UPDATE inventory_reservations
  SET
    status = 'paid',
    stripe_session_id = COALESCE(stripe_session_id, p_stripe_session_id),
    updated_at = NOW()
  WHERE id = p_reservation_id
    AND status IN ('pending', 'paid');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESERVATION_NOT_PENDING:%', p_reservation_id;
  END IF;

  INSERT INTO order_alert_outbox (
    stripe_session_id,
    stripe_event_id
  ) VALUES (
    p_stripe_session_id,
    p_event_id
  )
  ON CONFLICT (stripe_session_id) DO NOTHING;

  RETURN TRUE;
END;
$$;

