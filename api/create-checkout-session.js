import Stripe from "stripe";
import fs from "fs";
import path from "path";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function loadProducts() {
  const filePath = path.join(process.cwd(), "public", "products.json");
  const fileContents = fs.readFileSync(filePath, "utf8");
  return JSON.parse(fileContents);
}

function getValidQuantity(value, maxStock = 99) {
  const parsed = parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return 1;
  }

  const safeMax = Math.min(
    99,
    Number.isFinite(Number(maxStock)) && Number(maxStock) > 0
      ? Number(maxStock)
      : 99
  );

  return Math.min(parsed, safeMax);
}

function getWeightOz(product) {
  const weight = Number(product.weight_oz);
  if (!Number.isFinite(weight) || weight <= 0) {
    return 8;
  }
  return weight;
}

function getStandardShippingAmount(totalWeightOz) {
  if (totalWeightOz <= 16) return 595;
  if (totalWeightOz <= 32) return 895;
  if (totalWeightOz <= 48) return 1195;
  if (totalWeightOz <= 64) return 1495;
  return 1895;
}

function getExpeditedShippingAmount(totalWeightOz) {
  if (totalWeightOz <= 16) return 1095;
  if (totalWeightOz <= 32) return 1495;
  if (totalWeightOz <= 48) return 1895;
  if (totalWeightOz <= 64) return 2495;
  return 3295;
}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    const { items, preferredShippingMethod } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const products = loadProducts();
    const line_items = [];

    let totalWeightOz = 0;

    for (const item of items) {

      if (!item || typeof item.id !== "string") {
        return res.status(400).json({ error: "Invalid cart item" });
      }

      const product = products.find(p => p.id === item.id);

      if (!product) {
        return res.status(404).json({ error: `Product not found: ${item.id}` });
      }

      const availableStock =
        Number.isFinite(Number(product.quantity)) && Number(product.quantity) > 0
          ? Number(product.quantity)
          : 99;

      const safeQuantity = getValidQuantity(item.quantity, availableStock);
      const weightOz = getWeightOz(product);

      totalWeightOz += weightOz * safeQuantity;

      line_items.push({
        price_data: {
          currency: "usd",
          unit_amount: Math.round(product.price * 100),
          product_data: {
            name: product.name
          }
        },
        quantity: safeQuantity
      });
    }

    const standardShippingAmount = getStandardShippingAmount(totalWeightOz);
    const expeditedShippingAmount = getExpeditedShippingAmount(totalWeightOz);

    const defaultShipping =
      preferredShippingMethod === "priority"
        ? "priority"
        : "ground";

    const groundShipping = {
      shipping_rate_data: {
        type: "fixed_amount",
        fixed_amount: {
          amount: standardShippingAmount,
          currency: "usd"
        },
        display_name: "USPS Ground Advantage",
        delivery_estimate: {
          minimum: { unit: "business_day", value: 3 },
          maximum: { unit: "business_day", value: 6 }
        }
      }
    };

    const priorityShipping = {
      shipping_rate_data: {
        type: "fixed_amount",
        fixed_amount: {
          amount: expeditedShippingAmount,
          currency: "usd"
        },
        display_name: "USPS Priority Mail",
        delivery_estimate: {
          minimum: { unit: "business_day", value: 1 },
          maximum: { unit: "business_day", value: 3 }
        }
      }
    };

    const shipping_options =
      defaultShipping === "priority"
        ? [priorityShipping, groundShipping]
        : [groundShipping, priorityShipping];

    const session = await stripe.checkout.sessions.create({

      mode: "payment",

      payment_method_types: ["card"],

      automatic_tax: {
        enabled: true
      },

      billing_address_collection: "required",

      line_items,

      shipping_address_collection: {
        allowed_countries: ["US"]
      },

      shipping_options,

      success_url: "https://3dtransmissiontools.com/success.html",

      cancel_url: "https://3dtransmissiontools.com/cancel.html"

    });

    return res.status(200).json({ url: session.url });

  } catch (error) {

    console.error("Stripe checkout error:", error);

    return res.status(500).json({ error: error.message });

  }
}
