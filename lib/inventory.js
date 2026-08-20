import { getSql } from "./database.js";

export class InventoryError extends Error {
  constructor(message, code = "INVENTORY_ERROR") {
    super(message);
    this.name = "InventoryError";
    this.code = code;
  }
}

function mapInventoryError(error) {
  const message = String(error?.message || "");

  if (message.includes("PRODUCT_NOT_FOUND:")) {
    return new InventoryError(
      "One of the products is no longer available.",
      "PRODUCT_NOT_FOUND"
    );
  }

  if (message.includes("OUT_OF_STOCK:")) {
    return new InventoryError(
      "One of the products does not have enough stock.",
      "OUT_OF_STOCK"
    );
  }

  if (message.includes("INVALID_CART")) {
    return new InventoryError(
      "Your cart contains an invalid item.",
      "INVALID_CART"
    );
  }

  return error;
}

export async function reserveInventory(items, expiresAt, sql = getSql()) {

  try {
    await releaseExpiredInventory(sql);

    const rows = await sql`
      SELECT reserve_inventory(
        ${JSON.stringify(items)}::jsonb,
        ${expiresAt.toISOString()}::timestamptz
      ) AS reservation_id
    `;

    const reservationId = rows[0]?.reservation_id;

    if (!reservationId) {
      throw new Error("Inventory reservation did not return an ID.");
    }

    const reservedItems = await sql`
      SELECT
        product_id AS id,
        product_name AS name,
        unit_amount,
        weight_oz,
        quantity
      FROM inventory_reservation_items
      WHERE reservation_id = ${reservationId}::uuid
      ORDER BY product_id
    `;

    return {
      reservationId,
      items: reservedItems
    };
  } catch (error) {
    throw mapInventoryError(error);
  }
}

export async function attachCheckoutSession(
  reservationId,
  sessionId,
  expiresAt
) {
  const sql = getSql();

  await sql`
    UPDATE inventory_reservations
    SET
      stripe_session_id = ${sessionId},
      expires_at = ${expiresAt.toISOString()}::timestamptz,
      updated_at = NOW()
    WHERE id = ${reservationId}::uuid
      AND status = 'pending'
  `;
}

export async function releaseInventory(reservationId) {
  const sql = getSql();
  await sql`SELECT release_inventory_reservation(${reservationId}::uuid)`;
}

export async function completeInventoryReservation(
  reservationId,
  sessionId,
  eventId,
  eventType
) {
  const sql = getSql();

  await sql`
    SELECT complete_inventory_reservation(
      ${reservationId}::uuid,
      ${sessionId},
      ${eventId},
      ${eventType}
    )
  `;
}

export async function releaseExpiredInventory(sql = getSql()) {
  await sql`SELECT release_expired_inventory_reservations()`;
}

export async function listProducts(sql = getSql()) {
  await releaseExpiredInventory(sql);

  return sql`
    SELECT
      id,
      name,
      unit_amount,
      stock_available AS quantity,
      weight_oz,
      currency,
      category,
      description,
      images,
      video,
      videos
    FROM products
    WHERE active = TRUE
    ORDER BY sort_order, id
  `;
}

