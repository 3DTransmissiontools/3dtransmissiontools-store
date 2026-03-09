import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { name, price } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Missing or invalid product name" });
    }

    if (typeof price !== "number" || price <= 0) {
      return res.status(400).json({ error: "Missing or invalid price" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],

      automatic_tax: {
        enabled: true
      },

      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: Math.round(price * 100),
            tax_behavior: "exclusive",
            product_data: {
              name: name,
              tax_code: "txcd_99999999"
            }
          },
          quantity: 1
        }
      ],

      shipping_address_collection: {
        allowed_countries: ["US"]
      },

      success_url: "https://3dtransmissiontools.com/success.html",
      cancel_url: "https://3dtransmissiontools.com/cancel.html"
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
