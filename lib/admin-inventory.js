import { getSql } from "./database.js";
import { releaseExpiredInventory } from "./inventory.js";
import {
  isAllowedMediaUrl,
  isValidProductId
} from "./site-security.js";

const MAX_RESTOCK_QUANTITY = 1000;
const MAX_IMAGES = 10;
const MAX_FEATURED_PRODUCTS = 4;
const featuredSchemaClients = new WeakSet();

function cleanText(value, maximumLength) {
  return typeof value === "string"
    ? value.trim().slice(0, maximumLength)
    : "";
}

export function parseProductRequest(body) {
  const id = cleanText(body?.id, 64);
  const name = cleanText(body?.name, 160);
  const category = cleanText(body?.category, 80);
  const description = cleanText(body?.description, 2000);
  const price = Number(body?.price);
  const stock = Number(body?.stock);
  const weightOz = Number(body?.weight_oz);
  const images = Array.isArray(body?.images)
    ? body.images.map(value => cleanText(value, 2048)).filter(Boolean)
    : [];
  const video = cleanText(body?.video, 2048) || null;

  if (!isValidProductId(id)) {
    return {
      error: "Product ID must use only letters, numbers, hyphens, or underscores."
    };
  }

  if (!name) return { error: "Enter a product name." };

  if (!Number.isFinite(price) || price < 0.01 || price > 100000) {
    return { error: "Price must be between $0.01 and $100,000." };
  }

  const unitAmount = Math.round(price * 100);

  if (Math.abs(price * 100 - unitAmount) > 0.000001) {
    return { error: "Price cannot contain fractions of a cent." };
  }

  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) {
    return {
      error: "Starting quantity must be a whole number from 0 to 100,000."
    };
  }

  if (!Number.isFinite(weightOz) || weightOz <= 0 || weightOz > 10000) {
    return { error: "Shipping weight must be greater than 0 ounces." };
  }

  if (images.length < 1 || images.length > MAX_IMAGES) {
    return { error: `Add between 1 and ${MAX_IMAGES} product images.` };
  }

  if (images.some(url => !isAllowedMediaUrl(url, "image"))) {
    return {
      error: "Images must use a local path or an approved i.ebayimg.com URL."
    };
  }

  if (video && !isAllowedMediaUrl(video, "video")) {
    return { error: "Video must use an approved local site path." };
  }

  return {
    id,
    name,
    unitAmount,
    stock,
    weightOz,
    category,
    description,
    images,
    video
  };
}

export function parseRestockRequest(body) {
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const quantity = Number(body?.quantity);

  if (!isValidProductId(id)) {
    return { error: "Select a valid product." };
  }

  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_RESTOCK_QUANTITY
  ) {
    return {
      error: `Restock quantity must be a whole number from 1 to ${MAX_RESTOCK_QUANTITY}.`
    };
  }

  return { id, quantity };
}

export function parseFeaturedProductsRequest(body) {
  const ids = Array.isArray(body?.ids)
    ? body.ids.map(value => cleanText(value, 64))
    : [];

  if (ids.length < 1 || ids.length > MAX_FEATURED_PRODUCTS) {
    return { error: `Choose between 1 and ${MAX_FEATURED_PRODUCTS} featured products.` };
  }

  if (ids.some(id => !isValidProductId(id))) {
    return { error: "Featured products contain an invalid product ID." };
  }

  if (new Set(ids).size !== ids.length) {
    return { error: "Each featured product can only be selected once." };
  }

  return { ids };
}

async function ensureFeaturedSchema(sql) {
  if (featuredSchemaClients.has(sql)) return;

  await sql`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS featured_rank INTEGER
  `;

  await sql`
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
        SELECT 1 FROM products WHERE featured_rank IS NOT NULL
      )
  `;

  featuredSchemaClients.add(sql);
}

export async function listAdminInventory(sql = getSql()) {
  await releaseExpiredInventory(sql);
  await ensureFeaturedSchema(sql);

  return sql`
    SELECT
      id,
      name,
      unit_amount,
      stock_available,
      weight_oz,
      category,
      description,
      images,
      video,
      active,
      featured_rank,
      updated_at
    FROM products
    ORDER BY active DESC, sort_order, id
  `;
}

