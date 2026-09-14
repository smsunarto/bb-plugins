/** Check theme-wide composition against the shipped CSS in an isolated BB app.
 * bun plugins/monokai/scripts/audit-theme-surfaces.ts SESSION APP_URL REPORT.json
 * This temporary fixture verifies host selector contracts, not host data flows.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [session, appUrl, reportPath] = process.argv.slice(2);
if (!session || !appUrl || !reportPath) throw new Error("Expected SESSION APP_URL REPORT.json");
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
function evaluate(source: string) {
  return browser("eval", source).result;
}
browser("open", new URL("/settings/appearance", appUrl).href);
browser("wait", 'button[aria-label="Palette"]');
let report: unknown;
try {
  report = evaluate(`(() => {
    const root = document.createElement('section'); root.id = 'monokai-surface-audit';
    root.style.cssText = 'position:fixed;inset:60px 20px 20px 330px;z-index:9999;overflow:auto;padding:24px;background:var(--background);color:var(--foreground)';
    root.innerHTML = '<h2 style="font-size:20px;margin-bottom:20px">Shared surfaces on different grounds</h2>';
    const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:16px'; root.append(grid);
    const cases = [
      ['User message', '<div class="rounded-xl border border-border-seam bg-surface-recessed">User message</div>', .06],
      ['Composer', '<form data-promptbox><div data-promptbox-editor-scroll>Composer editor</div></form>', .06],
      ['Context', '<div aria-label="Thread context before sending"><div class="flex items-center gap-0.5 p-1">Context inlay</div></div>', .06],
      ['Annotation', '<div data-agentation-staging-banner>Annotation banner</div>', .06],
      ['Embed header', '<div class="smart-embed-header">Embed header</div>', .06],
      ['Last turn', '<div class="last-turn-diff-heading">Last turn heading</div>', .06],
      ['Inline code', '<code class="bg-muted/70">inlineCode</code>', .08],
    ];
    const measurements = [];
    for (const [name, token] of [['Conversation','--background'],['Sidebar','--sidebar'],['Popover','--popover'],['Nested card','--card']]) {
      const parent = document.createElement('div'); parent.style.cssText = 'padding:14px;border-radius:12px;background:var('+token+')';
      const title = document.createElement('h3');title.textContent=name;title.style.marginBottom='12px';parent.append(title);grid.append(parent);
      if(name==='Nested card') { const outer=document.createElement('div');outer.style.background='var(--card)';grid.replaceChild(outer,parent);outer.append(parent); }
      for (const [kind,html,expected] of cases) {
        const wrapper=document.createElement('div');wrapper.innerHTML=html;
        const e=wrapper.firstElementChild;e.style.cssText='display:block;margin-bottom:12px;padding:12px;border-radius:8px;font-size:13px';parent.append(e);
        measurements.push({name,kind,e,expected});
      }
    }
    // A sticky Git header covers code using a layer-derived opaque fallback.
    const shelf=document.createElement('div');shelf.setAttribute('data-secondary-panel-shelf','');
    shelf.innerHTML='<div class="sticky rounded-lg bg-background"><div class="flex"><span><button aria-expanded="true">Sticky Git header</button></span></div></div>';
    shelf.style.cssText='margin-top:12px;background:var(--diffs-bg-context-override)';root.append(shelf);
    document.body.append(root);
    const results=measurements.map(({name,kind,e,expected})=>{
      const style=getComputedStyle(e);const color=style.backgroundColor;
      const alpha=color.startsWith('rgba')?Number(color.split(',').at(-1).replace(')','')):1;
      if(Math.abs(alpha-expected)>.005) throw Error(name+'/'+kind+': '+color);
      const child=e.querySelector('[data-promptbox-editor-scroll],.gap-0\\\\.5');
      if(child && getComputedStyle(child).backgroundColor!=='rgba(0, 0, 0, 0)') throw Error(kind+' paints its layout twice');
      return {parent:name,kind,fill:color,clip:style.backgroundClip};
    });
    const sticky=getComputedStyle(shelf.firstElementChild).backgroundColor;
    if(sticky!=='rgb(36, 36, 36)') throw Error('Sticky header does not occlude code: '+sticky);
    return {surfaces:results,sticky};
  })()`);
  browser("screenshot", reportPath.replace(/\.json$/, ".png"));
} finally {
  evaluate("document.getElementById('monokai-surface-audit')?.remove()");
  writeFileSync(
    reportPath,
    JSON.stringify(report ?? { error: "Audit did not complete" }, null, 2) + "\n",
  );
}
console.log("28 surface/parent combinations and opaque sticky header passed.");
