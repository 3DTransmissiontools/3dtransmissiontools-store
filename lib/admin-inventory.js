import { getSql } from "./database.js";
import { releaseExpiredInventory } from "./inventory.js";
import { isValidProductId } from "./site-security.js";

const MAX_RESTOCK_QUANTITY = 1000;

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
      stock_available,
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

