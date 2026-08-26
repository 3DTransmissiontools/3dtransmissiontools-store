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
  addRestock,
  createProduct,
  parseFeaturedProductsRequest,
  parseProductRequest,
  parseRestockRequest,
  setFeaturedProducts,
  setProductActive,
  updateProduct
} from "../lib/admin-inventory.js";
import {
  createContactMessage,
  deleteContactMessage,
  isValidContactMessageId,
  listContactMessages,
  markContactMessageRead,
  parseContactMessage
} from "../lib/contact-messages.js";
import {
  buildContactAlert,
  sendContactAlert
} from "../lib/contact-alerts.js";
import {
  getAllowedSiteOrigins,
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

test("same-origin validation accepts trusted Vercel preview URLs", () => {
  process.env.NODE_ENV = "production";
  process.env.SITE_URL = "https://preview.example.com";
  process.env.VERCEL_ENV = "preview";
  process.env.VERCEL_URL = "store-random.vercel.app";
  process.env.VERCEL_BRANCH_URL = "store-git-feature-team.vercel.app";

  assert.deepEqual(
    [...getAllowedSiteOrigins()].sort(),
    [
      "https://preview.example.com",
      "https://store-git-feature-team.vercel.app",
      "https://store-random.vercel.app"
    ]
  );

  assert.equal(
    validateSameOrigin({
      headers: { origin: "https://store-random.vercel.app" }
    }),
    true
  );

  assert.equal(
    validateSameOrigin({
      headers: { origin: "https://store-git-feature-team.vercel.app" }
    }),
    true
  );

  process.env.VERCEL_ENV = "production";
  assert.equal(
    validateSameOrigin({
      headers: { origin: "https://store-random.vercel.app" }
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

test("admin restocks only accept safe positive quantities", async () => {
  assert.deepEqual(
    parseRestockRequest({ id: "21", quantity: 12 }),
    { id: "21", quantity: 12 }
  );

  for (const body of [
    { id: "<script>", quantity: 1 },
    { id: "21", quantity: 0 },
    { id: "21", quantity: -1 },
    { id: "21", quantity: 1.5 },
    { id: "21", quantity: 1001 },
    { id: "21", quantity: "not-a-number" }
  ]) {
    assert.equal(typeof parseRestockRequest(body).error, "string");
  }

  const queries = [];
  const sql = async (strings, ...values) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ query, values });

    if (query.startsWith("UPDATE products")) {
      return [{ id: "21", name: "Test Tool", stock_available: 17 }];
    }

    return [];
  };

  const product = await addRestock("21", 12, sql);

  assert.equal(product.stock_available, 17);
  assert.match(queries[0].query, /release_expired_inventory_reservations/);
  assert.match(queries[1].query, /stock_available = stock_available \+ \?/);
  assert.deepEqual(queries[1].values, [12, "21"]);
});

test("featured products require 1 to 4 unique valid product IDs", async () => {
  assert.deepEqual(
    parseFeaturedProductsRequest({ ids: ["21", "17", "9", "4"] }),
    { ids: ["21", "17", "9", "4"] }
  );

  for (const body of [
    { ids: [] },
    { ids: ["1", "2", "3", "4", "5"] },
    { ids: ["21", "21"] },
    { ids: ["<script>"] },
    { ids: "21" }
  ]) {
    assert.equal(
      typeof parseFeaturedProductsRequest(body).error,
      "string"
    );
  }

  const queries = [];
  const sql = async (strings, ...values) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ query, values });

    if (query.startsWith("SELECT id FROM products")) {
      return ["21", "17", "9"].map(id => ({ id }));
    }

    return [];
  };

  const ids = await setFeaturedProducts(
    { ids: ["21", "17", "9"] },
    sql
  );

  assert.deepEqual(ids, ["21", "17", "9"]);
  assert.match(queries[0].query, /^ALTER TABLE products/);
  assert.match(queries[1].query, /^UPDATE products SET featured_rank/);
  assert.match(queries[2].query, /^SELECT id FROM products/);
  assert.match(queries[3].query, /^WITH requested AS/);
  assert.ok(queries[3].values.includes('["21","17","9"]'));
});

