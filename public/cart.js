const CART_KEY = "transmissionToolsCart"

function getCart(){
return JSON.parse(localStorage.getItem(CART_KEY) || "[]")
}

function saveCart(cart){
localStorage.setItem(CART_KEY, JSON.stringify(cart))
updateCartCount()
}

async function addToCart(id, quantity){
const res = await fetch("/products.json")
const products = await res.json()
const product = products.find(p => p.id === id)

if(!product){
alert("Product not found")
return
}

const maxStock = Number(product.quantity ?? 99)
const safeQty = Math.max(1, Number(quantity) || 1)

const cart = getCart()
const existing = cart.find(item => item.id === id)

if(existing){
existing.quantity = Math.min(existing.quantity + safeQty, maxStock)
}else{
cart.push({id, quantity: Math.min(safeQty, maxStock)})
}

saveCart(cart)
alert("Added to cart")
}

function removeFromCart(id){
let cart = getCart()
cart = cart.filter(item => item.id !== id)
saveCart(cart)
renderCart()
}

function updateQuantity(id, qty){
const cart = getCart()
const item = cart.find(i => i.id === id)

if(item){
item.quantity = Math.max(1, Number(qty) || 1)
}

saveCart(cart)
renderCart()
}

function clearCart(){
localStorage.removeItem(CART_KEY)
updateCartCount()
}

function updateCartCount(){
const cart = getCart()
const count = cart.reduce((t,i)=>t+i.quantity,0)
const el = document.getElementById("cart-count")

if(el){
el.textContent = count
}
}

updateCartCount()
