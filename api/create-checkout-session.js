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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { id, quantity } = req.body;

    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Missing or invalid product id" });
    }

    const products = loadProducts();
    const product = products.find((p) => p.id === id);

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    if (typeof product.price !== "number" || product.price <= 0) {
      return res.status(400).json({ error: "Invalid product price" });
    }

    const availableStock =
      Number.isFinite(Number(product.quantity)) && Number(product.quantity) > 0
        ? Number(product.quantity)
        : 99;

    const safeQuantity = getValidQuantity(quantity, availableStock);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],

      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: Math.round(product.price * 100),
            product_data: {
              name: product.name
            }
          },
          quantity: safeQuantity
        }
      ],

      shipping_address_collection: {
        allowed_countries: ["US"]
      },

      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: {
              amount: 695,
              currency: "usd"
            },
            display_name: "Standard Shipping",
            delivery_estimate: {
              minimum: {
                unit: "business_day",
                value: 5
              },
              maximum: {
                unit: "business_day",
                value: 7
              }
            }
          }
        },
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: {
              amount: 1895,
              currency: "usd"
            },
            display_name: "Expedited Shipping",
            delivery_estimate: {
              minimum: {
                unit: "business_day",
                value: 2
              },
              maximum: {
                unit: "business_day",
                value: 3
              }
            }
          }
        }
      ],

      success_url: "https://3dtransmissiontools.com/success.html",
      cancel_url: "https://3dtransmissiontools.com/cancel.html"
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error("Stripe checkout error:", error);
    return res.status(500).json({ error: error.message });
  }
}
