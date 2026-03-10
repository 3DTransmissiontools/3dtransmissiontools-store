import Stripe from "stripe";
import fs from "fs";
import path from "path";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {

if (req.method !== "POST") {
return res.status(405).send("Method not allowed");
}

const sig = req.headers["stripe-signature"];

let event;

try {

event = stripe.webhooks.constructEvent(
req.body,
sig,
process.env.STRIPE_WEBHOOK_SECRET
);

} catch (err) {

console.error("Webhook signature verification failed.", err.message);
return res.status(400).send(`Webhook Error: ${err.message}`);

}

if (event.type === "checkout.session.completed") {

const session = event.data.object;

const order = {
id: session.id,
date: new Date().toISOString(),
customer_email: session.customer_details?.email || "",
amount_total: session.amount_total / 100,
tax: session.total_details?.amount_tax
? session.total_details.amount_tax / 100
: 0,
shipping_method: session.shipping_cost?.shipping_rate || "unknown",
shipping_address: session.customer_details?.address || {},
payment_status: session.payment_status,
shipped: false,
tracking: ""
};

const ordersFile = path.join(process.cwd(), "api", "orders-data.json");

let orders = [];

if (fs.existsSync(ordersFile)) {

orders = JSON.parse(fs.readFileSync(ordersFile));

}

orders.unshift(order);

fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));

}

res.json({ received: true });

}
