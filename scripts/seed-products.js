import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { getSql } from "../lib/database.js";
import {
  isAllowedMediaUrl,
  isValidProductId
} from "../lib/site-security.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const productPath = path.join(scriptDirectory, "..", "public", "products.json");
const products = JSON.parse(await fs.readFile(productPath, "utf8"));
const sql = getSql();

if (!Array.isArray(products)) {
  throw new Error("products.json must contain an array.");
}

for (const [index, product] of products.entries()) {
  const id = String(product.id || "").trim();
  const unitAmount = Math.round(Number(product.price) * 100);
  const stock = Number(product.quantity);
  const weightOz = Number(product.weight_oz);

  if (
    !isValidProductId(id) ||
    !Number.isSafeInteger(unitAmount) ||
    unitAmount < 1 ||
    !Number.isInteger(stock) ||
    stock < 0 ||
    !Number.isFinite(weightOz) ||
    weightOz <= 0
  ) {
    throw new Error(`Invalid product configuration for ${id || index}.`);
  }

  const images = Array.isArray(product.images) ? product.images : [];
  const videos = Array.isArray(product.videos) ? product.videos : [];

  if (
    images.some(url => !isAllowedMediaUrl(url, "image")) ||
    (product.video && !isAllowedMediaUrl(product.video, "video")) ||
    videos.some(video =>
      typeof video === "string"
        ? !isAllowedMediaUrl(video, "video")
        : !isAllowedMediaUrl(video?.src, "video") ||
          (video.poster && !isAllowedMediaUrl(video.poster, "image"))
    )
  ) {
    throw new Error(`Product ${id} contains an unapproved media URL.`);
  }

  await sql`
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
      video,
      videos,
      sort_order
    ) VALUES (
      ${id},
      ${String(product.name || "Product").trim()},
      ${unitAmount},
      ${stock},
      ${weightOz},
      ${String(product.currency || "USD").toUpperCase()},
      ${String(product.category || "")},
      ${String(product.description || "")},
      ${JSON.stringify(images)}::jsonb,
      ${typeof product.video === "string" ? product.video : null},
      ${JSON.stringify(videos)}::jsonb,
      ${index}
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      unit_amount = EXCLUDED.unit_amount,
      weight_oz = EXCLUDED.weight_oz,
      currency = EXCLUDED.currency,
      category = EXCLUDED.category,
      description = EXCLUDED.description,
      images = EXCLUDED.images,
      video = EXCLUDED.video,
      videos = EXCLUDED.videos,
      sort_order = EXCLUDED.sort_order,
      active = TRUE,
      updated_at = NOW()
  `;
}

console.log(
  `Seeded metadata for ${products.length} products. ` +
  "Products created in the admin dashboard were preserved."
);

