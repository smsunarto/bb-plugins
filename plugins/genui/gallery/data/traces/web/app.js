import { renderResults } from "./search.js";

const list = document.querySelector("#results");

function onResponse(response) {
  renderResults(list, response);
}

window.addEventListener("load", () => {
  setTimeout(() => onResponse({ results: [{ title: "Lisbon", score: 0.91 }, { title: "Porto" }] }), 0);
});
