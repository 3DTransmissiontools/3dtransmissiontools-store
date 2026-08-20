import { getSql } from "./database.js";
import { releaseExpiredInventory } from "./inventory.js";
import {
  isAllowedMediaUrl,
  isValidProductId
} from "./site-security.js";

const MAX_RESTOCK_QUANTITY = 1000;
const MAX_IMAGES = 10;

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

export async function listAdminInventory(sql = getSql()) {
  await releaseExpiredInventory(sql);

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
      updated_at
    FROM products
    ORDER BY active DESC, sort_order, id
  `;
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
    SET active = ${active}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, name, stock_available, active, updated_at
  `;

  return rows[0] || null;
}