test("admin product changes enforce the catalog schema", async () => {
  const validProduct = {
    id: "new-tool-24",
    name: "New Transmission Tool",
    price: 49.95,
    stock: 7,
    weight_oz: 12.5,
    category: "10L",
    description: "A useful service tool.",
    images: ["https://i.ebayimg.com/images/example.webp"],
    video: ""
  };

  assert.deepEqual(parseProductRequest(validProduct), {
    id: "new-tool-24",
    name: "New Transmission Tool",
    unitAmount: 4995,
    stock: 7,
    weightOz: 12.5,
    category: "10L",
    description: "A useful service tool.",
    images: ["https://i.ebayimg.com/images/example.webp"],
    video: null
  });

  for (const product of [
    { ...validProduct, id: "<script>" },
    { ...validProduct, price: 0 },
    { ...validProduct, price: 1.001 },
    { ...validProduct, stock: -1 },
    { ...validProduct, weight_oz: 0 },
    { ...validProduct, images: [] },
    { ...validProduct, images: ["https://attacker.example/image.jpg"] },
    { ...validProduct, video: "https://attacker.example/video.mp4" }
  ]) {
    assert.equal(typeof parseProductRequest(product).error, "string");
  }

  const queries = [];
  const sql = async (strings, ...values) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ query, values });
    return [{ id: "new-tool-24", name: "New Transmission Tool" }];
  };

  await createProduct(validProduct, sql);
  await updateProduct(validProduct, sql);
  await setProductActive("new-tool-24", false, sql);

  assert.match(queries[0].query, /^INSERT INTO products/);
  assert.ok(queries[0].values.includes(4995));
  assert.ok(queries[0].values.includes(7));
  assert.match(queries[1].query, /^UPDATE products SET name/);
  assert.doesNotMatch(
    queries[1].query,
    /stock_available\s*=/
  );
  assert.match(queries[2].query, /SET active = \?/);
  assert.deepEqual(queries[2].values, [false, false, "new-tool-24"]);
});

test("contact messages are validated and stored without client HTML", async () => {
  const validMessage = {
    name: "Jane Customer",
    email: "JANE@example.com",
    subject: "Product question",
    order_reference: "ORDER-123",
    message: "Will this tool work with my transmission?",
    website: ""
  };

  assert.deepEqual(parseContactMessage(validMessage), {
    name: "Jane Customer",
    email: "jane@example.com",
    subject: "Product question",
    orderReference: "ORDER-123",
    message: "Will this tool work with my transmission?"
  });

  for (const message of [
    { ...validMessage, name: "" },
    { ...validMessage, email: "not-an-email" },
    { ...validMessage, subject: "" },
    { ...validMessage, message: "short" }
  ]) {
    assert.equal(typeof parseContactMessage(message).error, "string");
  }

  assert.deepEqual(
    parseContactMessage({ ...validMessage, website: "spam.example" }),
    { spam: true }
  );

  const messageId = "00000000-0000-4000-8000-000000000123";
  assert.equal(isValidContactMessageId(messageId), true);
  assert.equal(isValidContactMessageId("<script>"), false);

  const queries = [];
  const sql = async (strings, ...values) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ query, values });

    if (query.startsWith("INSERT INTO contact_messages")) {
      return [{ id: messageId }];
    }

    if (query.startsWith("SELECT id,")) {
      return [{ id: messageId, status: "new" }];
    }

    if (query.startsWith("UPDATE contact_messages")) {
      return [{ id: messageId, status: "read" }];
    }

    if (query.startsWith("DELETE FROM contact_messages")) {
      return [{ id: messageId }];
    }

    return [];
  };

  assert.deepEqual(await createContactMessage(validMessage, sql), {
    id: messageId
  });
  assert.deepEqual(await listContactMessages(sql), [
    { id: messageId, status: "new" }
  ]);
  assert.deepEqual(await markContactMessageRead(messageId, sql), {
    id: messageId,
    status: "read"
  });
  assert.deepEqual(await deleteContactMessage(messageId, sql), {
    id: messageId
  });
  assert.equal(await deleteContactMessage("invalid", sql), null);

  assert.match(
    queries.find(entry => entry.query.startsWith("INSERT INTO contact_messages"))
      .query,
    /RETURNING id, created_at/
  );
  assert.ok(queries.some(entry => entry.query.startsWith("CREATE TABLE")));
});

