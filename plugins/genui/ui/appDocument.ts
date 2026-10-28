// The documents a ```app block runs in (ui/AppBlock.tsx): the app itself,
// the preview drawn while its fence streams, and the standalone file the
// user downloads. Each starts with our CSP, base styles, theme and a
// bootstrap that runs before the model's HTML, so the model writes plain
// HTML and the sandbox's gaps (storage, dialogs, forms, the way back to the
// thread) are already filled. The bootstrap is ES5 text: it runs as written
// in the frame, outside the plugin's bundle.

/** Serialized size (UTF-16 units of every key and value) an app's localStorage may hold. */
export const APP_STORAGE_CAP = 256 * 1024;
/** What `genui.answer` keeps of its text. */
export const MAX_ANSWER_LENGTH = 2000;
export const MAX_URL_LENGTH = 2048;
/** How long an app's storage writes settle before they go to the host. */
const STORAGE_POST_MS = 250;

// `form-action` keeps a form from navigating where the submit listener below
// can't (WebKit honours it; Chromium lets about:srcdoc through, hence both).
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'";

/** The sandbox each frame gets: forms must be allowed for a submit event to fire at all in Chromium. */
export const APP_SANDBOX = "allow-scripts allow-forms";
export const PREVIEW_SANDBOX = "allow-scripts";

/** App variable → host properties tried in order (first non-empty wins). */
const THEME_SOURCES: ReadonlyArray<readonly [string, ...string[]]> = [
  ["--background", "--background"],
  ["--foreground", "--foreground"],
  ["--muted", "--muted", "--surface-recessed"],
  ["--muted-foreground", "--muted-foreground"],
  ["--subtle-foreground", "--subtle-foreground", "--muted-foreground"],
  ["--border", "--border"],
  ["--card", "--card", "--background"],
  ["--primary", "--primary"],
  ["--primary-foreground", "--primary-foreground"],
  ["--success", "--success"],
  ["--warning", "--warning"],
  ["--warning-text", "--warning-text", "--warning"],
  ["--destructive", "--destructive"],
  ["--accent", "--color-timeline-accent", "--primary"],
  ["--font-sans", "--font-sans", "font-family"],
  ["--font-mono", "--font-mono"],
  ["color-scheme", "color-scheme"],
];

// The SVG kit: text, box, connector and tone classes for diagrams drawn as
// inline SVG, so they read like the rest of BB without the model picking
// colours. A tone on a shape or a <g> tints fills, strokes the outline and
// colours the text inside.
const SVG_KIT = `svg .t,svg .ts,svg .th{font-family:var(--font-sans,ui-sans-serif,system-ui,sans-serif)}
svg .t{font-size:14px;fill:var(--foreground)}
svg .ts{font-size:12px;fill:var(--muted-foreground)}
svg .th{font-size:14px;font-weight:500;fill:var(--foreground)}
svg .box{fill:var(--muted);stroke:var(--border);stroke-width:1}
svg .arr{fill:none;stroke:var(--muted-foreground);stroke-width:1.5}
svg .leader{fill:none;stroke:var(--muted-foreground);stroke-width:1;stroke-dasharray:3 3}
svg .tone-good{--tone:var(--success)}
svg .tone-warn{--tone:var(--warning-text,var(--warning))}
svg .tone-bad{--tone:var(--destructive)}
svg .tone-info{--tone:var(--primary)}
svg .tone-accent{--tone:var(--accent)}
svg [class*=tone-]:not(g,text,tspan,line,polyline,.arr,.leader),svg g[class*=tone-] :not(g,text,tspan,line,polyline,.arr,.leader){fill:color-mix(in srgb,var(--tone) 14%,transparent);stroke:var(--tone)}
svg [class*=tone-]:is(line,polyline,.arr,.leader),svg g[class*=tone-] :is(line,polyline,.arr,.leader){stroke:var(--tone)}
svg text[class*=tone-],svg g[class*=tone-] text{fill:var(--tone)}`;

