// Asks every mirror for the release status and takes the first answer.
const MIRRORS = ["http://127.0.0.1:4319/status", "http://127.0.0.1:4320/status"];

async function releaseStatus() {
  const response = await Promise.any(MIRRORS.map((url) => fetch(url)));
  return response.json();
}

console.log(await releaseStatus());