test("contact email alerts are private, escaped, and safely configurable", async () => {
  const message = {
    id: "00000000-0000-4000-8000-000000000123",
    name: "Jane <Customer>",
    email: "jane@example.com",
    subject: "New tool suggestion",
    orderReference: "",
    message: "Please build a <strong>new tool</strong>."
  };

  const alert = buildContactAlert(message);
  assert.match(alert.subject, /New tool suggestion/);
  assert.match(alert.html, /Jane &lt;Customer&gt;/);
  assert.match(alert.html, /&lt;strong&gt;new tool&lt;\/strong&gt;/);
  assert.doesNotMatch(alert.html, /<strong>new tool<\/strong>/);

  assert.deepEqual(
    await sendContactAlert(message, { env: {}, fetchImpl: null }),
    { sent: false, reason: "not-configured" }
  );

  let request;
  const result = await sendContactAlert(message, {
    env: {
      RESEND_API_KEY: "re_test_key",
      CONTACT_ALERT_EMAIL: "owner@example.com",
      CONTACT_FROM_EMAIL: "3D Transmission Tools <alerts@example.com>"
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, text: async () => "" };
    }
  });

  assert.deepEqual(result, { sent: true });
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(
    request.options.headers["Idempotency-Key"],
    `contact-message-${message.id}`
  );

  const payload = JSON.parse(request.options.body);
  assert.deepEqual(payload.to, ["owner@example.com"]);
  assert.equal(payload.reply_to, "jane@example.com");
  assert.doesNotMatch(payload.html, /<strong>new tool<\/strong>/);
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

test("homepage uses database-backed featured ranking with a safe fallback", () => {
  const homepage = fs.readFileSync(
    new URL("../public/index.html", import.meta.url),
    "utf8"
  );
  const migration = fs.readFileSync(
    new URL("../db/002_featured_products.sql", import.meta.url),
    "utf8"
  );

  assert.match(homepage, /product\.featured_rank/);
  assert.match(homepage, /rankedProducts\.length/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS featured_rank INTEGER/);
  assert.match(migration, /products_featured_rank_check/);
});

test("all customer pages link safely to the eBay store with a local logo", () => {
  const customerPages = [
    "index.html",
    "shop.html",
    "cart.html",
    "success.html",
    "cancel.html",
    "contact.html"
  ];
  const logo = fs.readFileSync(
    new URL("../public/ebay-logo.png", import.meta.url)
  );

  for (const page of customerPages) {
    const html = fs.readFileSync(
      new URL(`../public/${page}`, import.meta.url),
      "utf8"
    );

    assert.match(html, /https:\/\/www\.ebay\.com\/usr\/3dtransmissiontools/);
    assert.match(html, /class="ebay-store-link"/);
    assert.match(html, /src="\/ebay-logo\.png"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);

    if (page === "success.html") {
      assert.equal(
        (html.match(/class="ebay-store-link"/g) || []).length,
        2
      );
    }
  }

  assert.equal(logo.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("all customer pages provide a Contact link", () => {
  const customerPages = [
    "index.html",
    "shop.html",
    "cart.html",
    "success.html",
    "cancel.html",
    "contact.html"
  ];

  for (const page of customerPages) {
    const html = fs.readFileSync(
      new URL(`../public/${page}`, import.meta.url),
      "utf8"
    );

    assert.match(html, /href="\/contact\.html"/);
  }

  const contactPage = fs.readFileSync(
    new URL("../public/contact.html", import.meta.url),
    "utf8"
  );
  const adminPage = fs.readFileSync(
    new URL("../public/admin-orders.html", import.meta.url),
    "utf8"
  );
  const migration = fs.readFileSync(
    new URL("../db/003_contact_messages.sql", import.meta.url),
    "utf8"
  );

  assert.match(contactPage, /fetch\("\/api\/contact"/);
  assert.match(contactPage, /contact-website/);
  assert.match(contactPage, /value="New tool suggestion">New tool suggestion/);
  assert.match(adminPage, /id="messages-tab"/);
  assert.match(adminPage, /loadContactMessages/);
  assert.match(adminPage, /action: "delete"/);
  assert.match(adminPage, /window\.confirm/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS contact_messages/);
});

test("eBay navigation label remains readable on the white button", () => {
  const styles = fs.readFileSync(
    new URL("../public/styles.css", import.meta.url),
    "utf8"
  );

  assert.match(
    styles,
    /\.nav-inner a\.ebay-store-link\s*\{[^}]*color:\s*#111;/s
  );
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

