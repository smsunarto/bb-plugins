import { RATES, lineTotal } from "./pricing.mjs";

const cart = {
  id: "c_42",
  items: [
    { sku: "mug", qty: 2, price: 12, currency: "EUR" },
    { sku: "poster", qty: 1, price: 30, currency: "CHF" },
  ],
};

function priceCart(cart) {
  try {
    return cart.items.map((item) => lineTotal(item, RATES)).reduce((sum, total) => sum + total, 0);
  } catch (error) {
    throw new Error(`Couldn't price cart ${cart.id}`, { cause: error });
  }
}

console.log(priceCart(cart));
