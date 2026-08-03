const CART_KEY = "transmissionToolsCart"

function getCart() {
  try {
    const storedCart =
      localStorage.getItem(CART_KEY)

    if (!storedCart) {
      return []
    }

    const parsedCart = JSON.parse(storedCart)

    if (!Array.isArray(parsedCart)) {
      throw new Error("Invalid cart format")
    }

    return parsedCart.filter(item =>
      item &&
      typeof item.id === "string" &&
      Number.isInteger(Number(item.quantity)) &&
      Number(item.quantity) >= 1
    )
  } catch (error) {
    console.error("Cart data was invalid:", error)
    localStorage.removeItem(CART_KEY)

    return []
  }
}

function saveCart(cart) {
  localStorage.setItem(
    CART_KEY,
    JSON.stringify(cart)
  )

  updateCartCount()
}

async function addToCart(id, quantity) {
  try {
    const response =
      await fetch("/products.json")

    if (!response.ok) {
      throw new Error("Unable to load products")
    }

    const products = await response.json()

    const product = products.find(
      currentProduct =>
        String(currentProduct.id) === String(id)
    )

    if (!product) {
      alert("Product not found.")
      return
    }

    const maxStock = Number(product.quantity)

    if (
      !Number.isInteger(maxStock) ||
      maxStock <= 0
    ) {
      alert("This product is out of stock.")
      return
    }

    const requestedQuantity =
      Number(quantity)

    const safeQuantity =
      Number.isInteger(requestedQuantity) &&
      requestedQuantity > 0
        ? requestedQuantity
        : 1

    const cart = getCart()

    const existing = cart.find(
      item => String(item.id) === String(id)
    )

    if (existing) {
      existing.quantity = Math.min(
        Number(existing.quantity) +
          safeQuantity,
        maxStock,
        99
      )
    } else {
      cart.push({
        id: String(id),
        quantity: Math.min(
          safeQuantity,
          maxStock,
          99
        )
      })
    }

    saveCart(cart)
    alert("Added to cart.")
  } catch (error) {
    console.error("Unable to add product:", error)

    alert(
      "Unable to add this product right now."
    )
  }
}

function removeFromCart(id) {
  const cart = getCart().filter(
    item => String(item.id) !== String(id)
  )

  saveCart(cart)
}

function updateQuantity(id, quantity) {
  const cart = getCart()

  const item = cart.find(
    currentItem =>
      String(currentItem.id) === String(id)
  )

  if (!item) {
    return
  }

  const parsedQuantity = Number(quantity)

  item.quantity =
    Number.isInteger(parsedQuantity) &&
    parsedQuantity >= 1
      ? Math.min(parsedQuantity, 99)
      : 1

  saveCart(cart)
}

function clearCart() {
  localStorage.removeItem(CART_KEY)
  updateCartCount()
}

function updateCartCount() {
  const cart = getCart()

  const count = cart.reduce(
    (total, item) =>
      total + Number(item.quantity || 0),
    0
  )

  const element =
    document.getElementById("cart-count")

  if (element) {
    element.textContent = count
  }
}

updateCartCount()
