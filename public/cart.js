const CART_KEY = "transmissionToolsCart"

function getCart(){
return JSON.parse(localStorage.getItem(CART_KEY) || "[]")
}

function saveCart(cart){
localStorage.setItem(CART_KEY, JSON.stringify(cart))
updateCartCount()
}

function addToCart(id, quantity){

const cart = getCart()

const existing = cart.find(item => item.id === id)

if(existing){
existing.quantity += quantity
}else{
cart.push({id, quantity})
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
item.quantity = qty
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
