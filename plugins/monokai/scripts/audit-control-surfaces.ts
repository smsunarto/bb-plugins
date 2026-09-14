/** Exercise shipped BB control classes against nested theme surfaces.
 * Run against an isolated verification runtime, never the live app:
 * bun plugins/monokai/scripts/audit-control-surfaces.ts SESSION APP_URL REPORT.json
 * The temporary matrix is removed even if an assertion fails.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [session, appUrl, reportPath] = process.argv.slice(2);
if (!session || !appUrl || !reportPath) throw new Error("Expected SESSION APP_URL REPORT.json");
const origin = new URL(appUrl).origin;
function browser(...args: string[]) {
  const response = JSON.parse(
    execFileSync("agent-browser", ["--session", session!, "--json", ...args], {
      encoding: "utf8",
      timeout: 35_000,
    }),
  );
  if (!response.success) throw new Error(JSON.stringify(response.error));
  return response.data;
}
function evaluate(source: string) {
  return browser("eval", source).result;
}
function navigate(path: string, selector: string) {
  browser("open", new URL(path, origin).href);
  browser("wait", selector);
}

// Read the actual host Input and picker, including its settings-specific classes.
navigate("/settings/general", 'input[aria-label="New branch prefix"]');
const inputClass = evaluate(
  `document.querySelector('input[aria-label="New branch prefix"]').className`,
);
navigate("/settings/appearance", 'button[aria-label="Palette"]');
const pickerClass = evaluate(`document.querySelector('button[aria-label="Palette"]').className`);
const outlineClass = evaluate(
  `document.querySelector('button[aria-label="Sidebar thread list"]').className`,
);
const reports: unknown[] = [];
try {
  evaluate(`(() => {
    const root = document.createElement('section');
    root.id = 'monokai-control-audit';
    root.style.cssText = 'position:fixed;inset:64px 24px 24px 340px;z-index:9999;padding:24px;background:var(--background);color:var(--foreground);overflow:auto';
    const title = document.createElement('h2'); title.textContent = 'The same controls on every surface';
    title.style.cssText = 'font-size:20px;margin-bottom:20px'; root.append(title);
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px'; root.append(grid);
    const surfaces = [
      ['Canvas','--background'], ['Sidebar','--sidebar'], ['User surface','--agent-surface-background'],
      ['Popover','--popover'], ['Card','--card'], ['Nested card','--card','--card'],
    ];
    surfaces.forEach(([name,...tokens], index) => {
      const wrapper = document.createElement('div'); wrapper.style.backgroundColor = 'var(--background)';
      let parent = wrapper;
      tokens.forEach(token => { const layer = document.createElement('div'); layer.style.cssText = 'padding:16px;border-radius:10px;background-color:var('+token+')'; parent.append(layer); parent = layer; });
      const label = document.createElement('h3'); label.textContent = name; label.style.marginBottom = '14px'; parent.append(label);
      [['picker','button',${JSON.stringify(pickerClass)}],['outline','button',${JSON.stringify(outlineClass)}],['input','input',${JSON.stringify(inputClass)}],['primary','button','bg-foreground text-background rounded-md px-3 h-8 text-xs']].forEach(([kind,tag,classes])=>{
        const e = document.createElement(tag); e.className = classes; e.dataset.auditControl = index+'-'+kind;
        e.style.cssText = 'display:block;width:100%;margin-bottom:12px';
        if(tag==='input') {e.value='Editable text';e.setAttribute('aria-label',name+' input');}
        else { e.type='button';e.textContent=kind==='primary'?'Create thread':kind==='picker'?'Choose option ▾':'Browse'; }
        parent.append(e);
      });
      grid.append(wrapper);
    });
    document.querySelector('main main').append(root);
    return root.querySelectorAll('[data-audit-control]').length;
  })()`);
  const measure = `(id) => {
    const e = document.querySelector('[data-audit-control="'+id+'"]');
    const ctx = document.createElement('canvas').getContext('2d');
    function rgba(color) { ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return Array.from(ctx.getImageData(0,0,1,1).data).map((v,i)=>i===3?v/255:v); }
    function over(f,b) {return f.slice(0,3).map((v,i)=>v*f[3]+b[i]*(1-f[3]));}
    const ancestors=[]; for(let p=e.parentElement;p;p=p.parentElement) ancestors.unshift(p);
    let parent=[0,0,0]; for(const p of ancestors) parent=over(rgba(getComputedStyle(p).backgroundColor),parent);
    const s=getComputedStyle(e), fill=rgba(s.backgroundColor), background=over(fill,parent), ink=over(rgba(s.color),background);
    const lum = rgb => rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);
    return {fill:s.backgroundColor,alpha:fill[3],parent,background,border:s.borderColor,clip:s.backgroundClip,contrast:(lum(ink)+.05)/(lum(background)+.05)};
  }`;
  for (let surface = 0; surface < 6; surface++) {
    for (const kind of ["picker", "outline", "input", "primary"]) {
      const id = `${surface}-${kind}`;
      browser("hover", "#monokai-control-audit h2");
      browser(
        "wait",
        "--fn",
        `document.querySelector('[data-audit-control="${id}"]').getAnimations().length===0`,
      );
      const resting = evaluate(`(${measure})(${JSON.stringify(id)})`);
      const expected = kind === "primary" ? 0.14 : 0.04;
      if (Math.abs(resting.alpha - expected) > 0.005)
        throw new Error(`${id}: expected ${expected} alpha, got ${resting.fill}`);
      if (resting.contrast < 4.5)
        throw new Error(`${id}: insufficient text contrast ${resting.contrast}`);
      if (kind !== "primary" && resting.clip !== "padding-box")
        throw new Error(`${id}: fill compounds under its border`);
      browser("hover", `[data-audit-control="${id}"]`);
      browser(
        "wait",
        "--fn",
        `document.querySelector('[data-audit-control="${id}"]').getAnimations().length===0`,
      );
      const hovered = evaluate(`(${measure})(${JSON.stringify(id)})`);
      const expectedHover = kind === "primary" ? 0.2 : 0.08;
      if (Math.abs(hovered.alpha - expectedHover) > 0.005)
        throw new Error(`${id}: hover was overridden: ${hovered.fill}`);
      if (hovered.contrast < 4.5) throw new Error(`${id}: insufficient hover text contrast`);
      reports.push({ surface, kind, resting, hovered });
    }
  }
  browser("hover", "#monokai-control-audit h2");
  browser("screenshot", reportPath.replace(/\.json$/, ".png"));
} finally {
  evaluate(`document.getElementById('monokai-control-audit')?.remove()`);
  writeFileSync(reportPath, JSON.stringify(reports, null, 2) + "\n");
}
// Open the real picker and check the portalled menu after its entry animation.
browser("find", "role", "button", "click", "--name", "Palette", "--exact");
browser(
  "wait",
  "--fn",
  `!!document.querySelector('[role="menu"]') && getComputedStyle(document.querySelector('[role="menu"]')).opacity==='1' && document.querySelector('[role="menu"]').getAnimations().length===0`,
);
const menu = evaluate(
  `(() => {const s=getComputedStyle(document.querySelector('[role="menu"]')); return {background:s.backgroundColor,shadow:s.boxShadow,opacity:s.opacity};})()`,
);
if (menu.background !== "rgb(29, 29, 29)" || menu.shadow === "none")
  throw new Error(`Menu must occlude content and have a shadow: ${JSON.stringify(menu)}`);
writeFileSync(reportPath, JSON.stringify({ origin, cases: reports, menu }, null, 2) + "\n");
console.log(
  `PASS: ${reports.length} control/surface pairs in rest and hover, text >= 4.5:1, opaque real dropdown with shadow.`,
);
