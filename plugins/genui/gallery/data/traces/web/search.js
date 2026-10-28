// Renders the search results list.
export function renderResults(list, response) {
  list.replaceChildren(
    ...response.results.map((result) => {
      const item = document.createElement("li");
      item.textContent = `${result.title} (${result.score.toFixed(2)})`;
      return item;
    }),
  );
}
