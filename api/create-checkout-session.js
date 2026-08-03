import Stripe from "stripe";
import fs from "fs";
import path from "path";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);

    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY is not configured.");

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
        error: "Your cart contains too many different items."
      });
    }

    const products = loadProducts();
    const lineItems = [];
    const orderedProductIds = [];

    let totalWeightOz = 0;

    for (const item of items) {
      if (!item || typeof item.id !== "string") {
        return res.status(400).json({
          error: "Your cart contains an invalid item."
        });
      }

      const product = products.find(
        currentProduct =>
          String(currentProduct.id) === String(item.id)
      );

      if (!product) {
        return res.status(404).json({
          error: `Product not found: ${item.id}`
        });
      }

      const requestedQuantity = getRequestedQuantity(
        item.quantity
      );

      if (requestedQuantity === null) {
        return res.status(400).json({
          error: `Invalid quantity for ${product.name}.`
        });
      }

      const availableStock = getAvailableStock(product);

      if (availableStock === 0) {
        return res.status(409).json({
          error: `${product.name} is currently out of stock.`
        });
      }

      if (requestedQuantity > availableStock) {
        return res.status(409).json({
          error:
            `Only ${availableStock} of ${product.name} ` +
            `are currently available.`
        });
      }

      const price = Number(product.price);

      if (!Number.isFinite(price) || price < 0) {
        throw new Error(
          `Invalid price configured for product ${product.id}.`
        );
      }

      const weightOz = getWeightOz(product);

      totalWeightOz += weightOz * requestedQuantity;
      orderedProductIds.push(String(product.id));

      lineItems.push({
        price_data: {
          currency: "usd",
          unit_amount: Math.round(price * 100),
          product_data: {
            name: String(product.name || "Product"),
            metadata: {
              product_id: String(product.id)
            }
          }
        },
        quantity: requestedQuantity
      });
    }

    const groundShippingAmount =
      getGroundShippingAmount(totalWeightOz);

    const priorityShippingAmount =
      getPriorityShippingAmount(totalWeightOz);

    const groundShipping = {
      shipping_rate_data: {
        type: "fixed_amount",
        fixed_amount: {
          amount: groundShippingAmount,
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

    const priorityShipping = {
      shipping_rate_data: {
        type: "fixed_amount",
        fixed_amount: {
          amount: priorityShippingAmount,
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

    const priorityFirst =
      preferredShippingMethod === "priority";

    const shippingOptions = priorityFirst
      ? [priorityShipping, groundShipping]
      : [groundShipping, priorityShipping];

    const session = await stripe.checkout.sessions.create({
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
        product_ids: orderedProductIds.join(","),
        shipped: "false",
        tracking: ""
      },

      success_url:
        "https://3dtransmissiontools.com/" +
        "success.html?session_id={CHECKOUT_SESSION_ID}",

      cancel_url:
        "https://3dtransmissiontools.com/cart.html"
    });

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
