ALTER TABLE products
  ADD COLUMN IF NOT EXISTS featured_rank INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'products_featured_rank_check'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_featured_rank_check
      CHECK (featured_rank IS NULL OR featured_rank BETWEEN 0 AND 3);
  END IF;
END;
$$;

UPDATE products
SET featured_rank = CASE id
  WHEN '21' THEN 0
  WHEN '17' THEN 1
  WHEN '9' THEN 2
  WHEN '4' THEN 3
END
WHERE featured_rank IS NULL
  AND id IN ('21', '17', '9', '4')
  AND NOT EXISTS (
    SELECT 1
    FROM products
    WHERE featured_rank IS NOT NULL
  );

