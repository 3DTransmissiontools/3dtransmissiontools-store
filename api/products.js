import { listProducts } from "../lib/inventory.js";
import { isAllowedMediaUrl } from "../lib/site-security.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const products = await listProducts();

    res.setHeader(
      "Cache-Control",
      "public, max-age=0, s-maxage=30, stale-while-revalidate=60"
    );

    return res.status(200).json(
      products.map(product => ({
        id: String(product.id),
        name: String(product.name),
        price: Number(product.unit_amount) / 100,
        quantity: Number(product.quantity),
        weight_oz: Number(product.weight_oz),
        currency: String(product.currency || "USD"),
        category: String(product.category || ""),
        description: String(product.description || ""),
        images: Array.isArray(product.images)
          ? product.images.filter(url => isAllowedMediaUrl(url, "image"))
          : [],
        ...(isAllowedMediaUrl(product.video, "video")
          ? { video: String(product.video) }
          : {}),
        ...(Array.isArray(product.videos) && product.videos.length
          ? {
              videos: product.videos.filter(video =>
                typeof video === "string"
                  ? isAllowedMediaUrl(video, "video")
                  : isAllowedMediaUrl(video?.src, "video") &&
                    (!video.poster || isAllowedMediaUrl(video.poster, "image"))
              )
            }
          : {})
      }))
    );
  } catch (error) {
    console.error("Product API error:", error);
    return res.status(500).json({ error: "Unable to load products." });
  }
}
