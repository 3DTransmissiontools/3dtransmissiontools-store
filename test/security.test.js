import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  createAdminSessionCookie,
  hasValidAdminSession,
  passwordMatches
} from "../lib/admin-auth.js";
import { getUniqueCartItems } from "../api/create-checkout-session.js";
import {
  listProducts,
  reserveInventory
} from "../lib/inventory.js";
import {
  getConfiguredSiteUrl,
  isAllowedMediaUrl,
  isValidProductId,
  validateSameOrigin
} from "../lib/site-security.js";

const originalEnvironment = { ...process.env };

test.afterEach(() => {
  process.env = { ...originalEnvironment };
});

test("media URLs are restricted to local files and the approved image host", () => {
  assert.equal(isAllowedMediaUrl("/videos/demo.mp4", "video"), true);
  assert.equal(
    isAllowedMediaUrl("https://i.ebayimg.com/images/example.webp", "image"),
    true
  );
  assert.equal(isAllowedMediaUrl("javascript:alert(1)", "image"), false);
  assert.equal(isAllowedMediaUrl("https://attacker.example/a.mp4", "video"), false);
  assert.equal(isAllowedMediaUrl("/../api/orders", "image"), false);
});

test("SITE_URL must be a clean HTTPS origin", () => {
  process.env.NODE_ENV = "production";
  process.env.SITE_URL = "https://3dtransmissiontools.com/";
  assert.equal(
    getConfiguredSiteUrl(),
    "https://3dtransmissiontools.com"
  );

  for (const invalidValue of [
    "http://3dtransmissiontools.com",
    "https://3dtransmissiontools.com/store",
    "https://user:password@3dtransmissiontools.com",
    "not-a-url"
  ]) {
    process.env.SITE_URL = invalidValue;
    assert.throws(() => getConfiguredSiteUrl());
  }
});

test("same-origin validation ignores forwarding and Host headers", () => {
  process.env.NODE_ENV = "production";
  process.env.SITE_URL = "https://3dtransmissiontools.com";

  assert.equal(
    validateSameOrigin({
      headers: {
        origin: "https://3dtransmissiontools.com",
        host: "attacker.example",
        "x-forwarded-host": "attacker.example"
      }
    }),
    true
  );

  assert.equal(
    validateSameOrigin({
      headers: { origin: "https://attacker.example" }
    }),
    false
  );
});

test("product IDs and cart quantities use a strict schema", () => {
  assert.equal(isValidProductId("product_21-A"), true);
  assert.equal(isValidProductId("x' onclick='alert(1)"), false);

  assert.deepEqual(
    getUniqueCartItems([
      { id: "21", quantity: 2 },
      { id: "21", quantity: 3 }
    ]),
    [{ id: "21", quantity: 5 }]
  );

  assert.equal(
    getUniqueCartItems([{ id: "21", quantity: 100 }]),
    null
  );
  assert.equal(
    getUniqueCartItems([{ id: "<script>", quantity: 1 }]),
    null
  );
});

test("admin sessions are signed, expiring, and HttpOnly", () => {
  process.env.NODE_ENV = "production";
  process.env.ADMIN_SESSION_SECRET = "s".repeat(64);
  const now = Date.UTC(2026, 7, 20, 12, 0, 0);
  const setCookie = createAdminSessionCookie(now);

  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);

  const cookie = setCookie.split(";")[0];
  const request = { headers: { cookie } };

  assert.equal(hasValidAdminSession(request, now + 60_000), true);
  assert.equal(hasValidAdminSession(request, now + 16 * 60_000), false);

  const tamperedRequest = {
    headers: { cookie: `${cookie.slice(0, -1)}x` }
  };
  assert.equal(hasValidAdminSession(tamperedRequest, now), false);
});

test("admin passwords require a nontrivial configured value", () => {
  process.env.ADMIN_PASSWORD = "a-strong-random-password";
  assert.equal(passwordMatches("a-strong-random-password"), true);
  assert.equal(passwordMatches("wrong-password-value"), false);

  process.env.ADMIN_PASSWORD = "short";
  assert.equal(passwordMatches("short"), false);
});

test("expired reservations are released before stock is read or reserved", async () => {
  const catalogQueries = [];
  const catalogSql = async strings => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    catalogQueries.push(query);
    return query.includes("FROM products") ? [{ id: "21" }] : [];
  };

  assert.deepEqual(await listProducts(catalogSql), [{ id: "21" }]);
  assert.match(catalogQueries[0], /release_expired_inventory_reservations/);
  assert.match(catalogQueries[1], /FROM products/);

  const reservationQueries = [];
  const reservationId = "00000000-0000-4000-8000-000000000021";
  const reservationSql = async strings => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    reservationQueries.push(query);

    if (query.includes("AS reservation_id")) {
      return [{ reservation_id: reservationId }];
    }

    if (query.includes("FROM inventory_reservation_items")) {
      return [{ id: "21", quantity: 1 }];
    }

    return [];
  };

  const reservation = await reserveInventory(
    [{ id: "21", quantity: 1 }],
    new Date(Date.now() + 60_000),
    reservationSql
  );

  assert.equal(reservation.reservationId, reservationId);
  assert.match(
    reservationQueries[0],
    /release_expired_inventory_reservations/
  );
  assert.match(reservationQueries[1], /reserve_inventory/);
});

test("catalog source satisfies the server-side product schema", () => {
  const products = JSON.parse(
    fs.readFileSync(new URL("../public/products.json", import.meta.url), "utf8")
  );

  assert.ok(Array.isArray(products) && products.length > 0);

  for (const product of products) {
    assert.equal(isValidProductId(String(product.id)), true);
    assert.ok(Number.isInteger(Number(product.quantity)));
    assert.ok(Number(product.quantity) >= 0);
    assert.ok(Number(product.price) > 0);
    assert.ok(Number(product.weight_oz) > 0);
  }
});

test("Vercel security header configuration parses", () => {
  const config = JSON.parse(
    fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8")
  );
  const headers = Object.fromEntries(
    config.headers[0].headers.map(header => [header.key, header.value])
  );

  assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
});