const BASE_STYLES = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
html{color:var(--foreground);font-family:var(--font-sans,ui-sans-serif,system-ui,sans-serif);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
code,kbd,pre,samp{font-family:var(--font-mono,ui-monospace,monospace)}
img,video,canvas{max-width:100%}
button,input,select,textarea{font:inherit;color:inherit;margin:0}
button{cursor:pointer;padding:6px 12px;border:1px solid var(--border);border-radius:8px;background:var(--background);line-height:1.25}
button:hover{background:var(--muted)}
button:disabled{opacity:.5;cursor:default}
input,select,textarea{padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--background)}
input[type=range],input[type=checkbox],input[type=radio],progress{accent-color:var(--accent);padding:0}
input[type=range]{border:0;background:transparent}
::placeholder{color:var(--subtle-foreground)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
${SVG_KIT}`;

/**
 * With the Animations setting off: animations jump to their end and
 * transitions to their new value. Durations, not `animation:none`, so
 * content that fades in from `opacity:0` still ends up shown.
 */
const STILL_CSS =
  "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}";

/**
 * Runs first in both frames. Posts the document height (load, resize),
 * applies theme and motion updates from the host, and adds the arrowhead
 * marker the SVG kit's connectors point with (`marker-end="url(#genui-arrow)"`,
 * drawn in the line's own stroke colour; WebKit has no `context-stroke` and
 * draws it in the connectors' muted colour). `host` is captured first
 * because a top-level `var parent` in app code replaces it.
 */
const COMMON = `var host=window.parent,standalone=config.standalone===true,last=-1;
function post(message){if(standalone)return;message.source="genui-app";host.postMessage(message,"*");}
function measure(){
var body=document.body,height=Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height,body?body.scrollHeight:0));
if(height!==last){last=height;post({type:"height",height:height});}
}
var observer=new ResizeObserver(measure);
observer.observe(document.documentElement);
document.addEventListener("DOMContentLoaded",function(){if(document.body)observer.observe(document.body);measure();});
addEventListener("load",measure);
var arrows=document.createElementNS("http://www.w3.org/2000/svg","svg");
arrows.setAttribute("aria-hidden","true");
arrows.setAttribute("style","position:absolute;width:0;height:0;overflow:hidden");
arrows.innerHTML='<defs><marker id="genui-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill:var(--muted-foreground,currentColor);fill:context-stroke"/></marker></defs>';
document.documentElement.appendChild(arrows);
var STILL=${JSON.stringify(STILL_CSS)},motionOff=config.motionOff===true,systemMotion=matchMedia("(prefers-reduced-motion: reduce)"),motionWatchers=[];
function reduced(){return motionOff||systemMotion.matches;}
function motionChanged(){for(var i=0;i<motionWatchers.length;i++)motionWatchers[i]();}
systemMotion.addEventListener("change",function(){if(!motionOff)motionChanged();});
function setMotionOff(off){
if(off===motionOff)return;
var before=reduced();
motionOff=off;
document.getElementById("genui-motion").textContent=off?STILL:"";
if(reduced()!==before)motionChanged();
}
var preview=null;
addEventListener("message",function(event){
var data=event.data;
if(standalone||event.source!==host||!data||data.source!=="genui-host")return;
if(data.type==="theme"&&typeof data.css==="string")document.getElementById("genui-theme").textContent=data.css;
else if(data.type==="motion"&&typeof data.off==="boolean")setMotionOff(data.off);
else if(data.type==="preview"&&preview&&typeof data.css==="string"&&typeof data.body==="string")preview(data.css,data.body);
});`;

/**
 * The app's runtime: errors to the host; localStorage and sessionStorage
 * kept in memory (an opaque origin has neither) with localStorage posted to
 * the host to save; dialogs and window.open answered with a note instead;
 * forms that never navigate; reduced motion as `genui.reducedMotion` and in
 * `matchMedia`; and `genui.answer` / `genui.openLink`, which only work from
 * the user's own click or key press.
 */
const APP_RUNTIME = `addEventListener("error",function(event){post({type:"error",message:String(event.message||"Script error")});});
addEventListener("unhandledrejection",function(event){var reason=event.reason;post({type:"error",message:"Unhandled rejection: "+String(reason&&reason.message||reason)});});
addEventListener("securitypolicyviolation",function(event){post({type:"error",message:"Blocked by the sandbox (no network access): "+(event.blockedURI||event.effectiveDirective)});});
var realMatchMedia=window.matchMedia.bind(window),MOTION_QUERY=/^\\s*\\(\\s*prefers-reduced-motion\\s*:\\s*(reduce|no-preference)\\s*\\)\\s*$/i,motionLists={};
function motionList(query,reduce){
var listeners=[],list=Object.create(MediaQueryList.prototype);
function matches(){return reduced()===reduce;}
var shown=matches();
Object.defineProperties(list,{
media:{value:query},
matches:{get:matches},
onchange:{value:null,writable:true},
addEventListener:{value:function(type,listener){if(type==="change"&&listener&&listeners.indexOf(listener)<0)listeners.push(listener);}},
removeEventListener:{value:function(type,listener){var at=listeners.indexOf(listener);if(type==="change"&&at>=0)listeners.splice(at,1);}},
addListener:{value:function(listener){list.addEventListener("change",listener);}},
removeListener:{value:function(listener){list.removeEventListener("change",listener);}},
dispatchEvent:{value:function(){return true;}}
});
motionWatchers.push(function(){
var now=matches();
if(now===shown)return;
shown=now;
var event=new MediaQueryListEvent("change",{matches:now,media:query});
if(typeof list.onchange==="function")list.onchange.call(list,event);
listeners.slice().forEach(function(listener){if(typeof listener==="function")listener.call(list,event);else if(listener&&typeof listener.handleEvent==="function")listener.handleEvent(event);});
});
return list;
}
window.matchMedia=function(query){
var found=MOTION_QUERY.exec(String(query));
if(!found)return realMatchMedia(query);
var reduce=found[1].toLowerCase()==="reduce",name=reduce?"reduce":"no-preference";
return motionLists[name]||(motionLists[name]=motionList("(prefers-reduced-motion: "+name+")",reduce));
};
var CAP=${APP_STORAGE_CAP},own=Object.prototype.hasOwnProperty;
function memoryStorage(initial,changed){
var items=new Map(),size=0,methods={
getItem:function(key){key=String(key);return items.has(key)?items.get(key):null;},
setItem:function(key,value){
key=String(key);value=String(value);
var old=items.get(key),next=size-(old===undefined?0:key.length+old.length)+key.length+value.length;
if(next>CAP)throw new DOMException("This app's storage is full: it holds 256 KB.","QuotaExceededError");
items.set(key,value);size=next;changed(items);
},
removeItem:function(key){key=String(key);if(!items.has(key))return;size-=key.length+items.get(key).length;items.delete(key);changed(items);},
clear:function(){if(items.size===0)return;items.clear();size=0;changed(items);},
key:function(index){var keys=Array.from(items.keys());index=Math.floor(Number(index));return index>=0&&index<keys.length?keys[index]:null;}
};
Object.keys(initial).forEach(function(key){var value=initial[key];if(typeof value==="string"){items.set(key,value);size+=key.length+value.length;}});
return new Proxy(Object.create(Storage.prototype),{
get:function(target,name){
if(typeof name==="string"){if(own.call(methods,name))return methods[name];if(name==="length")return items.size;if(items.has(name))return items.get(name);}
return Reflect.get(target,name);
},
set:function(target,name,value){if(typeof name!=="string")return Reflect.set(target,name,value);methods.setItem(name,value);return true;},
has:function(target,name){return typeof name==="string"&&(items.has(name)||own.call(methods,name))||name in target;},
deleteProperty:function(target,name){if(typeof name==="string")methods.removeItem(name);return true;},
ownKeys:function(){return Array.from(items.keys());},
getOwnPropertyDescriptor:function(target,name){if(typeof name==="string"&&items.has(name))return{value:items.get(name),writable:true,enumerable:true,configurable:true};return undefined;},
defineProperty:function(target,name,descriptor){if(typeof name!=="string"||!("value" in descriptor))return false;methods.setItem(name,descriptor.value);return true;}
});
}
function install(name,value){try{Object.defineProperty(window,name,{value:value,configurable:true,enumerable:true});}catch(error){}}
var unsaved=null,saveTimer=0;
function save(){clearTimeout(saveTimer);if(unsaved===null)return;var items=Object.fromEntries(unsaved);unsaved=null;post({type:"storage",items:items});}
install("localStorage",memoryStorage(config.storage||{},function(items){unsaved=items;clearTimeout(saveTimer);saveTimer=setTimeout(save,${STORAGE_POST_MS});}));
install("sessionStorage",memoryStorage({},function(){}));
addEventListener("pagehide",save);
var openWindow=window.open;
function refuse(what){post({type:"blocked",what:what});}
if(!standalone){
window.alert=function(){refuse("alert");};
window.confirm=function(){refuse("confirm");return false;};
window.prompt=function(){refuse("prompt");return null;};
window.open=function(){refuse("open");return null;};
}
addEventListener("submit",function(event){event.preventDefault();},true);
HTMLFormElement.prototype.submit=function(){};
// A link the app didn't handle itself would load its page inside the frame,
// replacing the app: https links open in BB instead, others stay put. A
// "#part" link resolves against BB's address (a srcdoc document's base),
// so it would load BB in the frame: it moves this document's hash instead.
addEventListener("click",function(event){
if(standalone||event.defaultPrevented||event.button!==0)return;
var link=event.target&&event.target.closest?event.target.closest("a[href]"):null;
if(!link)return;
var href=link.getAttribute("href").trim();
if(href==="")return;
event.preventDefault();
if(href.charAt(0)==="#")location.hash=href;
else if(/^https:/i.test(href))genui.openLink(href);else refuse("link");
});
addEventListener("keydown",function(event){if(event.key==="Escape"&&!event.defaultPrevented)post({type:"escape"});});
var gesture=false;
function activate(event){if(!event.isTrusted)return;gesture=true;setTimeout(function(){gesture=false;},0);}
["pointerup","click","keydown","change"].forEach(function(type){addEventListener(type,activate,true);});
function inGesture(){var activation=navigator.userActivation;return gesture||!!(activation&&activation.isActive);}
var genui={
answer:function(text){
if(standalone)return false;
if(!inGesture()){refuse("answer");return false;}
var value=text==null?"":String(text).trim().slice(0,${MAX_ANSWER_LENGTH}).trim();
post({type:"answer",text:value===""?null:value});
return true;
},
openLink:function(url){
var link;
try{link=new URL(String(url));}catch(error){return false;}
if(link.protocol!=="https:"||link.href.length>${MAX_URL_LENGTH})return false;
if(!inGesture()){refuse("openLink");return false;}
if(standalone)openWindow.call(window,link.href,"_blank","noopener");
else post({type:"openLink",url:link.href});
return true;
}
};
Object.defineProperty(genui,"reducedMotion",{get:reduced,enumerable:true});
Object.defineProperty(window,"genui",{value:Object.freeze(genui),enumerable:true});`;

/**
 * The preview's runtime: it never runs the model's scripts. The host posts
 * the static markup written so far (core/partialHtml.ts) and the body is
 * morphed into it in place, so what is already drawn keeps its nodes (and
 * its images, its entrance animations) as the rest streams in. Markup is
 * parsed in a <template>, where nothing loads or runs, and copied without
 * inline handlers or javascript: URLs.
 */
const PREVIEW_RUNTIME = `function inert(attribute){return /^on/i.test(attribute.name)||/^\\s*javascript:/i.test(attribute.value);}
function skipped(node){return node.nodeType===1&&/^(SCRIPT|IFRAME|OBJECT|EMBED|FRAME)$/i.test(node.nodeName)||node.nodeType!==1&&node.nodeType!==3;}
function clean(node){
for(var i=node.attributes.length-1;i>=0;i--)if(inert(node.attributes[i]))node.removeAttribute(node.attributes[i].name);
for(var child=node.firstElementChild;child;){var next=child.nextElementSibling;if(skipped(child))child.remove();else clean(child);child=next;}
}
function adopt(node){var copy=document.importNode(node,true);if(copy.nodeType===1)clean(copy);return copy;}
function update(node,source){
if(node.nodeType!==1){if(node.nodeValue!==source.nodeValue)node.nodeValue=source.nodeValue;return;}
var i,attribute;
for(i=node.attributes.length-1;i>=0;i--){attribute=node.attributes[i];if(!source.hasAttributeNS(attribute.namespaceURI,attribute.localName))node.removeAttributeNS(attribute.namespaceURI,attribute.localName);}
for(i=0;i<source.attributes.length;i++){attribute=source.attributes[i];if(!inert(attribute)&&node.getAttributeNS(attribute.namespaceURI,attribute.localName)!==attribute.value)node.setAttributeNS(attribute.namespaceURI,attribute.name,attribute.value);}
if(node.nodeName!=="TEMPLATE")morph(node,source);
}
function morph(target,source){
var current=target.firstChild;
for(var next=source.firstChild;next;next=next.nextSibling){
if(skipped(next))continue;
if(current&&current.nodeType===next.nodeType&&current.nodeName===next.nodeName){update(current,next);current=current.nextSibling;continue;}
var copy=adopt(next);
if(current)target.replaceChild(copy,current);else target.appendChild(copy);
current=copy.nextSibling;
}
while(current){var after=current.nextSibling;target.removeChild(current);current=after;}
}
preview=function(css,markup){
document.getElementById("genui-preview-css").textContent=css;
var template=document.createElement("template");
template.innerHTML=markup;
morph(document.body,template.content);
measure();
};`;

export type AppTheme = Readonly<Record<string, string>>;

export interface AppConfig {
  readonly theme: AppTheme;
  /** The plugin's Animations setting is off. */
  readonly motionOff: boolean;
  /** The app's saved localStorage, to start with. */
  readonly storage: Readonly<Record<string, string>>;
  /** A downloaded file: no host to post to; links open in a new tab. */
  readonly standalone?: boolean;
}

/** Values that could close the theme `<style>` element or add rules are dropped. */
const UNSAFE_CSS_VALUE = /[<>{};\\]/;

/** The app's theme variables from host computed-style lookups (`read` returns "" when unset). */
export function resolveTheme(read: (property: string) => string): AppTheme {
  const theme: Record<string, string> = {};
  for (const [name, ...sources] of THEME_SOURCES) {
    const value = sources.map((source) => read(source).trim()).find((candidate) => candidate !== "");
    if (value !== undefined && !UNSAFE_CSS_VALUE.test(value)) theme[name] = value;
  }
  return theme;
}

export function themeCss(theme: AppTheme): string {
  return `:root{${Object.entries(theme)
    .map(([name, value]) => `${name}:${value}`)
    .join(";")}}`;
}

/** `value` as a JS expression safe inside an inline <script>: JSON.parse keeps a `__proto__` key as data. */
function scriptValue(value: unknown): string {
  return `JSON.parse(${JSON.stringify(JSON.stringify(value)).replace(/</g, "\\u003c")})`;
}

function head(config: Pick<AppConfig, "theme" | "motionOff">, bootstrap: string, runtime: object): string[] {
  return [
    "<!doctype html>",
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<style>${BASE_STYLES}</style>`,
    `<style id="genui-theme">${themeCss(config.theme)}</style>`,
    `<style id="genui-motion">${config.motionOff ? STILL_CSS : ""}</style>`,
    `<script>(function(config){\n${bootstrap}\n})(${scriptValue(runtime)});</script>`,
  ];
}

/** CSP, base styles, theme and bootstrap, then the model's document as written. */
export function buildSrcdoc(html: string, config: AppConfig): string {
  // Our doctype keeps standards mode; the parser then ignores the model's
  // doctype/<head> tags and merges its <html> attributes.
  const runtime = { motionOff: config.motionOff, storage: config.storage, standalone: config.standalone === true };
  return [...head(config, `${COMMON}\n${APP_RUNTIME}`, runtime), html].join("\n");
}

/** The streaming preview's frame: the same head, an empty body the host fills (see PREVIEW_RUNTIME). */
export function buildPreviewSrcdoc(config: Pick<AppConfig, "theme" | "motionOff">): string {
  return [
    ...head(config, `${COMMON}\n${PREVIEW_RUNTIME}`, { motionOff: config.motionOff }),
    '<style id="genui-preview-css"></style>',
    "<body></body>",
  ].join("\n");
}

/** The downloaded file's name: the document's <title>, else app.html. */
export function appFileName(html: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? "";
  const name = title
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return name === "" ? "app.html" : `${name}.html`;
}
