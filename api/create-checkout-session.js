import Stripe from "stripe";
import fs from "fs";
import path from "path";

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return null;
  }

  return new Stripe(secretKey);
}

function loadProducts() {
  const filePath = path.join(
    process.cwd(),
    "public",
    "products.json"
  );

  const fileContents = fs.readFileSync(filePath, "utf8");
  const products = JSON.parse(fileContents);

  if (!Array.isArray(products)) {
    throw new Error("products.json must contain an array.");
  }

  return products;
}

function getSiteUrl(req) {
  const configuredSiteUrl =
    process.env.SITE_URL?.trim();

  if (configuredSiteUrl) {
    return configuredSiteUrl.replace(/\/+$/, "");
  }

  const forwardedProto =
    req.headers["x-forwarded-proto"];

  const protocol =
    typeof forwardedProto === "string"
      ? forwardedProto.split(",")[0].trim()
      : "https";

  const forwardedHost =
    req.headers["x-forwarded-host"];

  const host =
    typeof forwardedHost === "string"
      ? forwardedHost.split(",")[0].trim()
      : req.headers.host;

  if (host) {
    return `${protocol}://${host}`.replace(/\/+$/, "");
  }

  return "https://3dtransmissiontools.com";
}

function getAvailableStock(product) {
  const stock = Number(product.quantity);

  if (!Number.isInteger(stock) || stock < 0) {
    return 0;
  }

  return Math.min(stock, 99);
}

function getWeightOz(product) {
  const weight = Number(product.weight_oz);

  if (!Number.isFinite(weight) || weight <= 0) {
    return 8;
  }

  return weight;
}

function getGroundShippingAmount(totalWeightOz) {
  if (totalWeightOz <= 16) return 595;
  if (totalWeightOz <= 32) return 895;
  if (totalWeightOz <= 48) return 1195;
  if (totalWeightOz <= 64) return 1495;

  return 1895;
}

function getPriorityShippingAmount(totalWeightOz) {
  if (totalWeightOz <= 16) return 1095;
  if (totalWeightOz <= 32) return 1495;
  if (totalWeightOz <= 48) return 1895;
  if (totalWeightOz <= 64) return 2495;

  return 3295;
}

function getRequestedQuantity(value) {
  const quantity = Number(value);

  if (!Number.isInteger(quantity) || quantity < 1) {
    return null;
  }

  return quantity;
}

function getUniqueCartItems(items) {
  const combinedItems = new Map();

  for (const item of items) {
    if (!item || typeof item.id !== "string") {
      return null;
    }

    const id = item.id.trim();
    const quantity = getRequestedQuantity(item.quantity);

    if (!id || quantity === null) {
      return null;
    }

    const existingQuantity =
      combinedItems.get(id) || 0;

    const combinedQuantity =
      existingQuantity + quantity;

    if (
      !Number.isSafeInteger(combinedQuantity) ||
      combinedQuantity > 99
    ) {
      return null;
    }

    combinedItems.set(id, combinedQuantity);
  }

  return Array.from(
    combinedItems,
    ([id, quantity]) => ({
      id,
      quantity
    })
  );
}

function createGroundShippingOption(amount) {
  return {
    shipping_rate_data: {
      type: "fixed_amount",

      fixed_amount: {
        amount,
        currency: "usd"
      },

      display_name: "USPS Ground Advantage",

      delivery_estimate: {
        minimum: {
          unit: "business_day",
          value: 3
        },

        maximum: {
          unit: "business_day",
          value: 6
        }
      }
    }
  };
}

function createPriorityShippingOption(amount) {
  return {
    shipping_rate_data: {
      type: "fixed_amount",

      fixed_amount: {
        amount,
        currency: "usd"
      },

      display_name: "USPS Priority Mail",

      delivery_estimate: {
        minimum: {
          unit: "business_day",
          value: 1
        },

        maximum: {
          unit: "business_day",
          value: 3
        }
      }
    }
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);

    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  const stripe = getStripe();

  if (!stripe) {
    console.error(
      "STRIPE_SECRET_KEY is not configured."
    );

    return res.status(500).json({
      error: "Checkout is temporarily unavailable."
    });
  }

  try {
    const {
      items,
      preferredShippingMethod
    } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "Your cart is empty."
      });
    }

    if (items.length > 50) {
      return res.status(400).json({
        error:
          "Your cart contains too many different items."
      });
    }

    const cartItems = getUniqueCartItems(items);

    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({
        error: "Your cart contains an invalid item."
      });
    }

    const products = loadProducts();
    const lineItems = [];

    let totalWeightOz = 0;

    for (const item of cartItems) {
      const product = products.find(
        currentProduct =>
          String(currentProduct.id) === item.id
      );

      if (!product) {
        return res.status(404).json({
          error: `Product not found: ${item.id}`
        });
      }

      const productName =
        String(product.name || "Product").trim();

      const availableStock =
        getAvailableStock(product);

      if (availableStock === 0) {
        return res.status(409).json({
          error:
            `${productName} is currently out of stock.`
        });
      }

      if (item.quantity > availableStock) {
        return res.status(409).json({
          error:
            `Only ${availableStock} of ${productName} ` +
            "are currently available."
        });
      }

      const price = Number(product.price);

      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {
        console.error(
          "Invalid product price:",
          product.id,
          product.price
        );

        return res.status(500).json({
          error:
            "One of the products is not configured correctly."
        });
      }

      const unitAmount = Math.round(price * 100);

      if (
        !Number.isSafeInteger(unitAmount) ||
        unitAmount < 1
      ) {
        return res.status(500).json({
          error:
            "One of the products is not configured correctly."
        });
      }

      const weightOz = getWeightOz(product);

      totalWeightOz += weightOz * item.quantity;

      lineItems.push({
        price_data: {
          currency: "usd",

          unit_amount: unitAmount,

          product_data: {
            name: productName,

            metadata: {
              product_id: String(product.id)
            }
          }
        },

        quantity: item.quantity
      });
    }

    if (
      !Number.isFinite(totalWeightOz) ||
      totalWeightOz <= 0
    ) {
      return res.status(500).json({
        error:
          "Unable to calculate the package weight."
      });
    }

    const groundAmount =
      getGroundShippingAmount(totalWeightOz);

    const priorityAmount =
      getPriorityShippingAmount(totalWeightOz);

    const groundShipping =
      createGroundShippingOption(groundAmount);

    const priorityShipping =
      createPriorityShippingOption(priorityAmount);

    const shippingOptions =
      preferredShippingMethod === "priority"
        ? [priorityShipping, groundShipping]
        : [groundShipping, priorityShipping];

    const siteUrl = getSiteUrl(req);

    const session =
      await stripe.checkout.sessions.create({
        mode: "payment",

        payment_method_types: ["card"],

        automatic_tax: {
          enabled: true
        },

        billing_address_collection: "required",

        customer_creation: "always",

        line_items: lineItems,

        shipping_address_collection: {
          allowed_countries: ["US"]
        },

        shipping_options: shippingOptions,

        metadata: {
          shipped: "false",
          tracking: "",
          package_weight_oz:
            String(totalWeightOz)
        },

        success_url:
          `${siteUrl}/success.html` +
          "?session_id={CHECKOUT_SESSION_ID}",

        cancel_url:
          `${siteUrl}/cart.html`
      });

    if (!session.url) {
      throw new Error(
        "Stripe did not return a Checkout URL."
      );
    }

    return res.status(200).json({
      url: session.url
    });
  } catch (error) {
    console.error("Stripe checkout error:", error);

    return res.status(500).json({
      error: "Unable to start checkout right now."
    });
  }
}
