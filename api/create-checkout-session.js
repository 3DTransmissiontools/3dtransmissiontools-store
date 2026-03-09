import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
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
            tax_behavior: "exclusive",
            product_data: {
              name: "6L80 / 6L90 Solenoid Tool",
              tax_code: "txcd_99999999"
            },
            unit_amount: 4995
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

    res.status(200).json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
