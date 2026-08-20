CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit_amount INTEGER NOT NULL CHECK (unit_amount > 0),
  stock_available INTEGER NOT NULL CHECK (stock_available >= 0),
  weight_oz NUMERIC(10, 2) NOT NULL CHECK (weight_oz > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  images JSONB NOT NULL DEFAULT '[]'::jsonb,
  video TEXT,
  videos JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'released')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inventory_reservations_pending_expiry_idx
  ON inventory_reservations (expires_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS inventory_reservation_items (
  reservation_id UUID NOT NULL
    REFERENCES inventory_reservations(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit_amount INTEGER NOT NULL CHECK (unit_amount > 0),
  weight_oz NUMERIC(10, 2) NOT NULL CHECK (weight_oz > 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (reservation_id, product_id)
);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  reservation_id UUID,
  stripe_session_id TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  window_started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION release_inventory_reservation(
  p_reservation_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  changed BOOLEAN := FALSE;
BEGIN
  UPDATE inventory_reservations
  SET status = 'released', updated_at = NOW()
  WHERE id = p_reservation_id
    AND status = 'pending';

  IF FOUND THEN
    UPDATE products AS product
    SET
      stock_available = product.stock_available + item.quantity,
      updated_at = NOW()
    FROM inventory_reservation_items AS item
    WHERE item.reservation_id = p_reservation_id
      AND item.product_id = product.id;

    changed := TRUE;
  END IF;

  RETURN changed;
END;
$$;

CREATE OR REPLACE FUNCTION release_expired_inventory_reservations()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  reservation RECORD;
  released_count INTEGER := 0;
BEGIN
  FOR reservation IN
    SELECT id
    FROM inventory_reservations
    WHERE status = 'pending'
      AND expires_at <= NOW()
    FOR UPDATE SKIP LOCKED
  LOOP
    IF release_inventory_reservation(reservation.id) THEN
      released_count := released_count + 1;
    END IF;
  END LOOP;

  RETURN released_count;
END;
$$;

CREATE OR REPLACE FUNCTION reserve_inventory(
  p_items JSONB,
  p_expires_at TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  reservation_id UUID := gen_random_uuid();
  cart_item JSONB;
  requested_id TEXT;
  requested_quantity INTEGER;
  product_row products%ROWTYPE;
BEGIN
  IF jsonb_typeof(p_items) <> 'array'
    OR jsonb_array_length(p_items) = 0
    OR jsonb_array_length(p_items) > 50
    OR p_expires_at <= NOW()
  THEN
    RAISE EXCEPTION 'INVALID_CART';
  END IF;

  INSERT INTO inventory_reservations (id, expires_at)
  VALUES (reservation_id, p_expires_at);

  FOR cart_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    requested_id := cart_item->>'id';

    BEGIN
      requested_quantity := (cart_item->>'quantity')::INTEGER;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'INVALID_CART';
    END;

    IF requested_id IS NULL
      OR requested_id !~ '^[A-Za-z0-9_-]{1,64}$'
      OR requested_quantity < 1
      OR requested_quantity > 99
    THEN
      RAISE EXCEPTION 'INVALID_CART';
    END IF;

    SELECT * INTO product_row
    FROM products
    WHERE id = requested_id
      AND active = TRUE
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND:%', requested_id;
    END IF;

    IF product_row.stock_available < requested_quantity THEN
      RAISE EXCEPTION 'OUT_OF_STOCK:%:%',
        requested_id,
        product_row.stock_available;
    END IF;

    UPDATE products
    SET
      stock_available = stock_available - requested_quantity,
      updated_at = NOW()
    WHERE id = requested_id;

    INSERT INTO inventory_reservation_items (
      reservation_id,
      product_id,
      product_name,
      unit_amount,
      weight_oz,
      quantity
    ) VALUES (
      reservation_id,
      product_row.id,
      product_row.name,
      product_row.unit_amount,
      product_row.weight_oz,
      requested_quantity
    );
  END LOOP;

  RETURN reservation_id;
END;
$$;

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

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION consume_rate_limit(
  p_key TEXT,
  p_limit INTEGER,
  p_window_seconds INTEGER
) RETURNS TABLE (allowed BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql
AS $$
DECLARE
  current_row rate_limits%ROWTYPE;
  now_value TIMESTAMPTZ := NOW();
BEGIN
  IF p_limit < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'INVALID_RATE_LIMIT';
  END IF;

  DELETE FROM rate_limits WHERE expires_at <= now_value;

  INSERT INTO rate_limits (
    key,
    request_count,
    window_started_at,
    expires_at
  ) VALUES (
    p_key,
    1,
    now_value,
    now_value + make_interval(secs => p_window_seconds)
  )
  ON CONFLICT (key) DO UPDATE
  SET request_count = rate_limits.request_count + 1
  RETURNING * INTO current_row;

  allowed := current_row.request_count <= p_limit;
  retry_after_seconds := GREATEST(
    1,
    CEIL(EXTRACT(EPOCH FROM (current_row.expires_at - now_value)))::INTEGER
  );

  RETURN NEXT;
END;
$$;
