/** Read-only browser audit. Run with a prepared isolated BB browser session.
 * bun scripts/audit-settings-surfaces.ts SESSION APP_URL REPORT.json [--check]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [session, appUrl, reportPath, mode] = process.argv.slice(2);
if (!session || !appUrl || !reportPath)
  throw new Error("Expected SESSION APP_URL REPORT.json [--check]");
function browser(...args: string[]) {
  const result = JSON.parse(
    execFileSync("agent-browser", ["--session", session!, "--json", ...args], {
      encoding: "utf8",
      timeout: 35_000,
    }),
  );
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return result.data;
}
const routes = browser(
  "eval",
  `Array.from(document.querySelectorAll('a[href^="/settings"]')).filter(a=>!a.closest('main main')).map(a => ({name:a.textContent.trim(), path:a.getAttribute('href')}))`,
).result as { name: string; path: string }[];
if (!routes.length) throw new Error("Open Settings in the prepared browser before auditing");
const reports = [];
for (const { name, path } of routes) {
  if (new URL(appUrl).origin !== new URL(browser("get", "url").url).origin)
    throw new Error("Browser left the specified app");
  browser("click", `a[href="${path}"]`);
  browser(
    "wait",
    "--fn",
    `location.pathname === ${JSON.stringify(path)} && !!document.querySelector('main main') && document.querySelector('main main').innerText.trim().length > 0`,
  );
  const result = browser(
    "eval",
    `(() => {
    const main = document.querySelector('main main');
    return {path: location.pathname, cards: Array.from(main.querySelectorAll('div,section,article,li')).filter(e => {
      const c = e.classList;
      return (c.contains('bg-card') || (c.contains('border') && c.contains('border-border'))) && !c.contains('bg-transparent') && Array.from(c).some(x=>x.startsWith('rounded'));
    }).map(e => ({ classes:e.className, background:getComputedStyle(e).backgroundColor, border:getComputedStyle(e).borderTopWidth }))};
  })()`,
  ).result;
  const missingMarketplaceEntries = path === "/settings/marketplaces" && result.cards.length === 0;
  reports.push({ name, ...result, missingMarketplaceEntries });
  writeFileSync(reportPath, JSON.stringify(reports, null, 2) + "\n");
  console.log(
    result.cards.length === 0
      ? `${name}: UNVERIFIED (no containers rendered)`
      : `${name}: ${result.cards.length} containers; ${result.cards.filter((c: { background: string; border: string }) => c.background !== "rgba(227, 227, 221, 0.04)" || c.border !== "0px").length} mismatches`,
  );
}
writeFileSync(reportPath, JSON.stringify(reports, null, 2) + "\n");
if (
  mode === "--check" &&
  reports.some(
    (r) =>
      r.missingMarketplaceEntries ||
      r.cards.some(
        (c: { background: string; border: string }) =>
          c.background !== "rgba(227, 227, 221, 0.04)" || c.border !== "0px",
      ),
  )
)
  process.exitCode = 1;
