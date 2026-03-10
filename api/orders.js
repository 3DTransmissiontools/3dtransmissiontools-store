import fs from "fs";
import path from "path";

const ordersFile = path.join(process.cwd(), "api", "orders-data.json");

export default function handler(req, res) {

if (!fs.existsSync(ordersFile)) {

return res.json([]);

}

let orders = JSON.parse(fs.readFileSync(ordersFile));

if (req.method === "GET") {

return res.json(orders);

}

if (req.method === "POST") {

const { id, shipped, tracking } = req.body;

orders = orders.map(order => {

if (order.id === id) {

return {
...order,
shipped,
tracking
};

}

return order;

});

fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));

return res.json({ success: true });

}

}