export async function setFeaturedProducts(input, sql = getSql()) {
  const featured = parseFeaturedProductsRequest(input);

  if (featured.error) throw new TypeError(featured.error);

  await ensureFeaturedSchema(sql);

  const activeProducts = await sql`
    SELECT id
    FROM products
    WHERE active = TRUE
      AND id IN (
        SELECT value
        FROM jsonb_array_elements_text(
          ${JSON.stringify(featured.ids)}::jsonb
        )
      )
  `;

  if (activeProducts.length !== featured.ids.length) {
    throw new TypeError("Featured products must all be active products.");
  }

  await sql`
    WITH requested AS (
      SELECT
        value AS id,
        (ordinality - 1)::INTEGER AS featured_rank
      FROM jsonb_array_elements_text(
        ${JSON.stringify(featured.ids)}::jsonb
      ) WITH ORDINALITY
    )
    UPDATE products AS product
    SET
      featured_rank = requested.featured_rank,
      updated_at = NOW()
    FROM (
      SELECT id, featured_rank FROM requested
      UNION ALL
      SELECT id, NULL::INTEGER
      FROM products
      WHERE featured_rank IS NOT NULL
        AND id NOT IN (SELECT id FROM requested)
    ) AS requested
    WHERE product.id = requested.id
  `;

  return featured.ids;
}

export async function addRestock(id, quantity, sql = getSql()) {
  const input = parseRestockRequest({ id, quantity });

  if (input.error) {
    throw new TypeError(input.error);
  }

  await releaseExpiredInventory(sql);

  const rows = await sql`
    UPDATE products
    SET
      stock_available = stock_available + ${input.quantity},
      updated_at = NOW()
    WHERE id = ${input.id}
      AND active = TRUE
    RETURNING
      id,
      name,
      stock_available,
      active,
      updated_at
  `;

  return rows[0] || null;
}

export async function createProduct(input, sql = getSql()) {
  const product = parseProductRequest(input);

  if (product.error) throw new TypeError(product.error);

  const rows = await sql`
    INSERT INTO products (
      id,
      name,
      unit_amount,
      stock_available,
      weight_oz,
      currency,
      category,
      description,
      images,
      videos,
      video,
      active,
      sort_order
    ) VALUES (
      ${product.id},
      ${product.name},
      ${product.unitAmount},
      ${product.stock},
      ${product.weightOz},
      'USD',
      ${product.category},
      ${product.description},
      ${JSON.stringify(product.images)}::jsonb,
      '[]'::jsonb,
      ${product.video},
      TRUE,
      COALESCE((SELECT MAX(sort_order) + 1 FROM products), 0)
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id, name, stock_available, active, updated_at
  `;

  return rows[0] || null;
}

export async function updateProduct(input, sql = getSql()) {
  const product = parseProductRequest(input);

  if (product.error) throw new TypeError(product.error);

  const rows = await sql`
    UPDATE products
    SET
      name = ${product.name},
      unit_amount = ${product.unitAmount},
      weight_oz = ${product.weightOz},
      category = ${product.category},
      description = ${product.description},
      images = ${JSON.stringify(product.images)}::jsonb,
      video = ${product.video},
      updated_at = NOW()
    WHERE id = ${product.id}
    RETURNING id, name, stock_available, active, updated_at
  `;

  return rows[0] || null;
}

export async function setProductActive(id, active, sql = getSql()) {
  if (!isValidProductId(id) || typeof active !== "boolean") {
    throw new TypeError("Invalid product status update.");
  }

  const rows = await sql`
    UPDATE products
    SET
      active = ${active},
      featured_rank = CASE
        WHEN ${active} THEN featured_rank
        ELSE NULL
      END,
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, name, stock_available, active, updated_at
  `;

  return rows[0] || null;
}

export async function deleteProduct(id, sql = getSql()) {
  if (!isValidProductId(id)) {
    throw new TypeError("Invalid product deletion request.");
  }

  await releaseExpiredInventory(sql);

  const products = await sql`
    SELECT
      product.id,
      product.name,
      product.active,
      EXISTS (
        SELECT 1
        FROM inventory_reservation_items AS item
        WHERE item.product_id = product.id
      ) AS has_history
    FROM products AS product
    WHERE product.id = ${id}
  `;
  const product = products[0];

  if (!product) return { status: "not-found" };
  if (product.active) return { status: "active", product };
  if (product.has_history) return { status: "in-use", product };

  const deleted = await sql`
    DELETE FROM products AS product
    WHERE product.id = ${id}
      AND product.active = FALSE
      AND NOT EXISTS (
        SELECT 1
        FROM inventory_reservation_items AS item
        WHERE item.product_id = product.id
      )
    RETURNING id, name
  `;

  return deleted[0]
    ? { status: "deleted", product: deleted[0] }
    : { status: "blocked", product };
}


