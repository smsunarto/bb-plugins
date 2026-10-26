"use client";
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  Agentation: () => PageFeedbackToolbarCSS,
  AnimatedBunny: () => AnimatedBunny,
  AnnotationPopupCSS: () => AnnotationPopupCSS,
  IconChatEllipsis: () => IconChatEllipsis,
  IconCheck: () => IconCheck,
  IconCheckSmall: () => IconCheckSmall,
  IconCheckSmallAnimated: () => IconCheckSmallAnimated,
  IconCheckmark: () => IconCheckmark,
  IconCheckmarkCircle: () => IconCheckmarkCircle,
  IconCheckmarkLarge: () => IconCheckmarkLarge,
  IconChevronLeft: () => IconChevronLeft,
  IconChevronRight: () => IconChevronRight,
  IconClose: () => IconClose,
  IconCopyAlt: () => IconCopyAlt,
  IconCopyAnimated: () => IconCopyAnimated,
  IconEdit: () => IconEdit,
  IconEye: () => IconEye,
  IconEyeAlt: () => IconEyeAlt,
  IconEyeAnimated: () => IconEyeAnimated,
  IconEyeClosed: () => IconEyeClosed,
  IconEyeMinus: () => IconEyeMinus,
  IconGear: () => IconGear,
  IconHelp: () => IconHelp,
  IconLayout: () => IconLayout,
  IconListSparkle: () => IconListSparkle,
  IconMoon: () => IconMoon,
  IconPause: () => IconPause,
  IconPauseAlt: () => IconPauseAlt,
  IconPausePlayAnimated: () => IconPausePlayAnimated,
  IconPlayAlt: () => IconPlayAlt,
  IconPlus: () => IconPlus,
  IconSendAnimated: () => IconSendAnimated,
  IconSendArrow: () => IconSendArrow,
  IconSun: () => IconSun,
  IconTrash: () => IconTrash,
  IconTrashAlt: () => IconTrashAlt,
  IconXmark: () => IconXmark,
  IconXmarkLarge: () => IconXmarkLarge,
  PageFeedbackToolbarCSS: () => PageFeedbackToolbarCSS,
  closestCrossingShadow: () => closestCrossingShadow,
  getElementClasses: () => getElementClasses,
  getElementPath: () => getElementPath,
  getNearbyText: () => getNearbyText,
  getShadowHost: () => getShadowHost,
  getStorageKey: () => getStorageKey,
  identifyAnimationElement: () => identifyAnimationElement,
  identifyElement: () => identifyElement,
  isInShadowDOM: () => isInShadowDOM,
  loadAnnotations: () => loadAnnotations,
  saveAnnotations: () => saveAnnotations
});
module.exports = __toCommonJS(index_exports);

// src/hooks/use-latest-action.ts
var import_react = require("react");

// src/utils/freeze-animations.ts
var EXCLUDE_ATTRS = [
  "data-feedback-toolbar",
  "data-annotation-popup",
  "data-annotation-marker"
];
var NOT_SELECTORS = EXCLUDE_ATTRS.flatMap((a) => [`:not([${a}])`, `:not([${a}] *)`]).join("");
var STYLE_ID = "feedback-freeze-styles";
var STATE_KEY = "__agentation_freeze";
function getState() {
  if (typeof window === "undefined") {
    return {
      frozen: false,
      installed: true,
      // prevent patching on server
      origSetTimeout: setTimeout,
      origSetInterval: setInterval,
      origRAF: (cb) => 0,
      pausedAnimations: [],
      frozenTimeoutQueue: [],
      frozenRAFQueue: []
    };
  }
  const w = window;
  return w[STATE_KEY] ?? {
    frozen: false,
    installed: false,
    origSetTimeout: window.setTimeout.bind(window),
    origSetInterval: window.setInterval.bind(window),
    origRAF: window.requestAnimationFrame.bind(window),
    pausedAnimations: [],
    frozenTimeoutQueue: [],
    frozenRAFQueue: []
  };
}
var _s = getState();
function installAnimationFreeze() {
  if (typeof window === "undefined") return;
  const w = window;
  _s = w[STATE_KEY] ?? (w[STATE_KEY] = _s);
  if (_s.installed) return;
  window.setTimeout = (handler, timeout, ...args) => {
    if (typeof handler === "string") {
      return _s.origSetTimeout(handler, timeout);
    }
    return _s.origSetTimeout(
      (...a) => {
        if (_s.frozen) {
          _s.frozenTimeoutQueue.push(() => handler(...a));
        } else {
          handler(...a);
        }
      },
      timeout,
      ...args
    );
  };
  window.setInterval = (handler, timeout, ...args) => {
    if (typeof handler === "string") {
      return _s.origSetInterval(handler, timeout);
    }
    return _s.origSetInterval(
      (...a) => {
        if (!_s.frozen) handler(...a);
      },
      timeout,
      ...args
    );
  };
  window.requestAnimationFrame = (callback) => {
    return _s.origRAF((timestamp) => {
      if (_s.frozen) {
        _s.frozenRAFQueue.push(callback);
      } else {
        callback(timestamp);
      }
    });
  };
  _s.installed = true;
}
var originalSetTimeout = _s.origSetTimeout;
var originalSetInterval = _s.origSetInterval;
var originalRequestAnimationFrame = _s.origRAF;
function isAgentationElement(el) {
  if (!el) return false;
  return EXCLUDE_ATTRS.some((attr) => !!el.closest?.(`[${attr}]`));
}
function freeze() {
  if (typeof document === "undefined") return;
  installAnimationFreeze();
  if (_s.frozen) return;
  _s.frozen = true;
  _s.frozenTimeoutQueue = [];
  _s.frozenRAFQueue = [];
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
  }
  style.textContent = `
    *${NOT_SELECTORS},
    *${NOT_SELECTORS}::before,
    *${NOT_SELECTORS}::after {
      animation-play-state: paused !important;
      transition: none !important;
    }
  `;
  document.head.appendChild(style);
  _s.pausedAnimations = [];
  try {
    document.getAnimations().forEach((anim) => {
      if (anim.playState !== "running") return;
      const target = anim.effect?.target;
      if (!isAgentationElement(target)) {
        anim.pause();
        _s.pausedAnimations.push(anim);
      }
    });
  } catch {
  }
  document.querySelectorAll("video").forEach((video) => {
    if (!video.paused) {
      video.dataset.wasPaused = "false";
      video.pause();
    }
  });
}
function unfreeze() {
  if (typeof document === "undefined") return;
  if (!_s.frozen) return;
  _s.frozen = false;
  const timeoutQueue = _s.frozenTimeoutQueue;
  _s.frozenTimeoutQueue = [];
  for (const cb of timeoutQueue) {
    _s.origSetTimeout(() => {
      if (_s.frozen) {
        _s.frozenTimeoutQueue.push(cb);
        return;
      }
      try {
        cb();
      } catch (e) {
        console.warn("[agentation] Error replaying queued timeout:", e);
      }
    }, 0);
  }
  const rafQueue = _s.frozenRAFQueue;
  _s.frozenRAFQueue = [];
  for (const cb of rafQueue) {
    _s.origRAF((ts) => {
      if (_s.frozen) {
        _s.frozenRAFQueue.push(cb);
        return;
      }
      cb(ts);
    });
  }
  for (const anim of _s.pausedAnimations) {
    try {
      anim.play();
    } catch (e) {
      console.warn("[agentation] Error resuming animation:", e);
    }
  }
  _s.pausedAnimations = [];
  document.getElementById(STYLE_ID)?.remove();
  document.querySelectorAll("video").forEach((video) => {
    if (video.dataset.wasPaused === "false") {
      video.play().catch(() => {
      });
      delete video.dataset.wasPaused;
    }
  });
}

// src/hooks/use-latest-action.ts
function useLatestAction() {
  const action = (0, import_react.useMemo)(() => {
    let sequence = 0;
    const timers = /* @__PURE__ */ new Set();
    const start = () => {
      timers.forEach(clearTimeout);
      timers.clear();
      return ++sequence;
    };
    const isCurrent = (id) => id === sequence;
    const schedule = (id, callback, delay) => {
      if (!isCurrent(id)) return;
      const timer = originalSetTimeout(() => {
        timers.delete(timer);
        if (isCurrent(id)) callback();
      }, delay);
      timers.add(timer);
    };
    return { start, isCurrent, schedule };
  }, []);
  (0, import_react.useEffect)(
    () => () => {
      action.start();
    },
    [action]
  );
  return action;
}

// src/utils/merge-session-feedback.ts
function mergeSessionFeedback(before, current, incoming, serverIds) {
  const serverId = (annotation) => serverIds.get(annotation.id) ?? annotation.id;
  const previous = new Map(before.map((annotation) => [serverId(annotation), annotation]));
  const latest = new Map(current.map((annotation) => [serverId(annotation), annotation]));
  const receivedIds = new Set(incoming.map((annotation) => annotation.id));
  const merged = [];
  for (const remote of incoming) {
    const original = previous.get(remote.id);
    const local = latest.get(remote.id);
    if (original && !local) continue;
    const edited = local && original && local.comment !== original.comment;
    merged.push(edited ? { ...remote, comment: local.comment } : remote);
  }
  for (const [id, local] of latest) {
    if (!previous.has(id) && !receivedIds.has(id)) merged.push(local);
  }
  return merged;
}

// src/utils/frame-dom.ts
function frameDocument(frame) {
  if (frame.tagName !== "IFRAME") return null;
  try {
    return frame.contentDocument;
  } catch {
    return null;
  }
}
function parentFrame(doc, root = document) {
  if (doc === root) return null;
  try {
    return doc.defaultView?.frameElement;
  } catch {
    return null;
  }
}
function isShadowRoot(node) {
  return node.nodeType === 11 && "host" in node;
}
function frameGeometry(frame) {
  const rect = frame.getBoundingClientRect();
  const sx = frame.offsetWidth ? rect.width / frame.offsetWidth : 1;
  const sy = frame.offsetHeight ? rect.height / frame.offsetHeight : 1;
  const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
  const padding = (value) => parseFloat(value || "0") || 0;
  const left = padding(style?.paddingLeft), top = padding(style?.paddingTop);
  const width = frame.clientWidth - left - padding(style?.paddingRight);
  const height = frame.clientHeight - top - padding(style?.paddingBottom);
  return {
    x: rect.left + (frame.clientLeft + left) * sx,
    y: rect.top + (frame.clientTop + top) * sy,
    sx,
    sy,
    width: width * sx,
    height: height * sy
  };
}
function frameLocationKey(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}
function viewportPoint(doc, x, y, root = document) {
  let frame = parentFrame(doc, root);
  while (frame) {
    const box = frameGeometry(frame);
    x = box.x + x * box.sx;
    y = box.y + y * box.sy;
    frame = parentFrame(frame.ownerDocument, root);
  }
  return { x, y };
}
function viewportRect(element, root = document) {
  const rect = element.getBoundingClientRect();
  return rectInViewport(element.ownerDocument, rect, root);
}
function rectInViewport(doc, rect, root) {
  if (!parentFrame(doc, root)) return rect;
  let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
  let frame = parentFrame(doc, root);
  while (frame) {
    const box = frameGeometry(frame);
    left = Math.max(box.x, box.x + left * box.sx);
    top = Math.max(box.y, box.y + top * box.sy);
    right = Math.min(box.x + box.width, box.x + right * box.sx);
    bottom = Math.min(box.y + box.height, box.y + bottom * box.sy);
    frame = parentFrame(frame.ownerDocument, root);
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
function framesIn(root) {
  const result = [];
  for (const element of root.querySelectorAll("*")) {
    if (element.tagName === "IFRAME") result.push(element);
    if (element.shadowRoot && element.tagName !== "AGENTATION-TOOLBAR")
      result.push(...framesIn(element.shadowRoot));
  }
  return result;
}
function captureFrameContext(element, x, y, root = document) {
  const chain = [];
  for (let frame = parentFrame(element.ownerDocument, root); frame; frame = parentFrame(frame.ownerDocument, root))
    chain.unshift(frame);
  if (!chain.length) return void 0;
  const path = chain.map((frame) => {
    const box = frameGeometry(frame);
    x = (x - box.x) / box.sx;
    y = (y - box.y) / box.sy;
    return {
      index: framesIn(frame.ownerDocument).indexOf(frame),
      id: frame.id || void 0,
      url: frameDocument(frame)?.URL ?? ""
    };
  });
  const win = element.ownerDocument.defaultView;
  let fixed = false;
  for (let current = element; current; current = current.parentElement) {
    if (["fixed", "sticky"].includes(win.getComputedStyle(current).position)) {
      fixed = true;
      break;
    }
  }
  const dx = fixed ? 0 : win.scrollX, dy = fixed ? 0 : win.scrollY;
  const rect = element.getBoundingClientRect();
  return {
    path,
    x: x + dx,
    y: y + dy,
    fixed,
    boundingBox: { x: rect.left + dx, y: rect.top + dy, width: rect.width, height: rect.height }
  };
}
function createFrameProjector(root = document) {
  const framesByDocument = /* @__PURE__ */ new Map();
  const lookup = (doc) => {
    let frames = framesByDocument.get(doc);
    if (!frames) {
      frames = framesIn(doc);
      framesByDocument.set(doc, frames);
    }
    return frames;
  };
  return (annotation) => projectFrameAnnotation(annotation, root, lookup);
}
function projectFrameAnnotation(annotation, root = document, lookup = framesIn) {
  const context = annotation.frame;
  if (!context) return annotation;
  let doc = root;
  for (const entry of context.path) {
    const frames = lookup(doc);
    const frame = entry.id ? frames.find((frame2) => frame2.id === entry.id) : frames[entry.index];
    const child = frame && frameDocument(frame);
    if (!child || frameLocationKey(child.URL) !== frameLocationKey(entry.url)) return null;
    doc = child;
  }
  const win = doc.defaultView;
  const dx = context.fixed ? 0 : win.scrollX, dy = context.fixed ? 0 : win.scrollY;
  let localX = context.x - dx, localY = context.y - dy;
  for (let current = doc, frame = parentFrame(doc, root); frame; frame = parentFrame(current, root)) {
    const view = current.defaultView;
    if (localX < 0 || localY < 0 || localX > view.innerWidth || localY > view.innerHeight)
      return null;
    const box2 = frameGeometry(frame);
    if (box2.width <= 0 || box2.height <= 0) return null;
    localX = box2.x + localX * box2.sx;
    localY = box2.y + localY * box2.sy;
    current = frame.ownerDocument;
  }
  const box = context.boundingBox;
  const rect = rectInViewport(doc, new DOMRect(box.x - dx, box.y - dy, box.width, box.height), root);
  const rootWindow = root.defaultView;
  return {
    ...annotation,
    x: localX / rootWindow.innerWidth * 100,
    y: localY + (annotation.isFixed ? 0 : rootWindow.scrollY),
    boundingBox: {
      x: rect.x,
      y: rect.y + (annotation.isFixed ? 0 : rootWindow.scrollY),
      width: rect.width,
      height: rect.height
    }
  };
}
function pageEvent(event, doc, root) {
  if (!("clientX" in event) || doc === root) return event;
  const point = viewportPoint(
    doc,
    event.clientX,
    event.clientY,
    root
  );
  return new Proxy(event, {
    get(target, key) {
      if (key === "clientX") return point.x;
      if (key === "clientY") return point.y;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
function createPageEvents(root, onGeometryChange) {
  const documents = /* @__PURE__ */ new Set([root]);
  const subscriptions = /* @__PURE__ */ new Set();
  let observers = [];
  let frames = /* @__PURE__ */ new Set();
  let queued = false, running = false;
  let resizeObserver;
  const connect = (subscription, doc) => {
    const handler = (event) => subscription.listener(pageEvent(event, doc, root));
    subscription.handlers.set(doc, handler);
    doc.addEventListener(subscription.type, handler, subscription.options);
  };
  const reconcile = () => {
    queued = false;
    if (!running) return;
    const next = /* @__PURE__ */ new Set();
    const nextFrames = /* @__PURE__ */ new Set();
    const roots = [];
    const visit = (tree) => {
      roots.push(tree);
      for (const element of tree.querySelectorAll("*")) {
        if (element.matches("agentation-toolbar, [data-agentation-portal]")) continue;
        if (element.shadowRoot) visit(element.shadowRoot);
        if (element.tagName === "IFRAME") {
          nextFrames.add(element);
          const child = frameDocument(element);
          if (child && !next.has(child)) {
            next.add(child);
            visit(child);
          }
        }
      }
    };
    next.add(root);
    visit(root);
    for (const doc of documents)
      if (!next.has(doc)) {
        for (const subscription of subscriptions) {
          const handler = subscription.handlers.get(doc);
          if (handler) doc.removeEventListener(subscription.type, handler, subscription.options);
          subscription.handlers.delete(doc);
        }
        documents.delete(doc);
      }
    for (const doc of next)
      if (!documents.has(doc)) {
        documents.add(doc);
        for (const subscription of subscriptions) connect(subscription, doc);
      }
    for (const frame of frames)
      if (!nextFrames.has(frame)) frame.removeEventListener("load", reconcile);
    for (const frame of nextFrames)
      if (!frames.has(frame)) frame.addEventListener("load", reconcile);
    frames = nextFrames;
    resizeObserver?.disconnect();
    frames.forEach((frame) => resizeObserver?.observe(frame));
    observers.forEach((observer) => observer.disconnect());
    observers = roots.map((tree) => {
      const observer = new MutationObserver((records) => {
        const structural = records.some(
          (record) => [...record.addedNodes, ...record.removedNodes].some(
            (node) => node.nodeType === 1 && !node.closest("agentation-toolbar, [data-agentation-portal]") && (node.tagName === "IFRAME" || !!node.shadowRoot || !!node.querySelector("iframe"))
          )
        );
        if (structural && !queued) {
          queued = true;
          queueMicrotask(reconcile);
        }
      });
      observer.observe(tree, { childList: true, subtree: true });
      return observer;
    });
    onGeometryChange?.();
  };
  return {
    start() {
      if (running) return;
      running = true;
      if (typeof ResizeObserver === "function") {
        resizeObserver = new ResizeObserver(() => onGeometryChange?.());
      }
      reconcile();
    },
    stop() {
      running = false;
      resizeObserver?.disconnect();
      resizeObserver = void 0;
      observers.forEach((observer) => observer.disconnect());
      observers = [];
      for (const frame of frames) frame.removeEventListener("load", reconcile);
      frames.clear();
      for (const subscription of subscriptions)
        for (const [doc, handler] of subscription.handlers) {
          doc.removeEventListener(subscription.type, handler, subscription.options);
        }
      subscriptions.clear();
      documents.clear();
      documents.add(root);
    },
    addEventListener(type, listener, options) {
      const subscription = {
        type,
        listener,
        options,
        handlers: /* @__PURE__ */ new Map()
      };
      subscriptions.add(subscription);
      for (const doc of documents) connect(subscription, doc);
    },
    removeEventListener(type, listener, _options) {
      for (const subscription of subscriptions)
        if (subscription.type === type && subscription.listener === listener) {
          for (const [doc, handler] of subscription.handlers)
            doc.removeEventListener(type, handler, subscription.options);
          subscriptions.delete(subscription);
        }
    },
    querySelectorAll(selector) {
      return [...documents].flatMap((doc) => [...doc.querySelectorAll(selector)]);
    }
  };
}

// src/utils/element-attributes.ts
var DEFAULT_IDENTIFYING_ATTRIBUTES = [
  "data-testid",
  "data-test",
  "data-qa",
  "data-cy",
  "data-component"
];
function captureElementAttributes(element, names = DEFAULT_IDENTIFYING_ATTRIBUTES) {
  const attributes = {};
  for (const name of [...new Set(names)].slice(0, 16)) {
    if (!/^[a-zA-Z_][\w:.-]*$/.test(name)) continue;
    const value = element.getAttribute(name);
    if (value != null && value.length <= 500) {
      Object.defineProperty(attributes, name, { value, enumerable: true });
    }
  }
  return attributes;
}
function identifyingAttributeSelector(element, names = DEFAULT_IDENTIFYING_ATTRIBUTES) {
  return Object.entries(captureElementAttributes(element, names)).filter(([name, value]) => /^data-[a-z0-9_-]+$/.test(name) && value.length <= 120).slice(0, 2).map(
    ([name, value]) => `[${name}="${value.replace(
      /[\\"\n\r\f\0]/g,
      (char) => char === "\\" || char === '"' ? `\\${char}` : `\\${char.charCodeAt(0).toString(16)} `
    )}"]`
  ).join("");
}

// src/utils/element-identification.ts
function getParentElement(element) {
  if (element.parentElement) {
    return element.parentElement;
  }
  const root = element.getRootNode();
  if (isShadowRoot(root)) {
    return root.host;
  }
  return null;
}
function closestCrossingShadow(element, selector) {
  let current = element;
  while (current) {
    if (current.matches(selector)) return current;
    current = getParentElement(current);
  }
  return null;
}
function isInShadowDOM(element) {
  return isShadowRoot(element.getRootNode());
}
function getShadowHost(element) {
  const root = element.getRootNode();
  if (isShadowRoot(root)) {
    return root.host;
  }
  return null;
}
function getElementPath(target, maxDepth = 4, attributeNames) {
  const parts = [];
  let current = target;
  let depth = 0;
  while (current && depth < maxDepth) {
    const tag = current.tagName.toLowerCase();
    if (tag === "html" || tag === "body") {
      if (parts.length === 0) parts.push(tag);
      break;
    }
    let identifier = tag;
    if (current.id) {
      identifier = `#${current.id}`;
    } else if (current.className && typeof current.className === "string") {
      const meaningfulClass = current.className.split(/\s+/).find((c) => c.length > 2 && !c.match(/^[a-z]{1,2}$/) && !c.match(/[A-Z0-9]{5,}/));
      if (meaningfulClass) {
        identifier = `.${meaningfulClass.split("_")[0]}`;
      }
    }
    identifier += identifyingAttributeSelector(current, attributeNames);
    const nextParent = getParentElement(current);
    if (!current.parentElement && nextParent) {
      identifier = `\u27E8shadow\u27E9 ${identifier}`;
    }
    parts.unshift(identifier);
    current = nextParent;
    depth++;
  }
  const frame = parentFrame(target.ownerDocument);
  return (frame ? getElementPath(frame, 2) + " > \u27E8iframe\u27E9 " : "") + parts.join(" > ");
}
function getDirectTextContent(el) {
  let text = "";
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent?.trim();
      if (t) text += (text ? " " : "") + t;
    }
  }
  return text;
}
function identifyElement(target, attributeNames) {
  const path = getElementPath(target, 4, attributeNames);
  if (target.dataset.element) {
    return { name: target.dataset.element, path };
  }
  const tag = target.tagName.toLowerCase();
  if (["path", "circle", "rect", "line", "g"].includes(tag)) {
    const svg = closestCrossingShadow(target, "svg");
    if (svg) {
      const parent = getParentElement(svg);
      if (parent?.namespaceURI === "http://www.w3.org/1999/xhtml") {
        const parentName = identifyElement(parent).name;
        return { name: `graphic in ${parentName}`, path };
      }
    }
    return { name: "graphic element", path };
  }
  if (tag === "svg") {
    const parent = getParentElement(target);
    if (parent?.tagName.toLowerCase() === "button") {
      const btnText = parent.textContent?.trim();
      return { name: btnText ? `icon in "${btnText}" button` : "button icon", path };
    }
    return { name: "icon", path };
  }
  if (tag === "button") {
    const text = target.textContent?.trim();
    const ariaLabel = target.getAttribute("aria-label");
    if (ariaLabel) return { name: `button [${ariaLabel}]`, path };
    return { name: text ? `button "${text.slice(0, 25)}"` : "button", path };
  }
  if (tag === "a") {
    const text = target.textContent?.trim();
    const href = target.getAttribute("href");
    if (text) return { name: `link "${text.slice(0, 25)}"`, path };
    if (href) return { name: `link to ${href.slice(0, 30)}`, path };
    return { name: "link", path };
  }
  if (tag === "input") {
    const type = target.getAttribute("type") || "text";
    const placeholder = target.getAttribute("placeholder");
    const name = target.getAttribute("name");
    if (placeholder) return { name: `input "${placeholder}"`, path };
    if (name) return { name: `input [${name}]`, path };
    return { name: `${type} input`, path };
  }
  if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
    const text = target.textContent?.trim();
    return { name: text ? `${tag} "${text.slice(0, 35)}"` : tag, path };
  }
  if (tag === "p") {
    const text = target.textContent?.trim();
    if (text) return { name: `paragraph: "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"`, path };
    return { name: "paragraph", path };
  }
  if (tag === "span" || tag === "label") {
    const text = target.textContent?.trim();
    if (text && text.length < 40) return { name: `"${text}"`, path };
    return { name: tag, path };
  }
  if (tag === "li") {
    const text = target.textContent?.trim();
    if (text && text.length < 40) return { name: `list item: "${text.slice(0, 35)}"`, path };
    return { name: "list item", path };
  }
  if (tag === "blockquote") return { name: "blockquote", path };
  if (tag === "code") {
    const text = target.textContent?.trim();
    if (text && text.length < 30) return { name: `code: \`${text}\``, path };
    return { name: "code", path };
  }
  if (tag === "pre") return { name: "code block", path };
  if (tag === "img") {
    const alt = target.getAttribute("alt");
    return { name: alt ? `image "${alt.slice(0, 30)}"` : "image", path };
  }
  if (tag === "video") return { name: "video", path };
  if (["div", "section", "article", "nav", "header", "footer", "aside", "main"].includes(tag)) {
    const className = target.className;
    const role = target.getAttribute("role");
    const ariaLabel = target.getAttribute("aria-label");
    if (ariaLabel) return { name: `${tag} [${ariaLabel}]`, path };
    if (role) return { name: `${role}`, path };
    const directText = getDirectTextContent(target);
    if (directText && directText.length < 50) {
      return { name: `"${directText}"`, path };
    }
    if (typeof className === "string" && className) {
      const words = className.split(/[\s_-]+/).map((c) => c.replace(/[A-Z0-9]{5,}.*$/, "")).filter((c) => c.length > 2 && !/^[a-z]{1,2}$/.test(c)).slice(0, 2);
      if (words.length > 0) return { name: words.join(" "), path };
    }
    return { name: tag === "div" ? "container" : tag, path };
  }
  return { name: tag, path };
}
function getNearbyText(element) {
  const texts = [];
  const ownText = element.textContent?.trim();
  if (ownText && ownText.length < 100) {
    texts.push(ownText);
  }
  const prev = element.previousElementSibling;
  if (prev) {
    const prevText = prev.textContent?.trim();
    if (prevText && prevText.length < 50) {
      texts.unshift(`[before: "${prevText.slice(0, 40)}"]`);
    }
  }
  const next = element.nextElementSibling;
  if (next) {
    const nextText = next.textContent?.trim();
    if (nextText && nextText.length < 50) {
      texts.push(`[after: "${nextText.slice(0, 40)}"]`);
    }
  }
  return texts.join(" ");
}
function identifyAnimationElement(target) {
  if (target.dataset.element) return target.dataset.element;
  const tag = target.tagName.toLowerCase();
  if (tag === "path") return "path";
  if (tag === "circle") return "circle";
  if (tag === "rect") return "rectangle";
  if (tag === "line") return "line";
  if (tag === "ellipse") return "ellipse";
  if (tag === "polygon") return "polygon";
  if (tag === "g") return "group";
  if (tag === "svg") return "svg";
  if (tag === "button") {
    const text = target.textContent?.trim();
    return text ? `button "${text}"` : "button";
  }
  if (tag === "input") {
    const type = target.getAttribute("type") || "text";
    return `input (${type})`;
  }
  if (tag === "span" || tag === "p" || tag === "label") {
    const text = target.textContent?.trim();
    if (text && text.length < 30) return `"${text}"`;
    return "text";
  }
  if (tag === "div") {
    const className = target.className;
    if (typeof className === "string" && className) {
      const words = className.split(/[\s_-]+/).map((c) => c.replace(/[A-Z0-9]{5,}.*$/, "")).filter((c) => c.length > 2 && !/^[a-z]{1,2}$/.test(c)).slice(0, 2);
      if (words.length > 0) {
        return words.join(" ");
      }
    }
    return "container";
  }
  return tag;
}
function getNearbyElements(element) {
  const parent = getParentElement(element);
  if (!parent) return "";
  const elementRoot = element.getRootNode();
  const children = isShadowRoot(elementRoot) && element.parentElement ? Array.from(element.parentElement.children) : Array.from(parent.children);
  const siblings = children.filter(
    (child) => child !== element && child.namespaceURI === "http://www.w3.org/1999/xhtml"
  );
  if (siblings.length === 0) return "";
  const siblingIds = siblings.slice(0, 4).map((sib) => {
    const tag = sib.tagName.toLowerCase();
    const className = sib.className;
    let cls = "";
    if (typeof className === "string" && className) {
      const meaningful = className.split(/\s+/).map((c) => c.replace(/[_][a-zA-Z0-9]{5,}.*$/, "")).find((c) => c.length > 2 && !/^[a-z]{1,2}$/.test(c));
      if (meaningful) cls = `.${meaningful}`;
    }
    if (tag === "button" || tag === "a") {
      const text = sib.textContent?.trim().slice(0, 15);
      if (text) return `${tag}${cls} "${text}"`;
    }
    return `${tag}${cls}`;
  });
  const parentTag = parent.tagName.toLowerCase();
  let parentId = parentTag;
  if (typeof parent.className === "string" && parent.className) {
    const parentCls = parent.className.split(/\s+/).map((c) => c.replace(/[_][a-zA-Z0-9]{5,}.*$/, "")).find((c) => c.length > 2 && !/^[a-z]{1,2}$/.test(c));
    if (parentCls) parentId = `.${parentCls}`;
  }
  const total = parent.children.length;
  const suffix = total > siblingIds.length + 1 ? ` (${total} total in ${parentId})` : "";
  return siblingIds.join(", ") + suffix;
}
function getElementClasses(target) {
  const className = target.className;
  if (typeof className !== "string" || !className) return "";
  const classes = className.split(/\s+/).filter((c) => c.length > 0).map((c) => {
    const match = c.match(/^([a-zA-Z][a-zA-Z0-9_-]*?)(?:_[a-zA-Z0-9]{5,})?$/);
    return match ? match[1] : c;
  }).filter((c, i, arr) => arr.indexOf(c) === i);
  return classes.join(", ");
}
var DEFAULT_STYLE_VALUES = /* @__PURE__ */ new Set([
  "none",
  "normal",
  "auto",
  "0px",
  "rgba(0, 0, 0, 0)",
  "transparent",
  "static",
  "visible"
]);
var TEXT_ELEMENTS = /* @__PURE__ */ new Set([
  "p",
  "span",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "label",
  "li",
  "td",
  "th",
  "blockquote",
  "figcaption",
  "caption",
  "legend",
  "dt",
  "dd",
  "pre",
  "code",
  "em",
  "strong",
  "b",
  "i",
  "a",
  "time",
  "cite",
  "q"
]);
var FORM_INPUT_ELEMENTS = /* @__PURE__ */ new Set(["input", "textarea", "select"]);
var MEDIA_ELEMENTS = /* @__PURE__ */ new Set(["img", "video", "canvas", "svg"]);
var CONTAINER_ELEMENTS = /* @__PURE__ */ new Set([
  "div",
  "section",
  "article",
  "nav",
  "header",
  "footer",
  "aside",
  "main",
  "ul",
  "ol",
  "form",
  "fieldset"
]);
function getDetailedComputedStyles(target) {
  if (typeof window === "undefined") return {};
  const styles = (target.ownerDocument.defaultView ?? window).getComputedStyle(target);
  const result = {};
  const tag = target.tagName.toLowerCase();
  let properties;
  if (TEXT_ELEMENTS.has(tag)) {
    properties = ["color", "fontSize", "fontWeight", "fontFamily", "lineHeight"];
  } else if (tag === "button" || tag === "a" && target.getAttribute("role") === "button") {
    properties = ["backgroundColor", "color", "padding", "borderRadius", "fontSize"];
  } else if (FORM_INPUT_ELEMENTS.has(tag)) {
    properties = ["backgroundColor", "color", "padding", "borderRadius", "fontSize"];
  } else if (MEDIA_ELEMENTS.has(tag)) {
    properties = ["width", "height", "objectFit", "borderRadius"];
  } else if (CONTAINER_ELEMENTS.has(tag)) {
    properties = ["display", "padding", "margin", "gap", "backgroundColor"];
  } else {
    properties = ["color", "fontSize", "margin", "padding", "backgroundColor"];
  }
  for (const prop of properties) {
    const cssPropertyName = prop.replace(/([A-Z])/g, "-$1").toLowerCase();
    const value = styles.getPropertyValue(cssPropertyName);
    if (value && !DEFAULT_STYLE_VALUES.has(value)) {
      result[prop] = value;
    }
  }
  return result;
}
var FORENSIC_PROPERTIES = [
  // Colors
  "color",
  "backgroundColor",
  "borderColor",
  // Typography
  "fontSize",
  "fontWeight",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  // Box model
  "width",
  "height",
  "padding",
  "margin",
  "border",
  "borderRadius",
  // Layout & positioning
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "zIndex",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  // Visual effects
  "opacity",
  "visibility",
  "overflow",
  "boxShadow",
  // Transform
  "transform"
];
function getForensicComputedStyles(target) {
  if (typeof window === "undefined") return "";
  const styles = (target.ownerDocument.defaultView ?? window).getComputedStyle(target);
  const parts = [];
  for (const prop of FORENSIC_PROPERTIES) {
    const cssPropertyName = prop.replace(/([A-Z])/g, "-$1").toLowerCase();
    const value = styles.getPropertyValue(cssPropertyName);
    if (value && !DEFAULT_STYLE_VALUES.has(value)) {
      parts.push(`${cssPropertyName}: ${value}`);
    }
  }
  return parts.join("; ");
}
function parseComputedStylesString(stylesStr) {
  if (!stylesStr) return void 0;
  const result = {};
  const parts = stylesStr.split(";").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const colonIndex = part.indexOf(":");
    if (colonIndex > 0) {
      const key = part.slice(0, colonIndex).trim();
      const value = part.slice(colonIndex + 1).trim();
      if (key && value) {
        result[key] = value;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : void 0;
}
function getAccessibilityInfo(target) {
  const parts = [];
  const role = target.getAttribute("role");
  const ariaLabel = target.getAttribute("aria-label");
  const ariaDescribedBy = target.getAttribute("aria-describedby");
  const tabIndex = target.getAttribute("tabindex");
  const ariaHidden = target.getAttribute("aria-hidden");
  if (role) parts.push(`role="${role}"`);
  if (ariaLabel) parts.push(`aria-label="${ariaLabel}"`);
  if (ariaDescribedBy) parts.push(`aria-describedby="${ariaDescribedBy}"`);
  if (tabIndex) parts.push(`tabindex=${tabIndex}`);
  if (ariaHidden === "true") parts.push("aria-hidden");
  const focusable = target.matches("a, button, input, select, textarea, [tabindex]");
  if (focusable) parts.push("focusable");
  return parts.join(", ");
}
function getFullElementPath(target) {
  const parts = [];
  let current = target;
  while (current && current.tagName.toLowerCase() !== "html") {
    const tag = current.tagName.toLowerCase();
    let identifier = tag;
    if (current.id) {
      identifier = `${tag}#${current.id}`;
    } else if (current.className && typeof current.className === "string") {
      const cls = current.className.split(/\s+/).map((c) => c.replace(/[_][a-zA-Z0-9]{5,}.*$/, "")).find((c) => c.length > 2);
      if (cls) identifier = `${tag}.${cls}`;
    }
    const nextParent = getParentElement(current);
    if (!current.parentElement && nextParent) {
      identifier = `\u27E8shadow\u27E9 ${identifier}`;
    }
    parts.unshift(identifier);
    current = nextParent;
  }
  const frame = parentFrame(target.ownerDocument);
  return (frame ? getFullElementPath(frame) + " > \u27E8iframe\u27E9 " : "") + parts.join(" > ");
}

// src/utils/hit-testing.ts
var TOOLBAR = "agentation-toolbar, [data-agentation-root], [data-feedback-toolbar], [data-annotation-popup], [data-annotation-marker]";
var CONTAINERS = /* @__PURE__ */ new Set([
  "DIV",
  "SPAN",
  "SECTION",
  "ARTICLE",
  "MAIN",
  "ASIDE",
  "HEADER",
  "FOOTER",
  "NAV"
]);
function deepElementFromPoint(x, y) {
  let element = document.elementFromPoint(x, y);
  const visited = /* @__PURE__ */ new Set();
  while (element && !visited.has(element)) {
    visited.add(element);
    const frame = frameDocument(element);
    let deeper;
    if (frame) {
      const box = frameGeometry(element);
      x = (x - box.x) / box.sx;
      y = (y - box.y) / box.sy;
      deeper = frame.elementFromPoint?.(x, y);
    } else deeper = element.shadowRoot?.elementFromPoint?.(x, y);
    if (!deeper || deeper === element) break;
    element = deeper;
  }
  return element;
}
function isVisible(element) {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.visibility === "collapse") return false;
  let current = element;
  while (current) {
    const currentStyle = getComputedStyle(current);
    if (currentStyle.opacity === "0" || currentStyle.display === "none" || currentStyle.contentVisibility === "hidden") return false;
    const root = current.getRootNode();
    current = current.parentElement || (isShadowRoot(root) ? root.host : null);
  }
  return true;
}
function elementsAtPoint(x, y) {
  const candidates = [];
  const seen = /* @__PURE__ */ new Set();
  const visit = (elements, localX, localY) => {
    for (const element of elements) {
      if (seen.has(element)) continue;
      seen.add(element);
      if (element.shadowRoot) {
        const root = element.shadowRoot;
        const inner = root.elementsFromPoint?.(localX, localY) ?? [];
        visit(inner.length ? inner : [root.elementFromPoint?.(localX, localY)].filter(Boolean), localX, localY);
      }
      const frame = frameDocument(element);
      if (frame) {
        const box = frameGeometry(element);
        const childX = (localX - box.x) / box.sx, childY = (localY - box.y) / box.sy;
        visit(frame.elementsFromPoint?.(childX, childY) ?? [frame.elementFromPoint?.(childX, childY)].filter(Boolean), childX, childY);
      }
      if (element !== element.ownerDocument.body && element !== element.ownerDocument.documentElement && !closestCrossingShadow(element, TOOLBAR) && isVisible(element)) {
        candidates.push(element);
      }
    }
  };
  visit(document.elementsFromPoint?.(x, y) ?? [document.elementFromPoint(x, y)].filter(Boolean), x, y);
  return candidates;
}
function annotationElementFromPoint(x, y, box) {
  if (box.width <= 0 || box.height <= 0) return null;
  let best = null;
  let score = Infinity;
  for (const element of elementsAtPoint(x, y)) {
    const rect = viewportRect(element);
    const widthRatio = rect.width / box.width;
    const heightRatio = rect.height / box.height;
    if (widthRatio < 0.5 || widthRatio > 2 || heightRatio < 0.5 || heightRatio > 2) continue;
    const difference = Math.abs(Math.log(widthRatio)) + Math.abs(Math.log(heightRatio));
    if (difference < score) {
      best = element;
      score = difference;
    }
  }
  return best;
}
function pierceElementFromPoint(x, y) {
  const top = deepElementFromPoint(x, y);
  if (!top || closestCrossingShadow(top, TOOLBAR)) return null;
  const candidates = elementsAtPoint(x, y);
  for (const element of candidates) {
    if (!CONTAINERS.has(element.tagName) && !element.shadowRoot || Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) {
      return element;
    }
  }
  let smallest = null;
  let smallestArea = Infinity;
  for (const element of candidates) {
    const rect = viewportRect(element);
    const area = rect.width * rect.height;
    if (area > 0 && area < smallestArea) {
      smallest = element;
      smallestArea = area;
    }
  }
  return smallest;
}

// src/components/page-toolbar-css/index.tsx
var import_react19 = require("react");

// src/utils/page-routing.ts
var import_react2 = require("react");
function usePagePath(useHashLocation) {
  const subscribe = (0, import_react2.useCallback)((notify) => {
    if (!useHashLocation) return () => {
    };
    window.addEventListener("hashchange", notify);
    window.addEventListener("popstate", notify);
    return () => {
      window.removeEventListener("hashchange", notify);
      window.removeEventListener("popstate", notify);
    };
  }, [useHashLocation]);
  return (0, import_react2.useSyncExternalStore)(
    subscribe,
    () => window.location.pathname + (useHashLocation ? window.location.hash : ""),
    () => "/"
  );
}
var pending = /* @__PURE__ */ new Map();
function runPageTask(key, work) {
  const task = (pending.get(key) ?? Promise.resolve()).then(work);
  const settled = task.then(() => {
  }, () => {
  });
  pending.set(key, settled);
  void settled.then(() => {
    if (pending.get(key) === settled) pending.delete(key);
  });
  return task;
}
function matchesPage(url, pathname, origin) {
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin && parsed.pathname + parsed.hash === pathname;
  } catch {
    return false;
  }
}

// src/components/page-toolbar-css/index.tsx
var import_react_dom3 = require("react-dom");

// src/components/page-toolbar-css/use-feedback-portal.ts
var import_react3 = require("react");
var useBrowserLayoutEffect = typeof window === "undefined" ? import_react3.useEffect : import_react3.useLayoutEffect;
function useFeedbackPortal(container) {
  const [portalHost, setPortalHost] = (0, import_react3.useState)(null);
  useBrowserLayoutEffect(() => {
    const host = document.createElement("div");
    host.setAttribute("data-agentation-portal", "");
    host.style.display = "contents";
    setPortalHost(host);
    return () => host.remove();
  }, []);
  useBrowserLayoutEffect(() => {
    if (!portalHost) return;
    const target = container ?? document.body;
    if (target.ownerDocument !== document) {
      console.warn("[Agentation] portalContainer belongs to another document; the toolbar will not render.");
      return;
    }
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    const restoreFocus = focused && portalHost.contains(document.activeElement) ? focused : null;
    if (typeof portalHost.hidePopover === "function" && portalHost.matches(":popover-open"))
      portalHost.hidePopover();
    target.appendChild(portalHost);
    if (container && typeof portalHost.showPopover === "function") {
      portalHost.setAttribute("popover", "manual");
      portalHost.style.cssText = "position:fixed;inset:0 auto auto 0;margin:0;padding:0;border:0;background:transparent;width:0;height:0;overflow:visible;pointer-events:none";
      portalHost.showPopover();
    } else {
      portalHost.removeAttribute("popover");
      portalHost.style.cssText = "display:contents";
    }
    restoreFocus?.focus({ preventScroll: true });
  }, [portalHost, container]);
  return portalHost;
}

// src/components/shadow-root/index.tsx
var import_react4 = require("react");
var import_react_dom = require("react-dom");
var import_jsx_runtime = require("react/jsx-runtime");
var ShadowRoot = ({
  mode = "open",
  delegatesFocus,
  slotAssignment,
  host = "div",
  children,
  className,
  ...hostProps
}) => {
  const hostRef = (0, import_react4.useRef)(null);
  const [shadowContainer, setShadowContainer] = (0, import_react4.useState)(
    null
  );
  (0, import_react4.useLayoutEffect)(() => {
    const hostElement = hostRef.current;
    if (!hostElement || hostElement.shadowRoot) return;
    const shadow = hostElement.attachShadow({
      mode,
      delegatesFocus,
      slotAssignment
    });
    setShadowContainer(shadow);
  }, []);
  const Host = host;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    Host,
    {
      ref: hostRef,
      ...hostProps,
      ...host.includes("-") ? { class: className } : { className },
      children: shadowContainer && (0, import_react_dom.createPortal)(children, shadowContainer)
    }
  );
};

// src/components/annotation-popup-css/index.tsx
var import_react8 = require("react");

// src/hooks/use-exit-completion.ts
var import_react5 = require("react");
function useExitCompletion(ref, exiting, onExited) {
  const onExitedRef = (0, import_react5.useRef)(onExited);
  (0, import_react5.useLayoutEffect)(() => {
    onExitedRef.current = onExited;
  }, [onExited]);
  (0, import_react5.useLayoutEffect)(() => {
    const element = ref.current;
    if (!exiting || !element) return;
    let cancelled = false;
    const animations = element.getAnimations?.() ?? [];
    Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!cancelled) onExitedRef.current();
    });
    return () => {
      cancelled = true;
    };
  }, [ref, exiting]);
}

// src/components/annotation-popup-css/styles.module.scss
var css = '@charset "UTF-8";\n.styles-module__popup___IhzrD svg[fill=none] {\n  fill: none !important;\n}\n.styles-module__popup___IhzrD svg[fill=none] :not([fill]) {\n  fill: none !important;\n}\n\n@keyframes styles-module__popupEnter___AuQDN {\n  from {\n    opacity: 0;\n    transform: translateX(-50%) scale(0.95) translateY(4px);\n  }\n  to {\n    opacity: 1;\n    transform: translateX(-50%) scale(1) translateY(0);\n  }\n}\n@keyframes styles-module__popupExit___JJKQX {\n  from {\n    opacity: 1;\n    transform: translateX(-50%) scale(1) translateY(0);\n  }\n  to {\n    opacity: 0;\n    transform: translateX(-50%) scale(0.95) translateY(4px);\n  }\n}\n@keyframes styles-module__shake___jdbWe {\n  0%, 100% {\n    transform: translateX(-50%) scale(1) translateY(0) translateX(0);\n  }\n  20% {\n    transform: translateX(-50%) scale(1) translateY(0) translateX(-3px);\n  }\n  40% {\n    transform: translateX(-50%) scale(1) translateY(0) translateX(3px);\n  }\n  60% {\n    transform: translateX(-50%) scale(1) translateY(0) translateX(-2px);\n  }\n  80% {\n    transform: translateX(-50%) scale(1) translateY(0) translateX(2px);\n  }\n}\n.styles-module__popup___IhzrD {\n  position: fixed;\n  transform: translateX(-50%);\n  width: 280px;\n  padding: 0.75rem 1rem;\n  background: #1a1a1a;\n  border-radius: 16px;\n  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);\n  z-index: 100001;\n  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  will-change: transform, opacity;\n  opacity: 0;\n}\n.styles-module__popup___IhzrD.styles-module__enter___L7U7N {\n  animation: styles-module__popupEnter___AuQDN 0.2s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;\n}\n.styles-module__popup___IhzrD.styles-module__entered___COX-w {\n  opacity: 1;\n  transform: translateX(-50%) scale(1) translateY(0);\n}\n.styles-module__popup___IhzrD.styles-module__exit___5eGjE {\n  pointer-events: none;\n  animation: styles-module__popupExit___JJKQX 0.15s ease-in forwards;\n}\n.styles-module__popup___IhzrD.styles-module__entered___COX-w.styles-module__shake___jdbWe {\n  animation: styles-module__shake___jdbWe 0.25s ease-out;\n}\n\n.styles-module__header___wWsSi {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin-bottom: 0.5625rem;\n}\n\n.styles-module__element___fTV2z {\n  font-size: 0.75rem;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.5);\n  max-width: 100%;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  flex: 1;\n}\n\n.styles-module__headerToggle___WpW0b {\n  display: flex;\n  align-items: center;\n  gap: 0.25rem;\n  background: none;\n  border: none;\n  padding: 0;\n  cursor: pointer;\n  flex: 1;\n  min-width: 0;\n  text-align: left;\n}\n.styles-module__headerToggle___WpW0b .styles-module__element___fTV2z {\n  flex: 1;\n}\n\n.styles-module__chevron___ZZJlR {\n  color: rgba(255, 255, 255, 0.5);\n  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);\n  flex-shrink: 0;\n}\n.styles-module__chevron___ZZJlR.styles-module__expanded___2Hxgv {\n  transform: rotate(90deg);\n}\n\n.styles-module__stylesWrapper___pnHgy {\n  display: grid;\n  grid-template-rows: 0fr;\n  transition: grid-template-rows 0.3s cubic-bezier(0.16, 1, 0.3, 1);\n}\n.styles-module__stylesWrapper___pnHgy.styles-module__expanded___2Hxgv {\n  grid-template-rows: 1fr;\n}\n\n.styles-module__stylesInner___YYZe2 {\n  overflow: hidden;\n}\n\n.styles-module__stylesBlock___VfQKn {\n  background: rgba(255, 255, 255, 0.05);\n  border-radius: 0.375rem;\n  padding: 0.5rem 0.625rem;\n  margin-bottom: 0.5rem;\n  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;\n  font-size: 0.6875rem;\n  line-height: 1.5;\n}\n\n.styles-module__styleLine___1YQiD {\n  color: rgba(255, 255, 255, 0.85);\n  word-break: break-word;\n}\n\n.styles-module__styleProperty___84L1i {\n  color: #c792ea;\n}\n\n.styles-module__styleValue___q51-h {\n  color: rgba(255, 255, 255, 0.85);\n}\n\n.styles-module__timestamp___Dtpsv {\n  font-size: 0.625rem;\n  font-weight: 500;\n  color: rgba(255, 255, 255, 0.35);\n  font-variant-numeric: tabular-nums;\n  margin-left: 0.5rem;\n  flex-shrink: 0;\n}\n\n.styles-module__quote___mcMmQ {\n  font-size: 12px;\n  font-style: italic;\n  color: rgba(255, 255, 255, 0.6);\n  margin-bottom: 0.5rem;\n  padding: 0.4rem 0.5rem;\n  background: rgba(255, 255, 255, 0.05);\n  border-radius: 0.25rem;\n  line-height: 1.45;\n}\n\n.styles-module__textarea___jrSae {\n  box-sizing: border-box;\n  width: 100%;\n  padding: 0.5rem 0.625rem;\n  font-size: 0.8125rem;\n  font-family: inherit;\n  background: rgba(255, 255, 255, 0.05);\n  color: #fff;\n  border: 1px solid rgba(255, 255, 255, 0.15);\n  border-radius: 8px;\n  resize: none;\n  outline: none;\n  transition: border-color 0.15s ease;\n}\n.styles-module__textarea___jrSae:focus {\n  border-color: var(--agentation-color-blue);\n}\n.styles-module__textarea___jrSae.styles-module__green___99l3h:focus {\n  border-color: var(--agentation-color-green);\n}\n.styles-module__textarea___jrSae::placeholder {\n  color: rgba(255, 255, 255, 0.35);\n}\n.styles-module__textarea___jrSae::-webkit-scrollbar {\n  width: 6px;\n}\n.styles-module__textarea___jrSae::-webkit-scrollbar-track {\n  background: transparent;\n}\n.styles-module__textarea___jrSae::-webkit-scrollbar-thumb {\n  background: rgba(255, 255, 255, 0.2);\n  border-radius: 3px;\n}\n\n.styles-module__actions___D6x3f {\n  display: flex;\n  align-items: center;\n  justify-content: flex-end;\n  gap: 0.375rem;\n  margin-top: 0.75rem;\n}\n\n.styles-module__sourceAction___EabJb {\n  display: block;\n  max-width: 100%;\n  margin: -2px 0 8px;\n  padding: 2px 0;\n  background: transparent;\n  color: #fff;\n  font: inherit;\n  font-size: 11px;\n  border: 0;\n  cursor: pointer;\n  opacity: 0.6;\n  transition: opacity 0.15s ease;\n}\n.styles-module__sourceAction___EabJb:hover, .styles-module__sourceAction___EabJb:focus-visible {\n  opacity: 1;\n}\n.styles-module__sourceAction___EabJb:focus-visible {\n  outline: 2px solid currentColor;\n  outline-offset: 3px;\n}\n\n.styles-module__light___6AaSQ .styles-module__sourceAction___EabJb {\n  color: #111;\n}\n\n.styles-module__cancel___hRjnL,\n.styles-module__submit___K-mIR,\n.styles-module__deleteButton___4VuAE {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  min-height: 1.875rem;\n  padding: 0.375rem 0.875rem;\n  font-size: 0.75rem;\n  font-weight: 500;\n  border-radius: 1rem;\n  border: none;\n  cursor: pointer;\n  transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;\n}\n\n.styles-module__cancel___hRjnL {\n  background: transparent;\n  color: rgba(255, 255, 255, 0.5);\n}\n.styles-module__cancel___hRjnL:hover {\n  background: rgba(255, 255, 255, 0.1);\n  color: rgba(255, 255, 255, 0.8);\n}\n\n.styles-module__submit___K-mIR {\n  color: white;\n}\n.styles-module__submit___K-mIR:hover:not(:disabled) {\n  filter: brightness(0.9);\n}\n.styles-module__submit___K-mIR:disabled {\n  cursor: not-allowed;\n}\n\n.styles-module__deleteWrapper___oSjdo {\n  display: flex;\n  margin-right: auto;\n}\n\n.styles-module__deleteButton___4VuAE {\n  background: transparent;\n  color: rgba(255, 255, 255, 0.4);\n  transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;\n}\n.styles-module__deleteButton___4VuAE:hover {\n  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);\n  color: var(--agentation-color-red);\n}\n.styles-module__deleteButton___4VuAE:active {\n  transform: scale(0.92);\n}\n\n.styles-module__light___6AaSQ.styles-module__popup___IhzrD {\n  background: #fff;\n  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.06);\n}\n.styles-module__light___6AaSQ .styles-module__element___fTV2z {\n  color: rgba(0, 0, 0, 0.6);\n}\n.styles-module__light___6AaSQ .styles-module__timestamp___Dtpsv {\n  color: rgba(0, 0, 0, 0.4);\n}\n.styles-module__light___6AaSQ .styles-module__chevron___ZZJlR {\n  color: rgba(0, 0, 0, 0.4);\n}\n.styles-module__light___6AaSQ .styles-module__stylesBlock___VfQKn {\n  background: rgba(0, 0, 0, 0.03);\n}\n.styles-module__light___6AaSQ .styles-module__styleLine___1YQiD {\n  color: rgba(0, 0, 0, 0.75);\n}\n.styles-module__light___6AaSQ .styles-module__styleProperty___84L1i {\n  color: #7c3aed;\n}\n.styles-module__light___6AaSQ .styles-module__styleValue___q51-h {\n  color: rgba(0, 0, 0, 0.75);\n}\n.styles-module__light___6AaSQ .styles-module__quote___mcMmQ {\n  color: rgba(0, 0, 0, 0.55);\n  background: rgba(0, 0, 0, 0.04);\n}\n.styles-module__light___6AaSQ .styles-module__textarea___jrSae {\n  background: rgba(0, 0, 0, 0.03);\n  color: #1a1a1a;\n  border-color: rgba(0, 0, 0, 0.12);\n}\n.styles-module__light___6AaSQ .styles-module__textarea___jrSae::placeholder {\n  color: rgba(0, 0, 0, 0.4);\n}\n.styles-module__light___6AaSQ .styles-module__textarea___jrSae::-webkit-scrollbar-thumb {\n  background: rgba(0, 0, 0, 0.15);\n}\n.styles-module__light___6AaSQ .styles-module__cancel___hRjnL {\n  color: rgba(0, 0, 0, 0.5);\n}\n.styles-module__light___6AaSQ .styles-module__cancel___hRjnL:hover {\n  background: rgba(0, 0, 0, 0.06);\n  color: rgba(0, 0, 0, 0.75);\n}\n.styles-module__light___6AaSQ .styles-module__deleteButton___4VuAE {\n  color: rgba(0, 0, 0, 0.4);\n}\n.styles-module__light___6AaSQ .styles-module__deleteButton___4VuAE:hover {\n  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);\n  color: var(--agentation-color-red);\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .styles-module__popup___IhzrD.styles-module__enter___L7U7N, .styles-module__popup___IhzrD.styles-module__exit___5eGjE {\n    animation-duration: 1ms;\n    animation-delay: 0ms !important;\n  }\n}\n.styles-module__sharedForm___8GvQl {\n  --card-motion: 200ms cubic-bezier(0.2, 0.8, 0.2, 1);\n  padding: 0.75rem 1rem;\n  transition: padding var(--card-motion);\n}\n.styles-module__sharedForm___8GvQl .styles-module__header___wWsSi {\n  transition: margin-bottom var(--card-motion);\n}\n.styles-module__sharedForm___8GvQl .styles-module__element___fTV2z {\n  font-style: italic;\n  color: rgba(255, 255, 255, 0.6);\n}\n.styles-module__sharedForm___8GvQl .styles-module__previewExcerpt___DCOIL {\n  display: none;\n}\n.styles-module__sharedForm___8GvQl .styles-module__headerToggle___WpW0b .styles-module__chevron___ZZJlR {\n  opacity: 1;\n  margin-left: 0;\n  transition: margin-left var(--card-motion), opacity 100ms ease-out, transform var(--card-motion);\n}\n.styles-module__sharedForm___8GvQl .styles-module__sharedNote___OYVi5 {\n  position: relative;\n  height: var(--editor-field-height, 57px);\n  border-radius: 8px;\n  overflow: clip;\n  transition: height var(--card-motion);\n}\n.styles-module__sharedForm___8GvQl .styles-module__sharedNote___OYVi5::before {\n  content: "";\n  position: absolute;\n  inset: 0;\n  border: 1px solid var(--field-border, rgba(255, 255, 255, 0.15));\n  border-radius: inherit;\n  background: rgba(255, 255, 255, 0.05);\n  pointer-events: none;\n  transition: opacity var(--card-motion), border-color var(--card-motion);\n}\n.styles-module__sharedForm___8GvQl .styles-module__sharedNoteContent___6q3KD {\n  position: relative;\n  width: 100%;\n  height: 100%;\n  overflow: clip;\n  transition: width var(--card-motion);\n}\n.styles-module__sharedForm___8GvQl .styles-module__sharedNote___OYVi5[data-truncated]::after {\n  content: "\u2026";\n  position: absolute;\n  right: 0;\n  top: 0;\n  color: #fff;\n  font-size: 13px;\n  line-height: 1.4;\n  opacity: 0;\n  pointer-events: none;\n  transition: opacity 80ms ease-out;\n}\n.styles-module__sharedForm___8GvQl .styles-module__textarea___jrSae {\n  display: block;\n  width: calc(280px - 2rem);\n  max-width: calc(100vw - 24px - 2rem);\n  margin: 0;\n  background: transparent !important;\n  border-color: transparent !important;\n  transform: translate(0, 0);\n  transition: transform var(--card-motion), color var(--card-motion);\n}\n.styles-module__sharedForm___8GvQl .styles-module__sharedExtra___RUBKC, .styles-module__sharedForm___8GvQl .styles-module__sharedActions___6Glpl {\n  display: grid;\n  grid-template-rows: 1fr;\n  opacity: 1;\n  transition: grid-template-rows var(--card-motion), opacity 80ms ease-out;\n}\n.styles-module__sharedForm___8GvQl .styles-module__sharedActions___6Glpl {\n  transition-delay: 0ms, 120ms;\n}\n.styles-module__sharedForm___8GvQl .styles-module__sharedExtraInner___EuUh4 {\n  min-height: 0;\n  overflow: hidden;\n}\n.styles-module__sharedForm___8GvQl .styles-module__actions___D6x3f {\n  min-height: 0;\n  overflow: hidden;\n  transition: margin-top var(--card-motion);\n}\n.styles-module__sharedForm___8GvQl[data-preview] {\n  padding: 8px 12px;\n}\n.styles-module__sharedForm___8GvQl[data-preview] .styles-module__header___wWsSi {\n  margin-bottom: 5px;\n}\n.styles-module__sharedForm___8GvQl[data-preview] .styles-module__previewExcerpt___DCOIL {\n  display: inline;\n}\n.styles-module__sharedForm___8GvQl[data-preview] .styles-module__element___fTV2z {\n  line-height: 1.4;\n}\n.styles-module__sharedForm___8GvQl[data-preview] .styles-module__chevron___ZZJlR {\n  opacity: 0;\n  margin-left: -18px;\n}\n.styles-module__sharedForm___8GvQl[data-preview] .styles-module__sharedNote___OYVi5 {\n  height: 20.2px;\n  border-radius: 0;\n}\n.styles-module__sharedForm___8GvQl[data-preview] .styles-module__sharedNote___OYVi5::before {\n  opacity: 0;\n}\n.styles-module__sharedForm___8GvQl[data-preview] .styles-module__textarea___jrSae {\n  transform: translate(-11px, calc(-9px + (1.4em - 1lh) / 2));\n  color: #fff;\n  overflow: hidden;\n  cursor: default;\n}\n.styles-module__sharedForm___8GvQl[data-preview] .styles-module__sharedExtra___RUBKC, .styles-module__sharedForm___8GvQl[data-preview] .styles-module__sharedActions___6Glpl {\n  grid-template-rows: 0fr;\n  opacity: 0;\n  transition-delay: 0ms;\n}\n.styles-module__sharedForm___8GvQl[data-preview] .styles-module__actions___D6x3f {\n  margin-top: 0;\n}\n.styles-module__sharedForm___8GvQl[data-preview] .styles-module__stylesWrapper___pnHgy {\n  grid-template-rows: 0fr;\n}\n.styles-module__sharedForm___8GvQl[data-preview] .styles-module__sharedNote___OYVi5[data-truncated] .styles-module__sharedNoteContent___6q3KD {\n  width: calc(100% - 12px);\n}\n.styles-module__sharedForm___8GvQl[data-preview] .styles-module__sharedNote___OYVi5[data-truncated]::after {\n  opacity: 1;\n}\n\n.styles-module__light___6AaSQ .styles-module__sharedForm___8GvQl .styles-module__sharedNote___OYVi5::before {\n  border-color: var(--field-border, rgba(0, 0, 0, 0.12));\n  background: rgba(0, 0, 0, 0.03);\n}\n\n.styles-module__light___6AaSQ .styles-module__sharedForm___8GvQl .styles-module__element___fTV2z {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__light___6AaSQ .styles-module__sharedForm___8GvQl[data-preview] .styles-module__textarea___jrSae, .styles-module__light___6AaSQ .styles-module__sharedForm___8GvQl[data-preview] .styles-module__sharedNote___OYVi5::after {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .styles-module__sharedForm___8GvQl {\n    --card-motion: 1ms linear;\n  }\n  .styles-module__sharedForm___8GvQl .styles-module__sharedActions___6Glpl, .styles-module__sharedForm___8GvQl .styles-module__headerToggle___WpW0b .styles-module__chevron___ZZJlR {\n    transition: opacity 100ms ease-out;\n    transition-delay: 0ms;\n  }\n}';
var styles_module_default = { "popup": "styles-module__popup___IhzrD", "enter": "styles-module__enter___L7U7N", "popupEnter": "styles-module__popupEnter___AuQDN", "entered": "styles-module__entered___COX-w", "exit": "styles-module__exit___5eGjE", "popupExit": "styles-module__popupExit___JJKQX", "shake": "styles-module__shake___jdbWe", "header": "styles-module__header___wWsSi", "element": "styles-module__element___fTV2z", "headerToggle": "styles-module__headerToggle___WpW0b", "chevron": "styles-module__chevron___ZZJlR", "expanded": "styles-module__expanded___2Hxgv", "stylesWrapper": "styles-module__stylesWrapper___pnHgy", "stylesInner": "styles-module__stylesInner___YYZe2", "stylesBlock": "styles-module__stylesBlock___VfQKn", "styleLine": "styles-module__styleLine___1YQiD", "styleProperty": "styles-module__styleProperty___84L1i", "styleValue": "styles-module__styleValue___q51-h", "timestamp": "styles-module__timestamp___Dtpsv", "quote": "styles-module__quote___mcMmQ", "textarea": "styles-module__textarea___jrSae", "green": "styles-module__green___99l3h", "actions": "styles-module__actions___D6x3f", "sourceAction": "styles-module__sourceAction___EabJb", "light": "styles-module__light___6AaSQ", "cancel": "styles-module__cancel___hRjnL", "submit": "styles-module__submit___K-mIR", "deleteButton": "styles-module__deleteButton___4VuAE", "deleteWrapper": "styles-module__deleteWrapper___oSjdo", "sharedForm": "styles-module__sharedForm___8GvQl", "previewExcerpt": "styles-module__previewExcerpt___DCOIL", "sharedNote": "styles-module__sharedNote___OYVi5", "sharedNoteContent": "styles-module__sharedNoteContent___6q3KD", "sharedExtra": "styles-module__sharedExtra___RUBKC", "sharedActions": "styles-module__sharedActions___6Glpl", "sharedExtraInner": "styles-module__sharedExtraInner___EuUh4" };

// src/utils/ensure-styles.ts
var import_react6 = require("react");
var ATTR = "data-agentation-styles";
function ensureStyles(root, id, css13) {
  if (!css13 || !root) return;
  const container = root.nodeType === 9 ? root.head : root.nodeType === 11 ? root : null;
  if (!container || typeof container.querySelector !== "function") return;
  if (container.querySelector(`style[${ATTR}~="toolbar"], style[${ATTR}~="${id}"]`)) return;
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  const style = doc.createElement("style");
  style.setAttribute(ATTR, id);
  style.textContent = css13;
  container.appendChild(style);
}
function useEnsureStyles(id, css13) {
  return (0, import_react6.useCallback)((element) => {
    if (element) ensureStyles(element.getRootNode(), id, css13);
  }, [id, css13]);
}

// src/components/annotation-popup-css/annotation-editor.tsx
var import_react7 = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
function focusBypassingTraps(el) {
  if (!el) return;
  const trap = (e) => e.stopImmediatePropagation();
  document.addEventListener("focusin", trap, true);
  document.addEventListener("focusout", trap, true);
  try {
    el.focus({ preventScroll: true });
  } finally {
    document.removeEventListener("focusin", trap, true);
    document.removeEventListener("focusout", trap, true);
  }
}
var AnnotationEditor = (0, import_react7.forwardRef)(function AnnotationEditor2({
  element,
  timestamp,
  selectedText,
  placeholder = "What should change?",
  initialValue = "",
  submitLabel = "Add",
  onSubmit,
  onCancel,
  onDelete,
  onOpenSource,
  allowEmpty = false,
  accentColor = "#3c82f7",
  computedStyles,
  disabled = false,
  preview = false,
  resetOnPreview = true,
  variant = "popup"
}, ref) {
  const isCard = variant === "card";
  const [text, setText] = (0, import_react7.useState)(initialValue);
  const [isFocused, setIsFocused] = (0, import_react7.useState)(false);
  const [isStylesExpanded, setIsStylesExpanded] = (0, import_react7.useState)(false);
  const textareaRef = (0, import_react7.useRef)(null);
  const formRef = (0, import_react7.useRef)(null);
  const previewExcerpt = selectedText ? ` "${selectedText.slice(0, 30)}${selectedText.length > 30 ? "..." : ""}"` : "";
  (0, import_react7.useLayoutEffect)(() => {
    const form = formRef.current;
    const textarea = textareaRef.current;
    if (!isCard || !form || !textarea) return;
    const measure = () => {
      form.style.setProperty(
        "--editor-field-height",
        `${textarea.offsetHeight}px`
      );
    };
    measure();
    if ("CanvasRenderingContext2D" in window) {
      const context = document.createElement("canvas").getContext("2d");
      if (context) {
        const family = getComputedStyle(textarea).fontFamily;
        context.font = `13px ${family}`;
        const noteWidth = context.measureText(
          initialValue.replace(/\s+/g, " ")
        ).width;
        context.font = `italic 12px ${family}`;
        const headingWidth = context.measureText(
          element + previewExcerpt
        ).width;
        const width = Math.min(
          200,
          Math.max(120, Math.ceil(Math.max(noteWidth, headingWidth)) + 24)
        );
        form.closest("[data-annotation-card]")?.style.setProperty("--preview-width", `${width}px`);
        const note = form.querySelector("[data-shared-note]");
        if (note)
          note.toggleAttribute("data-truncated", noteWidth > width - 24);
      }
    }
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(textarea);
    return () => observer?.disconnect();
  }, [isCard, element, initialValue, previewExcerpt]);
  (0, import_react7.useLayoutEffect)(() => {
    if (preview && resetOnPreview) {
      setText(initialValue);
      setIsStylesExpanded(false);
      if (textareaRef.current) {
        textareaRef.current.scrollTop = 0;
        textareaRef.current.scrollLeft = 0;
      }
    }
  }, [preview, resetOnPreview, initialValue]);
  (0, import_react7.useImperativeHandle)(
    ref,
    () => ({
      focus() {
        const textarea = textareaRef.current;
        focusBypassingTraps(textarea);
        if (textarea) {
          textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
          textarea.scrollTop = isCard ? 0 : textarea.scrollHeight;
        }
      }
    }),
    [isCard]
  );
  const handleSubmit = (0, import_react7.useCallback)(() => {
    if (disabled || !text.trim() && !allowEmpty) return;
    onSubmit(text.trim());
  }, [disabled, text, allowEmpty, onSubmit]);
  const handleKeyDown = (event) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
    if (event.key === "Escape") onCancel();
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    "div",
    {
      ref: formRef,
      className: isCard ? styles_module_default.sharedForm : void 0,
      style: isCard ? void 0 : { display: "contents" },
      "data-annotation-editor": true,
      "data-preview": preview || void 0,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: styles_module_default.header, "data-editor-heading": true, children: [
          computedStyles && Object.keys(computedStyles).length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
            "button",
            {
              className: styles_module_default.headerToggle,
              onClick: () => {
                const wasExpanded = isStylesExpanded;
                setIsStylesExpanded(!isStylesExpanded);
                if (wasExpanded) {
                  originalSetTimeout(
                    () => focusBypassingTraps(textareaRef.current),
                    0
                  );
                }
              },
              type: "button",
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                  "svg",
                  {
                    className: `${styles_module_default.chevron} ${isStylesExpanded ? styles_module_default.expanded : ""}`,
                    width: "14",
                    height: "14",
                    viewBox: "0 0 14 14",
                    fill: "none",
                    xmlns: "http://www.w3.org/2000/svg",
                    children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                      "path",
                      {
                        d: "M5.5 10.25L9 7.25L5.75 4",
                        stroke: "currentColor",
                        strokeWidth: "1.5",
                        strokeLinecap: "round",
                        strokeLinejoin: "round"
                      }
                    )
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: styles_module_default.element, children: [
                  element,
                  isCard && previewExcerpt && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: styles_module_default.previewExcerpt, children: previewExcerpt })
                ] })
              ]
            }
          ) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: styles_module_default.element, children: [
            element,
            isCard && previewExcerpt && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: styles_module_default.previewExcerpt, children: previewExcerpt })
          ] }),
          timestamp && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: styles_module_default.timestamp, children: timestamp })
        ] }),
        onOpenSource && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "div",
          {
            className: isCard ? styles_module_default.sharedExtra : void 0,
            style: isCard ? void 0 : { display: "contents" },
            children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "div",
              {
                className: isCard ? styles_module_default.sharedExtraInner : void 0,
                style: isCard ? void 0 : { display: "contents" },
                children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                  "button",
                  {
                    type: "button",
                    className: styles_module_default.sourceAction,
                    onClick: onOpenSource,
                    children: "Open in editor"
                  }
                )
              }
            )
          }
        ),
        computedStyles && Object.keys(computedStyles).length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "div",
          {
            className: `${styles_module_default.stylesWrapper} ${isStylesExpanded ? styles_module_default.expanded : ""}`,
            children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: styles_module_default.stylesInner, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: styles_module_default.stylesBlock, children: Object.entries(computedStyles).map(([key, value]) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: styles_module_default.styleLine, children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: styles_module_default.styleProperty, children: key.replace(/([A-Z])/g, "-$1").toLowerCase() }),
              ": ",
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: styles_module_default.styleValue, children: value }),
              ";"
            ] }, key)) }) })
          }
        ),
        selectedText && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "div",
          {
            className: isCard ? styles_module_default.sharedExtra : void 0,
            style: isCard ? void 0 : { display: "contents" },
            children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "div",
              {
                className: isCard ? styles_module_default.sharedExtraInner : void 0,
                style: isCard ? void 0 : { display: "contents" },
                children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: styles_module_default.quote, children: [
                  "\u201C",
                  selectedText.slice(0, 80),
                  selectedText.length > 80 ? "..." : "",
                  "\u201D"
                ] })
              }
            )
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "div",
          {
            "data-shared-note": true,
            className: isCard ? styles_module_default.sharedNote : void 0,
            style: isCard ? {
              "--field-border": isFocused ? accentColor : void 0
            } : { display: "contents" },
            children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
              "div",
              {
                className: isCard ? styles_module_default.sharedNoteContent : void 0,
                style: isCard ? void 0 : { display: "contents" },
                children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                  "textarea",
                  {
                    ref: textareaRef,
                    className: styles_module_default.textarea,
                    readOnly: preview,
                    "aria-hidden": preview,
                    style: isCard ? void 0 : { borderColor: isFocused ? accentColor : void 0 },
                    placeholder,
                    value: preview ? text.replace(/\s+/g, " ") : text,
                    onChange: (e) => setText(e.target.value),
                    onFocus: () => setIsFocused(true),
                    onBlur: () => setIsFocused(false),
                    rows: 2,
                    onKeyDown: handleKeyDown
                  }
                )
              }
            )
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "div",
          {
            "data-editor-actions": true,
            className: isCard ? styles_module_default.sharedActions : void 0,
            style: isCard ? void 0 : { display: "contents" },
            children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: styles_module_default.actions, children: [
              onDelete && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: styles_module_default.deleteWrapper, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "button",
                {
                  className: styles_module_default.deleteButton,
                  onClick: onDelete,
                  type: "button",
                  "aria-label": "Delete annotation",
                  children: "Delete"
                }
              ) }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { className: styles_module_default.cancel, onClick: onCancel, children: "Cancel" }),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "button",
                {
                  className: styles_module_default.submit,
                  style: {
                    backgroundColor: accentColor,
                    opacity: text.trim() || allowEmpty ? 1 : 0.4
                  },
                  onClick: handleSubmit,
                  disabled: disabled || !text.trim() && !allowEmpty,
                  children: submitLabel
                }
              )
            ] })
          }
        )
      ]
    }
  );
});

// src/components/annotation-popup-css/index.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
var AnnotationPopupCSS = (0, import_react8.forwardRef)(
  function AnnotationPopupCSS2({
    element,
    timestamp,
    selectedText,
    placeholder = "What should change?",
    initialValue = "",
    submitLabel = "Add",
    onSubmit,
    onCancel,
    onDelete,
    onOpenSource,
    allowEmpty = false,
    style,
    accentColor = "#3c82f7",
    isExiting = false,
    onExitComplete,
    lightMode = false,
    computedStyles
  }, ref) {
    const [isShaking, setIsShaking] = (0, import_react8.useState)(false);
    const [animState, setAnimState] = (0, import_react8.useState)("initial");
    const editorRef = (0, import_react8.useRef)(null);
    const popupRef = (0, import_react8.useRef)(null);
    (0, import_react8.useEffect)(() => {
      ensureStyles(popupRef.current?.getRootNode(), "annotation-popup", css);
    }, []);
    const shakeTimerRef = (0, import_react8.useRef)(null);
    (0, import_react8.useEffect)(() => {
      const startTimer = originalSetTimeout(() => {
        setAnimState((previous) => previous === "initial" ? "enter" : previous);
      }, 0);
      return () => {
        clearTimeout(startTimer);
        if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
      };
    }, []);
    (0, import_react8.useEffect)(() => {
      if (isExiting) return;
      const timer = originalSetTimeout(() => editorRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }, [isExiting]);
    const shake = (0, import_react8.useCallback)(() => {
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
      setIsShaking(true);
      shakeTimerRef.current = originalSetTimeout(() => {
        setIsShaking(false);
        editorRef.current?.focus();
      }, 250);
    }, []);
    (0, import_react8.useImperativeHandle)(ref, () => ({
      shake
    }), [shake]);
    const handleCancel = (0, import_react8.useCallback)(() => {
      if (onExitComplete) {
        onCancel();
        return;
      }
      setAnimState("exit");
    }, [onCancel, onExitComplete]);
    const visibleAnimState = isExiting ? "exit" : animState;
    useExitCompletion(popupRef, visibleAnimState === "exit", () => {
      if (isExiting) onExitComplete?.();
      else onCancel();
    });
    const popupClassName = [
      styles_module_default.popup,
      lightMode ? styles_module_default.light : "",
      visibleAnimState === "enter" ? styles_module_default.enter : "",
      visibleAnimState === "entered" ? styles_module_default.entered : "",
      visibleAnimState === "exit" ? styles_module_default.exit : "",
      isShaking && visibleAnimState !== "exit" ? styles_module_default.shake : ""
    ].filter(Boolean).join(" ");
    return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
      "div",
      {
        ref: popupRef,
        className: popupClassName,
        "data-annotation-popup": true,
        style,
        onAnimationEnd: (event) => {
          if (event.target !== event.currentTarget) return;
          if (event.animationName.includes("popupEnter") && !isExiting) {
            setAnimState("entered");
          }
        },
        onKeyDownCapture: (event) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          handleCancel();
        },
        onClick: (e) => e.stopPropagation(),
        children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          AnnotationEditor,
          {
            ref: editorRef,
            element,
            timestamp,
            selectedText,
            placeholder,
            initialValue,
            submitLabel,
            onSubmit,
            onCancel: handleCancel,
            onDelete,
            onOpenSource,
            allowEmpty,
            accentColor,
            computedStyles,
            disabled: visibleAnimState === "exit"
          }
        )
      }
    );
  }
);

// src/components/icon-transitions.module.scss
var css2 = ".icon-transitions-module__iconState___uqK9J {\n  transition: opacity 0.2s ease, transform 0.2s ease;\n  transform-origin: center;\n}\n\n.icon-transitions-module__iconStateFast___HxlMm {\n  transition: opacity 0.15s ease, transform 0.15s ease;\n  transform-origin: center;\n}\n\n.icon-transitions-module__iconFade___nPwXg {\n  transition: opacity 0.2s ease;\n}\n\n.icon-transitions-module__iconFadeFast___Ofb2t {\n  transition: opacity 0.15s ease;\n}\n\n.icon-transitions-module__visible___PlHsU {\n  opacity: 1 !important;\n}\n\n.icon-transitions-module__visibleScaled___8Qog- {\n  opacity: 1 !important;\n  transform: scale(1);\n}\n\n.icon-transitions-module__hidden___ETykt {\n  opacity: 0 !important;\n}\n\n.icon-transitions-module__hiddenScaled___JXn-m {\n  opacity: 0 !important;\n  transform: scale(0.8);\n}\n\n.icon-transitions-module__sending___uaLN- {\n  opacity: 0.5 !important;\n  transform: scale(0.8);\n}";
var icon_transitions_module_default = { "iconState": "icon-transitions-module__iconState___uqK9J", "iconStateFast": "icon-transitions-module__iconStateFast___HxlMm", "iconFade": "icon-transitions-module__iconFade___nPwXg", "iconFadeFast": "icon-transitions-module__iconFadeFast___Ofb2t", "visible": "icon-transitions-module__visible___PlHsU", "visibleScaled": "icon-transitions-module__visibleScaled___8Qog-", "hidden": "icon-transitions-module__hidden___ETykt", "hiddenScaled": "icon-transitions-module__hiddenScaled___JXn-m", "sending": "icon-transitions-module__sending___uaLN-" };

// src/components/icons.tsx
var import_jsx_runtime4 = require("react/jsx-runtime");
var IconClose = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
  "path",
  {
    d: "M4 4l8 8M12 4l-8 8",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round"
  }
) });
var IconPlus = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
  "path",
  {
    d: "M8 3v10M3 8h10",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round"
  }
) });
var IconCheck = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
  "path",
  {
    d: "M3 8l3.5 3.5L13 5",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }
) });
var IconCheckSmall = ({ size = 14 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("svg", { width: size, height: size, viewBox: "0 0 14 14", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
  "path",
  {
    d: "M3.9375 7L6.125 9.1875L10.5 4.8125",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }
) });
var IconListSparkle = ({
  size = 24,
  style = {}
}) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", style, children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("g", { clipPath: "url(#clip0_list_sparkle)", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M11.5 12L5.5 12",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M18.5 6.75L5.5 6.75",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M9.25 17.25L5.5 17.25",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M16 12.75L16.5179 13.9677C16.8078 14.6494 17.3506 15.1922 18.0323 15.4821L19.25 16L18.0323 16.5179C17.3506 16.8078 16.8078 17.3506 16.5179 18.0323L16 19.25L15.4821 18.0323C15.1922 17.3506 14.6494 16.8078 13.9677 16.5179L12.75 16L13.9677 15.4821C14.6494 15.1922 15.1922 14.6494 15.4821 13.9677L16 12.75Z",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinejoin: "round"
      }
    )
  ] }),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("defs", { children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("clipPath", { id: "clip0_list_sparkle", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("rect", { width: "24", height: "24", fill: "white" }) }) })
] });
var IconHelp = ({
  size = 20,
  ...props
}) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 20 20",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    ...props,
    children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "circle",
        {
          cx: "10",
          cy: "10",
          r: "5.375",
          stroke: "currentColor",
          strokeWidth: "1.25"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "path",
        {
          d: "M8.5 8.5C8.73 7.85 9.31 7.49 10 7.5C10.86 7.51 11.5 8.13 11.5 9C11.5 10.08 10 10.5 10 10.5V10.75",
          stroke: "currentColor",
          strokeWidth: "1.25",
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("circle", { cx: "10", cy: "12.625", r: "0.625", fill: "currentColor" })
    ]
  }
);
var IconCheckSmallAnimated = ({ size = 14 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 14 14", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("style", { children: `
      @keyframes checkDraw {
        0% {
          stroke-dashoffset: 12;
        }
        100% {
          stroke-dashoffset: 0;
        }
      }
      @keyframes checkBounce {
        0% {
          transform: scale(0.5);
          opacity: 0;
        }
        50% {
          transform: scale(1.12);
          opacity: 1;
        }
        75% {
          transform: scale(0.95);
        }
        100% {
          transform: scale(1);
        }
      }
      .check-path-animated {
        stroke-dasharray: 12;
        stroke-dashoffset: 0;
        transform-origin: center;
        animation: checkDraw 0.18s ease-out, checkBounce 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
    ` }),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      className: "check-path-animated",
      d: "M3.9375 7L6.125 9.1875L10.5 4.8125",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  )
] });
var IconCopyAlt = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M4.75 11.25C4.75 10.4216 5.42157 9.75 6.25 9.75H12.75C13.5784 9.75 14.25 10.4216 14.25 11.25V17.75C14.25 18.5784 13.5784 19.25 12.75 19.25H6.25C5.42157 19.25 4.75 18.5784 4.75 17.75V11.25Z",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M17.25 14.25H17.75C18.5784 14.25 19.25 13.5784 19.25 12.75V6.25C19.25 5.42157 18.5784 4.75 17.75 4.75H11.25C10.4216 4.75 9.75 5.42157 9.75 6.25V6.75",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round"
    }
  )
] });
var IconCopyAnimated = ({
  size = 24,
  copied = false,
  tint
}) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { ref: useEnsureStyles("icon-transitions", css2), width: size, height: size, viewBox: "0 0 24 24", fill: "none", style: tint ? { color: tint, transition: "color 0.3s ease" } : void 0, children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
    "g",
    {
      className: `${icon_transitions_module_default.iconState} ${copied ? icon_transitions_module_default.hiddenScaled : icon_transitions_module_default.visibleScaled}`,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "path",
          {
            d: "M4.75 11.25C4.75 10.4216 5.42157 9.75 6.25 9.75H12.75C13.5784 9.75 14.25 10.4216 14.25 11.25V17.75C14.25 18.5784 13.5784 19.25 12.75 19.25H6.25C5.42157 19.25 4.75 18.5784 4.75 17.75V11.25Z",
            stroke: "currentColor",
            strokeWidth: "1.5"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "path",
          {
            d: "M17.25 14.25H17.75C18.5784 14.25 19.25 13.5784 19.25 12.75V6.25C19.25 5.42157 18.5784 4.75 17.75 4.75H11.25C10.4216 4.75 9.75 5.42157 9.75 6.25V6.75",
            stroke: "currentColor",
            strokeWidth: "1.5",
            strokeLinecap: "round"
          }
        )
      ]
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
    "g",
    {
      className: `${icon_transitions_module_default.iconState} ${copied ? icon_transitions_module_default.visibleScaled : icon_transitions_module_default.hiddenScaled}`,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "path",
          {
            d: "M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z",
            stroke: "var(--agentation-color-green)",
            strokeWidth: "1.5",
            strokeLinecap: "round",
            strokeLinejoin: "round"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "path",
          {
            d: "M15 10L11 14.25L9.25 12.25",
            stroke: "var(--agentation-color-green)",
            strokeWidth: "1.5",
            strokeLinecap: "round",
            strokeLinejoin: "round"
          }
        )
      ]
    }
  )
] });
var IconSendArrow = ({
  size = 24,
  state = "idle"
}) => {
  const showArrow = state === "idle";
  const showCheck = state === "sent";
  const showError = state === "failed";
  const isSending = state === "sending";
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "g",
      {
        className: `${icon_transitions_module_default.iconStateFast} ${showArrow ? icon_transitions_module_default.visibleScaled : isSending ? icon_transitions_module_default.sending : icon_transitions_module_default.hiddenScaled}`,
        children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "path",
          {
            d: "M9.875 14.125L12.3506 19.6951C12.7184 20.5227 13.9091 20.4741 14.2083 19.6193L18.8139 6.46032C19.0907 5.6695 18.3305 4.90933 17.5397 5.18611L4.38072 9.79174C3.52589 10.0909 3.47731 11.2816 4.30494 11.6494L9.875 14.125ZM9.875 14.125L13.375 10.625",
            stroke: "currentColor",
            strokeWidth: "1.5",
            strokeLinecap: "round",
            strokeLinejoin: "round"
          }
        )
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
      "g",
      {
        className: `${icon_transitions_module_default.iconStateFast} ${showCheck ? icon_transitions_module_default.visibleScaled : icon_transitions_module_default.hiddenScaled}`,
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "path",
            {
              d: "M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z",
              stroke: "var(--agentation-color-green)",
              strokeWidth: "1.5",
              strokeLinecap: "round",
              strokeLinejoin: "round"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "path",
            {
              d: "M15 10L11 14.25L9.25 12.25",
              stroke: "var(--agentation-color-green)",
              strokeWidth: "1.5",
              strokeLinecap: "round",
              strokeLinejoin: "round"
            }
          )
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
      "g",
      {
        className: `${icon_transitions_module_default.iconStateFast} ${showError ? icon_transitions_module_default.visibleScaled : icon_transitions_module_default.hiddenScaled}`,
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "path",
            {
              d: "M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z",
              stroke: "var(--agentation-color-red)",
              strokeWidth: "1.5",
              strokeLinecap: "round",
              strokeLinejoin: "round"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "path",
            {
              d: "M12 8V12",
              stroke: "var(--agentation-color-red)",
              strokeWidth: "1.5",
              strokeLinecap: "round"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
            "circle",
            {
              cx: "12",
              cy: "15",
              r: "0.5",
              fill: "var(--agentation-color-red)",
              stroke: "var(--agentation-color-red)",
              strokeWidth: "1"
            }
          )
        ]
      }
    )
  ] });
};
var IconSendAnimated = ({
  size = 24,
  sent = false
}) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { ref: useEnsureStyles("icon-transitions", css2), width: size, height: size, viewBox: "0 0 22 21", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("g", { className: `${icon_transitions_module_default.iconState} ${sent ? icon_transitions_module_default.hiddenScaled : icon_transitions_module_default.visibleScaled}`, children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M9.5 5H6.5C4.84315 5 3.5 6.34315 3.5 8V15C3.5 16.6569 4.84315 18 6.5 18H13.5C15.1569 18 16.5 16.6569 16.5 15V12",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M13.5 8.5L18.5 3.5M18.5 3.5L14.4524 3.5M18.5 3.5L18.5 7.54762",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M7.5 13.75H12.5",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M7.5 10.75H10.5",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    )
  ] }),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("g", { className: `${icon_transitions_module_default.iconState} ${sent ? icon_transitions_module_default.visibleScaled : icon_transitions_module_default.hiddenScaled}`, children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M11 19C6.58172 19 3 15.4182 3 11C3 6.58172 6.58172 3 11 3C15.4182 3 19 6.58172 19 11C19 15.4182 15.4182 19 11 19Z",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M14 9L10 13.25L8.25 11.25",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    )
  ] })
] });
var IconEye = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M4.91516 12.7108C4.63794 12.2883 4.63705 11.7565 4.91242 11.3328C5.84146 9.9033 8.30909 6.74994 12 6.74994C15.6909 6.74994 18.1585 9.9033 19.0876 11.3328C19.3629 11.7565 19.3621 12.2883 19.0848 12.7108C18.1537 14.13 15.6873 17.2499 12 17.2499C8.31272 17.2499 5.8463 14.13 4.91516 12.7108Z",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M12 14.25C13.2426 14.25 14.25 13.2426 14.25 12C14.25 10.7574 13.2426 9.75 12 9.75C10.7574 9.75 9.75 10.7574 9.75 12C9.75 13.2426 10.7574 14.25 12 14.25Z",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  )
] });
var IconEyeAlt = ({ size = 24 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M3.91752 12.7539C3.65127 12.2996 3.65037 11.7515 3.9149 11.2962C4.9042 9.59346 7.72688 5.49994 12 5.49994C16.2731 5.49994 19.0958 9.59346 20.0851 11.2962C20.3496 11.7515 20.3487 12.2996 20.0825 12.7539C19.0908 14.4459 16.2694 18.4999 12 18.4999C7.73064 18.4999 4.90918 14.4459 3.91752 12.7539Z",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M12 14.8261C13.5608 14.8261 14.8261 13.5608 14.8261 12C14.8261 10.4392 13.5608 9.17392 12 9.17392C10.4392 9.17392 9.17391 10.4392 9.17391 12C9.17391 13.5608 10.4392 14.8261 12 14.8261Z",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  )
] });
var IconEyeClosed = ({ size = 24 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M18.6025 9.28503C18.9174 8.9701 19.4364 8.99481 19.7015 9.35271C20.1484 9.95606 20.4943 10.507 20.7342 10.9199C21.134 11.6086 21.1329 12.4454 20.7303 13.1328C20.2144 14.013 19.2151 15.5225 17.7723 16.8193C16.3293 18.1162 14.3852 19.2497 12.0008 19.25C11.4192 19.25 10.8638 19.1823 10.3355 19.0613C9.77966 18.934 9.63498 18.2525 10.0382 17.8493C10.2412 17.6463 10.5374 17.573 10.8188 17.6302C11.1993 17.7076 11.5935 17.75 12.0008 17.75C13.8848 17.7497 15.4867 16.8568 16.7693 15.7041C18.0522 14.5511 18.9606 13.1867 19.4363 12.375C19.5656 12.1543 19.5659 11.8943 19.4373 11.6729C19.2235 11.3049 18.921 10.8242 18.5364 10.3003C18.3085 9.98991 18.3302 9.5573 18.6025 9.28503ZM12.0008 4.75C12.5814 4.75006 13.1358 4.81803 13.6632 4.93953C14.2182 5.06741 14.362 5.74812 13.9593 6.15091C13.7558 6.35435 13.4589 6.42748 13.1771 6.36984C12.7983 6.29239 12.4061 6.25006 12.0008 6.25C10.1167 6.25 8.51415 7.15145 7.23028 8.31543C5.94678 9.47919 5.03918 10.8555 4.56426 11.6729C4.43551 11.8945 4.43582 12.1542 4.56524 12.375C4.77587 12.7343 5.07189 13.2012 5.44718 13.7105C5.67623 14.0213 5.65493 14.4552 5.38193 14.7282C5.0671 15.0431 4.54833 15.0189 4.28292 14.6614C3.84652 14.0736 3.50813 13.5369 3.27129 13.1328C2.86831 12.4451 2.86717 11.6088 3.26739 10.9199C3.78185 10.0345 4.77959 8.51239 6.22247 7.2041C7.66547 5.89584 9.61202 4.75 12.0008 4.75Z",
      fill: "currentColor"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M5 19L19 5",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round"
    }
  )
] });
var IconEyeAnimated = ({
  size = 24,
  isOpen = true
}) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { ref: useEnsureStyles("icon-transitions", css2), width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("g", { className: `${icon_transitions_module_default.iconFade} ${isOpen ? icon_transitions_module_default.visible : icon_transitions_module_default.hidden}`, children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M3.91752 12.7539C3.65127 12.2996 3.65037 11.7515 3.9149 11.2962C4.9042 9.59346 7.72688 5.49994 12 5.49994C16.2731 5.49994 19.0958 9.59346 20.0851 11.2962C20.3496 11.7515 20.3487 12.2996 20.0825 12.7539C19.0908 14.4459 16.2694 18.4999 12 18.4999C7.73064 18.4999 4.90918 14.4459 3.91752 12.7539Z",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M12 14.8261C13.5608 14.8261 14.8261 13.5608 14.8261 12C14.8261 10.4392 13.5608 9.17392 12 9.17392C10.4392 9.17392 9.17391 10.4392 9.17391 12C9.17391 13.5608 10.4392 14.8261 12 14.8261Z",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    )
  ] }),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("g", { className: `${icon_transitions_module_default.iconFade} ${isOpen ? icon_transitions_module_default.hidden : icon_transitions_module_default.visible}`, children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M18.6025 9.28503C18.9174 8.9701 19.4364 8.99481 19.7015 9.35271C20.1484 9.95606 20.4943 10.507 20.7342 10.9199C21.134 11.6086 21.1329 12.4454 20.7303 13.1328C20.2144 14.013 19.2151 15.5225 17.7723 16.8193C16.3293 18.1162 14.3852 19.2497 12.0008 19.25C11.4192 19.25 10.8638 19.1823 10.3355 19.0613C9.77966 18.934 9.63498 18.2525 10.0382 17.8493C10.2412 17.6463 10.5374 17.573 10.8188 17.6302C11.1993 17.7076 11.5935 17.75 12.0008 17.75C13.8848 17.7497 15.4867 16.8568 16.7693 15.7041C18.0522 14.5511 18.9606 13.1867 19.4363 12.375C19.5656 12.1543 19.5659 11.8943 19.4373 11.6729C19.2235 11.3049 18.921 10.8242 18.5364 10.3003C18.3085 9.98991 18.3302 9.5573 18.6025 9.28503ZM12.0008 4.75C12.5814 4.75006 13.1358 4.81803 13.6632 4.93953C14.2182 5.06741 14.362 5.74812 13.9593 6.15091C13.7558 6.35435 13.4589 6.42748 13.1771 6.36984C12.7983 6.29239 12.4061 6.25006 12.0008 6.25C10.1167 6.25 8.51415 7.15145 7.23028 8.31543C5.94678 9.47919 5.03918 10.8555 4.56426 11.6729C4.43551 11.8945 4.43582 12.1542 4.56524 12.375C4.77587 12.7343 5.07189 13.2012 5.44718 13.7105C5.67623 14.0213 5.65493 14.4552 5.38193 14.7282C5.0671 15.0431 4.54833 15.0189 4.28292 14.6614C3.84652 14.0736 3.50813 13.5369 3.27129 13.1328C2.86831 12.4451 2.86717 11.6088 3.26739 10.9199C3.78185 10.0345 4.77959 8.51239 6.22247 7.2041C7.66547 5.89584 9.61202 4.75 12.0008 4.75Z",
        fill: "currentColor"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M5 19L19 5",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    )
  ] })
] });
var IconPausePlayAnimated = ({
  size = 24,
  isPaused = false
}) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { ref: useEnsureStyles("icon-transitions", css2), width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("g", { className: `${icon_transitions_module_default.iconFadeFast} ${isPaused ? icon_transitions_module_default.hidden : icon_transitions_module_default.visible}`, children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M8 6L8 18",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M16 18L16 6",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    )
  ] }),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      className: `${icon_transitions_module_default.iconFadeFast} ${isPaused ? icon_transitions_module_default.visible : icon_transitions_module_default.hidden}`,
      d: "M17.75 10.701C18.75 11.2783 18.75 12.7217 17.75 13.299L8.75 18.4952C7.75 19.0725 6.5 18.3509 6.5 17.1962L6.5 6.80384C6.5 5.64914 7.75 4.92746 8.75 5.50481L17.75 10.701Z",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }
  )
] });
var IconEyeMinus = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M4.91516 12.7108C4.63794 12.2883 4.63705 11.7565 4.91242 11.3328C5.84146 9.9033 8.30909 6.74994 12 6.74994C15.6909 6.74994 18.1585 9.9033 19.0876 11.3328C19.3629 11.7565 19.3621 12.2883 19.0848 12.7108C18.1537 14.13 15.6873 17.2499 12 17.2499C8.31272 17.2499 5.8463 14.13 4.91516 12.7108Z",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M9 12H15",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round"
    }
  )
] });
var IconGear = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M10.6504 5.81117C10.9939 4.39628 13.0061 4.39628 13.3496 5.81117C13.5715 6.72517 14.6187 7.15891 15.4219 6.66952C16.6652 5.91193 18.0881 7.33479 17.3305 8.57815C16.8411 9.38134 17.2748 10.4285 18.1888 10.6504C19.6037 10.9939 19.6037 13.0061 18.1888 13.3496C17.2748 13.5715 16.8411 14.6187 17.3305 15.4219C18.0881 16.6652 16.6652 18.0881 15.4219 17.3305C14.6187 16.8411 13.5715 17.2748 13.3496 18.1888C13.0061 19.6037 10.9939 19.6037 10.6504 18.1888C10.4285 17.2748 9.38135 16.8411 8.57815 17.3305C7.33479 18.0881 5.91193 16.6652 6.66952 15.4219C7.15891 14.6187 6.72517 13.5715 5.81117 13.3496C4.39628 13.0061 4.39628 10.9939 5.81117 10.6504C6.72517 10.4285 7.15891 9.38134 6.66952 8.57815C5.91193 7.33479 7.33479 5.91192 8.57815 6.66952C9.38135 7.15891 10.4285 6.72517 10.6504 5.81117Z",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("circle", { cx: "12", cy: "12", r: "2.5", stroke: "currentColor", strokeWidth: "1.5" })
] });
var IconPauseAlt = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M9.25 5.75C9.80228 5.75 10.25 6.19772 10.25 6.75L10.25 17.25C10.25 17.8023 9.80228 18.25 9.25 18.25L6.75 18.25C6.19772 18.25 5.75 17.8023 5.75 17.25L5.75 6.75C5.75 6.19772 6.19772 5.75 6.75 5.75L9.25 5.75Z",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M17.25 5.75C17.8023 5.75 18.25 6.19772 18.25 6.75L18.25 17.25C18.25 17.8023 17.8023 18.25 17.25 18.25L14.75 18.25C14.1977 18.25 13.75 17.8023 13.75 17.25L13.75 6.75C13.75 6.19772 14.1977 5.75 14.75 5.75L17.25 5.75Z",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }
  )
] });
var IconPause = ({ size = 24 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M8 6L8 18",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M16 18L16 6",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round"
    }
  )
] });
var IconPlayAlt = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
  "path",
  {
    d: "M17.75 10.701C18.75 11.2783 18.75 12.7217 17.75 13.299L8.75 18.4952C7.75 19.0725 6.5 18.3509 6.5 17.1962L6.5 6.80384C6.5 5.64914 7.75 4.92746 8.75 5.50481L17.75 10.701Z",
    stroke: "currentColor",
    strokeWidth: "1.5"
  }
) });
var IconTrashAlt = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
  "path",
  {
    d: "M13.5 4C14.7426 4 15.75 5.00736 15.75 6.25V7H18.5C18.9142 7 19.25 7.33579 19.25 7.75C19.25 8.16421 18.9142 8.5 18.5 8.5H17.9678L17.6328 16.2217C17.61 16.7475 17.5912 17.1861 17.5469 17.543C17.5015 17.9087 17.4225 18.2506 17.2461 18.5723C16.9747 19.0671 16.5579 19.4671 16.0518 19.7168C15.7227 19.8791 15.3772 19.9422 15.0098 19.9717C14.6514 20.0004 14.2126 20 13.6865 20H10.3135C9.78735 20 9.34856 20.0004 8.99023 19.9717C8.62278 19.9422 8.27729 19.8791 7.94824 19.7168C7.44205 19.4671 7.02532 19.0671 6.75391 18.5723C6.57751 18.2506 6.49853 17.9087 6.45312 17.543C6.40883 17.1861 6.39005 16.7475 6.36719 16.2217L6.03223 8.5H5.5C5.08579 8.5 4.75 8.16421 4.75 7.75C4.75 7.33579 5.08579 7 5.5 7H8.25V6.25C8.25 5.00736 9.25736 4 10.5 4H13.5ZM7.86621 16.1562C7.89013 16.7063 7.90624 17.0751 7.94141 17.3584C7.97545 17.6326 8.02151 17.7644 8.06934 17.8516C8.19271 18.0763 8.38239 18.2577 8.6123 18.3711C8.70153 18.4151 8.83504 18.4545 9.11035 18.4766C9.39482 18.4994 9.76335 18.5 10.3135 18.5H13.6865C14.2367 18.5 14.6052 18.4994 14.8896 18.4766C15.165 18.4545 15.2985 18.4151 15.3877 18.3711C15.6176 18.2577 15.8073 18.0763 15.9307 17.8516C15.9785 17.7644 16.0245 17.6326 16.0586 17.3584C16.0938 17.0751 16.1099 16.7063 16.1338 16.1562L16.4668 8.5H7.5332L7.86621 16.1562ZM9.97656 10.75C10.3906 10.7371 10.7371 11.0626 10.75 11.4766L10.875 15.4766C10.8879 15.8906 10.5624 16.2371 10.1484 16.25C9.73443 16.2629 9.38794 15.9374 9.375 15.5234L9.25 11.5234C9.23706 11.1094 9.56255 10.7629 9.97656 10.75ZM14.0244 10.75C14.4384 10.7635 14.7635 11.1105 14.75 11.5244L14.6201 15.5244C14.6066 15.9384 14.2596 16.2634 13.8457 16.25C13.4317 16.2365 13.1067 15.8896 13.1201 15.4756L13.251 11.4756C13.2645 11.0617 13.6105 10.7366 14.0244 10.75ZM10.5 5.5C10.0858 5.5 9.75 5.83579 9.75 6.25V7H14.25V6.25C14.25 5.83579 13.9142 5.5 13.5 5.5H10.5Z",
    fill: "currentColor"
  }
) });
var IconChatEllipsis = ({
  size = 16,
  style = {}
}) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", style, children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M18.8875 19.25L19.6112 19.0533C19.6823 19.3148 19.6068 19.5943 19.4137 19.7844C19.2206 19.9746 18.9399 20.0457 18.6795 19.9706L18.8875 19.25ZM14.9631 18.244L15.263 18.9314L14.9631 18.244ZM18.0914 15.6309L17.4669 15.2156L18.0914 15.6309ZM4.75 11.8041H5.5C5.5 15.2664 8.39065 18.1081 12 18.1081V18.8581V19.6081C7.60123 19.6081 4 16.1334 4 11.8041H4.75ZM19.25 11.8041H18.5C18.5 8.34166 15.6094 5.5 12 5.5V4.75V4C16.3988 4 20 7.47476 20 11.8041H19.25ZM12 4.75V5.5C8.39065 5.5 5.5 8.34166 5.5 11.8041H4.75H4C4 7.47476 7.60123 4 12 4V4.75ZM18.0914 15.6309L17.4669 15.2156C18.1213 14.2315 18.5 13.0612 18.5 11.8041H19.25H20C20 13.3681 19.5276 14.8257 18.716 16.0462L18.0914 15.6309ZM18.8875 19.25L18.1638 19.4467L17.2953 16.2517L18.019 16.055L18.7428 15.8583L19.6112 19.0533L18.8875 19.25ZM12 18.8581V18.1081C12.9509 18.1081 13.8518 17.9105 14.6632 17.5565L14.9631 18.244L15.263 18.9314C14.2652 19.3667 13.1603 19.6081 12 19.6081V18.8581ZM15.3144 18.2188L15.5224 17.4982L19.0955 18.5294L18.8875 19.25L18.6795 19.9706L15.1064 18.9394L15.3144 18.2188ZM14.9631 18.244L14.6632 17.5565C14.925 17.4423 15.2286 17.4134 15.5224 17.4982L15.3144 18.2188L15.1064 18.9394C15.1677 18.957 15.223 18.9489 15.263 18.9314L14.9631 18.244ZM18.0914 15.6309L18.716 16.0462C18.7451 16.0024 18.7636 15.9351 18.7428 15.8583L18.019 16.055L17.2953 16.2517C17.1957 15.8853 17.2716 15.5093 17.4669 15.2156L18.0914 15.6309Z",
      fill: "currentColor"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("circle", { cx: "15", cy: "11.75", r: "1", fill: "currentColor" }),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("circle", { cx: "12", cy: "11.75", r: "1", fill: "currentColor" }),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("circle", { cx: "9", cy: "11.75", r: "1", fill: "currentColor" })
] });
var IconCheckmark = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("g", { clipPath: "url(#clip0_2_45)", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M16.25 8.75L10 15.25L7.25 12.25",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ) }),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("defs", { children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("clipPath", { id: "clip0_2_45", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("rect", { width: "24", height: "24", fill: "white" }) }) })
] });
var IconCheckmarkLarge = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("g", { clipPath: "url(#clip0_2_37)", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M17.5962 7.75L9.42308 16.25L6.15385 12.6538",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ) }),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("defs", { children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("clipPath", { id: "clip0_2_37", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("rect", { width: "24", height: "24", fill: "white" }) }) })
] });
var IconCheckmarkCircle = ({ size = 24 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("g", { clipPath: "url(#clip0_checkmark_circle)", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M15 10L11 14.25L9.25 12.25",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    )
  ] }),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("defs", { children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("clipPath", { id: "clip0_checkmark_circle", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("rect", { width: "24", height: "24", fill: "white" }) }) })
] });
var IconXmark = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("g", { clipPath: "url(#clip0_2_53)", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M16.25 16.25L7.75 7.75",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M7.75 16.25L16.25 7.75",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    )
  ] }),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("defs", { children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("clipPath", { id: "clip0_2_53", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("rect", { width: "24", height: "24", fill: "white" }) }) })
] });
var IconXmarkLarge = ({ size = 24 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
  "path",
  {
    d: "M16.7198 6.21973C17.0127 5.92683 17.4874 5.92683 17.7803 6.21973C18.0732 6.51262 18.0732 6.9874 17.7803 7.28027L13.0606 12L17.7803 16.7197C18.0732 17.0126 18.0732 17.4874 17.7803 17.7803C17.4875 18.0731 17.0127 18.0731 16.7198 17.7803L12.0001 13.0605L7.28033 17.7803C6.98746 18.0731 6.51268 18.0731 6.21979 17.7803C5.92689 17.4874 5.92689 17.0126 6.21979 16.7197L10.9395 12L6.21979 7.28027C5.92689 6.98738 5.92689 6.51262 6.21979 6.21973C6.51268 5.92683 6.98744 5.92683 7.28033 6.21973L12.0001 10.9395L16.7198 6.21973Z",
    fill: "currentColor"
  }
) });
var IconSun = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 20 20", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M9.99999 12.7082C11.4958 12.7082 12.7083 11.4956 12.7083 9.99984C12.7083 8.50407 11.4958 7.2915 9.99999 7.2915C8.50422 7.2915 7.29166 8.50407 7.29166 9.99984C7.29166 11.4956 8.50422 12.7082 9.99999 12.7082Z",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M10 3.9585V5.05698",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M10 14.9429V16.0414",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M5.7269 5.72656L6.50682 6.50649",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M13.4932 13.4932L14.2731 14.2731",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M3.95834 10H5.05683",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M14.9432 10H16.0417",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M5.7269 14.2731L6.50682 13.4932",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "path",
    {
      d: "M13.4932 6.50649L14.2731 5.72656",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  )
] });
var IconMoon = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("svg", { width: size, height: size, viewBox: "0 0 20 20", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
  "path",
  {
    d: "M15.5 10.4955C15.4037 11.5379 15.0124 12.5314 14.3721 13.3596C13.7317 14.1878 12.8688 14.8165 11.8841 15.1722C10.8995 15.5278 9.83397 15.5957 8.81217 15.3679C7.79038 15.1401 6.8546 14.6259 6.11434 13.8857C5.37408 13.1454 4.85995 12.2096 4.63211 11.1878C4.40427 10.166 4.47215 9.10048 4.82781 8.11585C5.18346 7.13123 5.81218 6.26825 6.64039 5.62791C7.4686 4.98756 8.46206 4.59634 9.5045 4.5C8.89418 5.32569 8.60049 6.34302 8.67685 7.36695C8.75321 8.39087 9.19454 9.35339 9.92058 10.0794C10.6466 10.8055 11.6091 11.2468 12.6331 11.3231C13.657 11.3995 14.6743 11.1058 15.5 10.4955Z",
    stroke: "currentColor",
    strokeWidth: "1.13793",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }
) });
var IconEdit = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M11.3799 6.9572L9.05645 4.63375M11.3799 6.9572L6.74949 11.5699C6.61925 11.6996 6.45577 11.791 6.277 11.8339L4.29549 12.3092C3.93194 12.3964 3.60478 12.0683 3.69297 11.705L4.16585 9.75693C4.20893 9.57947 4.29978 9.4172 4.42854 9.28771L9.05645 4.63375M11.3799 6.9572L12.3455 5.98759C12.9839 5.34655 12.9839 4.31002 12.3455 3.66897C11.7033 3.02415 10.6594 3.02415 10.0172 3.66897L9.06126 4.62892L9.05645 4.63375",
        stroke: "currentColor",
        strokeWidth: "0.9",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    )
  }
);
var IconTrash = ({ size = 24 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M13.5 4C14.7426 4 15.75 5.00736 15.75 6.25V7H18.5C18.9142 7 19.25 7.33579 19.25 7.75C19.25 8.16421 18.9142 8.5 18.5 8.5H17.9678L17.6328 16.2217C17.61 16.7475 17.5912 17.1861 17.5469 17.543C17.5015 17.9087 17.4225 18.2506 17.2461 18.5723C16.9747 19.0671 16.5579 19.4671 16.0518 19.7168C15.7227 19.8791 15.3772 19.9422 15.0098 19.9717C14.6514 20.0004 14.2126 20 13.6865 20H10.3135C9.78735 20 9.34856 20.0004 8.99023 19.9717C8.62278 19.9422 8.27729 19.8791 7.94824 19.7168C7.44205 19.4671 7.02532 19.0671 6.75391 18.5723C6.57751 18.2506 6.49853 17.9087 6.45312 17.543C6.40883 17.1861 6.39005 16.7475 6.36719 16.2217L6.03223 8.5H5.5C5.08579 8.5 4.75 8.16421 4.75 7.75C4.75 7.33579 5.08579 7 5.5 7H8.25V6.25C8.25 5.00736 9.25736 4 10.5 4H13.5ZM7.86621 16.1562C7.89013 16.7063 7.90624 17.0751 7.94141 17.3584C7.97545 17.6326 8.02151 17.7644 8.06934 17.8516C8.19271 18.0763 8.38239 18.2577 8.6123 18.3711C8.70153 18.4151 8.83504 18.4545 9.11035 18.4766C9.39482 18.4994 9.76335 18.5 10.3135 18.5H13.6865C14.2367 18.5 14.6052 18.4994 14.8896 18.4766C15.165 18.4545 15.2985 18.4151 15.3877 18.3711C15.6176 18.2577 15.8073 18.0763 15.9307 17.8516C15.9785 17.7644 16.0245 17.6326 16.0586 17.3584C16.0938 17.0751 16.1099 16.7063 16.1338 16.1562L16.4668 8.5H7.5332L7.86621 16.1562ZM9.97656 10.75C10.3906 10.7371 10.7371 11.0626 10.75 11.4766L10.875 15.4766C10.8879 15.8906 10.5624 16.2371 10.1484 16.25C9.73443 16.2629 9.38794 15.9374 9.375 15.5234L9.25 11.5234C9.23706 11.1094 9.56255 10.7629 9.97656 10.75ZM14.0244 10.75C14.4383 10.7635 14.7635 11.1105 14.75 11.5244L14.6201 15.5244C14.6066 15.9384 14.2596 16.2634 13.8457 16.25C13.4317 16.2365 13.1067 15.8896 13.1201 15.4756L13.251 11.4756C13.2645 11.0617 13.6105 10.7366 14.0244 10.75ZM10.5 5.5C10.0858 5.5 9.75 5.83579 9.75 6.25V7H14.25V6.25C14.25 5.83579 13.9142 5.5 13.5 5.5H10.5Z",
        fill: "currentColor"
      }
    )
  }
);
var IconChevronLeft = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M8.5 3.5L4 8L8.5 12.5",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    )
  }
);
var IconChevronRight = ({ size = 16 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      "path",
      {
        d: "M8.5 11.5L12 8L8.5 4.5",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    )
  }
);
var AnimatedBunny = ({
  size = 20,
  color = "#4C74FF"
}) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 28 28",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("style", { children: `
      @keyframes bunnyEnterEar {
        0% { opacity: 0; transform: scale(0.8); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes bunnyEnterFace {
        0% { opacity: 0; transform: scale(0.9); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes bunnyEnterEye {
        0% { opacity: 0; transform: scale(0.5); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes leftEyeLook {
        0%, 8% { transform: translate(0, 0); }
        10%, 18% { transform: translate(1.5px, 0); }
        20%, 22% { transform: translate(1.5px, 0) scaleY(0.1); }
        24%, 32% { transform: translate(1.5px, 0); }
        35%, 48% { transform: translate(-0.8px, -0.6px); }
        52%, 54% { transform: translate(0, 0) scaleY(0.1); }
        56%, 68% { transform: translate(0, 0); }
        72%, 82% { transform: translate(-0.5px, 0.5px); }
        85%, 100% { transform: translate(0, 0); }
      }
      @keyframes rightEyeLook {
        0%, 8% { transform: translate(0, 0); }
        10%, 18% { transform: translate(0.8px, 0); }
        20%, 22% { transform: translate(0.8px, 0) scaleY(0.1); }
        24%, 32% { transform: translate(0.8px, 0); }
        35%, 48% { transform: translate(-1.5px, -0.6px); }
        52%, 54% { transform: translate(0, 0) scaleY(0.1); }
        56%, 68% { transform: translate(0, 0); }
        72%, 82% { transform: translate(-1.2px, 0.5px); }
        85%, 100% { transform: translate(0, 0); }
      }
      @keyframes leftEarTwitch {
        0%, 9% { transform: rotate(0deg); }
        12% { transform: rotate(-8deg); }
        16%, 34% { transform: rotate(0deg); }
        38% { transform: rotate(-12deg); }
        42% { transform: rotate(-6deg); }
        48%, 100% { transform: rotate(0deg); }
      }
      @keyframes rightEarTwitch {
        0%, 9% { transform: rotate(0deg); }
        12% { transform: rotate(6deg); }
        16%, 34% { transform: rotate(0deg); }
        38% { transform: rotate(10deg); }
        42% { transform: rotate(4deg); }
        48%, 71% { transform: rotate(0deg); }
        74% { transform: rotate(8deg); }
        78%, 100% { transform: rotate(0deg); }
      }
      .bunny-eye-left {
        opacity: 0;
        animation: bunnyEnterEye 0.3s ease-out 0.35s forwards, leftEyeLook 5s ease-in-out 0.65s infinite;
        transform-origin: center;
        transform-box: fill-box;
      }
      .bunny-eye-right {
        opacity: 0;
        animation: bunnyEnterEye 0.3s ease-out 0.4s forwards, rightEyeLook 5s ease-in-out 0.7s infinite;
        transform-origin: center;
        transform-box: fill-box;
      }
      .bunny-ear-left {
        opacity: 0;
        animation: bunnyEnterEar 0.3s ease-out 0.1s forwards, leftEarTwitch 5s ease-in-out 0.4s infinite;
        transform-origin: bottom center;
        transform-box: fill-box;
      }
      .bunny-ear-right {
        opacity: 0;
        animation: bunnyEnterEar 0.3s ease-out 0.15s forwards, rightEarTwitch 5s ease-in-out 0.45s infinite;
        transform-origin: bottom center;
        transform-box: fill-box;
      }
      .bunny-face {
        opacity: 0;
        animation: bunnyEnterFace 0.3s ease-out 0.25s forwards;
        transform-origin: center;
        transform-box: fill-box;
      }
      svg:hover .bunny-eye-left,
      svg:hover .bunny-eye-right {
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      .bunny-happy-face {
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      svg:hover .bunny-happy-face {
        opacity: 1;
      }
    ` }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("rect", { width: "28", height: "28", fill: "transparent" }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "path",
        {
          className: "bunny-ear-left",
          d: "M3.738 10.2164L7.224 2.007H9.167L5.676 10.2164H3.738ZM10.791 6.42705C10.791 5.90346 10.726 5.42764 10.596 4.99959C10.47 4.57155 10.292 4.16643 10.063 3.78425C9.833 3.39825 9.56 3.01797 9.243 2.64343C8.926 2.26507 8.767 2.07589 8.767 2.07589L10.24 0.957996C10.24 0.957996 10.433 1.17203 10.819 1.60007C11.209 2.0243 11.559 2.49056 11.869 2.99886C12.178 3.50717 12.413 4.04222 12.574 4.60403C12.734 5.16584 12.814 5.77352 12.814 6.42705C12.814 7.10734 12.73 7.7303 12.562 8.29593C12.394 8.85774 12.153 9.3966 11.84 9.9126C11.526 10.4247 11.181 10.8833 10.802 11.2884C10.428 11.6974 10.24 11.9018 10.24 11.9018L8.767 10.7839C8.767 10.7839 8.924 10.5948 9.237 10.2164C9.554 9.8419 9.83 9.4597 10.063 9.06985C10.3 8.6762 10.479 8.26726 10.602 7.84304C10.728 7.41499 10.791 6.943 10.791 6.42705Z",
          fill: color
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "path",
        {
          className: "bunny-ear-right",
          d: "M15.003 10.2164L18.489 2.007H20.432L16.941 10.2164H15.003ZM22.056 6.42705C22.056 5.90346 21.991 5.42764 21.861 4.99959C21.735 4.57155 21.557 4.16643 21.328 3.78425C21.098 3.39825 20.825 3.01797 20.508 2.64343C20.191 2.26507 20.032 2.07589 20.032 2.07589L21.505 0.957996C21.505 0.957996 21.698 1.17203 22.084 1.60007C22.474 2.0243 22.824 2.49056 23.133 2.99886C23.443 3.50717 23.678 4.04222 23.839 4.60403C23.999 5.16584 24.079 5.77352 24.079 6.42705C24.079 7.10734 23.995 7.7303 23.827 8.29593C23.659 8.85774 23.418 9.3966 23.105 9.9126C22.791 10.4247 22.445 10.8833 22.067 11.2884C21.693 11.6974 21.505 11.9018 21.505 11.9018L20.032 10.7839C20.032 10.7839 20.189 10.5948 20.502 10.2164C20.819 9.8419 21.094 9.4597 21.328 9.06985C21.565 8.6762 21.744 8.26726 21.866 7.84304C21.993 7.41499 22.056 6.943 22.056 6.42705Z",
          fill: color
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "path",
        {
          className: "bunny-face",
          d: "M2.03 20.4328C2.03 20.9564 2.093 21.4322 2.219 21.8602C2.345 22.2883 2.523 22.6953 2.752 23.0813C2.981 23.4635 3.254 23.8419 3.572 24.2164C3.889 24.5948 4.047 24.7839 4.047 24.7839L2.574 25.9018C2.574 25.9018 2.379 25.6878 1.989 25.2598C1.603 24.8355 1.256 24.3693 0.946 23.861C0.636 23.3527 0.401 22.8176 0.241 22.2558C0.08 21.694 0 21.0863 0 20.4328C0 19.7525 0.084 19.1314 0.252 18.5696C0.421 18.004 0.661 17.4651 0.975 16.953C1.288 16.4371 1.632 15.9765 2.007 15.5714C2.385 15.1625 2.574 14.958 2.574 14.958L4.047 16.0759C4.047 16.0759 3.889 16.2651 3.572 16.6434C3.258 17.018 2.983 17.4021 2.746 17.7957C2.513 18.1855 2.335 18.5945 2.213 19.0225C2.091 19.4467 2.03 19.9168 2.03 20.4328ZM23.687 20.4271C23.687 19.9035 23.622 19.4276 23.492 18.9996C23.366 18.5715 23.188 18.1664 22.959 17.7843C22.729 17.3982 22.456 17.018 22.139 16.6434C21.822 16.2651 21.663 16.0759 21.663 16.0759L23.136 14.958C23.136 14.958 23.329 15.172 23.715 15.6001C24.105 16.0243 24.455 16.4906 24.765 16.9989C25.074 17.5072 25.309 18.0422 25.47 18.604C25.63 19.1658 25.71 19.7735 25.71 20.4271C25.71 21.1073 25.626 21.7303 25.458 22.2959C25.29 22.8577 25.049 23.3966 24.736 23.9126C24.422 24.4247 24.077 24.8833 23.698 25.2884C23.324 25.6974 23.136 25.9018 23.136 25.9018L21.663 24.7839C21.663 24.7839 21.82 24.5948 22.133 24.2164C22.45 23.8419 22.726 23.4597 22.959 23.0698C23.196 22.6762 23.375 22.2673 23.498 21.843C23.624 21.415 23.687 20.943 23.687 20.4271Z",
          fill: color
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "circle",
        {
          className: "bunny-eye-left",
          cx: "8.277",
          cy: "20.466",
          r: "1.8",
          fill: color
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "circle",
        {
          className: "bunny-eye-right",
          cx: "19.878",
          cy: "20.466",
          r: "1.8",
          fill: color
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
        "text",
        {
          className: "bunny-happy-face",
          x: "14",
          y: "26",
          textAnchor: "middle",
          fontSize: "12",
          fontWeight: "bold",
          fill: color,
          fontFamily: "system-ui, -apple-system, sans-serif",
          children: "\u02C3 \u1D55 \u02C2"
        }
      )
    ]
  }
);
var IconLayout = ({ size = 24 }) => /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "rect",
    {
      x: "3",
      y: "3",
      width: "18",
      height: "18",
      rx: "2",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "line",
    {
      x1: "3",
      y1: "9",
      x2: "21",
      y2: "9",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
    "line",
    {
      x1: "9",
      y1: "9",
      x2: "9",
      y2: "21",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }
  )
] });

// src/components/tooltip/index.tsx
var import_react9 = require("react");
var import_react_dom2 = require("react-dom");
var import_jsx_runtime5 = require("react/jsx-runtime");
var Tooltip = ({
  content,
  children,
  ...props
}) => {
  const [visible, setVisible] = (0, import_react9.useState)(false);
  const [shouldRender, setShouldRender] = (0, import_react9.useState)(false);
  const [position, setPosition] = (0, import_react9.useState)({ top: 0, right: 0 });
  const triggerRef = (0, import_react9.useRef)(null);
  const timeoutRef = (0, import_react9.useRef)(null);
  const exitTimeoutRef = (0, import_react9.useRef)(null);
  const updatePosition = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({
        top: rect.top + rect.height / 2,
        right: window.innerWidth - rect.left + 8
      });
    }
  };
  const handleMouseEnter = () => {
    setShouldRender(true);
    if (exitTimeoutRef.current) {
      clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = null;
    }
    updatePosition();
    timeoutRef.current = originalSetTimeout(() => {
      setVisible(true);
    }, 500);
  };
  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setVisible(false);
    exitTimeoutRef.current = originalSetTimeout(() => {
      setShouldRender(false);
    }, 150);
  };
  (0, import_react9.useEffect)(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (exitTimeoutRef.current) clearTimeout(exitTimeoutRef.current);
    };
  }, []);
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(import_jsx_runtime5.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
      "span",
      {
        ref: triggerRef,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
        ...props,
        children
      }
    ),
    shouldRender && (0, import_react_dom2.createPortal)(
      /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
        "div",
        {
          "data-feedback-toolbar": true,
          style: {
            position: "fixed",
            top: position.top,
            right: position.right,
            transform: "translateY(-50%)",
            padding: "6px 10px",
            background: "#383838",
            color: "rgba(255, 255, 255, 0.7)",
            fontSize: "11px",
            fontWeight: 400,
            lineHeight: "14px",
            borderRadius: "10px",
            width: "180px",
            textAlign: "left",
            zIndex: 100020,
            pointerEvents: "none",
            boxShadow: "0px 1px 8px rgba(0, 0, 0, 0.28)",
            opacity: visible ? 1 : 0,
            transition: "opacity 0.15s ease"
          },
          children: content
        }
      ),
      document.body
    )
  ] });
};

// src/components/help-tooltip/styles.module.scss
var css3 = ".styles-module__tooltip___mcXL2 {\n  display: flex;\n  justify-content: center;\n  align-items: center;\n  cursor: help;\n}\n\n.styles-module__tooltipIcon___Nq2nD {\n  transform: translateY(0.5px);\n  color: #fff;\n  opacity: 0.2;\n  transition: opacity 0.15s ease;\n  will-change: transform;\n}\n.styles-module__tooltip___mcXL2:hover .styles-module__tooltipIcon___Nq2nD {\n  opacity: 0.5;\n}\n[data-agentation-theme=light] .styles-module__tooltipIcon___Nq2nD {\n  color: #000;\n}";
var styles_module_default2 = { "tooltip": "styles-module__tooltip___mcXL2", "tooltipIcon": "styles-module__tooltipIcon___Nq2nD" };

// src/components/help-tooltip/index.tsx
var import_jsx_runtime6 = require("react/jsx-runtime");
var HelpTooltip = ({ content }) => {
  return /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Tooltip, { className: styles_module_default2.tooltip, content, children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(IconHelp, { className: styles_module_default2.tooltipIcon }) });
};

// src/components/page-toolbar-css/styles.module.scss
var css4 = '.styles-module__toolbar___wNsdK svg[fill=none],\n.styles-module__markersLayer___-25j1 svg[fill=none],\n.styles-module__fixedMarkersLayer___ffyX6 svg[fill=none] {\n  fill: none !important;\n}\n.styles-module__toolbar___wNsdK svg[fill=none] :not([fill]),\n.styles-module__markersLayer___-25j1 svg[fill=none] :not([fill]),\n.styles-module__fixedMarkersLayer___ffyX6 svg[fill=none] :not([fill]) {\n  fill: none !important;\n}\n\n.styles-module__controlsContent___9GJWU :where(button, input, select, textarea, label) {\n  background: unset;\n  border: unset;\n  border-radius: unset;\n  padding: unset;\n  margin: unset;\n  color: unset;\n  font-family: unset;\n  font-weight: unset;\n  font-style: unset;\n  line-height: unset;\n  letter-spacing: unset;\n  text-transform: unset;\n  text-decoration: unset;\n  box-shadow: unset;\n  outline: unset;\n}\n\n@keyframes styles-module__toolbarEnter___u8RRu {\n  from {\n    opacity: 0;\n    transform: scale(0.5) rotate(90deg);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1) rotate(0deg);\n  }\n}\n@keyframes styles-module__toolbarHide___y8kaT {\n  from {\n    opacity: 1;\n    transform: scale(1);\n  }\n  to {\n    opacity: 0;\n    transform: scale(0.8);\n  }\n}\n@keyframes styles-module__badgeEnter___mVQLj {\n  from {\n    opacity: 0;\n    transform: scale(0);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1);\n  }\n}\n@keyframes styles-module__scaleIn___c-r1K {\n  from {\n    opacity: 0;\n    transform: scale(0.85);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1);\n  }\n}\n@keyframes styles-module__scaleOut___Wctwz {\n  from {\n    opacity: 1;\n    transform: scale(1);\n  }\n  to {\n    opacity: 0;\n    transform: scale(0.85);\n  }\n}\n@keyframes styles-module__slideUp___kgD36 {\n  from {\n    opacity: 0;\n    transform: scale(0.85) translateY(8px);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1) translateY(0);\n  }\n}\n@keyframes styles-module__slideDown___zcdje {\n  from {\n    opacity: 1;\n    transform: scale(1) translateY(0);\n  }\n  to {\n    opacity: 0;\n    transform: scale(0.85) translateY(8px);\n  }\n}\n@keyframes styles-module__fadeIn___b9qmf {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}\n@keyframes styles-module__fadeOut___6Ut6- {\n  from {\n    opacity: 1;\n  }\n  to {\n    opacity: 0;\n  }\n}\n@keyframes styles-module__hoverHighlightIn___6WYHY {\n  from {\n    opacity: 0;\n    transform: scale(0.98);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1);\n  }\n}\n@keyframes styles-module__hoverTooltipIn___FYGQx {\n  from {\n    opacity: 0;\n    transform: scale(0.95) translateY(4px);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1) translateY(0);\n  }\n}\n.styles-module__disableTransitions___EopxO :is(*, *::before, *::after) {\n  transition: none !important;\n}\n\n:host {\n  /* Set here rather than inline so a consumer className rule can still hide the toolbar. */\n  display: contents;\n  position: fixed;\n  top: auto;\n  left: auto;\n  bottom: 1.25rem;\n  right: 1.25rem;\n  z-index: 100000;\n}\n\n.styles-module__positionContext___AZFHE,\n.styles-module__toolbar___wNsdK {\n  position: inherit;\n  top: inherit;\n  left: inherit;\n  bottom: inherit;\n  right: inherit;\n  z-index: inherit;\n}\n\n.styles-module__toolbar___wNsdK {\n  width: 337px;\n  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  pointer-events: none;\n  transition: left 0.36s cubic-bezier(0.19, 1, 0.22, 1), top 0s, right 0s, bottom 0s;\n}\n.styles-module__toolbar___wNsdK[data-dragging=true] {\n  transition: none;\n}\n\n.styles-module__toolbarContainer___dIhma {\n  position: relative;\n  -webkit-user-select: none;\n  user-select: none;\n  margin-left: auto;\n  align-self: flex-end;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: #1a1a1a;\n  color: #fff;\n  border: none;\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2), 0 4px 16px rgba(0, 0, 0, 0.1);\n  pointer-events: auto;\n  transition: width 0.36s cubic-bezier(0.19, 1, 0.22, 1), transform 0.36s cubic-bezier(0.19, 1, 0.22, 1);\n}\n.styles-module__toolbarContainer___dIhma.styles-module__entrance___sgHd8 {\n  animation: styles-module__toolbarEnter___u8RRu 0.5s cubic-bezier(0.34, 1.2, 0.64, 1) forwards;\n}\n.styles-module__toolbarContainer___dIhma.styles-module__hiding___1td44 {\n  animation: styles-module__toolbarHide___y8kaT 0.4s cubic-bezier(0.4, 0, 1, 1) forwards;\n  pointer-events: none;\n}\n.styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn {\n  width: 44px;\n  height: 44px;\n  border-radius: 22px;\n  padding: 0;\n  cursor: pointer;\n}\n.styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn:hover {\n  background: #2a2a2a;\n}\n.styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn:active {\n  transform: scale(0.95);\n}\n.styles-module__toolbarContainer___dIhma.styles-module__expanded___ofKPx {\n  height: 44px;\n  border-radius: 22px;\n  padding: 5px;\n  width: 297px;\n}\n.styles-module__toolbarContainer___dIhma.styles-module__expanded___ofKPx.styles-module__serverConnected___Gfbou {\n  width: 337px;\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .styles-module__toolbar___wNsdK,\n  .styles-module__toolbarContainer___dIhma {\n    transition: none;\n  }\n}\n.styles-module__buttonWrapper___rBcdv.styles-module__toggleWrapper___7N0-q {\n  position: absolute;\n  top: 0;\n  right: 0;\n  width: 44px;\n  height: 44px;\n}\n\n.styles-module__togglePlaceholder___wnqrL {\n  width: 34px;\n  flex: 0 0 34px;\n  height: 34px;\n}\n\n.styles-module__toggleContent___0yfyP {\n  position: absolute;\n  top: 0;\n  right: 0;\n  width: 44px;\n  height: 44px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  border: 0;\n  border-radius: 50%;\n  padding: 0;\n  margin: 0;\n  background: transparent;\n  color: #fff;\n  cursor: pointer;\n  transition: color 0.15s ease;\n}\n.styles-module__toggleContent___0yfyP::before {\n  content: "";\n  position: absolute;\n  inset: 5px;\n  border-radius: 50%;\n  pointer-events: none;\n  background: transparent;\n  transition: background-color 0.15s ease, transform 0.1s ease;\n}\n.styles-module__toggleContent___0yfyP.styles-module__expandedToggle___F7SRN {\n  color: rgba(255, 255, 255, 0.85);\n}\n.styles-module__toggleContent___0yfyP.styles-module__expandedToggle___F7SRN:hover {\n  color: #fff;\n}\n.styles-module__toggleContent___0yfyP.styles-module__expandedToggle___F7SRN:hover::before {\n  background: rgba(255, 255, 255, 0.12);\n}\n.styles-module__toggleContent___0yfyP.styles-module__expandedToggle___F7SRN:active::before, .styles-module__toggleContent___0yfyP.styles-module__expandedToggle___F7SRN:active .styles-module__toggleGlyph___R7Oom {\n  transform: scale(0.92);\n}\n\n.styles-module__toggleIcon___Jbtus {\n  transform: translateY(-0.5px);\n  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);\n  position: relative;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n\n.styles-module__expandedToggle___F7SRN .styles-module__toggleIcon___Jbtus {\n  transform: none;\n}\n\n.styles-module__toggleGlyph___R7Oom {\n  overflow: visible;\n  transition: transform 0.1s ease;\n}\n.styles-module__toggleGlyph___R7Oom path {\n  transform-box: fill-box;\n  transform-origin: center;\n  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.16s ease;\n}\n\n.styles-module__toggleTopLine___hQaCm,\n.styles-module__toggleMiddleLine___sFFVe {\n  vector-effect: non-scaling-stroke;\n}\n\n.styles-module__toggleBottomLine___V-jX3 {\n  transform-origin: left center;\n}\n\n.styles-module__toggleGlyph___R7Oom[data-active=true] .styles-module__toggleTopLine___hQaCm {\n  transform: translateY(5.25px) rotate(45deg) scaleX(1.1422494);\n}\n.styles-module__toggleGlyph___R7Oom[data-active=true] .styles-module__toggleMiddleLine___sFFVe {\n  transform: translateX(3.5px) rotate(-45deg) scaleX(2.4748737);\n}\n.styles-module__toggleGlyph___R7Oom[data-active=true] .styles-module__toggleBottomLine___V-jX3 {\n  transform: scaleX(0);\n  opacity: 0;\n}\n.styles-module__toggleGlyph___R7Oom[data-active=true] .styles-module__toggleSparkle___eeF99 {\n  transform: scale(0);\n  opacity: 0;\n}\n\n.styles-module__toggleContent___0yfyP:focus-visible,\n.styles-module__controlButton___8Q0jc:focus-visible {\n  outline: 2px solid var(--agentation-color-accent);\n  outline-offset: 3px;\n}\n\n.styles-module__controlsContent___9GJWU {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  transition: filter 0.14s ease-out, opacity 0.14s ease-out, transform 0.36s cubic-bezier(0.19, 1, 0.22, 1);\n}\n.styles-module__controlsContent___9GJWU.styles-module__visible___KHwEW {\n  transition: filter 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.24s ease-out, transform 0.42s cubic-bezier(0.19, 1, 0.22, 1);\n  opacity: 1;\n  filter: blur(0px);\n  transform: scale(1);\n  visibility: visible;\n  pointer-events: auto;\n}\n.styles-module__controlsContent___9GJWU.styles-module__hidden___Ae8H4 {\n  pointer-events: none;\n  opacity: 0;\n  filter: blur(6px);\n  transform: scale(0.4);\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .styles-module__controlsContent___9GJWU,\n  .styles-module__controlsContent___9GJWU.styles-module__visible___KHwEW,\n  .styles-module__toggleContent___0yfyP,\n  .styles-module__toggleContent___0yfyP::before,\n  .styles-module__toggleGlyph___R7Oom,\n  .styles-module__toggleIcon___Jbtus,\n  .styles-module__toggleGlyph___R7Oom path {\n    transition: none;\n  }\n  .styles-module__controlsContent___9GJWU.styles-module__hidden___Ae8H4 {\n    filter: none;\n    transform: none;\n  }\n}\n.styles-module__badge___2XsgF {\n  position: absolute;\n  top: -13px;\n  right: -13px;\n  -webkit-user-select: none;\n  user-select: none;\n  min-width: 18px;\n  height: 18px;\n  padding: 0 5px;\n  border-radius: 9px;\n  background-color: var(--agentation-color-accent);\n  color: white;\n  font-size: 0.625rem;\n  font-weight: 600;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15), inset 0 0 0 1px rgba(255, 255, 255, 0.04);\n  opacity: 1;\n  transition: transform 0.3s ease, opacity 0.2s ease;\n  transform: scale(1);\n}\n.styles-module__badge___2XsgF.styles-module__fadeOut___6Ut6- {\n  opacity: 0;\n  transform: scale(0);\n  pointer-events: none;\n}\n.styles-module__badge___2XsgF.styles-module__entrance___sgHd8 {\n  animation: styles-module__badgeEnter___mVQLj 0.3s cubic-bezier(0.34, 1.2, 0.64, 1) 0.4s both;\n}\n\n.styles-module__controlButton___8Q0jc {\n  position: relative;\n  cursor: pointer;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 34px;\n  height: 34px;\n  border-radius: 50%;\n  border: none;\n  background: transparent;\n  color: rgba(255, 255, 255, 0.85);\n  transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease, opacity 0.2s ease;\n}\n.styles-module__controlButton___8Q0jc:hover:not(:disabled):not([data-active=true]):not([data-failed=true]):not([data-auto-sync=true]):not([data-error=true]):not([data-no-hover=true]) {\n  background: rgba(255, 255, 255, 0.12);\n  color: #fff;\n}\n.styles-module__controlButton___8Q0jc:active:not(:disabled) {\n  transform: scale(0.92);\n}\n.styles-module__controlButton___8Q0jc:disabled {\n  opacity: 0.35;\n  cursor: not-allowed;\n}\n.styles-module__controlButton___8Q0jc[data-active=true] {\n  color: var(--agentation-color-blue);\n  background-color: color-mix(in srgb, var(--agentation-color-blue) 25%, transparent);\n}\n.styles-module__controlButton___8Q0jc[data-error=true] {\n  color: var(--agentation-color-red);\n  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);\n}\n.styles-module__controlButton___8Q0jc[data-danger]:hover:not(:disabled):not([data-active=true]):not([data-failed=true]) {\n  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);\n  color: var(--agentation-color-red);\n}\n.styles-module__controlButton___8Q0jc[data-no-hover=true], .styles-module__controlButton___8Q0jc.styles-module__statusShowing___te6iu {\n  cursor: default;\n  pointer-events: none;\n  background: transparent !important;\n}\n.styles-module__controlButton___8Q0jc[data-auto-sync=true] {\n  color: var(--agentation-color-green);\n  background: transparent;\n  cursor: default;\n}\n.styles-module__controlButton___8Q0jc[data-failed=true] {\n  color: var(--agentation-color-red);\n  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);\n}\n\n.styles-module__buttonBadge___NeFWb {\n  position: absolute;\n  top: 0px;\n  right: 0px;\n  min-width: 16px;\n  height: 16px;\n  padding: 0 4px;\n  border-radius: 8px;\n  background-color: var(--agentation-color-accent);\n  color: white;\n  font-size: 0.625rem;\n  font-weight: 600;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  box-shadow: 0 0 0 2px #1a1a1a, 0 1px 3px rgba(0, 0, 0, 0.2);\n  pointer-events: none;\n}\n[data-agentation-theme=light] .styles-module__buttonBadge___NeFWb {\n  box-shadow: 0 0 0 2px #fff, 0 1px 3px rgba(0, 0, 0, 0.2);\n}\n\n@keyframes styles-module__mcpIndicatorPulseConnected___EDodZ {\n  0%, 100% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 50%, transparent);\n  }\n  50% {\n    box-shadow: 0 0 0 5px color-mix(in srgb, var(--agentation-color-green) 0%, transparent);\n  }\n}\n@keyframes styles-module__mcpIndicatorPulseConnecting___cCYte {\n  0%, 100% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-yellow) 50%, transparent);\n  }\n  50% {\n    box-shadow: 0 0 0 5px color-mix(in srgb, var(--agentation-color-yellow) 0%, transparent);\n  }\n}\n.styles-module__mcpIndicator___zGJeL {\n  position: absolute;\n  top: 3px;\n  right: 3px;\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  pointer-events: none;\n  transition: background-color 0.3s ease, opacity 0.15s ease, transform 0.15s ease;\n  opacity: 1;\n  transform: scale(1);\n}\n.styles-module__mcpIndicator___zGJeL.styles-module__connected___7c28g {\n  background-color: var(--agentation-color-green);\n  animation: styles-module__mcpIndicatorPulseConnected___EDodZ 2.5s ease-in-out infinite;\n}\n.styles-module__mcpIndicator___zGJeL.styles-module__connecting___uo-CW {\n  background-color: var(--agentation-color-yellow);\n  animation: styles-module__mcpIndicatorPulseConnecting___cCYte 1.5s ease-in-out infinite;\n}\n.styles-module__mcpIndicator___zGJeL.styles-module__hidden___Ae8H4 {\n  opacity: 0;\n  transform: scale(0);\n  animation: none;\n}\n\n@keyframes styles-module__connectionPulse___-Zycw {\n  0%, 100% {\n    opacity: 1;\n    transform: scale(1);\n  }\n  50% {\n    opacity: 0.6;\n    transform: scale(0.9);\n  }\n}\n.styles-module__connectionIndicatorWrapper___L-e-3 {\n  width: 8px;\n  height: 34px;\n  margin-left: 6px;\n  margin-right: 6px;\n}\n\n.styles-module__connectionIndicator___afk9p {\n  position: relative;\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  opacity: 0;\n  transition: opacity 0.3s ease, background-color 0.3s ease;\n  cursor: default;\n}\n\n.styles-module__connectionIndicatorVisible___C-i5B {\n  opacity: 1;\n}\n\n.styles-module__connectionIndicatorConnected___IY8pR {\n  background-color: var(--agentation-color-green);\n  animation: styles-module__connectionPulse___-Zycw 2.5s ease-in-out infinite;\n}\n\n.styles-module__connectionIndicatorDisconnected___kmpaZ {\n  background-color: var(--agentation-color-red);\n  animation: none;\n}\n\n.styles-module__connectionIndicatorConnecting___QmSLH {\n  background-color: var(--agentation-color-yellow);\n  animation: styles-module__connectionPulse___-Zycw 1s ease-in-out infinite;\n}\n\n.styles-module__buttonWrapper___rBcdv {\n  position: relative;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n.styles-module__buttonWrapper___rBcdv:hover .styles-module__buttonTooltip___Burd9 {\n  opacity: 1;\n  visibility: visible;\n  transform: translateX(-50%) scale(1);\n  transition-delay: 0.85s;\n}\n.styles-module__buttonWrapper___rBcdv:has(.styles-module__controlButton___8Q0jc:disabled):hover .styles-module__buttonTooltip___Burd9 {\n  opacity: 0;\n  visibility: hidden;\n}\n\n.styles-module__tooltipsInSession___-0lHH .styles-module__buttonWrapper___rBcdv:hover .styles-module__buttonTooltip___Burd9 {\n  transition-delay: 0s;\n}\n\n.styles-module__sendButtonWrapper___UUxG6 {\n  width: 0;\n  opacity: 0;\n  overflow: hidden;\n  pointer-events: none;\n  margin-left: -6px;\n  transition: width 0.36s cubic-bezier(0.19, 1, 0.22, 1), opacity 0.2s cubic-bezier(0.19, 1, 0.22, 1), margin 0.36s cubic-bezier(0.19, 1, 0.22, 1);\n}\n.styles-module__sendButtonWrapper___UUxG6 .styles-module__controlButton___8Q0jc {\n  transform: scale(0.8);\n  transition: transform 0.36s cubic-bezier(0.19, 1, 0.22, 1);\n}\n.styles-module__sendButtonWrapper___UUxG6.styles-module__sendButtonVisible___WPSQU {\n  width: 34px;\n  opacity: 1;\n  overflow: visible;\n  pointer-events: auto;\n  margin-left: 0;\n}\n.styles-module__sendButtonWrapper___UUxG6.styles-module__sendButtonVisible___WPSQU .styles-module__controlButton___8Q0jc {\n  transform: scale(1);\n}\n\n.styles-module__buttonTooltip___Burd9 {\n  position: absolute;\n  bottom: calc(100% + 14px);\n  left: 50%;\n  transform: translateX(-50%) scale(0.95);\n  padding: 6px 10px;\n  background: #1a1a1a;\n  color: rgba(255, 255, 255, 0.9);\n  font-size: 12px;\n  font-weight: 500;\n  border-radius: 8px;\n  white-space: nowrap;\n  opacity: 0;\n  visibility: hidden;\n  pointer-events: none;\n  z-index: 100001;\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);\n  transition: opacity 0.135s ease, transform 0.135s ease, visibility 0.135s ease;\n}\n.styles-module__buttonTooltip___Burd9::after {\n  content: "";\n  position: absolute;\n  top: calc(100% - 4px);\n  left: 50%;\n  transform: translateX(-50%) rotate(45deg);\n  width: 8px;\n  height: 8px;\n  background: #1a1a1a;\n  border-radius: 0 0 2px 0;\n}\n\n.styles-module__shortcut___lEAQk {\n  margin-left: 4px;\n  opacity: 0.5;\n}\n\n.styles-module__tooltipBelow___m6ats .styles-module__buttonTooltip___Burd9 {\n  bottom: auto;\n  top: calc(100% + 14px);\n  transform: translateX(-50%) scale(0.95);\n}\n.styles-module__tooltipBelow___m6ats .styles-module__buttonTooltip___Burd9::after {\n  top: -4px;\n  bottom: auto;\n  border-radius: 2px 0 0 0;\n}\n\n.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapper___rBcdv:hover .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(-50%) scale(1);\n}\n\n.styles-module__tooltipsHidden___VtLJG .styles-module__buttonTooltip___Burd9 {\n  opacity: 0 !important;\n  visibility: hidden !important;\n  transition: none !important;\n}\n\n.styles-module__tooltipVisible___0jcCv,\n.styles-module__tooltipsHidden___VtLJG .styles-module__tooltipVisible___0jcCv {\n  opacity: 1 !important;\n  visibility: visible !important;\n  transform: translateX(-50%) scale(1) !important;\n  transition-delay: 0s !important;\n}\n\n.styles-module__buttonWrapperAlignLeft___myzIp .styles-module__buttonTooltip___Burd9 {\n  left: 50%;\n  transform: translateX(-12px) scale(0.95);\n}\n.styles-module__buttonWrapperAlignLeft___myzIp .styles-module__buttonTooltip___Burd9::after {\n  left: 16px;\n}\n.styles-module__buttonWrapperAlignLeft___myzIp:hover .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(-12px) scale(1);\n}\n\n.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapperAlignLeft___myzIp .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(-12px) scale(0.95);\n}\n.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapperAlignLeft___myzIp:hover .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(-12px) scale(1);\n}\n\n.styles-module__buttonWrapperAlignRight___HCQFR .styles-module__buttonTooltip___Burd9 {\n  left: 50%;\n  transform: translateX(calc(-100% + 12px)) scale(0.95);\n}\n.styles-module__buttonWrapperAlignRight___HCQFR .styles-module__buttonTooltip___Burd9::after {\n  left: auto;\n  right: 8px;\n}\n.styles-module__buttonWrapperAlignRight___HCQFR:hover .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(calc(-100% + 12px)) scale(1);\n}\n\n.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapperAlignRight___HCQFR .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(calc(-100% + 12px)) scale(0.95);\n}\n.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapperAlignRight___HCQFR:hover .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(calc(-100% + 12px)) scale(1);\n}\n\n.styles-module__divider___c--s1 {\n  width: 1px;\n  height: 12px;\n  background: rgba(255, 255, 255, 0.15);\n  margin: 0 3px;\n}\n\n.styles-module__overlay___Q1O9y {\n  position: fixed;\n  inset: 0;\n  z-index: 99997;\n  pointer-events: none;\n}\n.styles-module__overlay___Q1O9y > * {\n  pointer-events: auto;\n}\n\n.styles-module__hoverHighlight___ogakW {\n  position: fixed;\n  border: 2px solid color-mix(in srgb, var(--agentation-color-accent) 50%, transparent);\n  border-radius: 4px;\n  background-color: color-mix(in srgb, var(--agentation-color-accent) 4%, transparent);\n  pointer-events: none !important;\n  box-sizing: border-box;\n  will-change: opacity;\n  contain: layout style;\n}\n.styles-module__hoverHighlight___ogakW.styles-module__enter___WFIki {\n  animation: styles-module__hoverHighlightIn___6WYHY 0.12s ease-out forwards;\n}\n\n.styles-module__multiSelectOutline___cSJ-m {\n  position: fixed;\n  border: 2px dashed color-mix(in srgb, var(--agentation-color-green) 60%, transparent);\n  border-radius: 4px;\n  pointer-events: none !important;\n  background-color: color-mix(in srgb, var(--agentation-color-green) 5%, transparent);\n  box-sizing: border-box;\n  will-change: opacity;\n}\n.styles-module__multiSelectOutline___cSJ-m.styles-module__enter___WFIki {\n  animation: styles-module__fadeIn___b9qmf 0.15s ease-out forwards;\n}\n.styles-module__multiSelectOutline___cSJ-m.styles-module__exit___fyOJ0 {\n  animation: styles-module__fadeOut___6Ut6- 0.15s ease-out forwards;\n}\n\n.styles-module__singleSelectOutline___QhX-O {\n  position: fixed;\n  border: 2px solid color-mix(in srgb, var(--agentation-color-blue) 60%, transparent);\n  border-radius: 4px;\n  pointer-events: none !important;\n  background-color: color-mix(in srgb, var(--agentation-color-blue) 5%, transparent);\n  box-sizing: border-box;\n  will-change: opacity;\n}\n.styles-module__singleSelectOutline___QhX-O.styles-module__enter___WFIki {\n  animation: styles-module__fadeIn___b9qmf 0.15s ease-out forwards;\n}\n.styles-module__singleSelectOutline___QhX-O.styles-module__exit___fyOJ0 {\n  animation: styles-module__fadeOut___6Ut6- 0.15s ease-out forwards;\n}\n\n.styles-module__hoverTooltip___bvLk7 {\n  position: fixed;\n  z-index: 99999;\n  font-size: 0.6875rem;\n  font-weight: 500;\n  color: #fff;\n  background: rgba(0, 0, 0, 0.85);\n  padding: 0.35rem 0.6rem;\n  border-radius: 0.375rem;\n  pointer-events: none !important;\n  white-space: nowrap;\n  max-width: min(280px, 100vw - 16px - 1.2rem);\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.styles-module__hoverTooltip___bvLk7.styles-module__enter___WFIki {\n  animation: styles-module__hoverTooltipIn___FYGQx 0.1s ease-out forwards;\n}\n\n.styles-module__hoverReactPath___gx1IJ {\n  font-size: 0.625rem;\n  color: rgba(255, 255, 255, 0.6);\n  margin-bottom: 0.15rem;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.styles-module__hoverElementName___QMLMl {\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.styles-module__markersLayer___-25j1 {\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;\n  height: 0;\n  z-index: 99998;\n  pointer-events: none;\n}\n.styles-module__markersLayer___-25j1 > * {\n  pointer-events: auto;\n}\n\n.styles-module__fixedMarkersLayer___ffyX6 {\n  position: fixed;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  z-index: 99998;\n  pointer-events: none;\n}\n.styles-module__fixedMarkersLayer___ffyX6 > * {\n  pointer-events: auto;\n}\n\n.styles-module__marker___6sQrs {\n  position: absolute;\n  width: 22px;\n  height: 22px;\n  background: var(--agentation-color-blue);\n  color: white;\n  border-radius: 50%;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-size: 0.6875rem;\n  font-weight: 600;\n  transform: translate(-50%, -50%) scale(1);\n  opacity: 1;\n  cursor: pointer;\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2), inset 0 0 0 1px rgba(0, 0, 0, 0.04);\n  -webkit-user-select: none;\n  user-select: none;\n  will-change: transform, opacity;\n  contain: layout style;\n  z-index: 1;\n}\n.styles-module__marker___6sQrs:hover {\n  z-index: 2;\n}\n.styles-module__marker___6sQrs:not(.styles-module__enter___WFIki):not(.styles-module__exit___fyOJ0):not(.styles-module__clearing___FQ--7) {\n  transition: background-color 0.15s ease, transform 0.1s ease;\n}\n.styles-module__marker___6sQrs.styles-module__enter___WFIki {\n  animation: styles-module__markerIn___5FaAP 0.25s cubic-bezier(0.22, 1, 0.36, 1) both;\n}\n.styles-module__marker___6sQrs.styles-module__exit___fyOJ0 {\n  animation: styles-module__markerOut___GU5jX 0.2s ease-out both;\n  pointer-events: none;\n}\n.styles-module__marker___6sQrs.styles-module__clearing___FQ--7 {\n  animation: styles-module__markerOut___GU5jX 0.15s ease-out both;\n  pointer-events: none;\n}\n.styles-module__marker___6sQrs:not(.styles-module__enter___WFIki):not(.styles-module__exit___fyOJ0):not(.styles-module__clearing___FQ--7):hover {\n  transform: translate(-50%, -50%) scale(1.1);\n}\n.styles-module__marker___6sQrs.styles-module__pending___2IHLC {\n  position: fixed;\n  background-color: var(--agentation-color-blue);\n  cursor: default;\n}\n.styles-module__marker___6sQrs.styles-module__fixed___dBMHC {\n  position: fixed;\n}\n.styles-module__marker___6sQrs.styles-module__multiSelect___YWiuz {\n  background-color: var(--agentation-color-green);\n  width: 26px;\n  height: 26px;\n  border-radius: 6px;\n  font-size: 0.75rem;\n}\n.styles-module__marker___6sQrs.styles-module__multiSelect___YWiuz.styles-module__pending___2IHLC {\n  background-color: var(--agentation-color-green);\n}\n.styles-module__marker___6sQrs.styles-module__hovered___ZgXIy {\n  background-color: var(--agentation-color-red);\n}\n\n.styles-module__renumber___nCTxD {\n  display: block;\n  animation: styles-module__renumberRoll___Wgbq3 0.2s ease-out;\n}\n\n@keyframes styles-module__renumberRoll___Wgbq3 {\n  0% {\n    transform: translateX(-40%);\n    opacity: 0;\n  }\n  100% {\n    transform: translateX(0);\n    opacity: 1;\n  }\n}\n.styles-module__markerTooltip___aLJID {\n  position: absolute;\n  top: calc(100% + 10px);\n  left: 50%;\n  transform: translateX(-50%) scale(0.909);\n  z-index: 100002;\n  background: #1a1a1a;\n  padding: 8px 0.75rem;\n  border-radius: 0.75rem;\n  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  font-weight: 400;\n  color: #fff;\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);\n  min-width: 120px;\n  max-width: 200px;\n  pointer-events: none;\n  cursor: default;\n}\n.styles-module__markerTooltip___aLJID.styles-module__enter___WFIki {\n  animation: styles-module__tooltipIn___0N31w 0.1s ease-out forwards;\n}\n\n.styles-module__markerQuote___FHmrz {\n  display: block;\n  font-size: 12px;\n  font-style: italic;\n  color: rgba(255, 255, 255, 0.6);\n  margin-bottom: 0.3125rem;\n  line-height: 1.4;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.styles-module__markerNote___QkrrS {\n  display: block;\n  font-size: 13px;\n  font-weight: 400;\n  line-height: 1.4;\n  color: #fff;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  padding-bottom: 2px;\n}\n\n.styles-module__markerHint___2iF-6 {\n  display: block;\n  font-size: 0.625rem;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.6);\n  margin-top: 0.375rem;\n  white-space: nowrap;\n}\n\n.styles-module__settingsPanel___OxX3Y {\n  position: absolute;\n  right: 5px;\n  bottom: calc(100% + 0.5rem);\n  z-index: 1;\n  overflow: hidden;\n  background: #1c1c1c;\n  border-radius: 1rem;\n  padding: 13px 0 16px;\n  min-width: 205px;\n  cursor: default;\n  opacity: 1;\n  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.04);\n  transition: background-color 0.25s ease, box-shadow 0.25s ease;\n}\n.styles-module__settingsPanel___OxX3Y::before, .styles-module__settingsPanel___OxX3Y::after {\n  content: "";\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  width: 16px;\n  z-index: 2;\n  pointer-events: none;\n}\n.styles-module__settingsPanel___OxX3Y::before {\n  left: 0;\n  background: linear-gradient(to right, #1c1c1c 0%, transparent 100%);\n}\n.styles-module__settingsPanel___OxX3Y::after {\n  right: 0;\n  background: linear-gradient(to left, #1c1c1c 0%, transparent 100%);\n}\n.styles-module__settingsPanel___OxX3Y .styles-module__settingsHeader___pwDY9,\n.styles-module__settingsPanel___OxX3Y .styles-module__settingsBrand___0gJeM,\n.styles-module__settingsPanel___OxX3Y .styles-module__settingsBrandSlash___uTG18,\n.styles-module__settingsPanel___OxX3Y .styles-module__settingsVersion___TUcFq,\n.styles-module__settingsPanel___OxX3Y .styles-module__settingsSection___m-YM2,\n.styles-module__settingsPanel___OxX3Y .styles-module__settingsLabel___8UjfX,\n.styles-module__settingsPanel___OxX3Y .styles-module__cycleButton___FMKfw,\n.styles-module__settingsPanel___OxX3Y .styles-module__cycleDot___nPgLY,\n.styles-module__settingsPanel___OxX3Y .styles-module__dropdownButton___16NPz,\n.styles-module__settingsPanel___OxX3Y .styles-module__toggleLabel___Xm8Aa,\n.styles-module__settingsPanel___OxX3Y .styles-module__customCheckbox___U39ax,\n.styles-module__settingsPanel___OxX3Y .styles-module__sliderLabel___U8sPr,\n.styles-module__settingsPanel___OxX3Y .styles-module__slider___GLdxp,\n.styles-module__settingsPanel___OxX3Y .styles-module__themeToggle___2rUjA {\n  transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease;\n}\n.styles-module__settingsPanel___OxX3Y.styles-module__enter___WFIki {\n  opacity: 1;\n  transform: translateY(0) scale(1);\n  filter: blur(0px);\n  transition: opacity 0.2s ease, transform 0.2s ease, filter 0.2s ease;\n}\n.styles-module__settingsPanel___OxX3Y.styles-module__exit___fyOJ0 {\n  opacity: 0;\n  transform: translateY(8px) scale(0.95);\n  filter: blur(5px);\n  pointer-events: none;\n  transition: opacity 0.1s ease, transform 0.1s ease, filter 0.1s ease;\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y {\n  background: #1a1a1a;\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__settingsLabel___8UjfX {\n  color: rgba(255, 255, 255, 0.6);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__settingsOption___UNa12 {\n  color: rgba(255, 255, 255, 0.85);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__settingsOption___UNa12:hover {\n  background: rgba(255, 255, 255, 0.1);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__settingsOption___UNa12.styles-module__selected___OwRqP {\n  background: rgba(255, 255, 255, 0.15);\n  color: #fff;\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__toggleLabel___Xm8Aa {\n  color: rgba(255, 255, 255, 0.85);\n}\n\n.styles-module__settingsPanelContainer___Xksv8 {\n  overflow: visible;\n  position: relative;\n  display: flex;\n  padding: 0 1rem;\n}\n\n.styles-module__settingsPage___6YfHH {\n  min-width: 100%;\n  flex-shrink: 0;\n  transition: transform 0.2s ease, opacity 0.2s ease;\n  transition-delay: 0s;\n  opacity: 1;\n}\n\n.styles-module__settingsPage___6YfHH.styles-module__slideLeft___Ps01J {\n  transform: translateX(-24px);\n  opacity: 0;\n  pointer-events: none;\n}\n\n.styles-module__automationsPage___uvCq6 {\n  position: absolute;\n  top: 0;\n  left: 24px;\n  width: 100%;\n  height: 100%;\n  padding: 3px 1rem 0;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  transition: transform 0.2s ease, opacity 0.2s ease;\n  opacity: 0;\n  pointer-events: none;\n}\n\n.styles-module__automationsPage___uvCq6.styles-module__slideIn___4-qXe {\n  transform: translateX(-24px);\n  opacity: 1;\n  pointer-events: auto;\n}\n\n.styles-module__settingsNavLink___wCzJt {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  width: 100%;\n  padding: 0;\n  border: none;\n  background: transparent;\n  font-family: inherit;\n  font-size: 0.8125rem;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.5);\n  cursor: pointer;\n  transition: color 0.15s ease;\n}\n.styles-module__settingsNavLink___wCzJt:hover {\n  color: rgba(255, 255, 255, 0.9);\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___wCzJt {\n  color: rgba(0, 0, 0, 0.5);\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___wCzJt:hover {\n  color: rgba(0, 0, 0, 0.8);\n}\n.styles-module__settingsNavLink___wCzJt svg {\n  color: rgba(255, 255, 255, 0.4);\n  transition: color 0.15s ease;\n}\n.styles-module__settingsNavLink___wCzJt:hover svg {\n  color: #fff;\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___wCzJt svg {\n  color: rgba(0, 0, 0, 0.25);\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___wCzJt:hover svg {\n  color: rgba(0, 0, 0, 0.8);\n}\n\n.styles-module__settingsNavLinkRight___ZWwhj {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.styles-module__mcpNavIndicator___cl9pO {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  flex-shrink: 0;\n}\n.styles-module__mcpNavIndicator___cl9pO.styles-module__connected___7c28g {\n  background-color: var(--agentation-color-green);\n  animation: styles-module__mcpPulse___uNggr 2.5s ease-in-out infinite;\n}\n.styles-module__mcpNavIndicator___cl9pO.styles-module__connecting___uo-CW {\n  background-color: var(--agentation-color-yellow);\n  animation: styles-module__mcpPulse___uNggr 1.5s ease-in-out infinite;\n}\n\n.styles-module__settingsBackButton___bIe2j {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  padding: 6px 0 12px 0;\n  margin: -6px 0 0.5rem 0;\n  border: none;\n  border-bottom: 1px solid rgba(255, 255, 255, 0.07);\n  border-radius: 0;\n  background: transparent;\n  font-family: inherit;\n  font-size: 0.8125rem;\n  font-weight: 500;\n  letter-spacing: -0.15px;\n  color: #fff;\n  cursor: pointer;\n  transition: transform 0.12s cubic-bezier(0.32, 0.72, 0, 1);\n}\n.styles-module__settingsBackButton___bIe2j svg {\n  opacity: 0.4;\n  flex-shrink: 0;\n  transition: opacity 0.15s ease, transform 0.18s cubic-bezier(0.32, 0.72, 0, 1);\n}\n.styles-module__settingsBackButton___bIe2j:hover {\n  border-bottom-color: rgba(255, 255, 255, 0.07);\n}\n.styles-module__settingsBackButton___bIe2j:hover svg {\n  opacity: 1;\n}\n[data-agentation-theme=light] .styles-module__settingsBackButton___bIe2j {\n  color: rgba(0, 0, 0, 0.85);\n  border-bottom-color: rgba(0, 0, 0, 0.08);\n}\n[data-agentation-theme=light] .styles-module__settingsBackButton___bIe2j:hover {\n  border-bottom-color: rgba(0, 0, 0, 0.08);\n}\n\n.styles-module__automationHeader___InP0r {\n  display: flex;\n  align-items: center;\n  gap: 0.125rem;\n  font-size: 0.8125rem;\n  font-weight: 400;\n  color: #fff;\n}\n[data-agentation-theme=light] .styles-module__automationHeader___InP0r {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n.styles-module__automationDescription___NKlmo {\n  font-size: 0.6875rem;\n  font-weight: 300;\n  color: rgba(255, 255, 255, 0.5);\n  margin-top: 2px;\n  line-height: 14px;\n}\n[data-agentation-theme=light] .styles-module__automationDescription___NKlmo {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__learnMoreLink___8xv-x {\n  color: rgba(255, 255, 255, 0.8);\n  text-decoration: underline dotted;\n  text-decoration-color: rgba(255, 255, 255, 0.2);\n  text-underline-offset: 2px;\n  transition: color 0.15s ease;\n}\n.styles-module__learnMoreLink___8xv-x:hover {\n  color: #fff;\n}\n[data-agentation-theme=light] .styles-module__learnMoreLink___8xv-x {\n  color: rgba(0, 0, 0, 0.6);\n  text-decoration-color: rgba(0, 0, 0, 0.2);\n}\n[data-agentation-theme=light] .styles-module__learnMoreLink___8xv-x:hover {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n.styles-module__autoSendRow___UblX5 {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.styles-module__autoSendLabel___icDc2 {\n  font-size: 0.6875rem;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.4);\n  transition: color 0.15s ease;\n}\n.styles-module__autoSendLabel___icDc2.styles-module__active___-zoN6 {\n  color: #66b8ff;\n  color: color(display-p3 0.4 0.72 1);\n}\n[data-agentation-theme=light] .styles-module__autoSendLabel___icDc2 {\n  color: rgba(0, 0, 0, 0.4);\n}\n[data-agentation-theme=light] .styles-module__autoSendLabel___icDc2.styles-module__active___-zoN6 {\n  color: var(--agentation-color-blue);\n}\n\n.styles-module__webhookUrlInput___2375C {\n  display: block;\n  width: 100%;\n  flex: 1;\n  min-height: 60px;\n  box-sizing: border-box;\n  margin-top: 11px;\n  padding: 8px 10px;\n  border: 1px solid rgba(255, 255, 255, 0.1);\n  border-radius: 6px;\n  background: rgba(255, 255, 255, 0.03);\n  font-family: inherit;\n  font-size: 0.75rem;\n  font-weight: 400;\n  color: #fff;\n  outline: none;\n  resize: none;\n  user-select: text;\n  transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;\n}\n.styles-module__webhookUrlInput___2375C::placeholder {\n  color: rgba(255, 255, 255, 0.3);\n}\n.styles-module__webhookUrlInput___2375C:focus {\n  border-color: rgba(255, 255, 255, 0.3);\n  background: rgba(255, 255, 255, 0.08);\n}\n[data-agentation-theme=light] .styles-module__webhookUrlInput___2375C {\n  border-color: rgba(0, 0, 0, 0.1);\n  background: rgba(0, 0, 0, 0.03);\n  color: rgba(0, 0, 0, 0.85);\n}\n[data-agentation-theme=light] .styles-module__webhookUrlInput___2375C::placeholder {\n  color: rgba(0, 0, 0, 0.3);\n}\n[data-agentation-theme=light] .styles-module__webhookUrlInput___2375C:focus {\n  border-color: rgba(0, 0, 0, 0.25);\n  background: rgba(0, 0, 0, 0.05);\n}\n\n.styles-module__settingsHeader___pwDY9 {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  min-height: 24px;\n  margin-bottom: 0.5rem;\n  padding-bottom: 9px;\n  border-bottom: 1px solid rgba(255, 255, 255, 0.07);\n}\n\n.styles-module__settingsBrand___0gJeM {\n  font-size: 0.8125rem;\n  font-weight: 600;\n  letter-spacing: -0.0094em;\n  color: #fff;\n  text-decoration: none;\n}\n\n.styles-module__settingsBrandSlash___uTG18 {\n  color: var(--agentation-color-accent);\n  transition: color 0.2s ease;\n}\n\n.styles-module__settingsVersion___TUcFq {\n  font-size: 11px;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.4);\n  margin-left: auto;\n  letter-spacing: -0.0094em;\n}\n\n.styles-module__settingsSection___m-YM2 + .styles-module__settingsSection___m-YM2 {\n  margin-top: 0.5rem;\n  padding-top: 0.5rem;\n  border-top: 1px solid rgba(255, 255, 255, 0.07);\n}\n.styles-module__settingsSection___m-YM2.styles-module__settingsSectionExtraPadding___jdhFV {\n  padding-top: calc(0.5rem + 4px);\n}\n\n.styles-module__settingsSectionGrow___h-5HZ {\n  flex: 1;\n  display: flex;\n  flex-direction: column;\n}\n\n.styles-module__settingsRow___3sdhc {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  min-height: 24px;\n}\n.styles-module__settingsRow___3sdhc.styles-module__settingsRowMarginTop___zA0Sp {\n  margin-top: 8px;\n}\n\n.styles-module__dropdownContainer___BVnxe {\n  position: relative;\n}\n\n.styles-module__dropdownButton___16NPz {\n  display: flex;\n  align-items: center;\n  gap: 0.5rem;\n  padding: 0.25rem 0.5rem;\n  border: none;\n  border-radius: 0.375rem;\n  background: transparent;\n  font-size: 0.8125rem;\n  font-weight: 600;\n  color: #fff;\n  cursor: pointer;\n  transition: background-color 0.15s ease, color 0.15s ease;\n  letter-spacing: -0.0094em;\n}\n.styles-module__dropdownButton___16NPz:hover {\n  background: rgba(255, 255, 255, 0.08);\n}\n.styles-module__dropdownButton___16NPz svg {\n  opacity: 0.6;\n}\n\n.styles-module__cycleButton___FMKfw {\n  display: flex;\n  align-items: center;\n  gap: 0.5rem;\n  padding: 0;\n  border: none;\n  background: transparent;\n  font-size: 0.8125rem;\n  font-weight: 500;\n  color: #fff;\n  cursor: pointer;\n  letter-spacing: -0.0094em;\n}\n[data-agentation-theme=light] .styles-module__cycleButton___FMKfw {\n  color: rgba(0, 0, 0, 0.85);\n}\n.styles-module__cycleButton___FMKfw:disabled {\n  opacity: 0.35;\n  cursor: not-allowed;\n}\n\n.styles-module__settingsRowDisabled___EgS0V .styles-module__settingsLabel___8UjfX {\n  color: rgba(255, 255, 255, 0.2);\n}\n[data-agentation-theme=light] .styles-module__settingsRowDisabled___EgS0V .styles-module__settingsLabel___8UjfX {\n  color: rgba(0, 0, 0, 0.2);\n}\n.styles-module__settingsRowDisabled___EgS0V .styles-module__toggleSwitch___l4Ygm {\n  opacity: 0.4;\n  cursor: not-allowed;\n}\n\n@keyframes styles-module__cycleTextIn___Q6zJf {\n  0% {\n    opacity: 0;\n    transform: translateY(-6px);\n  }\n  100% {\n    opacity: 1;\n    transform: translateY(0);\n  }\n}\n.styles-module__cycleButtonText___fD1LR {\n  display: inline-block;\n  animation: styles-module__cycleTextIn___Q6zJf 0.2s ease-out;\n}\n\n.styles-module__cycleDots___LWuoQ {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.styles-module__cycleDot___nPgLY {\n  width: 3px;\n  height: 3px;\n  border-radius: 50%;\n  background: rgba(255, 255, 255, 0.3);\n  transform: scale(0.667);\n  transition: background-color 0.25s ease-out, transform 0.25s ease-out;\n}\n.styles-module__cycleDot___nPgLY.styles-module__active___-zoN6 {\n  background: #fff;\n  transform: scale(1);\n}\n[data-agentation-theme=light] .styles-module__cycleDot___nPgLY {\n  background: rgba(0, 0, 0, 0.2);\n}\n[data-agentation-theme=light] .styles-module__cycleDot___nPgLY.styles-module__active___-zoN6 {\n  background: rgba(0, 0, 0, 0.7);\n}\n\n.styles-module__dropdownMenu___k73ER {\n  position: absolute;\n  right: 0;\n  top: calc(100% + 0.25rem);\n  background: #1a1a1a;\n  border-radius: 0.5rem;\n  padding: 0.25rem;\n  min-width: 120px;\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1);\n  z-index: 10;\n  animation: styles-module__scaleIn___c-r1K 0.15s ease-out;\n}\n\n.styles-module__dropdownItem___ylsLj {\n  width: 100%;\n  display: flex;\n  align-items: center;\n  padding: 0.5rem 0.625rem;\n  border: none;\n  border-radius: 0.375rem;\n  background: transparent;\n  font-size: 0.8125rem;\n  font-weight: 500;\n  color: rgba(255, 255, 255, 0.85);\n  cursor: pointer;\n  text-align: left;\n  transition: background-color 0.15s ease, color 0.15s ease;\n  letter-spacing: -0.0094em;\n}\n.styles-module__dropdownItem___ylsLj:hover {\n  background: rgba(255, 255, 255, 0.08);\n}\n.styles-module__dropdownItem___ylsLj.styles-module__selected___OwRqP {\n  background: rgba(255, 255, 255, 0.12);\n  color: #fff;\n  font-weight: 600;\n}\n\n.styles-module__settingsLabel___8UjfX {\n  font-size: 0.8125rem;\n  font-weight: 400;\n  letter-spacing: -0.0094em;\n  color: rgba(255, 255, 255, 0.5);\n  display: flex;\n  align-items: center;\n  gap: 0.125rem;\n}\n[data-agentation-theme=light] .styles-module__settingsLabel___8UjfX {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__settingsLabelMarker___ewdtV {\n  padding-top: 3px;\n  margin-bottom: 10px;\n}\n\n.styles-module__settingsOptions___LyrBA {\n  display: flex;\n  gap: 0.25rem;\n}\n\n.styles-module__settingsOption___UNa12 {\n  flex: 1;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 0.25rem;\n  padding: 0.375rem 0.5rem;\n  border: none;\n  border-radius: 0.375rem;\n  background: transparent;\n  font-size: 0.6875rem;\n  font-weight: 500;\n  color: rgba(0, 0, 0, 0.7);\n  cursor: pointer;\n  transition: background-color 0.15s ease, color 0.15s ease;\n}\n.styles-module__settingsOption___UNa12:hover {\n  background: rgba(0, 0, 0, 0.05);\n}\n.styles-module__settingsOption___UNa12.styles-module__selected___OwRqP {\n  background: color-mix(in srgb, var(--agentation-color-blue) 15%, transparent);\n  color: var(--agentation-color-blue);\n}\n\n.styles-module__sliderContainer___ducXj {\n  display: flex;\n  flex-direction: column;\n  gap: 0.5rem;\n}\n\n.styles-module__slider___GLdxp {\n  -webkit-appearance: none;\n  appearance: none;\n  width: 100%;\n  height: 4px;\n  background: rgba(255, 255, 255, 0.15);\n  border-radius: 2px;\n  outline: none;\n  cursor: pointer;\n}\n.styles-module__slider___GLdxp::-webkit-slider-thumb {\n  -webkit-appearance: none;\n  appearance: none;\n  width: 14px;\n  height: 14px;\n  background: white;\n  border-radius: 50%;\n  cursor: pointer;\n  transition: transform 0.15s ease, box-shadow 0.15s ease;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);\n}\n.styles-module__slider___GLdxp::-moz-range-thumb {\n  width: 14px;\n  height: 14px;\n  background: white;\n  border: none;\n  border-radius: 50%;\n  cursor: pointer;\n  transition: transform 0.15s ease, box-shadow 0.15s ease;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);\n}\n.styles-module__slider___GLdxp:hover::-webkit-slider-thumb {\n  transform: scale(1.15);\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);\n}\n.styles-module__slider___GLdxp:hover::-moz-range-thumb {\n  transform: scale(1.15);\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);\n}\n\n.styles-module__sliderLabels___FhLDB {\n  display: flex;\n  justify-content: space-between;\n}\n\n.styles-module__sliderLabel___U8sPr {\n  font-size: 0.625rem;\n  font-weight: 500;\n  color: rgba(255, 255, 255, 0.4);\n  cursor: pointer;\n  transition: color 0.15s ease;\n}\n.styles-module__sliderLabel___U8sPr:hover {\n  color: rgba(255, 255, 255, 0.7);\n}\n.styles-module__sliderLabel___U8sPr.styles-module__active___-zoN6 {\n  color: rgba(255, 255, 255, 0.9);\n}\n\n.styles-module__colorOptions___iHCNX {\n  display: flex;\n  gap: 0.5rem;\n  margin-top: 0.375rem;\n  margin-bottom: 1px;\n}\n\n.styles-module__colorOption___IodiY {\n  display: block;\n  width: 20px;\n  height: 20px;\n  border-radius: 50%;\n  border: 2px solid transparent;\n  background-color: var(--swatch);\n  cursor: pointer;\n  transition: transform 0.2s cubic-bezier(0.25, 1, 0.5, 1);\n}\n@supports (color: color(display-p3 0 0 0)) {\n  .styles-module__colorOption___IodiY {\n    background-color: var(--swatch-p3);\n  }\n}\n.styles-module__colorOption___IodiY:hover {\n  transform: scale(1.15);\n}\n.styles-module__colorOption___IodiY.styles-module__selected___OwRqP {\n  transform: scale(0.83);\n}\n\n.styles-module__colorOptionRing___U2xpo {\n  display: flex;\n  width: 24px;\n  height: 24px;\n  border: 2px solid transparent;\n  border-radius: 50%;\n  transition: border-color 0.3s ease;\n}\n.styles-module__colorOptionRing___U2xpo.styles-module__selected___OwRqP {\n  border-color: var(--swatch);\n}\n@supports (color: color(display-p3 0 0 0)) {\n  .styles-module__colorOptionRing___U2xpo.styles-module__selected___OwRqP {\n    border-color: var(--swatch-p3);\n  }\n}\n\n.styles-module__settingsToggle___fBrFn {\n  display: flex;\n  align-items: center;\n  gap: 0.5rem;\n  cursor: pointer;\n}\n.styles-module__settingsToggle___fBrFn + .styles-module__settingsToggle___fBrFn {\n  margin-top: calc(0.5rem + 6px);\n}\n.styles-module__settingsToggle___fBrFn input[type=checkbox] {\n  position: absolute;\n  opacity: 0;\n  width: 0;\n  height: 0;\n}\n.styles-module__settingsToggle___fBrFn.styles-module__settingsToggleMarginBottom___MZUyF {\n  margin-bottom: calc(0.5rem + 6px);\n}\n\n@keyframes styles-module__mcpPulse___uNggr {\n  0% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 50%, transparent);\n  }\n  70% {\n    box-shadow: 0 0 0 6px color-mix(in srgb, var(--agentation-color-green) 0%, transparent);\n  }\n  100% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 0%, transparent);\n  }\n}\n@keyframes styles-module__mcpPulseError___fov9B {\n  0% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-red) 50%, transparent);\n  }\n  70% {\n    box-shadow: 0 0 0 6px color-mix(in srgb, var(--agentation-color-red) 0%, transparent);\n  }\n  100% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-red) 0%, transparent);\n  }\n}\n.styles-module__mcpStatusDot___ibgkc {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  flex-shrink: 0;\n}\n.styles-module__mcpStatusDot___ibgkc.styles-module__connecting___uo-CW {\n  background-color: var(--agentation-color-yellow);\n  animation: styles-module__mcpPulse___uNggr 1.5s infinite;\n}\n.styles-module__mcpStatusDot___ibgkc.styles-module__connected___7c28g {\n  background-color: var(--agentation-color-green);\n  animation: styles-module__mcpPulse___uNggr 2.5s ease-in-out infinite;\n}\n.styles-module__mcpStatusDot___ibgkc.styles-module__disconnected___cHPxR {\n  background-color: var(--agentation-color-red);\n  animation: styles-module__mcpPulseError___fov9B 2s infinite;\n}\n\n.styles-module__drawCanvas___7cG9U {\n  position: fixed;\n  inset: 0;\n  z-index: 99996;\n  pointer-events: none !important;\n}\n.styles-module__drawCanvas___7cG9U.styles-module__active___-zoN6 {\n  pointer-events: auto !important;\n  cursor: crosshair !important;\n}\n.styles-module__drawCanvas___7cG9U.styles-module__active___-zoN6[data-stroke-hover] {\n  cursor: pointer !important;\n}\n\n.styles-module__dragSelection___kZLq2 {\n  position: fixed;\n  top: 0;\n  left: 0;\n  border: 2px solid color-mix(in srgb, var(--agentation-color-green) 60%, transparent);\n  border-radius: 4px;\n  background-color: color-mix(in srgb, var(--agentation-color-green) 8%, transparent);\n  pointer-events: none;\n  z-index: 99997;\n  will-change: transform, width, height;\n  contain: layout style;\n}\n\n.styles-module__dragCount___KM90j {\n  position: absolute;\n  top: 50%;\n  left: 50%;\n  transform: translate(-50%, -50%);\n  background-color: var(--agentation-color-green);\n  color: white;\n  font-size: 0.875rem;\n  font-weight: 600;\n  padding: 0.25rem 0.5rem;\n  border-radius: 1rem;\n  min-width: 1.5rem;\n  text-align: center;\n}\n\n.styles-module__highlightsContainer___-0xzG {\n  position: fixed;\n  top: 0;\n  left: 0;\n  pointer-events: none;\n  z-index: 99996;\n}\n\n.styles-module__selectedElementHighlight___fyVlI {\n  position: fixed;\n  top: 0;\n  left: 0;\n  border: 2px solid color-mix(in srgb, var(--agentation-color-green) 50%, transparent);\n  border-radius: 4px;\n  background: color-mix(in srgb, var(--agentation-color-green) 6%, transparent);\n  pointer-events: none;\n  will-change: transform, width, height;\n  contain: layout style;\n}\n\n[data-agentation-theme=light] .styles-module__toolbarContainer___dIhma {\n  background: #fff;\n  color: rgba(0, 0, 0, 0.85);\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);\n}\n[data-agentation-theme=light] .styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn:hover {\n  background: #f5f5f5;\n}\n[data-agentation-theme=light] .styles-module__toggleContent___0yfyP {\n  color: rgba(0, 0, 0, 0.85);\n}\n[data-agentation-theme=light] .styles-module__toggleContent___0yfyP.styles-module__expandedToggle___F7SRN {\n  color: rgba(0, 0, 0, 0.5);\n}\n[data-agentation-theme=light] .styles-module__toggleContent___0yfyP.styles-module__expandedToggle___F7SRN:hover {\n  color: rgba(0, 0, 0, 0.85);\n}\n[data-agentation-theme=light] .styles-module__toggleContent___0yfyP.styles-module__expandedToggle___F7SRN:hover::before {\n  background: rgba(0, 0, 0, 0.06);\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc {\n  color: rgba(0, 0, 0, 0.5);\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc:hover:not(:disabled):not([data-active=true]):not([data-failed=true]):not([data-auto-sync=true]):not([data-error=true]):not([data-no-hover=true]) {\n  background: rgba(0, 0, 0, 0.06);\n  color: rgba(0, 0, 0, 0.85);\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-active=true] {\n  color: var(--agentation-color-blue);\n  background: color-mix(in srgb, var(--agentation-color-blue) 15%, transparent);\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-error=true] {\n  color: var(--agentation-color-red);\n  background: color-mix(in srgb, var(--agentation-color-red) 15%, transparent);\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-danger]:hover:not(:disabled):not([data-active=true]):not([data-failed=true]) {\n  color: var(--agentation-color-red);\n  background: color-mix(in srgb, var(--agentation-color-red) 15%, transparent);\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-auto-sync=true] {\n  color: var(--agentation-color-green);\n  background: transparent;\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-failed=true] {\n  color: var(--agentation-color-red);\n  background: color-mix(in srgb, var(--agentation-color-red) 15%, transparent);\n}\n[data-agentation-theme=light] .styles-module__buttonTooltip___Burd9 {\n  background: #fff;\n  color: rgba(0, 0, 0, 0.85);\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);\n}\n[data-agentation-theme=light] .styles-module__buttonTooltip___Burd9::after {\n  background: #fff;\n}\n[data-agentation-theme=light] .styles-module__divider___c--s1 {\n  background: rgba(0, 0, 0, 0.1);\n}';
var styles_module_default3 = { "toolbar": "styles-module__toolbar___wNsdK", "markersLayer": "styles-module__markersLayer___-25j1", "fixedMarkersLayer": "styles-module__fixedMarkersLayer___ffyX6", "controlsContent": "styles-module__controlsContent___9GJWU", "disableTransitions": "styles-module__disableTransitions___EopxO", "positionContext": "styles-module__positionContext___AZFHE", "toolbarContainer": "styles-module__toolbarContainer___dIhma", "entrance": "styles-module__entrance___sgHd8", "toolbarEnter": "styles-module__toolbarEnter___u8RRu", "hiding": "styles-module__hiding___1td44", "toolbarHide": "styles-module__toolbarHide___y8kaT", "collapsed": "styles-module__collapsed___Rydsn", "expanded": "styles-module__expanded___ofKPx", "serverConnected": "styles-module__serverConnected___Gfbou", "buttonWrapper": "styles-module__buttonWrapper___rBcdv", "toggleWrapper": "styles-module__toggleWrapper___7N0-q", "togglePlaceholder": "styles-module__togglePlaceholder___wnqrL", "toggleContent": "styles-module__toggleContent___0yfyP", "expandedToggle": "styles-module__expandedToggle___F7SRN", "toggleGlyph": "styles-module__toggleGlyph___R7Oom", "toggleIcon": "styles-module__toggleIcon___Jbtus", "toggleTopLine": "styles-module__toggleTopLine___hQaCm", "toggleMiddleLine": "styles-module__toggleMiddleLine___sFFVe", "toggleBottomLine": "styles-module__toggleBottomLine___V-jX3", "toggleSparkle": "styles-module__toggleSparkle___eeF99", "controlButton": "styles-module__controlButton___8Q0jc", "visible": "styles-module__visible___KHwEW", "hidden": "styles-module__hidden___Ae8H4", "badge": "styles-module__badge___2XsgF", "fadeOut": "styles-module__fadeOut___6Ut6-", "badgeEnter": "styles-module__badgeEnter___mVQLj", "statusShowing": "styles-module__statusShowing___te6iu", "buttonBadge": "styles-module__buttonBadge___NeFWb", "mcpIndicator": "styles-module__mcpIndicator___zGJeL", "connected": "styles-module__connected___7c28g", "mcpIndicatorPulseConnected": "styles-module__mcpIndicatorPulseConnected___EDodZ", "connecting": "styles-module__connecting___uo-CW", "mcpIndicatorPulseConnecting": "styles-module__mcpIndicatorPulseConnecting___cCYte", "connectionIndicatorWrapper": "styles-module__connectionIndicatorWrapper___L-e-3", "connectionIndicator": "styles-module__connectionIndicator___afk9p", "connectionIndicatorVisible": "styles-module__connectionIndicatorVisible___C-i5B", "connectionIndicatorConnected": "styles-module__connectionIndicatorConnected___IY8pR", "connectionPulse": "styles-module__connectionPulse___-Zycw", "connectionIndicatorDisconnected": "styles-module__connectionIndicatorDisconnected___kmpaZ", "connectionIndicatorConnecting": "styles-module__connectionIndicatorConnecting___QmSLH", "buttonTooltip": "styles-module__buttonTooltip___Burd9", "tooltipsInSession": "styles-module__tooltipsInSession___-0lHH", "sendButtonWrapper": "styles-module__sendButtonWrapper___UUxG6", "sendButtonVisible": "styles-module__sendButtonVisible___WPSQU", "shortcut": "styles-module__shortcut___lEAQk", "tooltipBelow": "styles-module__tooltipBelow___m6ats", "tooltipsHidden": "styles-module__tooltipsHidden___VtLJG", "tooltipVisible": "styles-module__tooltipVisible___0jcCv", "buttonWrapperAlignLeft": "styles-module__buttonWrapperAlignLeft___myzIp", "buttonWrapperAlignRight": "styles-module__buttonWrapperAlignRight___HCQFR", "divider": "styles-module__divider___c--s1", "overlay": "styles-module__overlay___Q1O9y", "hoverHighlight": "styles-module__hoverHighlight___ogakW", "enter": "styles-module__enter___WFIki", "hoverHighlightIn": "styles-module__hoverHighlightIn___6WYHY", "multiSelectOutline": "styles-module__multiSelectOutline___cSJ-m", "fadeIn": "styles-module__fadeIn___b9qmf", "exit": "styles-module__exit___fyOJ0", "singleSelectOutline": "styles-module__singleSelectOutline___QhX-O", "hoverTooltip": "styles-module__hoverTooltip___bvLk7", "hoverTooltipIn": "styles-module__hoverTooltipIn___FYGQx", "hoverReactPath": "styles-module__hoverReactPath___gx1IJ", "hoverElementName": "styles-module__hoverElementName___QMLMl", "marker": "styles-module__marker___6sQrs", "clearing": "styles-module__clearing___FQ--7", "markerIn": "styles-module__markerIn___5FaAP", "markerOut": "styles-module__markerOut___GU5jX", "pending": "styles-module__pending___2IHLC", "fixed": "styles-module__fixed___dBMHC", "multiSelect": "styles-module__multiSelect___YWiuz", "hovered": "styles-module__hovered___ZgXIy", "renumber": "styles-module__renumber___nCTxD", "renumberRoll": "styles-module__renumberRoll___Wgbq3", "markerTooltip": "styles-module__markerTooltip___aLJID", "tooltipIn": "styles-module__tooltipIn___0N31w", "markerQuote": "styles-module__markerQuote___FHmrz", "markerNote": "styles-module__markerNote___QkrrS", "markerHint": "styles-module__markerHint___2iF-6", "settingsPanel": "styles-module__settingsPanel___OxX3Y", "settingsHeader": "styles-module__settingsHeader___pwDY9", "settingsBrand": "styles-module__settingsBrand___0gJeM", "settingsBrandSlash": "styles-module__settingsBrandSlash___uTG18", "settingsVersion": "styles-module__settingsVersion___TUcFq", "settingsSection": "styles-module__settingsSection___m-YM2", "settingsLabel": "styles-module__settingsLabel___8UjfX", "cycleButton": "styles-module__cycleButton___FMKfw", "cycleDot": "styles-module__cycleDot___nPgLY", "dropdownButton": "styles-module__dropdownButton___16NPz", "toggleLabel": "styles-module__toggleLabel___Xm8Aa", "customCheckbox": "styles-module__customCheckbox___U39ax", "sliderLabel": "styles-module__sliderLabel___U8sPr", "slider": "styles-module__slider___GLdxp", "themeToggle": "styles-module__themeToggle___2rUjA", "settingsOption": "styles-module__settingsOption___UNa12", "selected": "styles-module__selected___OwRqP", "settingsPanelContainer": "styles-module__settingsPanelContainer___Xksv8", "settingsPage": "styles-module__settingsPage___6YfHH", "slideLeft": "styles-module__slideLeft___Ps01J", "automationsPage": "styles-module__automationsPage___uvCq6", "slideIn": "styles-module__slideIn___4-qXe", "settingsNavLink": "styles-module__settingsNavLink___wCzJt", "settingsNavLinkRight": "styles-module__settingsNavLinkRight___ZWwhj", "mcpNavIndicator": "styles-module__mcpNavIndicator___cl9pO", "mcpPulse": "styles-module__mcpPulse___uNggr", "settingsBackButton": "styles-module__settingsBackButton___bIe2j", "automationHeader": "styles-module__automationHeader___InP0r", "automationDescription": "styles-module__automationDescription___NKlmo", "learnMoreLink": "styles-module__learnMoreLink___8xv-x", "autoSendRow": "styles-module__autoSendRow___UblX5", "autoSendLabel": "styles-module__autoSendLabel___icDc2", "active": "styles-module__active___-zoN6", "webhookUrlInput": "styles-module__webhookUrlInput___2375C", "settingsSectionExtraPadding": "styles-module__settingsSectionExtraPadding___jdhFV", "settingsSectionGrow": "styles-module__settingsSectionGrow___h-5HZ", "settingsRow": "styles-module__settingsRow___3sdhc", "settingsRowMarginTop": "styles-module__settingsRowMarginTop___zA0Sp", "dropdownContainer": "styles-module__dropdownContainer___BVnxe", "settingsRowDisabled": "styles-module__settingsRowDisabled___EgS0V", "toggleSwitch": "styles-module__toggleSwitch___l4Ygm", "cycleButtonText": "styles-module__cycleButtonText___fD1LR", "cycleTextIn": "styles-module__cycleTextIn___Q6zJf", "cycleDots": "styles-module__cycleDots___LWuoQ", "dropdownMenu": "styles-module__dropdownMenu___k73ER", "scaleIn": "styles-module__scaleIn___c-r1K", "dropdownItem": "styles-module__dropdownItem___ylsLj", "settingsLabelMarker": "styles-module__settingsLabelMarker___ewdtV", "settingsOptions": "styles-module__settingsOptions___LyrBA", "sliderContainer": "styles-module__sliderContainer___ducXj", "sliderLabels": "styles-module__sliderLabels___FhLDB", "colorOptions": "styles-module__colorOptions___iHCNX", "colorOption": "styles-module__colorOption___IodiY", "colorOptionRing": "styles-module__colorOptionRing___U2xpo", "settingsToggle": "styles-module__settingsToggle___fBrFn", "settingsToggleMarginBottom": "styles-module__settingsToggleMarginBottom___MZUyF", "mcpStatusDot": "styles-module__mcpStatusDot___ibgkc", "disconnected": "styles-module__disconnected___cHPxR", "mcpPulseError": "styles-module__mcpPulseError___fov9B", "drawCanvas": "styles-module__drawCanvas___7cG9U", "dragSelection": "styles-module__dragSelection___kZLq2", "dragCount": "styles-module__dragCount___KM90j", "highlightsContainer": "styles-module__highlightsContainer___-0xzG", "selectedElementHighlight": "styles-module__selectedElementHighlight___fyVlI", "scaleOut": "styles-module__scaleOut___Wctwz", "slideUp": "styles-module__slideUp___kgD36", "slideDown": "styles-module__slideDown___zcdje" };

// src/components/page-toolbar-css/toolbar-toggle-icon.tsx
var import_jsx_runtime7 = require("react/jsx-runtime");
function ToolbarToggleIcon({ active }) {
  return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
    "svg",
    {
      className: styles_module_default3.toggleGlyph,
      "data-active": active,
      width: "24",
      height: "24",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("path", { className: styles_module_default3.toggleTopLine, d: "M5.5 6.75H18.5" }),
        /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("path", { className: styles_module_default3.toggleMiddleLine, d: "M5.5 12H11.5" }),
        /* @__PURE__ */ (0, import_jsx_runtime7.jsx)("path", { className: styles_module_default3.toggleBottomLine, d: "M5.5 17.25H9.25" }),
        /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
          "path",
          {
            className: styles_module_default3.toggleSparkle,
            d: "M16 12.75L16.5179 13.9677C16.8078 14.6494 17.3506 15.1922 18.0323 15.4821L19.25 16L18.0323 16.5179C17.3506 16.8078 16.8078 17.3506 16.5179 18.0323L16 19.25L15.4821 18.0323C15.1922 17.3506 14.6494 16.8078 13.9677 16.5179L12.75 16L13.9677 15.4821C14.6494 15.1922 15.1922 14.6494 15.4821 13.9677L16 12.75Z"
          }
        )
      ]
    }
  );
}

// src/components/design-mode/index.tsx
var import_react10 = require("react");

// src/components/design-mode/types.ts
var DEFAULT_SIZES = {
  navigation: { width: 800, height: 56 },
  hero: { width: 800, height: 320 },
  header: { width: 800, height: 80 },
  section: { width: 800, height: 400 },
  sidebar: { width: 240, height: 400 },
  footer: { width: 800, height: 160 },
  modal: { width: 480, height: 300 },
  card: { width: 280, height: 240 },
  text: { width: 400, height: 120 },
  image: { width: 320, height: 200 },
  video: { width: 480, height: 270 },
  table: { width: 560, height: 220 },
  grid: { width: 600, height: 300 },
  list: { width: 300, height: 180 },
  chart: { width: 400, height: 240 },
  button: { width: 140, height: 40 },
  input: { width: 280, height: 56 },
  form: { width: 360, height: 320 },
  tabs: { width: 480, height: 240 },
  dropdown: { width: 200, height: 200 },
  toggle: { width: 44, height: 24 },
  search: { width: 320, height: 44 },
  avatar: { width: 48, height: 48 },
  badge: { width: 80, height: 28 },
  breadcrumb: { width: 300, height: 24 },
  pagination: { width: 300, height: 36 },
  progress: { width: 240, height: 8 },
  divider: { width: 600, height: 1 },
  accordion: { width: 400, height: 200 },
  carousel: { width: 600, height: 300 },
  toast: { width: 320, height: 64 },
  tooltip: { width: 180, height: 40 },
  pricing: { width: 300, height: 360 },
  testimonial: { width: 360, height: 200 },
  cta: { width: 600, height: 160 },
  alert: { width: 400, height: 56 },
  banner: { width: 800, height: 48 },
  stat: { width: 200, height: 120 },
  stepper: { width: 480, height: 48 },
  tag: { width: 72, height: 28 },
  rating: { width: 160, height: 28 },
  map: { width: 480, height: 300 },
  timeline: { width: 360, height: 320 },
  fileUpload: { width: 360, height: 180 },
  codeBlock: { width: 480, height: 200 },
  calendar: { width: 300, height: 300 },
  notification: { width: 360, height: 72 },
  productCard: { width: 280, height: 360 },
  profile: { width: 280, height: 200 },
  drawer: { width: 320, height: 400 },
  popover: { width: 240, height: 160 },
  logo: { width: 120, height: 40 },
  faq: { width: 560, height: 320 },
  gallery: { width: 560, height: 360 },
  checkbox: { width: 20, height: 20 },
  radio: { width: 20, height: 20 },
  slider: { width: 240, height: 32 },
  datePicker: { width: 300, height: 320 },
  skeleton: { width: 320, height: 120 },
  chip: { width: 96, height: 32 },
  icon: { width: 24, height: 24 },
  spinner: { width: 32, height: 32 },
  feature: { width: 360, height: 200 },
  team: { width: 560, height: 280 },
  login: { width: 360, height: 360 },
  contact: { width: 400, height: 320 }
};
var COMPONENT_REGISTRY = [
  {
    section: "Layout",
    items: [
      { type: "navigation", label: "Navigation", ...DEFAULT_SIZES.navigation },
      { type: "header", label: "Header", ...DEFAULT_SIZES.header },
      { type: "hero", label: "Hero", ...DEFAULT_SIZES.hero },
      { type: "section", label: "Section", ...DEFAULT_SIZES.section },
      { type: "sidebar", label: "Sidebar", ...DEFAULT_SIZES.sidebar },
      { type: "footer", label: "Footer", ...DEFAULT_SIZES.footer },
      { type: "modal", label: "Modal", ...DEFAULT_SIZES.modal },
      { type: "banner", label: "Banner", ...DEFAULT_SIZES.banner },
      { type: "drawer", label: "Drawer", ...DEFAULT_SIZES.drawer },
      { type: "popover", label: "Popover", ...DEFAULT_SIZES.popover },
      { type: "divider", label: "Divider", ...DEFAULT_SIZES.divider }
    ]
  },
  {
    section: "Content",
    items: [
      { type: "card", label: "Card", ...DEFAULT_SIZES.card },
      { type: "text", label: "Text", ...DEFAULT_SIZES.text },
      { type: "image", label: "Image", ...DEFAULT_SIZES.image },
      { type: "video", label: "Video", ...DEFAULT_SIZES.video },
      { type: "table", label: "Table", ...DEFAULT_SIZES.table },
      { type: "grid", label: "Grid", ...DEFAULT_SIZES.grid },
      { type: "list", label: "List", ...DEFAULT_SIZES.list },
      { type: "chart", label: "Chart", ...DEFAULT_SIZES.chart },
      { type: "codeBlock", label: "Code Block", ...DEFAULT_SIZES.codeBlock },
      { type: "map", label: "Map", ...DEFAULT_SIZES.map },
      { type: "timeline", label: "Timeline", ...DEFAULT_SIZES.timeline },
      { type: "calendar", label: "Calendar", ...DEFAULT_SIZES.calendar },
      { type: "accordion", label: "Accordion", ...DEFAULT_SIZES.accordion },
      { type: "carousel", label: "Carousel", ...DEFAULT_SIZES.carousel },
      { type: "logo", label: "Logo", ...DEFAULT_SIZES.logo },
      { type: "faq", label: "FAQ", ...DEFAULT_SIZES.faq },
      { type: "gallery", label: "Gallery", ...DEFAULT_SIZES.gallery }
    ]
  },
  {
    section: "Controls",
    items: [
      { type: "button", label: "Button", ...DEFAULT_SIZES.button },
      { type: "input", label: "Input", ...DEFAULT_SIZES.input },
      { type: "search", label: "Search", ...DEFAULT_SIZES.search },
      { type: "form", label: "Form", ...DEFAULT_SIZES.form },
      { type: "tabs", label: "Tabs", ...DEFAULT_SIZES.tabs },
      { type: "dropdown", label: "Dropdown", ...DEFAULT_SIZES.dropdown },
      { type: "toggle", label: "Toggle", ...DEFAULT_SIZES.toggle },
      { type: "stepper", label: "Stepper", ...DEFAULT_SIZES.stepper },
      { type: "rating", label: "Rating", ...DEFAULT_SIZES.rating },
      { type: "fileUpload", label: "File Upload", ...DEFAULT_SIZES.fileUpload },
      { type: "checkbox", label: "Checkbox", ...DEFAULT_SIZES.checkbox },
      { type: "radio", label: "Radio", ...DEFAULT_SIZES.radio },
      { type: "slider", label: "Slider", ...DEFAULT_SIZES.slider },
      { type: "datePicker", label: "Date Picker", ...DEFAULT_SIZES.datePicker }
    ]
  },
  {
    section: "Elements",
    items: [
      { type: "avatar", label: "Avatar", ...DEFAULT_SIZES.avatar },
      { type: "badge", label: "Badge", ...DEFAULT_SIZES.badge },
      { type: "tag", label: "Tag", ...DEFAULT_SIZES.tag },
      { type: "breadcrumb", label: "Breadcrumb", ...DEFAULT_SIZES.breadcrumb },
      { type: "pagination", label: "Pagination", ...DEFAULT_SIZES.pagination },
      { type: "progress", label: "Progress", ...DEFAULT_SIZES.progress },
      { type: "alert", label: "Alert", ...DEFAULT_SIZES.alert },
      { type: "toast", label: "Toast", ...DEFAULT_SIZES.toast },
      { type: "notification", label: "Notification", ...DEFAULT_SIZES.notification },
      { type: "tooltip", label: "Tooltip", ...DEFAULT_SIZES.tooltip },
      { type: "stat", label: "Stat", ...DEFAULT_SIZES.stat },
      { type: "skeleton", label: "Skeleton", ...DEFAULT_SIZES.skeleton },
      { type: "chip", label: "Chip", ...DEFAULT_SIZES.chip },
      { type: "icon", label: "Icon", ...DEFAULT_SIZES.icon },
      { type: "spinner", label: "Spinner", ...DEFAULT_SIZES.spinner }
    ]
  },
  {
    section: "Blocks",
    items: [
      { type: "pricing", label: "Pricing", ...DEFAULT_SIZES.pricing },
      { type: "testimonial", label: "Testimonial", ...DEFAULT_SIZES.testimonial },
      { type: "cta", label: "CTA", ...DEFAULT_SIZES.cta },
      { type: "productCard", label: "Product Card", ...DEFAULT_SIZES.productCard },
      { type: "profile", label: "Profile", ...DEFAULT_SIZES.profile },
      { type: "feature", label: "Feature", ...DEFAULT_SIZES.feature },
      { type: "team", label: "Team", ...DEFAULT_SIZES.team },
      { type: "login", label: "Login", ...DEFAULT_SIZES.login },
      { type: "contact", label: "Contact", ...DEFAULT_SIZES.contact }
    ]
  }
];
var COMPONENT_MAP = {};
for (const section of COMPONENT_REGISTRY) {
  for (const item of section.items) {
    COMPONENT_MAP[item.type] = item;
  }
}

// src/components/design-mode/skeletons.tsx
var import_jsx_runtime8 = require("react/jsx-runtime");
function Bar({ w, h = 3, strong }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
    "div",
    {
      style: {
        width: typeof w === "number" ? `${w}px` : w,
        height: h,
        borderRadius: 2,
        background: strong ? "var(--agd-bar-strong)" : "var(--agd-bar)",
        flexShrink: 0
      }
    }
  );
}
function Block({
  w,
  h,
  radius = 3,
  style
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
    "div",
    {
      style: {
        width: typeof w === "number" ? `${w}px` : w,
        height: typeof h === "number" ? `${h}px` : h,
        borderRadius: radius,
        border: "1px dashed var(--agd-stroke)",
        background: "var(--agd-fill)",
        flexShrink: 0,
        ...style
      }
    }
  );
}
function Circle({ size }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
    "div",
    {
      style: {
        width: size,
        height: size,
        borderRadius: "50%",
        border: "1px dashed var(--agd-stroke)",
        background: "var(--agd-fill)",
        flexShrink: 0
      }
    }
  );
}
function NavigationSkeleton({ width, height }) {
  const pad = Math.max(8, height * 0.2);
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", alignItems: "center", height: "100%", padding: `0 ${pad}px`, gap: width * 0.02 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: Math.max(20, height * 0.5), h: Math.max(12, height * 0.4), radius: 2 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, display: "flex", gap: width * 0.03, marginLeft: width * 0.04 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.06 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.07 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.05 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.06 })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: width * 0.1, h: Math.min(28, height * 0.5), radius: 4 })
  ] });
}
function HeroSkeleton({ width, height, text }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: height * 0.05 }, children: [
    text ? /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: Math.min(20, height * 0.08), fontWeight: 600, color: "var(--agd-text-3)", textAlign: "center", maxWidth: "80%" }, children: text }) : /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.5, h: Math.max(6, height * 0.04), strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.6 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.4 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: Math.min(140, width * 0.2), h: Math.min(36, height * 0.12), radius: 6, style: { marginTop: height * 0.06 } })
  ] });
}
function SidebarSkeleton({ width, height }) {
  const items = Math.max(3, Math.floor(height / 36));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { padding: width * 0.08, display: "flex", flexDirection: "column", gap: height * 0.03 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.6, h: 4, strong: true }),
    Array.from({ length: items }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: 10, h: 10, radius: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * (0.4 + i * 17 % 30 / 100) })
    ] }, i))
  ] });
}
function FooterSkeleton({ width, height }) {
  const cols = Math.max(2, Math.min(4, Math.floor(width / 160)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", padding: `${height * 0.12}px ${width * 0.03}px`, gap: width * 0.05 }, children: Array.from({ length: cols }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 4 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "60%", h: 3, strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "80%", h: 2 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "70%", h: 2 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "60%", h: 2 })
  ] }, i)) });
}
function ModalSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { padding: "10px 12px", borderBottom: "1px solid var(--agd-stroke)", display: "flex", alignItems: "center", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.3, h: 4, strong: true }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: 14, height: 14, border: "1px solid var(--agd-stroke)", borderRadius: 3 } })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, padding: 12, display: "flex", flexDirection: "column", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "90%" }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "70%" }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "80%" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { padding: "10px 12px", borderTop: "1px solid var(--agd-stroke)", display: "flex", justifyContent: "flex-end", gap: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: 70, h: 26, radius: 4 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: 70, h: 26, radius: 4, style: { background: "var(--agd-bar)" } })
    ] })
  ] });
}
function CardSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { height: "40%", background: "var(--agd-fill)", borderBottom: "1px dashed var(--agd-stroke)" } }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, padding: 10, display: "flex", flexDirection: "column", gap: 5 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "70%", h: 4, strong: true }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "95%", h: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "85%", h: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "50%", h: 2 })
    ] })
  ] });
}
function TextSkeleton({ width, height, text }) {
  if (text) {
    return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { padding: 4, fontSize: Math.min(14, height * 0.3), lineHeight: 1.5, color: "var(--agd-text-3)", wordBreak: "break-word", overflow: "hidden" }, children: text });
  }
  const lines = Math.max(2, Math.floor(height / 18));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6, padding: 4 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.6, h: 5, strong: true }),
    Array.from({ length: lines }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: `${70 + i * 13 % 25}%`, h: 2 }, i))
  ] });
}
function ImageSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { height: "100%", position: "relative" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", fill: "none", children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("line", { x1: "0", y1: "0", x2: width, y2: height, stroke: "var(--agd-stroke)", strokeWidth: "1" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("line", { x1: width, y1: "0", x2: "0", y2: height, stroke: "var(--agd-stroke)", strokeWidth: "1" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("circle", { cx: width * 0.3, cy: height * 0.3, r: Math.min(width, height) * 0.08, fill: "var(--agd-fill)", stroke: "var(--agd-stroke)", strokeWidth: "0.8" })
  ] }) });
}
function TableSkeleton({ width, height }) {
  const cols = Math.max(2, Math.min(5, Math.floor(width / 100)));
  const rows = Math.max(2, Math.min(6, Math.floor(height / 32)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", borderBottom: "1px solid var(--agd-stroke)", padding: "6px 0" }, children: Array.from({ length: cols }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { flex: 1, padding: "0 8px" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "70%", h: 3, strong: true }) }, i)) }),
    Array.from({ length: rows }, (_, r) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", borderBottom: "1px solid rgba(255,255,255,0.03)", padding: "6px 0" }, children: Array.from({ length: cols }, (_2, c) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { flex: 1, padding: "0 8px" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: `${50 + (r * 7 + c * 13) % 40}%`, h: 2 }) }, c)) }, r))
  ] });
}
function ListSkeleton({ width, height }) {
  const items = Math.max(2, Math.floor(height / 28));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", flexDirection: "column", gap: 4, padding: 4 }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: 8 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: `${55 + i * 17 % 35}%`, h: 2 })
  ] }, i)) });
}
function ButtonSkeleton({ width, height, text }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: {
    height: "100%",
    borderRadius: Math.min(8, height / 3),
    border: "1px solid var(--agd-stroke)",
    background: "var(--agd-fill)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  }, children: text ? /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: Math.min(13, height * 0.4), fontWeight: 500, color: "var(--agd-text-3)", letterSpacing: "-0.01em" }, children: text }) : /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: Math.max(20, width * 0.5), h: 3, strong: true }) });
}
function InputSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 4, height: "100%", justifyContent: "center" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: Math.min(80, width * 0.3), h: 2 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: {
      height: Math.min(36, height * 0.6),
      borderRadius: 4,
      border: "1px dashed var(--agd-stroke)",
      background: "var(--agd-fill)",
      display: "flex",
      alignItems: "center",
      paddingLeft: 8
    }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "40%", h: 2 }) })
  ] });
}
function FormSkeleton({ width, height }) {
  const fields = Math.max(2, Math.min(5, Math.floor(height / 56)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: height * 0.04, padding: 8 }, children: [
    Array.from({ length: fields }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 60 + i * 17 % 30, h: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "100%", h: 28, radius: 4 })
    ] }, i)),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: Math.min(120, width * 0.35), h: 30, radius: 6, style: { marginTop: 8, alignSelf: "flex-end", background: "var(--agd-bar)" } })
  ] });
}
function TabsSkeleton({ width, height }) {
  const tabCount = Math.max(2, Math.min(4, Math.floor(width / 120)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", gap: 2, borderBottom: "1px solid var(--agd-stroke)" }, children: Array.from({ length: tabCount }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { padding: "8px 12px", borderBottom: i === 0 ? "2px solid var(--agd-bar-strong)" : "none" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 60, h: 3, strong: i === 0 }) }, i)) }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, padding: 12, display: "flex", flexDirection: "column", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "80%", h: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "65%", h: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "75%", h: 2 })
    ] })
  ] });
}
function AvatarSkeleton({ width, height }) {
  const r = Math.min(width, height) / 2;
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("circle", { cx: width / 2, cy: height / 2, r: r - 1, stroke: "var(--agd-stroke)", fill: "var(--agd-fill)", strokeWidth: "1.5", strokeDasharray: "3 2" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("circle", { cx: width / 2, cy: height * 0.38, r: r * 0.28, stroke: "var(--agd-stroke)", fill: "var(--agd-fill)", strokeWidth: "0.8" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
      "path",
      {
        d: `M${width / 2 - r * 0.55} ${height * 0.78} C${width / 2 - r * 0.55} ${height * 0.55} ${width / 2 + r * 0.55} ${height * 0.55} ${width / 2 + r * 0.55} ${height * 0.78}`,
        stroke: "var(--agd-stroke)",
        fill: "var(--agd-fill)",
        strokeWidth: "0.8"
      }
    )
  ] });
}
function BadgeSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: {
    height: "100%",
    borderRadius: height / 2,
    border: "1px solid var(--agd-stroke)",
    background: "var(--agd-fill)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: Math.max(16, width * 0.5), h: 2, strong: true }) });
}
function HeaderSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: height * 0.08 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.5, h: Math.max(5, height * 0.06), strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.35 })
  ] });
}
function SectionSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", height: "100%", gap: height * 0.04, padding: width * 0.04 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.3, h: 4, strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.7 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.5 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, display: "flex", gap: width * 0.03, marginTop: height * 0.06 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "33%", h: "100%", radius: 4 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "33%", h: "100%", radius: 4 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "33%", h: "100%", radius: 4 })
    ] })
  ] });
}
function GridSkeleton({ width, height }) {
  const cols = Math.max(2, Math.min(4, Math.floor(width / 140)));
  const rows = Math.max(1, Math.min(3, Math.floor(height / 120)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, gap: 6, height: "100%" }, children: Array.from({ length: cols * rows }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "100%", h: "100%", radius: 4 }, i)) });
}
function DropdownSkeleton({ width, height }) {
  const items = Math.max(2, Math.floor((height - 32) / 28));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { padding: "6px 8px", borderBottom: "1px solid var(--agd-stroke)" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.5, h: 3, strong: true }) }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { flex: 1, padding: 4, display: "flex", flexDirection: "column", gap: 2 }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { padding: "4px 6px", borderRadius: 3, background: i === 0 ? "var(--agd-fill)" : "transparent" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: `${50 + i * 17 % 35}%`, h: 2, strong: i === 0 }) }, i)) })
  ] });
}
function ToggleSkeleton({ width, height }) {
  const r = Math.min(width, height) / 2;
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("rect", { x: "1", y: "1", width: width - 2, height: height - 2, rx: r, stroke: "var(--agd-stroke)", strokeWidth: "1" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("circle", { cx: width - r, cy: height / 2, r: r * 0.7, fill: "var(--agd-bar)" })
  ] });
}
function SearchSkeleton({ width, height }) {
  const r = Math.min(height / 2, 20);
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", borderRadius: r, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", padding: `0 ${r * 0.6}px`, gap: 6 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: Math.min(14, height * 0.4) }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "50%", h: 2 })
  ] });
}
function ToastSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", borderRadius: 8, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", padding: "0 10px", gap: 8 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: Math.min(20, height * 0.5) }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 3 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "60%", h: 3, strong: true }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "80%", h: 2 })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: 14, height: 14, border: "1px solid var(--agd-stroke)", borderRadius: 3, flexShrink: 0 } })
  ] });
}
function ProgressSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("rect", { x: "0", y: "0", width, height, rx: height / 2, stroke: "var(--agd-stroke)", strokeWidth: "0.8" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("rect", { x: "1", y: "1", width: width * 0.65, height: height - 2, rx: (height - 2) / 2, fill: "var(--agd-bar)" })
  ] });
}
function ChartSkeleton({ width, height }) {
  const bars = Math.max(3, Math.min(7, Math.floor(width / 50)));
  const barW = width / (bars * 2);
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { height: "100%", display: "flex", alignItems: "flex-end", justifyContent: "space-around", padding: "0 4px", borderBottom: "1px solid var(--agd-stroke)" }, children: Array.from({ length: bars }, (_, i) => {
    const h = 30 + (i * 37 + 17) % 55;
    return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: barW, h: `${h}%`, radius: 2 }, i);
  }) });
}
function VideoSkeleton({ width, height }) {
  const btnR = Math.min(width, height) * 0.12;
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "100%", h: "100%", radius: 4 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { position: "absolute", width: btnR * 2, height: btnR * 2, borderRadius: "50%", border: "1.5px solid var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: 0, height: 0, borderLeft: `${btnR * 0.6}px solid var(--agd-bar-strong)`, borderTop: `${btnR * 0.4}px solid transparent`, borderBottom: `${btnR * 0.4}px solid transparent`, marginLeft: btnR * 0.15 } }) })
  ] });
}
function TooltipSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { flex: 1, width: "100%", borderRadius: 6, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "60%", h: 2 }) }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: 8, height: 8, background: "var(--agd-fill)", border: "1px dashed var(--agd-stroke)", borderTop: "none", borderLeft: "none", transform: "rotate(45deg)", marginTop: -5 } })
  ] });
}
function BreadcrumbSkeleton({ width, height }) {
  const items = Math.max(2, Math.min(4, Math.floor(width / 80)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", alignItems: "center", height: "100%", gap: 4 }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 4 }, children: [
    i > 0 && /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { color: "var(--agd-stroke)", fontSize: 10 }, children: "/" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 40 + i * 13 % 20, h: 2, strong: i === items - 1 })
  ] }, i)) });
}
function PaginationSkeleton({ width, height }) {
  const count = Math.max(3, Math.min(5, Math.floor(width / 40)));
  const sz = Math.min(28, height * 0.8);
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: 4 }, children: Array.from({ length: count }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: sz, h: sz, radius: 4, style: i === 1 ? { background: "var(--agd-bar)" } : void 0 }, i)) });
}
function DividerSkeleton({ width }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", alignItems: "center", height: "100%" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: "100%", height: 1, background: "var(--agd-stroke)" } }) });
}
function AccordionSkeleton({ width, height }) {
  const items = Math.max(2, Math.min(4, Math.floor(height / 40)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", flexDirection: "column", height: "100%" }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { borderBottom: "1px solid var(--agd-stroke)", padding: "8px 6px", display: "flex", alignItems: "center", justifyContent: "space-between", flex: i === 0 ? 2 : 1 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: `${40 + i * 17 % 25}%`, h: 3, strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: 8, color: "var(--agd-stroke)" }, children: i === 0 ? "\u25BC" : "\u25B6" })
  ] }, i)) });
}
function CarouselSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column", gap: 6 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, display: "flex", gap: 6, alignItems: "center" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: 12, color: "var(--agd-stroke)" }, children: "\u2039" }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "100%", h: "100%", radius: 4 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: 12, color: "var(--agd-stroke)" }, children: "\u203A" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", justifyContent: "center", gap: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: 5 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: 5 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: 5 })
    ] })
  ] });
}
function PricingSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", padding: 10, gap: height * 0.04 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.4, h: 3, strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.3, h: 6, strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 4, width: "100%", padding: "8px 0" }, children: Array.from({ length: 4 }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: 5 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: `${50 + i * 17 % 35}%`, h: 2 })
    ] }, i)) }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: width * 0.7, h: Math.min(32, height * 0.1), radius: 6, style: { background: "var(--agd-bar)" } })
  ] });
}
function TestimonialSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column", padding: 10, gap: 8 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: 18, lineHeight: 1, color: "var(--agd-stroke)", fontFamily: "serif" }, children: "\u201C" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "90%", h: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "75%", h: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "60%", h: 2 })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: 20 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 2 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 60, h: 3, strong: true }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 40, h: 2 })
      ] })
    ] })
  ] });
}
function CtaSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: height * 0.08 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.5, h: Math.max(4, height * 0.05), strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.35 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: Math.min(140, width * 0.25), h: Math.min(32, height * 0.15), radius: 6, style: { marginTop: height * 0.04, background: "var(--agd-bar)" } })
  ] });
}
function AlertSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", borderRadius: 6, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", padding: "0 10px", gap: 8 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: 16, height: 16, borderRadius: "50%", border: "1.5px solid var(--agd-bar-strong)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: 2, height: 6, background: "var(--agd-bar-strong)", borderRadius: 1 } }) }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 3 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "40%", h: 3, strong: true }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "70%", h: 2 })
    ] })
  ] });
}
function BannerSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", background: "var(--agd-fill)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "0 12px" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.4, h: 3, strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: 60, h: Math.min(24, height * 0.6), radius: 4 })
  ] });
}
function StatSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: height * 0.06 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.5, h: 2 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.4, h: Math.max(8, height * 0.18), strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.3, h: 2 })
  ] });
}
function StepperSkeleton({ width, height }) {
  const steps = Math.max(3, Math.min(5, Math.floor(width / 100)));
  const dotR = Math.min(12, height * 0.35);
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", height: "100%", padding: "0 8px" }, children: Array.from({ length: steps }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 0, flex: 1 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: dotR, height: dotR, borderRadius: "50%", border: "1.5px solid var(--agd-stroke)", background: i === 0 ? "var(--agd-bar)" : "transparent", flexShrink: 0 } }),
    i < steps - 1 && /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { flex: 1, height: 1, background: "var(--agd-stroke)", margin: "0 4px" } })
  ] }, i)) });
}
function TagSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", borderRadius: 4, border: "1px solid var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "0 6px" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: Math.max(16, width * 0.5), h: 2, strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: 8, height: 8, borderRadius: "50%", border: "1px solid var(--agd-stroke)", flexShrink: 0 } })
  ] });
}
function RatingSkeleton({ width, height }) {
  const stars = 5;
  const sz = Math.min(height * 0.7, width / (stars * 1.5));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: sz * 0.2 }, children: Array.from({ length: stars }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("svg", { width: sz, height: sz, viewBox: "0 0 16 16", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("path", { d: "M8 1.5l2 4 4.5.7-3.25 3.1.75 4.5L8 11.4l-4 2.4.75-4.5L1.5 6.2 6 5.5z", stroke: "var(--agd-stroke)", strokeWidth: "0.8", fill: i < 3 ? "var(--agd-bar)" : "none" }) }, i)) });
}
function MapSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", position: "relative", borderRadius: 4, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", overflow: "hidden" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", style: { position: "absolute", inset: 0 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("line", { x1: 0, y1: height * 0.3, x2: width, y2: height * 0.7, stroke: "var(--agd-stroke)", strokeWidth: "0.5", opacity: ".2" }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("line", { x1: 0, y1: height * 0.6, x2: width, y2: height * 0.2, stroke: "var(--agd-stroke)", strokeWidth: "0.5", opacity: ".15" }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("line", { x1: width * 0.4, y1: 0, x2: width * 0.6, y2: height, stroke: "var(--agd-stroke)", strokeWidth: "0.5", opacity: ".15" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { position: "absolute", left: "50%", top: "40%", transform: "translate(-50%, -100%)" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "16", height: "22", viewBox: "0 0 16 22", fill: "none", children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("path", { d: "M8 0C3.6 0 0 3.6 0 8c0 6 8 14 8 14s8-8 8-14c0-4.4-3.6-8-8-8z", fill: "var(--agd-bar)", opacity: ".4" }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("circle", { cx: "8", cy: "8", r: "3", fill: "var(--agd-fill)" })
    ] }) })
  ] });
}
function TimelineSkeleton({ width, height }) {
  const items = Math.max(3, Math.min(5, Math.floor(height / 60)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", height: "100%", padding: "8px 0" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: 16, display: "flex", flexDirection: "column", alignItems: "center" }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: 8 }),
      i < items - 1 && /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { flex: 1, width: 1, background: "var(--agd-stroke)" } })
    ] }, i)) }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-around", paddingLeft: 8 }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 3 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: `${35 + i * 13 % 25}%`, h: 3, strong: true }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: `${50 + i * 17 % 30}%`, h: 2 })
    ] }, i)) })
  ] });
}
function FileUploadSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", borderRadius: 8, border: "2px dashed var(--agd-stroke)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: height * 0.06 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "none", children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("path", { d: "M12 16V4m0 0l-4 4m4-4l4 4", stroke: "var(--agd-stroke)", strokeWidth: "1.5" }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("path", { d: "M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2", stroke: "var(--agd-stroke)", strokeWidth: "1.5" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.4, h: 2 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.25, h: 2 })
  ] });
}
function CodeBlockSkeleton({ width, height }) {
  const lines = Math.max(3, Math.min(8, Math.floor(height / 20)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", borderRadius: 6, background: "var(--agd-fill)", border: "1px solid var(--agd-stroke)", padding: 8, display: "flex", flexDirection: "column", gap: 4 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", gap: 3, marginBottom: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: 6 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: 6 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: 6 })
    ] }),
    Array.from({ length: lines }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", gap: 6, paddingLeft: i > 0 && i < lines - 1 ? 12 : 0 }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: `${25 + i * 23 % 50}%`, h: 2, strong: i === 0 }) }, i))
  ] });
}
function CalendarSkeleton({ width, height }) {
  const cols = 7;
  const rows = 5;
  const cellSz = Math.min((width - 16) / cols, (height - 40) / (rows + 1));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: 8, color: "var(--agd-stroke)" }, children: "\u2039" }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.3, h: 3, strong: true }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: 8, color: "var(--agd-stroke)" }, children: "\u203A" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 2, padding: "0 4px", flex: 1 }, children: [
      Array.from({ length: cols }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: cellSz * 0.6 }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: cellSz * 0.5, h: 2 }) }, `h${i}`)),
      Array.from({ length: cols * rows }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: cellSz }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: cellSz * 0.6, height: cellSz * 0.6, borderRadius: "50%", background: i === 12 ? "var(--agd-bar)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: 2, height: 2, borderRadius: 1, background: "var(--agd-bar-strong)", opacity: i === 12 ? 1 : 0.3 } }) }) }, i))
    ] })
  ] });
}
function NotificationSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", borderRadius: 8, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", padding: "0 10px", gap: 8 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: Math.min(32, height * 0.55) }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 3 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "50%", h: 3, strong: true }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "75%", h: 2 })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 30, h: 2 })
  ] });
}
function ProductCardSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { height: "50%", background: "var(--agd-fill)", borderBottom: "1px dashed var(--agd-stroke)" } }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, padding: 10, display: "flex", flexDirection: "column", gap: 5 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "65%", h: 4, strong: true }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "40%", h: 3 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { flex: 1 } }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "30%", h: 5, strong: true }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: Math.min(70, width * 0.3), h: 26, radius: 4, style: { background: "var(--agd-bar)" } })
      ] })
    ] })
  ] });
}
function ProfileSkeleton({ width, height }) {
  const avatarSz = Math.min(48, height * 0.3);
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: height * 0.06 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: avatarSz }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.45, h: 4, strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.3, h: 2 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", gap: width * 0.08, marginTop: height * 0.04 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 20, h: 3, strong: true }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 28, h: 2 })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 20, h: 3, strong: true }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 28, h: 2 })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 20, h: 3, strong: true }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 28, h: 2 })
      ] })
    ] })
  ] });
}
function DrawerSkeleton({ width, height }) {
  const panelW = Math.max(width * 0.6, 80);
  const items = Math.max(3, Math.floor(height / 40));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: width - panelW, background: "var(--agd-fill)", opacity: 0.3 } }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, borderLeft: "1px solid var(--agd-stroke)", display: "flex", flexDirection: "column", padding: width * 0.04 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: height * 0.06 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: panelW * 0.4, h: 4, strong: true }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: 12, height: 12, border: "1px solid var(--agd-stroke)", borderRadius: 3 } })
      ] }),
      Array.from({ length: items }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { padding: "6px 0" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: `${50 + i * 17 % 35}%`, h: 2, strong: i === 0 }) }, i))
    ] })
  ] });
}
function PopoverSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, width: "100%", borderRadius: 8, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", padding: 10, display: "flex", flexDirection: "column", gap: 5 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "70%", h: 3, strong: true }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "90%", h: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "60%", h: 2 })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: 10, height: 10, background: "var(--agd-fill)", border: "1px dashed var(--agd-stroke)", borderTop: "none", borderLeft: "none", transform: "rotate(45deg)", marginTop: -6 } })
  ] });
}
function LogoSkeleton({ width, height }) {
  const iconSz = Math.min(height * 0.7, width * 0.3);
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", alignItems: "center", gap: width * 0.08 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: iconSz, h: iconSz, radius: iconSz * 0.25 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.45, h: Math.max(4, height * 0.2), strong: true })
  ] });
}
function FaqSkeleton({ width, height }) {
  const items = Math.max(2, Math.min(5, Math.floor(height / 56)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", flexDirection: "column", height: "100%" }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { borderBottom: "1px solid var(--agd-stroke)", padding: "8px 6px", display: "flex", alignItems: "center", justifyContent: "space-between", flex: i === 0 ? 2 : 1 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: 9, fontWeight: 700, color: "var(--agd-stroke)" }, children: "Q" }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * (0.3 + i * 13 % 25 / 100), h: 3, strong: true })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: 8, color: "var(--agd-stroke)" }, children: i === 0 ? "\u25BC" : "\u25B6" })
  ] }, i)) });
}
function GallerySkeleton({ width, height }) {
  const cols = Math.max(2, Math.min(4, Math.floor(width / 120)));
  const rows = Math.max(1, Math.min(3, Math.floor(height / 120)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, gap: 4, height: "100%" }, children: Array.from({ length: cols * rows }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { borderRadius: 4, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", position: "relative", overflow: "hidden" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "100%", height: "100%", viewBox: "0 0 100 100", preserveAspectRatio: "none", fill: "none", children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("line", { x1: "0", y1: "0", x2: "100", y2: "100", stroke: "var(--agd-stroke)", strokeWidth: "0.5" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("line", { x1: "100", y1: "0", x2: "0", y2: "100", stroke: "var(--agd-stroke)", strokeWidth: "0.5" })
  ] }) }, i)) });
}
function CheckboxSkeleton({ width, height }) {
  const sz = Math.min(width, height);
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("rect", { x: "1", y: (height - sz + 2) / 2, width: sz - 2, height: sz - 2, rx: sz * 0.15, stroke: "var(--agd-stroke)", strokeWidth: "1.5" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("path", { d: `M${sz * 0.25} ${height / 2}l${sz * 0.2} ${sz * 0.2} ${sz * 0.3}-${sz * 0.35}`, stroke: "var(--agd-bar)", strokeWidth: "1.5", fill: "none", strokeLinecap: "round", strokeLinejoin: "round" })
  ] });
}
function RadioSkeleton({ width, height }) {
  const r = Math.min(width, height) / 2 - 1;
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("circle", { cx: width / 2, cy: height / 2, r, stroke: "var(--agd-stroke)", strokeWidth: "1.5" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("circle", { cx: width / 2, cy: height / 2, r: r * 0.45, fill: "var(--agd-bar)" })
  ] });
}
function SliderSkeleton({ width, height }) {
  const trackH = Math.max(2, height * 0.12);
  const thumbR = Math.min(height * 0.35, 10);
  const fillW = width * 0.55;
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", alignItems: "center", position: "relative" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: "100%", height: trackH, borderRadius: trackH / 2, background: "var(--agd-fill)", border: "1px solid var(--agd-stroke)", position: "relative" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: fillW, height: "100%", borderRadius: trackH / 2, background: "var(--agd-bar)" } }) }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { position: "absolute", left: fillW - thumbR, width: thumbR * 2, height: thumbR * 2, borderRadius: "50%", border: "1.5px solid var(--agd-stroke)", background: "var(--agd-fill)" } })
  ] });
}
function DatePickerSkeleton({ width, height }) {
  const inputH = Math.min(36, height * 0.15);
  const cols = 7;
  const rows = 4;
  const cellSz = Math.min((width - 16) / cols, (height - inputH - 40) / (rows + 1));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column", gap: 4 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: inputH, borderRadius: 4, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", padding: "0 8px", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "40%", h: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "12", height: "12", viewBox: "0 0 16 16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("rect", { x: "2", y: "3", width: "12", height: "11", rx: "1", stroke: "var(--agd-stroke)", strokeWidth: "1" }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("line", { x1: "2", y1: "6", x2: "14", y2: "6", stroke: "var(--agd-stroke)", strokeWidth: "0.5" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, borderRadius: 6, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", flexDirection: "column" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 6px" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: 7, color: "var(--agd-stroke)" }, children: "\u2039" }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.25, h: 2, strong: true }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: 7, color: "var(--agd-stroke)" }, children: "\u203A" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 1, padding: "0 4px", flex: 1 }, children: Array.from({ length: cols * rows }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: cellSz }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: cellSz * 0.5, height: cellSz * 0.5, borderRadius: "50%", background: i === 10 ? "var(--agd-bar)" : "transparent" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: 1.5, height: 1.5, borderRadius: 1, background: "var(--agd-bar-strong)", opacity: i === 10 ? 1 : 0.25 } }) }) }) }, i)) })
    ] })
  ] });
}
function SkeletonSkeletonRenderer({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column", gap: height * 0.08, padding: 4 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: "100%", height: height * 0.2, borderRadius: 4, background: "var(--agd-fill)" } }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: "70%", height: Math.max(6, height * 0.1), borderRadius: 3, background: "var(--agd-fill)" } }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: "90%", height: Math.max(4, height * 0.06), borderRadius: 3, background: "var(--agd-fill)" } }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: "50%", height: Math.max(4, height * 0.06), borderRadius: 3, background: "var(--agd-fill)" } })
  ] });
}
function ChipSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { height: "100%", display: "flex", alignItems: "center", gap: 6 }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", flex: 1, borderRadius: height / 2, border: "1px solid var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", padding: `0 ${height * 0.3}px`, gap: 4 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: "60%", h: 2, strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: Math.max(6, height * 0.3), height: Math.max(6, height * 0.3), borderRadius: "50%", border: "1px solid var(--agd-stroke)", flexShrink: 0, marginLeft: "auto" } })
  ] }) });
}
function IconSkeleton({ width, height }) {
  const sz = Math.min(width, height);
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
    "path",
    {
      d: `M${width / 2} ${(height - sz) / 2 + sz * 0.1}l${sz * 0.12} ${sz * 0.25} ${sz * 0.28} ${sz * 0.04}-${sz * 0.2} ${sz * 0.2} ${sz * 0.05} ${sz * 0.28}-${sz * 0.25}-${sz * 0.12}-${sz * 0.25} ${sz * 0.12} ${sz * 0.05}-${sz * 0.28}-${sz * 0.2}-${sz * 0.2} ${sz * 0.28}-${sz * 0.04}z`,
      stroke: "var(--agd-stroke)",
      strokeWidth: "1",
      fill: "var(--agd-fill)"
    }
  ) });
}
function SpinnerSkeleton({ width, height }) {
  const r = Math.min(width, height) / 2 - 2;
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("circle", { cx: width / 2, cy: height / 2, r, stroke: "var(--agd-stroke)", strokeWidth: "1.5", opacity: ".2" }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("path", { d: `M${width / 2} ${height / 2 - r}a${r} ${r} 0 0 1 ${r} ${r}`, stroke: "var(--agd-bar-strong)", strokeWidth: "1.5", strokeLinecap: "round" })
  ] });
}
function FeatureSkeleton({ width, height }) {
  const iconSz = Math.min(36, height * 0.25, width * 0.12);
  const items = Math.max(1, Math.min(3, Math.floor(height / 80)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", flexDirection: "column", height: "100%", justifyContent: "space-around", padding: 8 }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", gap: width * 0.04, alignItems: "flex-start" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: iconSz, h: iconSz, radius: iconSz * 0.25 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: `${40 + i * 13 % 20}%`, h: 3, strong: true }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: `${60 + i * 17 % 25}%`, h: 2 })
    ] })
  ] }, i)) });
}
function TeamSkeleton({ width, height }) {
  const cols = Math.max(2, Math.min(4, Math.floor(width / 120)));
  const avatarSz = Math.min(36, height * 0.25);
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: height * 0.06, padding: height * 0.06 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.3, h: 4, strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { display: "flex", gap: width * 0.06, justifyContent: "center", flex: 1, alignItems: "center" }, children: Array.from({ length: cols }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Circle, { size: avatarSz }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.12, h: 3, strong: true }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.08, h: 2 })
    ] }, i)) })
  ] });
}
function LoginSkeleton({ width, height }) {
  const fields = Math.max(2, Math.min(3, Math.floor(height / 80)));
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", padding: width * 0.06, gap: height * 0.04 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.5, h: Math.max(5, height * 0.04), strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.35, h: 2 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: "100%", display: "flex", flexDirection: "column", gap: height * 0.03, marginTop: height * 0.04 }, children: Array.from({ length: fields }, (_, i) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 3 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: Math.min(60, width * 0.2), h: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "100%", h: Math.min(32, height * 0.1), radius: 4 })
    ] }, i)) }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "100%", h: Math.min(36, height * 0.12), radius: 6, style: { marginTop: height * 0.03, background: "var(--agd-bar)" } }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.4, h: 2 })
  ] });
}
function ContactSkeleton({ width, height }) {
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { height: "100%", display: "flex", flexDirection: "column", padding: width * 0.04, gap: height * 0.03 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.4, h: 4, strong: true }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: width * 0.6, h: 2 }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", gap: 6, marginTop: height * 0.03 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 3 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 50, h: 2 }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "100%", h: Math.min(28, height * 0.1), radius: 4 })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 3 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 40, h: 2 }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "100%", h: Math.min(28, height * 0.1), radius: 4 })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 3 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 50, h: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "100%", h: Math.min(28, height * 0.1), radius: 4 })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 3, flex: 1 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Bar, { w: 60, h: 2 }),
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: "100%", h: "100%", radius: 4 })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Block, { w: Math.min(120, width * 0.3), h: Math.min(30, height * 0.1), radius: 6, style: { alignSelf: "flex-end", background: "var(--agd-bar)" } })
  ] });
}
var SKELETON_RENDERERS = {
  navigation: NavigationSkeleton,
  hero: HeroSkeleton,
  sidebar: SidebarSkeleton,
  footer: FooterSkeleton,
  modal: ModalSkeleton,
  card: CardSkeleton,
  text: TextSkeleton,
  image: ImageSkeleton,
  table: TableSkeleton,
  list: ListSkeleton,
  button: ButtonSkeleton,
  input: InputSkeleton,
  form: FormSkeleton,
  tabs: TabsSkeleton,
  avatar: AvatarSkeleton,
  badge: BadgeSkeleton,
  header: HeaderSkeleton,
  section: SectionSkeleton,
  grid: GridSkeleton,
  dropdown: DropdownSkeleton,
  toggle: ToggleSkeleton,
  search: SearchSkeleton,
  toast: ToastSkeleton,
  progress: ProgressSkeleton,
  chart: ChartSkeleton,
  video: VideoSkeleton,
  tooltip: TooltipSkeleton,
  breadcrumb: BreadcrumbSkeleton,
  pagination: PaginationSkeleton,
  divider: DividerSkeleton,
  accordion: AccordionSkeleton,
  carousel: CarouselSkeleton,
  pricing: PricingSkeleton,
  testimonial: TestimonialSkeleton,
  cta: CtaSkeleton,
  alert: AlertSkeleton,
  banner: BannerSkeleton,
  stat: StatSkeleton,
  stepper: StepperSkeleton,
  tag: TagSkeleton,
  rating: RatingSkeleton,
  map: MapSkeleton,
  timeline: TimelineSkeleton,
  fileUpload: FileUploadSkeleton,
  codeBlock: CodeBlockSkeleton,
  calendar: CalendarSkeleton,
  notification: NotificationSkeleton,
  productCard: ProductCardSkeleton,
  profile: ProfileSkeleton,
  drawer: DrawerSkeleton,
  popover: PopoverSkeleton,
  logo: LogoSkeleton,
  faq: FaqSkeleton,
  gallery: GallerySkeleton,
  checkbox: CheckboxSkeleton,
  radio: RadioSkeleton,
  slider: SliderSkeleton,
  datePicker: DatePickerSkeleton,
  skeleton: SkeletonSkeletonRenderer,
  chip: ChipSkeleton,
  icon: IconSkeleton,
  spinner: SpinnerSkeleton,
  feature: FeatureSkeleton,
  team: TeamSkeleton,
  login: LoginSkeleton,
  contact: ContactSkeleton
};
function Skeleton({ type, width, height, text }) {
  const Renderer = SKELETON_RENDERERS[type];
  if (!Renderer) {
    return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("span", { style: { fontSize: 10, fontWeight: 600, color: "var(--agd-text-3)", textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.5 }, children: type }) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)("div", { style: { width: "100%", height: "100%", padding: 8, position: "relative", pointerEvents: "none" }, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Renderer, { width, height, text }) });
}

// src/components/design-mode/styles.module.scss
var css5 = '.styles-module__overlay___aWh-q svg[fill=none],\n.styles-module__rearrangeOverlay___-3R3t svg[fill=none] {\n  fill: none !important;\n}\n.styles-module__overlay___aWh-q svg[fill=none] :not([fill]),\n.styles-module__rearrangeOverlay___-3R3t svg[fill=none] :not([fill]) {\n  fill: none !important;\n}\n\n.styles-module__overlayExiting___iEmYr {\n  opacity: 0 !important;\n  transition: opacity 0.25s ease !important;\n  pointer-events: none !important;\n}\n\n.styles-module__overlay___aWh-q {\n  position: fixed;\n  inset: 0;\n  z-index: 99995;\n  pointer-events: auto;\n  cursor: default;\n  animation: styles-module__overlayFadeIn___aECVy 0.15s ease;\n  --agd-stroke: rgba(59, 130, 246, 0.35);\n  --agd-fill: rgba(59, 130, 246, 0.06);\n  --agd-bar: rgba(59, 130, 246, 0.18);\n  --agd-bar-strong: rgba(59, 130, 246, 0.28);\n  --agd-text-3: rgba(255, 255, 255, 0.6);\n  --agd-surface: #fff;\n}\n.styles-module__overlay___aWh-q.styles-module__light___ORIft {\n  --agd-surface: #fff;\n}\n.styles-module__overlay___aWh-q:not(.styles-module__light___ORIft) {\n  --agd-surface: #141414;\n}\n.styles-module__overlay___aWh-q.styles-module__wireframe___itvQU {\n  --agd-stroke: rgba(249, 115, 22, 0.35);\n  --agd-fill: rgba(249, 115, 22, 0.06);\n  --agd-bar: rgba(249, 115, 22, 0.18);\n  --agd-bar-strong: rgba(249, 115, 22, 0.28);\n}\n.styles-module__overlay___aWh-q.styles-module__placing___45yD8 {\n  cursor: crosshair;\n}\n.styles-module__overlay___aWh-q.styles-module__passthrough___xaFeE {\n  pointer-events: none;\n}\n\n.styles-module__blankCanvas___t2Eue {\n  position: fixed;\n  inset: 0;\n  z-index: 99994;\n  background: #fff;\n  opacity: 0;\n  pointer-events: none;\n  transition: opacity 0.25s ease;\n}\n.styles-module__blankCanvas___t2Eue.styles-module__visible___OKKqX {\n  opacity: var(--canvas-opacity, 1);\n  pointer-events: auto;\n}\n.styles-module__blankCanvas___t2Eue::after {\n  content: "";\n  position: absolute;\n  inset: 0;\n  background-image: radial-gradient(circle, rgba(0, 0, 0, 0.08) 1px, transparent 1px);\n  background-size: 24px 24px;\n  background-position: 12px 12px;\n  pointer-events: none;\n  transition: opacity 0.2s ease;\n}\n.styles-module__blankCanvas___t2Eue.styles-module__gridActive___OZ-cf::after {\n  opacity: 1;\n  background-image: radial-gradient(circle, rgba(0, 0, 0, 0.22) 1px, transparent 1px);\n}\n\n.styles-module__paletteHeader___-Q5gQ {\n  padding: 0 1rem 0.375rem;\n}\n\n.styles-module__paletteHeaderTitle___oHqZC {\n  font-size: 0.8125rem;\n  font-weight: 500;\n  color: #fff;\n  letter-spacing: -0.0094em;\n}\n.styles-module__light___ORIft .styles-module__paletteHeaderTitle___oHqZC {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n.styles-module__paletteHeaderDesc___6i74T {\n  font-size: 0.6875rem;\n  font-weight: 300;\n  color: rgba(255, 255, 255, 0.45);\n  margin-top: 2px;\n  line-height: 14px;\n}\n.styles-module__light___ORIft .styles-module__paletteHeaderDesc___6i74T {\n  color: rgba(0, 0, 0, 0.45);\n}\n.styles-module__paletteHeaderDesc___6i74T a {\n  color: rgba(255, 255, 255, 0.8);\n  text-decoration: underline dotted;\n  text-decoration-color: rgba(255, 255, 255, 0.2);\n  text-underline-offset: 2px;\n  transition: color 0.15s ease;\n}\n.styles-module__paletteHeaderDesc___6i74T a:hover {\n  color: #fff;\n}\n.styles-module__light___ORIft .styles-module__paletteHeaderDesc___6i74T a {\n  color: rgba(0, 0, 0, 0.6);\n  text-decoration-color: rgba(0, 0, 0, 0.2);\n}\n.styles-module__light___ORIft .styles-module__paletteHeaderDesc___6i74T a:hover {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n.styles-module__wireframePurposeWrap___To-tS {\n  display: grid;\n  grid-template-rows: 1fr;\n  transition: grid-template-rows 0.2s ease, opacity 0.15s ease;\n  opacity: 1;\n}\n.styles-module__wireframePurposeWrap___To-tS.styles-module__collapsed___Ms9vS {\n  grid-template-rows: 0fr;\n  opacity: 0;\n}\n\n.styles-module__wireframePurposeInner___Lrahs {\n  overflow: hidden;\n}\n\n.styles-module__wireframePurposeInput___7EtBN {\n  display: block;\n  width: calc(100% - 2rem);\n  margin: 0.25rem 1rem 0.375rem;\n  padding: 0.375rem 0.5rem;\n  font-size: 0.8125rem;\n  font-family: inherit;\n  color: rgba(255, 255, 255, 0.85);\n  background: rgba(255, 255, 255, 0.03);\n  border: 1px solid rgba(255, 255, 255, 0.1);\n  border-radius: 0.375rem;\n  resize: none;\n  outline: none;\n  transition: border-color 0.15s ease;\n  letter-spacing: -0.0094em;\n}\n.styles-module__wireframePurposeInput___7EtBN::placeholder {\n  color: rgba(255, 255, 255, 0.3);\n}\n.styles-module__wireframePurposeInput___7EtBN:focus {\n  border-color: rgba(255, 255, 255, 0.3);\n  background: rgba(255, 255, 255, 0.05);\n}\n.styles-module__light___ORIft .styles-module__wireframePurposeInput___7EtBN {\n  color: rgba(0, 0, 0, 0.7);\n  background: rgba(0, 0, 0, 0.03);\n  border-color: rgba(0, 0, 0, 0.1);\n}\n.styles-module__light___ORIft .styles-module__wireframePurposeInput___7EtBN::placeholder {\n  color: rgba(0, 0, 0, 0.3);\n}\n.styles-module__light___ORIft .styles-module__wireframePurposeInput___7EtBN:focus {\n  border-color: rgba(0, 0, 0, 0.25);\n  background: rgba(0, 0, 0, 0.05);\n}\n\n.styles-module__canvasToggle___-QqSy {\n  width: calc(100% - 2rem);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 0.375rem;\n  margin: 0.25rem 1rem 0.25rem;\n  padding: 0.375rem 0.5rem;\n  border-radius: 0.5rem;\n  cursor: pointer;\n  border: 1px dashed rgba(255, 255, 255, 0.1);\n  background: transparent;\n  transition: background 0.15s ease, border-color 0.15s ease;\n}\n.styles-module__canvasToggle___-QqSy:hover {\n  background: rgba(255, 255, 255, 0.04);\n  border-color: rgba(255, 255, 255, 0.15);\n}\n.styles-module__canvasToggle___-QqSy.styles-module__active___hosp7 {\n  background: #f97316;\n  border-color: transparent;\n  border-style: solid;\n  box-shadow: none;\n}\n.styles-module__light___ORIft .styles-module__canvasToggle___-QqSy {\n  border-color: rgba(0, 0, 0, 0.08);\n}\n.styles-module__light___ORIft .styles-module__canvasToggle___-QqSy:hover {\n  background: rgba(0, 0, 0, 0.02);\n  border-color: rgba(0, 0, 0, 0.12);\n}\n.styles-module__light___ORIft .styles-module__canvasToggle___-QqSy.styles-module__active___hosp7 {\n  background: #f97316;\n  border-color: transparent;\n  border-style: solid;\n  box-shadow: none;\n}\n\n.styles-module__canvasToggleIcon___7pJ82 {\n  width: 14px;\n  height: 14px;\n  flex-shrink: 0;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  color: rgba(255, 255, 255, 0.35);\n}\n.styles-module__active___hosp7 .styles-module__canvasToggleIcon___7pJ82 {\n  color: rgba(255, 255, 255, 0.85);\n}\n.styles-module__light___ORIft .styles-module__canvasToggleIcon___7pJ82 {\n  color: rgba(0, 0, 0, 0.25);\n}\n.styles-module__light___ORIft .styles-module__active___hosp7 .styles-module__canvasToggleIcon___7pJ82 {\n  color: rgba(255, 255, 255, 0.85);\n}\n\n.styles-module__canvasToggleLabel___OanpY {\n  font-size: 0.8125rem;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.6);\n  letter-spacing: -0.0094em;\n}\n.styles-module__active___hosp7 .styles-module__canvasToggleLabel___OanpY {\n  color: #fff;\n}\n.styles-module__light___ORIft .styles-module__canvasToggleLabel___OanpY {\n  color: rgba(0, 0, 0, 0.5);\n}\n.styles-module__light___ORIft .styles-module__active___hosp7 .styles-module__canvasToggleLabel___OanpY {\n  color: #fff;\n}\n\n.styles-module__placement___zcxv8 {\n  position: absolute;\n  border: 1.5px dashed rgba(59, 130, 246, 0.4);\n  border-radius: 6px;\n  background: rgba(59, 130, 246, 0.08);\n  cursor: grab;\n  transition: box-shadow 0.15s, border-color 0.15s, opacity 0.15s ease, transform 0.15s ease;\n  -webkit-user-select: none;\n  user-select: none;\n  pointer-events: auto;\n  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);\n  animation: styles-module__placementEnter___TdRhf 0.25s cubic-bezier(0.34, 1.2, 0.64, 1);\n}\n.styles-module__placement___zcxv8:active {\n  cursor: grabbing;\n}\n.styles-module__placement___zcxv8:hover {\n  border-color: rgba(59, 130, 246, 0.5);\n  background: rgba(59, 130, 246, 0.1);\n  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.12);\n}\n.styles-module__placement___zcxv8.styles-module__selected___6yrp6 {\n  border-color: #3c82f7;\n  border-style: solid;\n  background: rgba(59, 130, 246, 0.1);\n  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);\n}\n.styles-module__placement___zcxv8.styles-module__selected___6yrp6:hover {\n  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);\n}\n.styles-module__wireframe___itvQU .styles-module__placement___zcxv8 {\n  border-color: rgba(249, 115, 22, 0.4);\n  background: rgba(249, 115, 22, 0.08);\n}\n.styles-module__wireframe___itvQU .styles-module__placement___zcxv8:hover {\n  border-color: rgba(249, 115, 22, 0.5);\n  background: rgba(249, 115, 22, 0.1);\n  box-shadow: 0 2px 8px rgba(249, 115, 22, 0.12);\n}\n.styles-module__wireframe___itvQU .styles-module__placement___zcxv8.styles-module__selected___6yrp6 {\n  border-color: #f97316;\n  background: rgba(249, 115, 22, 0.1);\n  box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.15), 0 2px 8px rgba(249, 115, 22, 0.15);\n}\n.styles-module__wireframe___itvQU .styles-module__placement___zcxv8.styles-module__selected___6yrp6:hover {\n  box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.15), 0 2px 8px rgba(249, 115, 22, 0.15);\n}\n.styles-module__placement___zcxv8.styles-module__dragging___le6KZ {\n  opacity: 0.85;\n  z-index: 50;\n}\n.styles-module__placement___zcxv8.styles-module__exiting___YrM8F {\n  opacity: 0;\n  transform: scale(0.97);\n  pointer-events: none;\n  animation: none;\n  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.32, 0.72, 0, 1);\n}\n\n.styles-module__placementContent___f64A4 {\n  width: 100%;\n  height: 100%;\n  overflow: hidden;\n  pointer-events: none;\n}\n\n.styles-module__placementLabel___0KvWl {\n  position: absolute;\n  top: -18px;\n  left: 0;\n  font-size: 10px;\n  font-weight: 600;\n  color: rgba(59, 130, 246, 0.7);\n  white-space: nowrap;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  text-shadow: 0 0 4px rgba(255, 255, 255, 0.8), 0 0 8px rgba(255, 255, 255, 0.5);\n}\n.styles-module__selected___6yrp6 .styles-module__placementLabel___0KvWl {\n  color: #3c82f7;\n}\n.styles-module__wireframe___itvQU .styles-module__placementLabel___0KvWl {\n  color: rgba(249, 115, 22, 0.7);\n}\n.styles-module__wireframe___itvQU .styles-module__selected___6yrp6 .styles-module__placementLabel___0KvWl {\n  color: #f97316;\n}\n\n.styles-module__placementAnnotation___78pTr {\n  position: absolute;\n  bottom: -18px;\n  left: 0;\n  right: 0;\n  font-weight: 450;\n  color: rgba(0, 0, 0, 0.5);\n  font-size: 10px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  text-shadow: 0 0 4px rgba(255, 255, 255, 0.9), 0 0 8px rgba(255, 255, 255, 0.6);\n  opacity: 0;\n  transform: translateY(-2px);\n  transition: opacity 0.2s ease, transform 0.2s ease;\n}\n.styles-module__placementAnnotation___78pTr.styles-module__annotationVisible___mrUyA {\n  opacity: 1;\n  transform: translateY(0);\n}\n\n.styles-module__sectionAnnotation___aUIs0 {\n  position: absolute;\n  bottom: -18px;\n  left: 0;\n  right: 0;\n  font-weight: 450;\n  color: rgba(59, 130, 246, 0.6);\n  font-size: 10px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  text-shadow: 0 0 4px rgba(255, 255, 255, 0.9), 0 0 8px rgba(255, 255, 255, 0.6);\n  opacity: 0;\n  transform: translateY(-2px);\n  transition: opacity 0.2s ease, transform 0.2s ease;\n}\n.styles-module__sectionAnnotation___aUIs0.styles-module__annotationVisible___mrUyA {\n  opacity: 1;\n  transform: translateY(0);\n}\n\n.styles-module__handle___Ikbxm {\n  position: absolute;\n  width: 8px;\n  height: 8px;\n  background: #fff;\n  border: 1.5px solid #3c82f7;\n  border-radius: 2px;\n  z-index: 12;\n  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.12);\n  opacity: 0;\n  transform: scale(0.3);\n  pointer-events: none;\n  will-change: opacity, transform;\n  transition: opacity 0.2s ease-out, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);\n}\n.styles-module__placement___zcxv8:hover .styles-module__handle___Ikbxm, .styles-module__sectionOutline___s0hy-:hover .styles-module__handle___Ikbxm, .styles-module__ghostOutline___po-kO:hover .styles-module__handle___Ikbxm, .styles-module__placement___zcxv8:active .styles-module__handle___Ikbxm, .styles-module__sectionOutline___s0hy-:active .styles-module__handle___Ikbxm, .styles-module__ghostOutline___po-kO:active .styles-module__handle___Ikbxm, .styles-module__selected___6yrp6 .styles-module__handle___Ikbxm {\n  opacity: 1;\n  transform: scale(1);\n  pointer-events: auto;\n}\n.styles-module__sectionOutline___s0hy- .styles-module__handle___Ikbxm {\n  border-color: inherit;\n}\n.styles-module__wireframe___itvQU .styles-module__handle___Ikbxm {\n  border-color: #f97316;\n}\n\n.styles-module__handleNw___4TMIj {\n  top: -4px;\n  left: -4px;\n  cursor: nw-resize;\n}\n\n.styles-module__handleNe___mnsTh {\n  top: -4px;\n  right: -4px;\n  cursor: ne-resize;\n}\n\n.styles-module__handleSe___oSFnk {\n  bottom: -4px;\n  right: -4px;\n  cursor: se-resize;\n}\n\n.styles-module__handleSw___pi--Z {\n  bottom: -4px;\n  left: -4px;\n  cursor: sw-resize;\n}\n\n.styles-module__handleN___aBA-Q,\n.styles-module__handleE___0hM5u,\n.styles-module__handleS___JjDRv,\n.styles-module__handleW___ERWGQ {\n  opacity: 0 !important;\n  pointer-events: none !important;\n}\n\n.styles-module__edgeHandle___XxXdT {\n  position: absolute;\n  z-index: 11;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n.styles-module__edgeHandle___XxXdT::after {\n  content: "";\n  position: absolute;\n  border-radius: 4px;\n  background: #3c82f7;\n}\n.styles-module__wireframe___itvQU .styles-module__edgeHandle___XxXdT::after {\n  background: #f97316;\n}\n.styles-module__edgeHandle___XxXdT::after {\n  opacity: 0;\n  transition: opacity 0.1s ease, transform 0.1s ease;\n  transform: scale(0.8);\n}\n.styles-module__edgeHandle___XxXdT:hover::after {\n  opacity: 0.85;\n  transform: scale(1);\n}\n.styles-module__edgeHandle___XxXdT svg {\n  position: relative;\n  z-index: 1;\n  opacity: 0;\n  transition: opacity 0.1s ease;\n  filter: drop-shadow(0 0 2px var(--agd-surface));\n}\n.styles-module__edgeHandle___XxXdT:hover svg {\n  opacity: 1;\n}\n\n.styles-module__edgeN___-JJDj,\n.styles-module__edgeS___66lMX {\n  left: 12px;\n  right: 12px;\n  height: 12px;\n  cursor: n-resize;\n}\n.styles-module__edgeN___-JJDj::after,\n.styles-module__edgeS___66lMX::after {\n  width: 24px;\n  height: 4px;\n}\n\n.styles-module__edgeN___-JJDj {\n  top: -6px;\n}\n\n.styles-module__edgeS___66lMX {\n  bottom: -6px;\n  cursor: s-resize;\n}\n\n.styles-module__edgeE___1bGDa,\n.styles-module__edgeW___lHQNo {\n  top: 12px;\n  bottom: 12px;\n  width: 12px;\n  cursor: e-resize;\n}\n.styles-module__edgeE___1bGDa::after,\n.styles-module__edgeW___lHQNo::after {\n  width: 4px;\n  height: 24px;\n}\n\n.styles-module__edgeE___1bGDa {\n  right: -6px;\n}\n\n.styles-module__edgeW___lHQNo {\n  left: -6px;\n  cursor: w-resize;\n}\n\n.styles-module__deleteButton___LkGCb {\n  position: absolute;\n  top: -8px;\n  right: -8px;\n  width: 18px;\n  height: 18px;\n  border-radius: 50%;\n  background: rgba(255, 255, 255, 0.9);\n  backdrop-filter: blur(8px);\n  border: 1px solid rgba(0, 0, 0, 0.08);\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);\n  color: rgba(0, 0, 0, 0.35);\n  cursor: pointer;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-size: 10px;\n  line-height: 1;\n  z-index: 15;\n  pointer-events: none;\n  opacity: 0;\n  transform: scale(0.8);\n  will-change: opacity, transform;\n  transition: opacity 0.2s ease-out, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.12s ease, color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;\n}\n.styles-module__placement___zcxv8:hover .styles-module__deleteButton___LkGCb, .styles-module__selected___6yrp6 .styles-module__deleteButton___LkGCb, .styles-module__sectionOutline___s0hy-:hover .styles-module__deleteButton___LkGCb, .styles-module__sectionOutline___s0hy-.styles-module__selected___6yrp6 .styles-module__deleteButton___LkGCb, .styles-module__ghostOutline___po-kO:hover .styles-module__deleteButton___LkGCb, .styles-module__ghostOutline___po-kO.styles-module__selected___6yrp6 .styles-module__deleteButton___LkGCb {\n  opacity: 1;\n  transform: scale(1);\n  pointer-events: auto;\n}\n.styles-module__deleteButton___LkGCb:hover {\n  background: #ef4444;\n  color: #fff;\n  border-color: #ef4444;\n  box-shadow: 0 1px 4px rgba(239, 68, 68, 0.3);\n  transform: scale(1.1);\n}\n.styles-module__overlay___aWh-q:not(.styles-module__light___ORIft) .styles-module__deleteButton___LkGCb, .styles-module__rearrangeOverlay___-3R3t:not(.styles-module__light___ORIft) .styles-module__deleteButton___LkGCb {\n  background: rgba(40, 40, 40, 0.9);\n  border-color: rgba(255, 255, 255, 0.1);\n  color: rgba(255, 255, 255, 0.5);\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);\n}\n.styles-module__overlay___aWh-q:not(.styles-module__light___ORIft) .styles-module__deleteButton___LkGCb:hover, .styles-module__rearrangeOverlay___-3R3t:not(.styles-module__light___ORIft) .styles-module__deleteButton___LkGCb:hover {\n  background: #ef4444;\n  color: #fff;\n  border-color: #ef4444;\n}\n\n.styles-module__drawBox___BrVAa {\n  position: fixed;\n  pointer-events: none;\n  z-index: 99996;\n  border: 2px solid #3c82f7;\n  border-radius: 6px;\n  background: rgba(59, 130, 246, 0.15);\n}\n\n.styles-module__selectBox___Iu8kB {\n  position: fixed;\n  pointer-events: none;\n  z-index: 99996;\n  border: 1px dashed #3c82f7;\n  background: rgba(59, 130, 246, 0.08);\n  border-radius: 2px;\n}\n\n.styles-module__sizeIndicator___7zJ4y {\n  position: fixed;\n  pointer-events: none;\n  z-index: 100001;\n  font-size: 10px;\n  color: #fff;\n  background: #3c82f7;\n  padding: 2px 6px;\n  border-radius: 4px;\n  white-space: nowrap;\n  font-weight: 500;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);\n}\n\n.styles-module__guideLine___DUQY2 {\n  pointer-events: none;\n  z-index: 100001;\n  background: #f0f;\n  opacity: 0.5;\n}\n\n.styles-module__dragPreview___onPbU {\n  position: fixed;\n  z-index: 100002;\n  pointer-events: none;\n  border: 1.5px dashed #3c82f7;\n  border-radius: 6px;\n  background: rgba(59, 130, 246, 0.1);\n  backdrop-filter: blur(8px);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-size: 9px;\n  font-weight: 600;\n  color: #3c82f7;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  text-transform: uppercase;\n  letter-spacing: 0.04em;\n  box-shadow: 0 4px 16px rgba(59, 130, 246, 0.15);\n  transition: width 0.08s ease, height 0.08s ease, opacity 0.08s ease;\n}\n\n.styles-module__dragPreviewWireframe___jsg0G {\n  border-color: #f97316;\n  background: rgba(249, 115, 22, 0.1);\n  color: #f97316;\n  box-shadow: 0 4px 16px rgba(249, 115, 22, 0.15);\n}\n\n.styles-module__palette___C7iSH {\n  position: absolute;\n  right: 5px;\n  bottom: calc(100% + 0.5rem);\n  width: 256px;\n  overflow: hidden;\n  background: #1c1c1c;\n  border: none;\n  border-radius: 1rem;\n  padding: 13px 0 16px;\n  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.04);\n  z-index: 100001;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  cursor: default;\n  opacity: 0;\n  filter: blur(5px);\n}\n.styles-module__palette___C7iSH .styles-module__paletteItem___6TlnA,\n.styles-module__palette___C7iSH .styles-module__paletteItemLabel___6ncO4,\n.styles-module__palette___C7iSH .styles-module__paletteSectionTitle___PqnjX,\n.styles-module__palette___C7iSH .styles-module__paletteFooter___QYnAG {\n  transition: background 0.25s ease, color 0.25s ease, border-color 0.25s ease;\n}\n.styles-module__palette___C7iSH {\n  opacity: 0;\n  transform: translateY(var(--panel-offset-y, 4px)) scale(0.98);\n  transform-origin: var(--panel-origin, bottom right);\n  filter: blur(2px);\n  pointer-events: none;\n  visibility: hidden;\n  transition: opacity 120ms cubic-bezier(0.25, 0.46, 0.45, 0.94), transform 120ms cubic-bezier(0.25, 0.46, 0.45, 0.94), filter 120ms cubic-bezier(0.25, 0.46, 0.45, 0.94);\n}\n.styles-module__palette___C7iSH[data-panel-present=true] {\n  visibility: visible;\n}\n.styles-module__palette___C7iSH[data-panel-open=true] {\n  opacity: 1;\n  transform: translateY(0) scale(1);\n  filter: blur(0);\n  pointer-events: auto;\n  transition-duration: 160ms;\n}\n@media (prefers-reduced-motion: reduce) {\n  .styles-module__palette___C7iSH {\n    transition: none;\n    transform: none;\n    filter: none;\n  }\n}\n.styles-module__palette___C7iSH.styles-module__light___ORIft {\n  background: #fff;\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);\n}\n\n.styles-module__paletteSection___V8DEA {\n  padding: 0 1rem;\n}\n.styles-module__paletteSection___V8DEA + .styles-module__paletteSection___V8DEA {\n  margin-top: 0.5rem;\n  padding-top: 0.5rem;\n  border-top: 1px solid rgba(255, 255, 255, 0.07);\n}\n.styles-module__light___ORIft .styles-module__paletteSection___V8DEA + .styles-module__paletteSection___V8DEA {\n  border-top-color: rgba(0, 0, 0, 0.07);\n}\n\n.styles-module__paletteSectionTitle___PqnjX {\n  font-size: 0.6875rem;\n  font-weight: 500;\n  color: rgba(255, 255, 255, 0.5);\n  letter-spacing: -0.0094em;\n  padding: 0 0 3px 3px;\n}\n.styles-module__light___ORIft .styles-module__paletteSectionTitle___PqnjX {\n  color: rgba(0, 0, 0, 0.4);\n}\n\n.styles-module__paletteItem___6TlnA {\n  width: 100%;\n  text-align: left;\n  background: transparent;\n  display: flex;\n  align-items: center;\n  gap: 0.375rem;\n  padding: 0.25rem 0.25rem;\n  margin-bottom: 1px;\n  border-radius: 0.375rem;\n  cursor: pointer;\n  transition: background-color 0.15s ease, border-color 0.15s ease;\n  border: 1px solid transparent;\n  -webkit-user-select: none;\n  user-select: none;\n  min-height: 24px;\n}\n.styles-module__paletteItem___6TlnA:hover {\n  background: rgba(255, 255, 255, 0.1);\n}\n.styles-module__paletteItem___6TlnA.styles-module__active___hosp7 {\n  background: #3c82f7;\n  border-color: transparent;\n}\n.styles-module__paletteItem___6TlnA.styles-module__wireframe___itvQU.styles-module__active___hosp7 {\n  background: #f97316;\n}\n.styles-module__light___ORIft .styles-module__paletteItem___6TlnA:hover {\n  background: rgba(0, 0, 0, 0.05);\n}\n.styles-module__light___ORIft .styles-module__paletteItem___6TlnA.styles-module__active___hosp7 {\n  background: #3c82f7;\n  border-color: transparent;\n}\n.styles-module__light___ORIft .styles-module__paletteItem___6TlnA.styles-module__wireframe___itvQU.styles-module__active___hosp7 {\n  background: #f97316;\n}\n\n.styles-module__paletteItemIcon___0NPQK {\n  width: 20px;\n  height: 16px;\n  border-radius: 2px;\n  border: 1px dashed rgba(255, 255, 255, 0.15);\n  background: rgba(255, 255, 255, 0.04);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  flex-shrink: 0;\n  overflow: hidden;\n  color: rgba(255, 255, 255, 0.45);\n}\n.styles-module__paletteItemIcon___0NPQK svg {\n  display: block;\n  width: 20px;\n  height: 16px;\n}\n.styles-module__active___hosp7 .styles-module__paletteItemIcon___0NPQK {\n  border-color: rgba(255, 255, 255, 0.3);\n  background: rgba(255, 255, 255, 0.15);\n  color: #fff;\n}\n.styles-module__light___ORIft .styles-module__paletteItemIcon___0NPQK {\n  border-color: rgba(0, 0, 0, 0.12);\n  background: rgba(0, 0, 0, 0.02);\n  color: rgba(0, 0, 0, 0.4);\n}\n.styles-module__light___ORIft .styles-module__active___hosp7 .styles-module__paletteItemIcon___0NPQK {\n  border-color: rgba(255, 255, 255, 0.3);\n  background: rgba(255, 255, 255, 0.15);\n  color: #fff;\n}\n\n.styles-module__paletteItemLabel___6ncO4 {\n  font-size: 0.8125rem;\n  font-weight: 500;\n  color: rgba(255, 255, 255, 0.85);\n  letter-spacing: -0.0094em;\n  line-height: 1;\n  min-width: 0;\n}\n.styles-module__active___hosp7 .styles-module__paletteItemLabel___6ncO4 {\n  color: #fff;\n  font-weight: 600;\n}\n.styles-module__light___ORIft .styles-module__paletteItemLabel___6ncO4 {\n  color: rgba(0, 0, 0, 0.7);\n}\n.styles-module__light___ORIft .styles-module__active___hosp7 .styles-module__paletteItemLabel___6ncO4 {\n  color: #fff;\n  font-weight: 600;\n}\n\n.styles-module__placeScroll___7sClM {\n  max-height: 240px;\n  overflow-y: auto;\n  overflow-x: hidden;\n  padding-top: 0.25rem;\n}\n.styles-module__placeScroll___7sClM.styles-module__fadeTop___KT9tF {\n  -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 32px);\n  mask-image: linear-gradient(to bottom, transparent 0, black 32px);\n}\n.styles-module__placeScroll___7sClM.styles-module__fadeBottom___x3ShT {\n  -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 32px), transparent 100%);\n  mask-image: linear-gradient(to bottom, black calc(100% - 32px), transparent 100%);\n}\n.styles-module__placeScroll___7sClM.styles-module__fadeTop___KT9tF.styles-module__fadeBottom___x3ShT {\n  -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 32px, black calc(100% - 32px), transparent 100%);\n  mask-image: linear-gradient(to bottom, transparent 0, black 32px, black calc(100% - 32px), transparent 100%);\n}\n.styles-module__placeScroll___7sClM::-webkit-scrollbar {\n  width: 3px;\n}\n.styles-module__placeScroll___7sClM::-webkit-scrollbar-thumb {\n  background: rgba(255, 255, 255, 0.12);\n  border-radius: 2px;\n}\n.styles-module__light___ORIft .styles-module__placeScroll___7sClM::-webkit-scrollbar-thumb {\n  background: rgba(0, 0, 0, 0.1);\n}\n\n.styles-module__paletteFooterWrap___71-fI {\n  display: grid;\n  grid-template-rows: 1fr;\n  transition: grid-template-rows 0.25s cubic-bezier(0.32, 0.72, 0, 1);\n}\n.styles-module__paletteFooterWrap___71-fI.styles-module__footerHidden___fJUik {\n  grid-template-rows: 0fr;\n}\n\n.styles-module__paletteFooterInnerContent___VC26h {\n  opacity: 1;\n  transform: translateY(0);\n  transition: opacity 0.15s ease, transform 0.15s ease;\n}\n.styles-module__footerHidden___fJUik .styles-module__paletteFooterInnerContent___VC26h {\n  opacity: 0;\n  transform: translateY(4px);\n}\n\n.styles-module__paletteFooterInner___dfylY {\n  overflow: hidden;\n}\n\n.styles-module__paletteFooter___QYnAG {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  min-height: 24px;\n  padding: 0 1rem;\n  margin-top: 0.5rem;\n  padding-top: 0.5rem;\n  border-top: 1px solid rgba(255, 255, 255, 0.07);\n}\n.styles-module__light___ORIft .styles-module__paletteFooter___QYnAG {\n  border-top-color: rgba(0, 0, 0, 0.07);\n}\n\n.styles-module__paletteFooterCount___D3Fia {\n  font-size: 0.8125rem;\n  font-weight: 400;\n  letter-spacing: -0.0094em;\n  color: rgba(255, 255, 255, 0.5);\n}\n.styles-module__light___ORIft .styles-module__paletteFooterCount___D3Fia {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__paletteFooterClear___ybBoa {\n  font-size: 0.8125rem;\n  font-weight: 400;\n  letter-spacing: -0.0094em;\n  color: rgba(255, 255, 255, 0.5);\n  background: none;\n  border: none;\n  cursor: pointer;\n  padding: 0;\n  font-family: inherit;\n  transition: color 0.15s ease;\n}\n.styles-module__paletteFooterClear___ybBoa:hover {\n  color: rgba(255, 255, 255, 0.7);\n}\n.styles-module__light___ORIft .styles-module__paletteFooterClear___ybBoa {\n  color: rgba(0, 0, 0, 0.5);\n}\n.styles-module__light___ORIft .styles-module__paletteFooterClear___ybBoa:hover {\n  color: rgba(0, 0, 0, 0.6);\n}\n\n.styles-module__paletteFooterActions___fLzv8 {\n  display: flex;\n  align-items: center;\n  gap: 0.75rem;\n}\n\n.styles-module__rollingWrap___S75jM {\n  display: inline-block;\n  overflow: hidden;\n  height: 1.15em;\n  position: relative;\n  vertical-align: bottom;\n}\n\n.styles-module__rollingNum___1RKDx {\n  position: absolute;\n  left: 0;\n  top: 0;\n}\n\n.styles-module__exitUp___AFDRW {\n  animation: styles-module__numExitUp___FRQqx 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards;\n}\n\n.styles-module__enterUp___CPlXb {\n  animation: styles-module__numEnterUp___2Yd-w 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards;\n}\n\n.styles-module__exitDown___-1yAy {\n  animation: styles-module__numExitDown___xm5by 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards;\n}\n\n.styles-module__enterDown___DDuFR {\n  animation: styles-module__numEnterDown___hpxBk 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards;\n}\n\n@keyframes styles-module__numExitUp___FRQqx {\n  from {\n    transform: translateY(0);\n    opacity: 1;\n  }\n  to {\n    transform: translateY(-110%);\n    opacity: 0;\n  }\n}\n@keyframes styles-module__numEnterUp___2Yd-w {\n  from {\n    transform: translateY(110%);\n    opacity: 0;\n  }\n  to {\n    transform: translateY(0);\n    opacity: 1;\n  }\n}\n@keyframes styles-module__numExitDown___xm5by {\n  from {\n    transform: translateY(0);\n    opacity: 1;\n  }\n  to {\n    transform: translateY(110%);\n    opacity: 0;\n  }\n}\n@keyframes styles-module__numEnterDown___hpxBk {\n  from {\n    transform: translateY(-110%);\n    opacity: 0;\n  }\n  to {\n    transform: translateY(0);\n    opacity: 1;\n  }\n}\n.styles-module__rearrangeOverlay___-3R3t {\n  position: fixed;\n  inset: 0;\n  z-index: 99995;\n  pointer-events: none;\n  cursor: default;\n  -webkit-user-select: none;\n  user-select: none;\n  animation: styles-module__overlayFadeIn___aECVy 0.15s ease;\n}\n\n.styles-module__hoverHighlight___8eT-v {\n  position: fixed;\n  pointer-events: none;\n  z-index: 99994;\n  border: 2px dashed rgba(59, 130, 246, 0.5);\n  border-radius: 4px;\n  background: rgba(59, 130, 246, 0.06);\n  animation: styles-module__highlightFadeIn___Lg7KY 0.12s ease;\n}\n\n.styles-module__sectionOutline___s0hy- {\n  position: fixed;\n  border: 2px solid;\n  border-radius: 4px;\n  cursor: grab;\n}\n.styles-module__sectionOutline___s0hy-:active {\n  cursor: grabbing;\n}\n.styles-module__sectionOutline___s0hy- {\n  transition: box-shadow 0.15s, border-color 0.3s, background-color 0.3s, border-style 0s;\n  -webkit-user-select: none;\n  user-select: none;\n  pointer-events: auto;\n  animation: styles-module__sectionEnter___-8BXT 0.2s ease;\n}\n.styles-module__sectionOutline___s0hy-:hover {\n  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 4px 12px rgba(0, 0, 0, 0.15);\n}\n.styles-module__sectionOutline___s0hy-.styles-module__selected___6yrp6 {\n  border-style: solid;\n  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);\n}\n.styles-module__sectionOutline___s0hy-.styles-module__selected___6yrp6:hover {\n  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);\n}\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6) {\n  border: 1.5px dashed rgba(150, 150, 150, 0.35);\n  background-color: transparent !important;\n  box-shadow: none;\n}\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6):hover {\n  border-color: rgba(150, 150, 150, 0.6);\n  box-shadow: none;\n}\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6) .styles-module__sectionLabel___F80HQ {\n  opacity: 0;\n  transition: opacity 0.15s ease;\n}\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6):hover .styles-module__sectionLabel___F80HQ {\n  opacity: 1;\n}\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6) .styles-module__movedBadge___s8z-q,\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6) .styles-module__sectionDimensions___RcJSL {\n  opacity: 0;\n  transition: opacity 0.15s ease;\n}\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6):hover .styles-module__sectionDimensions___RcJSL {\n  opacity: 1;\n}\n.styles-module__sectionOutline___s0hy-.styles-module__exiting___YrM8F {\n  opacity: 0;\n  transform: scale(0.97);\n  pointer-events: none;\n  animation: none;\n  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.32, 0.72, 0, 1);\n}\n\n.styles-module__sectionLabel___F80HQ {\n  position: absolute;\n  top: 4px;\n  left: 4px;\n  font-size: 10px;\n  font-weight: 600;\n  color: #fff;\n  padding: 2px 8px;\n  border-radius: 4px;\n  white-space: nowrap;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);\n  max-width: calc(100% - 8px);\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.styles-module__movedBadge___s8z-q {\n  position: absolute;\n  bottom: 22px;\n  right: 4px;\n  font-size: 9px;\n  font-weight: 700;\n  color: #fff;\n  background: #22c55e;\n  padding: 2px 6px;\n  border-radius: 4px;\n  white-space: nowrap;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  text-transform: uppercase;\n  letter-spacing: 0.04em;\n  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);\n  opacity: 0;\n  transform: scale(0.8);\n  transition: opacity 0.15s ease, transform 0.15s ease;\n}\n.styles-module__movedBadge___s8z-q.styles-module__badgeVisible___npbdS {\n  opacity: 1;\n  transform: scale(1);\n  transition: opacity 0.2s cubic-bezier(0.34, 1.2, 0.64, 1), transform 0.2s cubic-bezier(0.34, 1.2, 0.64, 1);\n}\n\n.styles-module__resizedBadge___u51V8 {\n  background: #3c82f7;\n  bottom: 40px;\n}\n\n.styles-module__sectionDimensions___RcJSL {\n  position: absolute;\n  bottom: 4px;\n  right: 4px;\n  font-size: 9px;\n  font-weight: 500;\n  color: rgba(255, 255, 255, 0.7);\n  background: rgba(0, 0, 0, 0.5);\n  padding: 1px 5px;\n  border-radius: 3px;\n  white-space: nowrap;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n}\n.styles-module__light___ORIft .styles-module__sectionDimensions___RcJSL {\n  color: rgba(0, 0, 0, 0.5);\n  background: rgba(255, 255, 255, 0.7);\n}\n\n.styles-module__wireframeNotice___4GJyB {\n  position: fixed;\n  bottom: 16px;\n  left: 24px;\n  z-index: 99995;\n  font-size: 9.5px;\n  font-weight: 400;\n  color: rgba(0, 0, 0, 0.4);\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  pointer-events: auto;\n  animation: styles-module__overlayFadeIn___aECVy 0.3s ease;\n  line-height: 1.5;\n  max-width: 280px;\n}\n\n.styles-module__wireframeOpacityRow___CJXzi {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  margin-bottom: 8px;\n}\n\n.styles-module__wireframeOpacityLabel___afkfT {\n  font-size: 9px;\n  font-weight: 500;\n  color: rgba(0, 0, 0, 0.32);\n  letter-spacing: 0.02em;\n  white-space: nowrap;\n  -webkit-user-select: none;\n  user-select: none;\n}\n\n.styles-module__wireframeOpacitySlider___YcoEs {\n  -webkit-appearance: none;\n  appearance: none;\n  width: 56px;\n  height: 4px;\n  background: rgba(0, 0, 0, 0.08);\n  border-radius: 2px;\n  outline: none;\n  cursor: pointer;\n  flex-shrink: 0;\n  transition: background 0.15s ease;\n}\n.styles-module__wireframeOpacitySlider___YcoEs:hover {\n  background: rgba(0, 0, 0, 0.13);\n}\n.styles-module__wireframeOpacitySlider___YcoEs::-webkit-slider-thumb {\n  -webkit-appearance: none;\n  appearance: none;\n  width: 10px;\n  height: 10px;\n  border-radius: 50%;\n  background: #f97316;\n  cursor: pointer;\n  transition: background 0.15s ease;\n}\n.styles-module__wireframeOpacitySlider___YcoEs::-webkit-slider-thumb:hover {\n  background: rgb(88.0082041185%, 37.39404381%, 2.2663056855%);\n}\n.styles-module__wireframeOpacitySlider___YcoEs::-moz-range-thumb {\n  width: 10px;\n  height: 10px;\n  border-radius: 50%;\n  background: #f97316;\n  border: none;\n  cursor: pointer;\n}\n.styles-module__wireframeOpacitySlider___YcoEs::-moz-range-track {\n  background: rgba(0, 0, 0, 0.08);\n  height: 4px;\n  border-radius: 2px;\n}\n\n.styles-module__wireframeNoticeTitleRow___PJqyG {\n  display: flex;\n  align-items: center;\n  gap: 0;\n  margin-bottom: 2px;\n}\n\n.styles-module__wireframeNoticeTitle___okr08 {\n  font-weight: 600;\n  color: rgba(0, 0, 0, 0.55);\n}\n\n.styles-module__wireframeNoticeDivider___PNKQ6 {\n  width: 1px;\n  height: 8px;\n  background: rgba(0, 0, 0, 0.12);\n  margin: 0 8px;\n  flex-shrink: 0;\n}\n\n.styles-module__wireframeStartOver___YFk-I {\n  font-size: 9.5px;\n  font-weight: 500;\n  color: rgba(0, 0, 0, 0.35);\n  cursor: pointer;\n  background: none;\n  border: none;\n  padding: 0;\n  font-family: inherit;\n  text-decoration: none;\n  transition: color 0.12s ease;\n  white-space: nowrap;\n}\n.styles-module__wireframeStartOver___YFk-I:hover {\n  color: rgba(0, 0, 0, 0.6);\n}\n\n.styles-module__ghostOutline___po-kO {\n  position: fixed;\n  border: 1.5px dashed rgba(59, 130, 246, 0.4);\n  border-radius: 4px;\n  background: rgba(59, 130, 246, 0.04);\n  cursor: grab;\n  opacity: 0.5;\n  -webkit-user-select: none;\n  user-select: none;\n  pointer-events: auto;\n  animation: styles-module__ghostEnter___EC3Mb 0.25s ease;\n  transition: box-shadow 0.15s, border-color 0.3s, opacity 0.25s;\n}\n.styles-module__ghostOutline___po-kO:active {\n  cursor: grabbing;\n}\n.styles-module__ghostOutline___po-kO:hover {\n  opacity: 0.7;\n  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.1), 0 4px 12px rgba(0, 0, 0, 0.08);\n}\n.styles-module__ghostOutline___po-kO.styles-module__selected___6yrp6 {\n  opacity: 1;\n  border-style: solid;\n  border-width: 2px;\n  border-color: #3c82f7;\n  background: rgba(59, 130, 246, 0.08);\n  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);\n}\n.styles-module__ghostOutline___po-kO.styles-module__exiting___YrM8F {\n  opacity: 0;\n  transform: scale(0.97);\n  pointer-events: none;\n  animation: none;\n  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.32, 0.72, 0, 1);\n}\n\n.styles-module__ghostBadge___tsQUK {\n  position: absolute;\n  bottom: calc(100% + 4px);\n  left: -1px;\n  font-size: 9px;\n  font-weight: 600;\n  color: rgba(59, 130, 246, 0.9);\n  background: rgba(59, 130, 246, 0.08);\n  border: 1px solid rgba(59, 130, 246, 0.2);\n  padding: 1px 5px;\n  border-radius: 3px;\n  white-space: nowrap;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  letter-spacing: 0.02em;\n  line-height: 1.2;\n  animation: styles-module__badgeSlideIn___typJ7 0.2s ease both;\n}\n\n@keyframes styles-module__badgeSlideIn___typJ7 {\n  from {\n    opacity: 0;\n    transform: translateY(4px);\n  }\n  to {\n    opacity: 1;\n    transform: translateY(0);\n  }\n}\n.styles-module__ghostBadgeExtra___6CVoD {\n  display: inline;\n  animation: styles-module__badgeExtraIn___i4W8F 0.2s ease both;\n}\n\n@keyframes styles-module__badgeExtraIn___i4W8F {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}\n.styles-module__originalOutline___Y6DD1 {\n  position: fixed;\n  border: 1.5px dashed rgba(150, 150, 150, 0.3);\n  border-radius: 4px;\n  background: transparent;\n  pointer-events: none;\n  -webkit-user-select: none;\n  user-select: none;\n  animation: styles-module__sectionEnter___-8BXT 0.2s ease;\n}\n\n.styles-module__originalLabel___HqI9g {\n  position: absolute;\n  top: 4px;\n  left: 4px;\n  font-size: 9px;\n  font-weight: 500;\n  color: rgba(150, 150, 150, 0.5);\n  padding: 1px 6px;\n  border-radius: 3px;\n  white-space: nowrap;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  background: rgba(150, 150, 150, 0.08);\n}\n\n.styles-module__connectorSvg___Lovld {\n  position: fixed;\n  inset: 0;\n  width: 100vw;\n  height: 100vh;\n  pointer-events: none;\n  z-index: 99996;\n}\n\n.styles-module__connectorLine___XeWh- {\n  transition: opacity 0.2s ease;\n  animation: styles-module__connectorDraw___8sK5I 0.3s ease both;\n}\n\n.styles-module__connectorDot___yvf7C {\n  transform-box: fill-box;\n  transform-origin: center;\n  animation: styles-module__connectorDotIn___NwTUq 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) 0.15s both;\n}\n\n@keyframes styles-module__connectorDraw___8sK5I {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}\n@keyframes styles-module__connectorDotIn___NwTUq {\n  from {\n    transform: scale(0);\n    opacity: 0;\n  }\n  to {\n    transform: scale(1);\n    opacity: 1;\n  }\n}\n.styles-module__connectorExiting___2lLOs {\n  animation: styles-module__connectorOut___5QoPl 0.2s ease forwards;\n}\n.styles-module__connectorExiting___2lLOs .styles-module__connectorDot___yvf7C {\n  animation: styles-module__connectorDotOut___FEq7e 0.2s ease forwards;\n}\n\n@keyframes styles-module__connectorOut___5QoPl {\n  from {\n    opacity: 1;\n  }\n  to {\n    opacity: 0;\n  }\n}\n@keyframes styles-module__connectorDotOut___FEq7e {\n  from {\n    transform: scale(1);\n    opacity: 1;\n  }\n  to {\n    transform: scale(0);\n    opacity: 0;\n  }\n}\n@keyframes styles-module__placementEnter___TdRhf {\n  from {\n    opacity: 0;\n    transform: scale(0.85);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1);\n  }\n}\n@keyframes styles-module__sectionEnter___-8BXT {\n  from {\n    opacity: 0;\n    transform: scale(0.96);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1);\n  }\n}\n@keyframes styles-module__highlightFadeIn___Lg7KY {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}\n@keyframes styles-module__overlayFadeIn___aECVy {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}\n@keyframes styles-module__ghostEnter___EC3Mb {\n  from {\n    opacity: 0;\n    transform: scale(0.96);\n  }\n  to {\n    opacity: 0.6;\n    transform: scale(1);\n  }\n}\n.styles-module__canvasToggle___-QqSy:focus-visible,\n.styles-module__paletteItem___6TlnA:focus-visible {\n  outline: 2px solid var(--agentation-color-accent);\n  outline-offset: -2px;\n}';
var styles_module_default4 = { "overlay": "styles-module__overlay___aWh-q", "rearrangeOverlay": "styles-module__rearrangeOverlay___-3R3t", "overlayExiting": "styles-module__overlayExiting___iEmYr", "overlayFadeIn": "styles-module__overlayFadeIn___aECVy", "light": "styles-module__light___ORIft", "wireframe": "styles-module__wireframe___itvQU", "placing": "styles-module__placing___45yD8", "passthrough": "styles-module__passthrough___xaFeE", "blankCanvas": "styles-module__blankCanvas___t2Eue", "visible": "styles-module__visible___OKKqX", "gridActive": "styles-module__gridActive___OZ-cf", "paletteHeader": "styles-module__paletteHeader___-Q5gQ", "paletteHeaderTitle": "styles-module__paletteHeaderTitle___oHqZC", "paletteHeaderDesc": "styles-module__paletteHeaderDesc___6i74T", "wireframePurposeWrap": "styles-module__wireframePurposeWrap___To-tS", "collapsed": "styles-module__collapsed___Ms9vS", "wireframePurposeInner": "styles-module__wireframePurposeInner___Lrahs", "wireframePurposeInput": "styles-module__wireframePurposeInput___7EtBN", "canvasToggle": "styles-module__canvasToggle___-QqSy", "active": "styles-module__active___hosp7", "canvasToggleIcon": "styles-module__canvasToggleIcon___7pJ82", "canvasToggleLabel": "styles-module__canvasToggleLabel___OanpY", "placement": "styles-module__placement___zcxv8", "placementEnter": "styles-module__placementEnter___TdRhf", "selected": "styles-module__selected___6yrp6", "dragging": "styles-module__dragging___le6KZ", "exiting": "styles-module__exiting___YrM8F", "placementContent": "styles-module__placementContent___f64A4", "placementLabel": "styles-module__placementLabel___0KvWl", "placementAnnotation": "styles-module__placementAnnotation___78pTr", "annotationVisible": "styles-module__annotationVisible___mrUyA", "sectionAnnotation": "styles-module__sectionAnnotation___aUIs0", "handle": "styles-module__handle___Ikbxm", "sectionOutline": "styles-module__sectionOutline___s0hy-", "ghostOutline": "styles-module__ghostOutline___po-kO", "handleNw": "styles-module__handleNw___4TMIj", "handleNe": "styles-module__handleNe___mnsTh", "handleSe": "styles-module__handleSe___oSFnk", "handleSw": "styles-module__handleSw___pi--Z", "handleN": "styles-module__handleN___aBA-Q", "handleE": "styles-module__handleE___0hM5u", "handleS": "styles-module__handleS___JjDRv", "handleW": "styles-module__handleW___ERWGQ", "edgeHandle": "styles-module__edgeHandle___XxXdT", "edgeN": "styles-module__edgeN___-JJDj", "edgeS": "styles-module__edgeS___66lMX", "edgeE": "styles-module__edgeE___1bGDa", "edgeW": "styles-module__edgeW___lHQNo", "deleteButton": "styles-module__deleteButton___LkGCb", "drawBox": "styles-module__drawBox___BrVAa", "selectBox": "styles-module__selectBox___Iu8kB", "sizeIndicator": "styles-module__sizeIndicator___7zJ4y", "guideLine": "styles-module__guideLine___DUQY2", "dragPreview": "styles-module__dragPreview___onPbU", "dragPreviewWireframe": "styles-module__dragPreviewWireframe___jsg0G", "palette": "styles-module__palette___C7iSH", "paletteItem": "styles-module__paletteItem___6TlnA", "paletteItemLabel": "styles-module__paletteItemLabel___6ncO4", "paletteSectionTitle": "styles-module__paletteSectionTitle___PqnjX", "paletteFooter": "styles-module__paletteFooter___QYnAG", "paletteSection": "styles-module__paletteSection___V8DEA", "paletteItemIcon": "styles-module__paletteItemIcon___0NPQK", "placeScroll": "styles-module__placeScroll___7sClM", "fadeTop": "styles-module__fadeTop___KT9tF", "fadeBottom": "styles-module__fadeBottom___x3ShT", "paletteFooterWrap": "styles-module__paletteFooterWrap___71-fI", "footerHidden": "styles-module__footerHidden___fJUik", "paletteFooterInnerContent": "styles-module__paletteFooterInnerContent___VC26h", "paletteFooterInner": "styles-module__paletteFooterInner___dfylY", "paletteFooterCount": "styles-module__paletteFooterCount___D3Fia", "paletteFooterClear": "styles-module__paletteFooterClear___ybBoa", "paletteFooterActions": "styles-module__paletteFooterActions___fLzv8", "rollingWrap": "styles-module__rollingWrap___S75jM", "rollingNum": "styles-module__rollingNum___1RKDx", "exitUp": "styles-module__exitUp___AFDRW", "numExitUp": "styles-module__numExitUp___FRQqx", "enterUp": "styles-module__enterUp___CPlXb", "numEnterUp": "styles-module__numEnterUp___2Yd-w", "exitDown": "styles-module__exitDown___-1yAy", "numExitDown": "styles-module__numExitDown___xm5by", "enterDown": "styles-module__enterDown___DDuFR", "numEnterDown": "styles-module__numEnterDown___hpxBk", "hoverHighlight": "styles-module__hoverHighlight___8eT-v", "highlightFadeIn": "styles-module__highlightFadeIn___Lg7KY", "sectionEnter": "styles-module__sectionEnter___-8BXT", "settled": "styles-module__settled___b5U5o", "sectionLabel": "styles-module__sectionLabel___F80HQ", "movedBadge": "styles-module__movedBadge___s8z-q", "sectionDimensions": "styles-module__sectionDimensions___RcJSL", "badgeVisible": "styles-module__badgeVisible___npbdS", "resizedBadge": "styles-module__resizedBadge___u51V8", "wireframeNotice": "styles-module__wireframeNotice___4GJyB", "wireframeOpacityRow": "styles-module__wireframeOpacityRow___CJXzi", "wireframeOpacityLabel": "styles-module__wireframeOpacityLabel___afkfT", "wireframeOpacitySlider": "styles-module__wireframeOpacitySlider___YcoEs", "wireframeNoticeTitleRow": "styles-module__wireframeNoticeTitleRow___PJqyG", "wireframeNoticeTitle": "styles-module__wireframeNoticeTitle___okr08", "wireframeNoticeDivider": "styles-module__wireframeNoticeDivider___PNKQ6", "wireframeStartOver": "styles-module__wireframeStartOver___YFk-I", "ghostEnter": "styles-module__ghostEnter___EC3Mb", "ghostBadge": "styles-module__ghostBadge___tsQUK", "badgeSlideIn": "styles-module__badgeSlideIn___typJ7", "ghostBadgeExtra": "styles-module__ghostBadgeExtra___6CVoD", "badgeExtraIn": "styles-module__badgeExtraIn___i4W8F", "originalOutline": "styles-module__originalOutline___Y6DD1", "originalLabel": "styles-module__originalLabel___HqI9g", "connectorSvg": "styles-module__connectorSvg___Lovld", "connectorLine": "styles-module__connectorLine___XeWh-", "connectorDraw": "styles-module__connectorDraw___8sK5I", "connectorDot": "styles-module__connectorDot___yvf7C", "connectorDotIn": "styles-module__connectorDotIn___NwTUq", "connectorExiting": "styles-module__connectorExiting___2lLOs", "connectorOut": "styles-module__connectorOut___5QoPl", "connectorDotOut": "styles-module__connectorDotOut___FEq7e" };

// src/components/design-mode/index.tsx
var import_jsx_runtime9 = require("react/jsx-runtime");
var MIN_SIZE = 24;
var SNAP_THRESHOLD = 5;
function computeSnap(rect, others, excludeIds, activeEdges, extraRects) {
  let bestDx = Infinity;
  let bestDy = Infinity;
  const mL = rect.x, mR = rect.x + rect.width, mCx = rect.x + rect.width / 2;
  const mT = rect.y, mB = rect.y + rect.height, mCy = rect.y + rect.height / 2;
  const checkAll = !activeEdges;
  const xFroms = checkAll ? [mL, mR, mCx] : [
    ...activeEdges.left ? [mL] : [],
    ...activeEdges.right ? [mR] : []
  ];
  const yFroms = checkAll ? [mT, mB, mCy] : [
    ...activeEdges.top ? [mT] : [],
    ...activeEdges.bottom ? [mB] : []
  ];
  const allTargets = [];
  for (const o of others) {
    if (!excludeIds.has(o.id)) allTargets.push(o);
  }
  if (extraRects) allTargets.push(...extraRects);
  for (const o of allTargets) {
    const oL = o.x, oR = o.x + o.width, oCx = o.x + o.width / 2;
    const oT = o.y, oB = o.y + o.height, oCy = o.y + o.height / 2;
    for (const from of xFroms) {
      for (const to of [oL, oR, oCx]) {
        const d = to - from;
        if (Math.abs(d) < SNAP_THRESHOLD && Math.abs(d) < Math.abs(bestDx)) bestDx = d;
      }
    }
    for (const from of yFroms) {
      for (const to of [oT, oB, oCy]) {
        const d = to - from;
        if (Math.abs(d) < SNAP_THRESHOLD && Math.abs(d) < Math.abs(bestDy)) bestDy = d;
      }
    }
  }
  const dx = Math.abs(bestDx) < SNAP_THRESHOLD ? bestDx : 0;
  const dy = Math.abs(bestDy) < SNAP_THRESHOLD ? bestDy : 0;
  const guides = [];
  const seen = /* @__PURE__ */ new Set();
  const sL = mL + dx, sR = mR + dx, sCx = mCx + dx;
  const sT = mT + dy, sB = mB + dy, sCy = mCy + dy;
  for (const o of allTargets) {
    const oL = o.x, oR = o.x + o.width, oCx = o.x + o.width / 2;
    const oT = o.y, oB = o.y + o.height, oCy = o.y + o.height / 2;
    for (const xPos of [oL, oCx, oR]) {
      for (const sx of [sL, sCx, sR]) {
        if (Math.abs(sx - xPos) < 0.5) {
          const key = `x:${Math.round(xPos)}`;
          if (!seen.has(key)) {
            seen.add(key);
            guides.push({ axis: "x", pos: xPos });
          }
        }
      }
    }
    for (const yPos of [oT, oCy, oB]) {
      for (const sy of [sT, sCy, sB]) {
        if (Math.abs(sy - yPos) < 0.5) {
          const key = `y:${Math.round(yPos)}`;
          if (!seen.has(key)) {
            seen.add(key);
            guides.push({ axis: "y", pos: yPos });
          }
        }
      }
    }
  }
  return { dx, dy, guides };
}
function generateId() {
  return `dp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
function DesignMode({
  placements,
  onChange,
  activeComponent,
  onActiveComponentChange,
  isDarkMode,
  exiting,
  onInteractionChange,
  className: extraClassName,
  passthrough,
  extraSnapRects,
  onSelectionChange,
  deselectSignal,
  onDragMove,
  onDragEnd,
  clearingPlacements,
  wireframe
}) {
  const [selectedIds, setSelectedIds] = (0, import_react10.useState)(/* @__PURE__ */ new Set());
  const [drawBox, setDrawBox] = (0, import_react10.useState)(null);
  const [selectBox, setSelectBox] = (0, import_react10.useState)(null);
  const [sizeIndicator, setSizeIndicator] = (0, import_react10.useState)(null);
  const [guides, setGuides] = (0, import_react10.useState)([]);
  const [editingId, setEditingId] = (0, import_react10.useState)(null);
  const [editExiting, setEditExiting] = (0, import_react10.useState)(false);
  const editHadTextRef = (0, import_react10.useRef)(false);
  const [exitingIds, setExitingIds] = (0, import_react10.useState)(/* @__PURE__ */ new Set());
  const lastAnnotationTextRef = (0, import_react10.useRef)(/* @__PURE__ */ new Map());
  const overlayRef = (0, import_react10.useRef)(null);
  const interactionRef = (0, import_react10.useRef)(null);
  const placementsRef = (0, import_react10.useRef)(placements);
  placementsRef.current = placements;
  const onSelectionChangeRef = (0, import_react10.useRef)(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const onDragMoveRef = (0, import_react10.useRef)(onDragMove);
  onDragMoveRef.current = onDragMove;
  const onDragEndRef = (0, import_react10.useRef)(onDragEnd);
  onDragEndRef.current = onDragEnd;
  const deselectRef = (0, import_react10.useRef)(deselectSignal);
  (0, import_react10.useEffect)(() => {
    if (deselectSignal !== deselectRef.current) {
      deselectRef.current = deselectSignal;
      setSelectedIds(/* @__PURE__ */ new Set());
    }
  }, [deselectSignal]);
  (0, import_react10.useEffect)(() => {
    if (clearingPlacements?.length) {
      setSelectedIds((previous) => new Set([...previous].filter((id) => !clearingPlacements.some((p) => p.id === id))));
      interactionRef.current = null;
    }
  }, [clearingPlacements]);
  (0, import_react10.useEffect)(() => {
    const handleKeyDown = (e) => {
      const target = e.composedPath()[0] || e.target;
      const isTyping = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if (isTyping) return;
      if ((e.key === "Backspace" || e.key === "Delete") && selectedIds.size > 0) {
        e.preventDefault();
        const toDelete = new Set(selectedIds);
        setExitingIds(toDelete);
        setSelectedIds(/* @__PURE__ */ new Set());
        originalSetTimeout(() => {
          onChange(placementsRef.current.filter((p) => !toDelete.has(p.id)));
          setExitingIds(/* @__PURE__ */ new Set());
        }, 180);
        return;
      }
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && selectedIds.size > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 20 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        onChange(
          placements.map(
            (p) => selectedIds.has(p.id) ? { ...p, x: Math.max(0, p.x + dx), y: Math.max(0, p.y + dy) } : p
          )
        );
        return;
      }
      if (e.key === "Escape") {
        if (activeComponent) {
          onActiveComponentChange(null);
        } else if (selectedIds.size > 0) {
          setSelectedIds(/* @__PURE__ */ new Set());
        }
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds, activeComponent, placements, onChange, onActiveComponentChange]);
  const handleOverlayMouseDown = (0, import_react10.useCallback)(
    (e) => {
      if (e.button !== 0) return;
      if (passthrough) return;
      const target = e.target;
      if (target.closest(`.${styles_module_default4.placement}`)) return;
      e.preventDefault();
      e.stopPropagation();
      const scrollY2 = window.scrollY;
      const startX = e.clientX;
      const startY = e.clientY;
      if (activeComponent) {
        interactionRef.current = "place";
        onInteractionChange?.(true);
        let isDrag = false;
        let endX = startX;
        let endY = startY;
        const onMove = (ev) => {
          endX = ev.clientX;
          endY = ev.clientY;
          const dx = Math.abs(endX - startX);
          const dy = Math.abs(endY - startY);
          if (dx > 5 || dy > 5) isDrag = true;
          if (isDrag) {
            const x = Math.min(startX, endX);
            const y = Math.min(startY, endY);
            const w = Math.abs(endX - startX);
            const h = Math.abs(endY - startY);
            setDrawBox({ x, y, w, h });
            setSizeIndicator({ x: ev.clientX + 12, y: ev.clientY + 12, text: `${Math.round(w)} \xD7 ${Math.round(h)}` });
          }
        };
        const onUp = (ev) => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          setDrawBox(null);
          setSizeIndicator(null);
          interactionRef.current = null;
          onInteractionChange?.(false);
          const def = DEFAULT_SIZES[activeComponent];
          let x, y, w, h;
          if (isDrag) {
            x = Math.min(startX, endX);
            y = Math.min(startY, endY) + scrollY2;
            w = Math.max(MIN_SIZE, Math.abs(endX - startX));
            h = Math.max(MIN_SIZE, Math.abs(endY - startY));
          } else {
            w = def.width;
            h = def.height;
            x = startX - w / 2;
            y = startY + scrollY2 - h / 2;
          }
          x = Math.max(0, x);
          y = Math.max(0, y);
          const placement = {
            id: generateId(),
            type: activeComponent,
            x,
            y,
            width: w,
            height: h,
            scrollY: scrollY2,
            timestamp: Date.now()
          };
          const next = [...placements, placement];
          onChange(next);
          setSelectedIds(/* @__PURE__ */ new Set([placement.id]));
          onActiveComponentChange(null);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      } else {
        if (!e.shiftKey) {
          setSelectedIds(/* @__PURE__ */ new Set());
        }
        interactionRef.current = "select";
        let isDrag = false;
        const onMove = (ev) => {
          const dx = Math.abs(ev.clientX - startX);
          const dy = Math.abs(ev.clientY - startY);
          if (dx > 4 || dy > 4) isDrag = true;
          if (isDrag) {
            const x = Math.min(startX, ev.clientX);
            const y = Math.min(startY, ev.clientY);
            setSelectBox({ x, y, w: Math.abs(ev.clientX - startX), h: Math.abs(ev.clientY - startY) });
          }
        };
        const onUp = (ev) => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          interactionRef.current = null;
          if (isDrag) {
            const boxX = Math.min(startX, ev.clientX);
            const boxY = Math.min(startY, ev.clientY) + scrollY2;
            const boxW = Math.abs(ev.clientX - startX);
            const boxH = Math.abs(ev.clientY - startY);
            const newSelected = new Set(e.shiftKey ? selectedIds : /* @__PURE__ */ new Set());
            for (const p of placements) {
              const pScreenY = p.y - scrollY2;
              if (p.x + p.width > boxX && p.x < boxX + boxW && p.y + p.height > boxY && p.y < boxY + boxH) {
                newSelected.add(p.id);
              }
            }
            setSelectedIds(newSelected);
          }
          setSelectBox(null);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }
    },
    [activeComponent, passthrough, placements, onChange, selectedIds]
  );
  const handlePlacementMouseDown = (0, import_react10.useCallback)(
    (e, id) => {
      if (e.button !== 0) return;
      const target = e.target;
      if (target.closest(`.${styles_module_default4.handle}`) || target.closest(`.${styles_module_default4.deleteButton}`)) return;
      e.preventDefault();
      e.stopPropagation();
      let newSelected;
      if (e.shiftKey) {
        newSelected = new Set(selectedIds);
        if (newSelected.has(id)) newSelected.delete(id);
        else newSelected.add(id);
      } else if (!selectedIds.has(id)) {
        newSelected = /* @__PURE__ */ new Set([id]);
      } else {
        newSelected = new Set(selectedIds);
      }
      setSelectedIds(newSelected);
      const changed = newSelected.size !== selectedIds.size || [...newSelected].some((x) => !selectedIds.has(x));
      if (changed) onSelectionChangeRef.current?.(newSelected, e.shiftKey);
      const scrollY2 = window.scrollY;
      const startX = e.clientX;
      const startY = e.clientY;
      const startPositions = /* @__PURE__ */ new Map();
      for (const p of placements) {
        if (newSelected.has(p.id)) {
          startPositions.set(p.id, { x: p.x, y: p.y });
        }
      }
      interactionRef.current = "move";
      onInteractionChange?.(true);
      let moved = false;
      let duplicated = false;
      let basePlacements = placements;
      let lastSnappedDx = 0, lastSnappedDy = 0;
      const selSizes = /* @__PURE__ */ new Map();
      for (const p of placements) {
        if (startPositions.has(p.id)) selSizes.set(p.id, { w: p.width, h: p.height });
      }
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        if (!moved) return;
        if (ev.altKey && !duplicated) {
          duplicated = true;
          const clones = [];
          for (const p of placements) {
            if (startPositions.has(p.id)) {
              clones.push({ ...p, id: generateId(), timestamp: Date.now() });
            }
          }
          basePlacements = [...placements, ...clones];
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [id2, start] of startPositions) {
          const sz = selSizes.get(id2);
          if (!sz) continue;
          minX = Math.min(minX, start.x + dx);
          minY = Math.min(minY, start.y + dy);
          maxX = Math.max(maxX, start.x + dx + sz.w);
          maxY = Math.max(maxY, start.y + dy + sz.h);
        }
        const selRect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        const { dx: snapDx, dy: snapDy, guides: newGuides } = computeSnap(selRect, basePlacements, new Set(startPositions.keys()), void 0, extraSnapRects);
        setGuides(newGuides);
        const snappedDx = dx + snapDx;
        const snappedDy = dy + snapDy;
        lastSnappedDx = snappedDx;
        lastSnappedDy = snappedDy;
        onChange(
          basePlacements.map((p) => {
            const start = startPositions.get(p.id);
            if (!start) return p;
            return { ...p, x: Math.max(0, start.x + snappedDx), y: Math.max(0, start.y + snappedDy) };
          })
        );
        onDragMoveRef.current?.(snappedDx, snappedDy);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        interactionRef.current = null;
        onInteractionChange?.(false);
        setGuides([]);
        onDragEndRef.current?.(lastSnappedDx, lastSnappedDy, moved);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [selectedIds, placements, onChange, onInteractionChange]
  );
  const handleResizeMouseDown = (0, import_react10.useCallback)(
    (e, id, dir) => {
      e.preventDefault();
      e.stopPropagation();
      const comp = placements.find((p) => p.id === id);
      if (!comp) return;
      setSelectedIds(/* @__PURE__ */ new Set([id]));
      interactionRef.current = "resize";
      onInteractionChange?.(true);
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = comp.width;
      const startH = comp.height;
      const startLeft = comp.x;
      const startTop = comp.y;
      const activeEdges = {
        left: dir.includes("w"),
        right: dir.includes("e"),
        top: dir.includes("n"),
        bottom: dir.includes("s")
      };
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let nw = startW, nh = startH, nx = startLeft, ny = startTop;
        if (dir.includes("e")) nw = Math.max(MIN_SIZE, startW + dx);
        if (dir.includes("w")) {
          nw = Math.max(MIN_SIZE, startW - dx);
          nx = startLeft + startW - nw;
        }
        if (dir.includes("s")) nh = Math.max(MIN_SIZE, startH + dy);
        if (dir.includes("n")) {
          nh = Math.max(MIN_SIZE, startH - dy);
          ny = startTop + startH - nh;
        }
        const rect = { x: nx, y: ny, width: nw, height: nh };
        const { dx: snapDx, dy: snapDy, guides: newGuides } = computeSnap(rect, placementsRef.current, /* @__PURE__ */ new Set([id]), activeEdges, extraSnapRects);
        setGuides(newGuides);
        if (snapDx !== 0) {
          if (activeEdges.right) nw += snapDx;
          else if (activeEdges.left) {
            nx += snapDx;
            nw -= snapDx;
          }
        }
        if (snapDy !== 0) {
          if (activeEdges.bottom) nh += snapDy;
          else if (activeEdges.top) {
            ny += snapDy;
            nh -= snapDy;
          }
        }
        onChange(
          placementsRef.current.map(
            (p) => p.id === id ? { ...p, x: nx, y: ny, width: nw, height: nh } : p
          )
        );
        setSizeIndicator({
          x: ev.clientX + 12,
          y: ev.clientY + 12,
          text: `${Math.round(nw)} \xD7 ${Math.round(nh)}`
        });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setSizeIndicator(null);
        interactionRef.current = null;
        onInteractionChange?.(false);
        setGuides([]);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [placements, onChange, onInteractionChange]
  );
  const handleDelete = (0, import_react10.useCallback)(
    (id) => {
      interactionRef.current = null;
      setExitingIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      originalSetTimeout(() => {
        onChange(placementsRef.current.filter((p) => p.id !== id));
        setExitingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 180);
    },
    [onChange]
  );
  const TEXT_TYPES = /* @__PURE__ */ new Set(["text", "hero", "button", "badge", "cta", "toast", "modal", "card", "navigation", "tabs", "input", "search", "breadcrumb", "pricing", "testimonial", "alert", "banner", "tag", "notification", "stat", "productCard"]);
  const TEXT_PLACEHOLDERS = {
    hero: "Headline text",
    button: "Button label",
    badge: "Badge label",
    cta: "Call to action text",
    toast: "Notification message",
    modal: "Dialog title",
    card: "Card title",
    navigation: "Brand / nav items",
    tabs: "Tab labels",
    input: "Placeholder text",
    search: "Search placeholder",
    pricing: "Plan name or price",
    testimonial: "Quote text",
    alert: "Alert message",
    banner: "Banner text",
    tag: "Tag label",
    notification: "Notification message",
    stat: "Metric value",
    productCard: "Product name"
  };
  const handleDoubleClick = (0, import_react10.useCallback)((id) => {
    const p = placements.find((pl) => pl.id === id);
    if (!p) return;
    editHadTextRef.current = !!p.text;
    setEditingId(id);
    setEditExiting(false);
  }, [placements]);
  const dismissEdit = (0, import_react10.useCallback)(() => {
    if (!editingId) return;
    setEditExiting(true);
    originalSetTimeout(() => {
      setEditingId(null);
      setEditExiting(false);
    }, 150);
  }, [editingId]);
  (0, import_react10.useEffect)(() => {
    if (exiting && editingId) dismissEdit();
  }, [exiting]);
  const submitEdit = (0, import_react10.useCallback)((text) => {
    if (!editingId) return;
    onChange(placements.map((p) => p.id === editingId ? { ...p, text: text.trim() || void 0 } : p));
    dismissEdit();
  }, [editingId, placements, onChange, dismissEdit]);
  const scrollY = typeof window !== "undefined" ? window.scrollY : 0;
  const cornerHandles = ["nw", "ne", "se", "sw"];
  const arrowColor = wireframe ? "#f97316" : "#3c82f7";
  const edgeHandles = [
    { dir: "n", cls: styles_module_default4.edgeN, arrow: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("svg", { width: "8", height: "6", viewBox: "0 0 8 6", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("path", { d: "M4 0.5L1 4.5h6z", fill: arrowColor }) }) },
    { dir: "e", cls: styles_module_default4.edgeE, arrow: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("svg", { width: "6", height: "8", viewBox: "0 0 6 8", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("path", { d: "M5.5 4L1.5 1v6z", fill: arrowColor }) }) },
    { dir: "s", cls: styles_module_default4.edgeS, arrow: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("svg", { width: "8", height: "6", viewBox: "0 0 8 6", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("path", { d: "M4 5.5L1 1.5h6z", fill: arrowColor }) }) },
    { dir: "w", cls: styles_module_default4.edgeW, arrow: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("svg", { width: "6", height: "8", viewBox: "0 0 6 8", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("path", { d: "M0.5 4L4.5 1v6z", fill: arrowColor }) }) }
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(import_jsx_runtime9.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
      "div",
      {
        ref: overlayRef,
        className: `${styles_module_default4.overlay} ${!isDarkMode ? styles_module_default4.light : ""} ${activeComponent ? styles_module_default4.placing : ""} ${passthrough ? styles_module_default4.passthrough : ""} ${exiting ? styles_module_default4.overlayExiting : ""} ${wireframe ? styles_module_default4.wireframe : ""}${extraClassName ? ` ${extraClassName}` : ""}`,
        "data-feedback-toolbar": true,
        onMouseDown: handleOverlayMouseDown,
        children: placements.map((p) => {
          const isSelected = selectedIds.has(p.id);
          const label = COMPONENT_MAP[p.type]?.label || p.type;
          const screenY = p.y - scrollY;
          return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(
            "div",
            {
              "data-design-placement": p.id,
              className: `${styles_module_default4.placement} ${isSelected ? styles_module_default4.selected : ""} ${exitingIds.has(p.id) || clearingPlacements?.includes(p) ? styles_module_default4.exiting : ""}`,
              style: {
                left: p.x,
                top: screenY,
                width: p.width,
                height: p.height,
                position: "fixed"
              },
              onMouseDown: (e) => handlePlacementMouseDown(e, p.id),
              onDoubleClick: () => handleDoubleClick(p.id),
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: styles_module_default4.placementLabel, children: label }),
                /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("span", { className: `${styles_module_default4.placementAnnotation} ${p.text ? styles_module_default4.annotationVisible : ""}`, children: (() => {
                  if (p.text) lastAnnotationTextRef.current.set(p.id, p.text);
                  return p.text || lastAnnotationTextRef.current.get(p.id) || "";
                })() }),
                /* @__PURE__ */ (0, import_jsx_runtime9.jsx)("div", { className: styles_module_default4.placementContent, children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Skeleton, { type: p.type, width: p.width, height: p.height, text: p.text }) }),
                /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
                  "div",
                  {
                    className: styles_module_default4.deleteButton,
                    onMouseDown: (e) => e.stopPropagation(),
                    onClick: () => handleDelete(p.id),
                    children: "\u2715"
                  }
                ),
                cornerHandles.map((dir) => /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
                  "div",
                  {
                    className: `${styles_module_default4.handle} ${styles_module_default4[`handle${dir.charAt(0).toUpperCase()}${dir.slice(1)}`]}`,
                    onMouseDown: (e) => handleResizeMouseDown(e, p.id, dir)
                  },
                  dir
                )),
                edgeHandles.map(({ dir, cls, arrow }) => /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
                  "div",
                  {
                    className: `${styles_module_default4.edgeHandle} ${cls}`,
                    onMouseDown: (e) => handleResizeMouseDown(e, p.id, dir),
                    children: arrow
                  },
                  dir
                ))
              ]
            },
            p.id
          );
        })
      }
    ),
    editingId && (() => {
      const ep = placements.find((p) => p.id === editingId);
      if (!ep) return null;
      const ey = ep.y - scrollY;
      const centerX = ep.x + ep.width / 2;
      const aboveY = ey - 8;
      const belowY = ey + ep.height + 8;
      const fitsAbove = aboveY > 200;
      const fitsBelow = belowY < window.innerHeight - 100;
      const popupLeft = Math.max(160, Math.min(window.innerWidth - 160, centerX));
      let popupStyle;
      if (fitsAbove) {
        popupStyle = { left: popupLeft, bottom: window.innerHeight - aboveY };
      } else if (fitsBelow) {
        popupStyle = { left: popupLeft, top: belowY };
      } else {
        popupStyle = { left: popupLeft, top: Math.max(80, window.innerHeight / 2 - 80) };
      }
      return /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
        AnnotationPopupCSS,
        {
          element: COMPONENT_MAP[ep.type]?.label || ep.type,
          placeholder: TEXT_PLACEHOLDERS[ep.type] || "Label or content text",
          initialValue: ep.text ?? "",
          submitLabel: editHadTextRef.current ? "Save" : "Set",
          onSubmit: submitEdit,
          onCancel: dismissEdit,
          onDelete: editHadTextRef.current ? () => {
            submitEdit("");
          } : void 0,
          isExiting: editExiting,
          lightMode: !isDarkMode,
          style: popupStyle
        }
      );
    })(),
    drawBox && /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
      "div",
      {
        className: styles_module_default4.drawBox,
        style: { left: drawBox.x, top: drawBox.y, width: drawBox.w, height: drawBox.h },
        "data-feedback-toolbar": true
      }
    ),
    selectBox && /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
      "div",
      {
        className: styles_module_default4.selectBox,
        style: { left: selectBox.x, top: selectBox.y, width: selectBox.w, height: selectBox.h },
        "data-feedback-toolbar": true
      }
    ),
    sizeIndicator && /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
      "div",
      {
        className: styles_module_default4.sizeIndicator,
        style: { left: sizeIndicator.x, top: sizeIndicator.y },
        "data-feedback-toolbar": true,
        children: sizeIndicator.text
      }
    ),
    guides.map((g, i) => /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
      "div",
      {
        className: styles_module_default4.guideLine,
        style: g.axis === "x" ? { position: "fixed", left: g.pos, top: 0, width: 1, bottom: 0 } : { position: "fixed", left: 0, top: g.pos - scrollY, right: 0, height: 1 },
        "data-feedback-toolbar": true
      },
      `${g.axis}-${g.pos}-${i}`
    ))
  ] });
}

// src/components/design-mode/palette.tsx
var import_react12 = require("react");

// src/hooks/use-panel-presence.ts
var import_react11 = require("react");
function usePanelPresence(open, { keepMounted = false, onExited } = {}) {
  const [mounted, setMounted] = (0, import_react11.useState)(keepMounted || open);
  const ref = (0, import_react11.useRef)(null);
  const onExitedRef = (0, import_react11.useRef)(onExited);
  if (open && !mounted) setMounted(true);
  (0, import_react11.useLayoutEffect)(() => {
    onExitedRef.current = onExited;
  }, [onExited]);
  (0, import_react11.useLayoutEffect)(() => {
    const panel = ref.current;
    if (!panel || panel.dataset.panelOpen === "true" === open) return;
    getComputedStyle(panel).opacity;
    panel.dataset.panelPresent = "true";
    panel.dataset.panelOpen = String(open);
    let cancelled = false;
    const transitions = panel.getAnimations?.() ?? [];
    Promise.allSettled(transitions.map((transition) => transition.finished)).then(() => {
      if (cancelled || open) return;
      delete panel.dataset.panelPresent;
      if (!keepMounted) setMounted(false);
      onExitedRef.current?.();
    });
    return () => {
      cancelled = true;
    };
  }, [open, mounted, keepMounted]);
  return { ref, mounted };
}

// src/components/design-mode/palette.tsx
var import_jsx_runtime10 = require("react/jsx-runtime");
function scrollFadeClass(el) {
  if (!el) return "";
  const top = el.scrollTop > 2;
  const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
  return `${top ? styles_module_default4.fadeTop : ""} ${bottom ? styles_module_default4.fadeBottom : ""}`;
}
var s = "currentColor";
var sw = "0.5";
function PaletteIconSvg({ type }) {
  switch (type) {
    case "navigation":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "4", width: "18", height: "8", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2.5", y: "7", width: "3", height: "1.5", rx: ".5", fill: s, opacity: ".4" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "7", width: "2.5", height: "1.5", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "11", y: "7", width: "2.5", height: "1.5", rx: ".5", fill: s, opacity: ".25" })
      ] });
    case "header":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "2", width: "18", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "5.5", width: "8", height: "2", rx: ".5", fill: s, opacity: ".35" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "9", width: "12", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "hero":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "1", width: "18", height: "14", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "5", width: "10", height: "1.5", rx: ".5", fill: s, opacity: ".35" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "8", width: "6", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7.5", y: "10.5", width: "5", height: "2.5", rx: "1", stroke: s, strokeWidth: sw })
      ] });
    case "section":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "1", width: "18", height: "14", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "4", width: "6", height: "1", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "6.5", width: "14", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "9", width: "10", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "sidebar":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "1", width: "7", height: "14", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2.5", y: "4", width: "4", height: "1", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2.5", y: "6.5", width: "3.5", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2.5", y: "9", width: "4", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "footer":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "7", width: "18", height: "8", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "9.5", width: "4", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "9", y: "9.5", width: "4", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "15", y: "9.5", width: "3", height: "1", rx: ".5", fill: s, opacity: ".2" })
      ] });
    case "modal":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "2", width: "14", height: "12", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "4.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "7", width: "10", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "11", y: "11", width: "5", height: "2", rx: ".75", stroke: s, strokeWidth: sw })
      ] });
    case "divider":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "2", y1: "8", x2: "18", y2: "8", stroke: s, strokeWidth: "0.5", opacity: ".3" }) });
    case "card":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "1", width: "16", height: "14", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "1", width: "16", height: "5.5", rx: "1", fill: s, opacity: ".04" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "8.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "11", width: "11", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "text":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "4", width: "14", height: "1.5", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "7", width: "11", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "9.5", width: "13", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "12", width: "8", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "image":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "2", width: "16", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "2", y1: "2", x2: "18", y2: "14", stroke: s, strokeWidth: ".3", opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "18", y1: "2", x2: "2", y2: "14", stroke: s, strokeWidth: ".3", opacity: ".25" })
      ] });
    case "video":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "2", width: "16", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M8.5 5.5v5l4.5-2.5z", stroke: s, strokeWidth: sw, fill: s, opacity: ".15" })
      ] });
    case "table":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "2", width: "18", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "1", y1: "5.5", x2: "19", y2: "5.5", stroke: s, strokeWidth: ".3", opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "1", y1: "9", x2: "19", y2: "9", stroke: s, strokeWidth: ".3", opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "7", y1: "2", x2: "7", y2: "14", stroke: s, strokeWidth: ".3", opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "13", y1: "2", x2: "13", y2: "14", stroke: s, strokeWidth: ".3", opacity: ".25" })
      ] });
    case "grid":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1.5", y: "2", width: "7", height: "5.5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "11.5", y: "2", width: "7", height: "5.5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1.5", y: "9.5", width: "7", height: "5.5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "11.5", y: "9.5", width: "7", height: "5.5", rx: "1", stroke: s, strokeWidth: sw })
      ] });
    case "list":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "3.5", cy: "4.5", r: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6.5", y: "4", width: "10", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "3.5", cy: "8", r: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6.5", y: "7.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "3.5", cy: "11.5", r: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6.5", y: "11", width: "11", height: "1", rx: ".5", fill: s, opacity: ".2" })
      ] });
    case "chart":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "9", width: "2.5", height: "4", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "6", width: "2.5", height: "7", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "11", y: "3", width: "2.5", height: "10", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "15", y: "5", width: "2.5", height: "8", rx: ".5", fill: s, opacity: ".2" })
      ] });
    case "accordion":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1.5", y: "2", width: "17", height: "4", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "3.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1.5", y: "7.5", width: "17", height: "3", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1.5", y: "12", width: "17", height: "3", rx: "1", stroke: s, strokeWidth: sw })
      ] });
    case "carousel":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "2", width: "14", height: "10", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M1.5 7L3 8.5 1.5 10", stroke: s, strokeWidth: sw, opacity: ".35" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M18.5 7L17 8.5 18.5 10", stroke: s, strokeWidth: sw, opacity: ".35" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "8.5", cy: "14", r: ".6", fill: s, opacity: ".35" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "14", r: ".6", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "11.5", cy: "14", r: ".6", fill: s, opacity: ".15" })
      ] });
    case "button":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "5", width: "14", height: "6", rx: "2", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6.5", y: "7.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".25" })
      ] });
    case "input":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "4", width: "5.5", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "6.5", width: "16", height: "5.5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3.5", y: "8.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "search":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "4.5", width: "16", height: "7", rx: "3.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "6", cy: "8", r: "2", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "7.5", y1: "9.5", x2: "9", y2: "11", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "9.5", y: "7.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "form":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "1.5", width: "5.5", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "3.5", width: "16", height: "3", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "8", width: "7", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "10", width: "16", height: "3", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "12", y: "14", width: "6", height: "2", rx: ".75", stroke: s, strokeWidth: sw })
      ] });
    case "tabs":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "5", width: "18", height: "10", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "2", width: "6", height: "3.5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2.5", y: "3.25", width: "3", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "2", width: "6", height: "3.5", rx: ".75", stroke: s, strokeWidth: sw })
      ] });
    case "dropdown":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "2", width: "16", height: "4", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3.5", y: "3.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M15 3.5l1.5 1.5L18 3.5", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "7", width: "16", height: "7", rx: "1", stroke: s, strokeWidth: sw, strokeDasharray: "2 1", opacity: ".3" })
      ] });
    case "toggle":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "5", width: "12", height: "6", rx: "3", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "13", cy: "8", r: "2", fill: s, opacity: ".3" })
      ] });
    case "avatar":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "8", r: "6", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "6.5", r: "2", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M6.5 13c0-2 1.5-3.5 3.5-3.5s3.5 1.5 3.5 3.5", stroke: s, strokeWidth: sw })
      ] });
    case "badge":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "5", width: "14", height: "6", rx: "3", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6", y: "7.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".25" })
      ] });
    case "breadcrumb":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1.5", y: "7", width: "3.5", height: "1", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M6.5 7l1 1-1 1", stroke: s, strokeWidth: sw, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "9", y: "7", width: "3.5", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M14 7l1 1-1 1", stroke: s, strokeWidth: sw, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "16.5", y: "7", width: "2", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "pagination":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "5.5", width: "3.5", height: "5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6.5", y: "5.5", width: "3.5", height: "5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "11", y: "5.5", width: "3.5", height: "5", rx: "1", fill: s, opacity: ".15", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "15.5", y: "5.5", width: "3.5", height: "5", rx: "1", stroke: s, strokeWidth: sw })
      ] });
    case "progress":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "7", width: "16", height: "2", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "7", width: "10", height: "2", rx: "1", fill: s, opacity: ".2" })
      ] });
    case "toast":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "4", width: "16", height: "8", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "5", cy: "8", r: "1.5", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "8", y: "6.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "8", y: "9", width: "5", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "tooltip":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "3", width: "14", height: "7", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5.5", y: "5.5", width: "9", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M9 10l1 2.5 1-2.5", stroke: s, strokeWidth: sw })
      ] });
    case "pricing":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "1", width: "16", height: "14", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6", y: "3", width: "8", height: "1.5", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "5.5", width: "6", height: "2", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "9", width: "10", height: "1", rx: ".5", fill: s, opacity: ".1" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "11", width: "10", height: "1", rx: ".5", fill: s, opacity: ".1" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6", y: "13", width: "8", height: "1.5", rx: ".5", fill: s, opacity: ".2" })
      ] });
    case "testimonial":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "1", width: "16", height: "14", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("text", { x: "4", y: "5.5", fontSize: "4", fill: s, opacity: ".2", fontFamily: "serif", children: "\u201C" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "7", width: "12", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "9", width: "9", height: "1", rx: ".5", fill: s, opacity: ".12" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "5.5", cy: "12.5", r: "1.5", stroke: s, strokeWidth: sw, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "8", y: "12", width: "5", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "cta":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "2", width: "18", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "4.5", width: "10", height: "1.5", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6", y: "7.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "10", width: "6", height: "2.5", rx: "1", stroke: s, strokeWidth: sw })
      ] });
    case "alert":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "4", width: "16", height: "8", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "6", cy: "8", r: "2", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "6", y1: "7", x2: "6", y2: "8.5", stroke: s, strokeWidth: "0.6", opacity: ".5" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "6", cy: "9.3", r: ".3", fill: s, opacity: ".5" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "9.5", y: "7", width: "6", height: "1", rx: ".5", fill: s, opacity: ".2" })
      ] });
    case "banner":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "5", width: "18", height: "6", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "7.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "14", y: "7", width: "3.5", height: "2", rx: ".75", stroke: s, strokeWidth: sw })
      ] });
    case "stat":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "2", width: "14", height: "12", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6", y: "4.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "7", width: "10", height: "2.5", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "11", width: "6", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "stepper":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "4", cy: "8", r: "2", fill: s, opacity: ".2", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "6", y1: "8", x2: "8", y2: "8", stroke: s, strokeWidth: ".4", opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "8", r: "2", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "12", y1: "8", x2: "14", y2: "8", stroke: s, strokeWidth: ".4", opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "16", cy: "8", r: "2", stroke: s, strokeWidth: sw })
      ] });
    case "tag":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "5", width: "14", height: "6", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5.5", y: "7.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "14", y1: "6.5", x2: "15.5", y2: "9.5", stroke: s, strokeWidth: sw, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "15.5", y1: "6.5", x2: "14", y2: "9.5", stroke: s, strokeWidth: sw, opacity: ".2" })
      ] });
    case "rating":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M4 5.5l1 2 2.2.3-1.6 1.5.4 2.2L4 10.3l-2 1.2.4-2.2L.8 7.8 3 7.5z", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M10 5.5l1 2 2.2.3-1.6 1.5.4 2.2L10 10.3l-2 1.2.4-2.2L6.8 7.8 9 7.5z", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M16 5.5l1 2 2.2.3-1.6 1.5.4 2.2L16 10.3l-2 1.2.4-2.2-1.6-1.5 2.2-.3z", stroke: s, strokeWidth: sw, opacity: ".25" })
      ] });
    case "map":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "2", width: "16", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "2", y1: "6", x2: "18", y2: "10", stroke: s, strokeWidth: ".3", opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "7", y1: "2", x2: "11", y2: "14", stroke: s, strokeWidth: ".3", opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M10 5c-1.7 0-3 1.3-3 3 0 2.5 3 5 3 5s3-2.5 3-5c0-1.7-1.3-3-3-3z", fill: s, opacity: ".15", stroke: s, strokeWidth: sw })
      ] });
    case "timeline":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "5", y1: "2", x2: "5", y2: "14", stroke: s, strokeWidth: ".4", opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "5", cy: "4", r: "1.5", fill: s, opacity: ".2", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "8", y: "3", width: "8", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "5", cy: "8.5", r: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "8", y: "7.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "5", cy: "13", r: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "8", y: "12", width: "7", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "fileUpload":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "2", width: "14", height: "12", rx: "1.5", stroke: s, strokeWidth: sw, strokeDasharray: "2 1" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M10 10V5.5m0 0L7.5 8m2.5-2.5L12.5 8", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "11.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "codeBlock":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "2", width: "16", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "4", cy: "4", r: ".6", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "5.5", cy: "4", r: ".6", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "7", cy: "4", r: ".6", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "7", width: "7", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6", y: "9", width: "5", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "11", width: "8", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "calendar":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "3", width: "16", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "2", y1: "6.5", x2: "18", y2: "6.5", stroke: s, strokeWidth: ".4", opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "4", width: "1", height: "1.5", rx: ".3", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "14", y: "4", width: "1", height: "1.5", rx: ".3", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "7", cy: "9", r: ".6", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "9", r: ".6", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "13", cy: "9", r: ".6", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "7", cy: "12", r: ".6", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "12", r: ".6", fill: s, opacity: ".2" })
      ] });
    case "notification":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "3", width: "16", height: "10", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "5.5", cy: "8", r: "2", stroke: s, strokeWidth: sw, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "9", y: "6", width: "6", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "9", y: "8.5", width: "4.5", height: "1", rx: ".5", fill: s, opacity: ".12" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "16.5", cy: "4.5", r: "1.5", fill: s, opacity: ".25" })
      ] });
    case "productCard":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "1", width: "14", height: "14", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "1", width: "14", height: "6", rx: "1", fill: s, opacity: ".04" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "8.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "10.5", width: "4", height: "1.5", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "12", y: "12", width: "4", height: "2", rx: ".75", stroke: s, strokeWidth: sw })
      ] });
    case "profile":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "5", r: "3", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "10", width: "10", height: "1.5", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "12.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "drawer":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "9", y: "1", width: "10", height: "14", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "10.5", y: "4", width: "5", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "10.5", y: "6.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "10.5", y: "9", width: "6", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "1", width: "7", height: "14", rx: "1", stroke: s, strokeWidth: sw, opacity: ".15" })
      ] });
    case "popover":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "2", width: "14", height: "9", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "4.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "7", width: "6", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M9 11l1 2.5 1-2.5", stroke: s, strokeWidth: sw })
      ] });
    case "logo":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "3", width: "10", height: "10", rx: "2", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M5 9.5l2-4 2 4", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "14", y: "6", width: "4", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "14", y: "8.5", width: "3", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "faq":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("text", { x: "2.5", y: "5.5", fontSize: "4", fill: s, opacity: ".3", fontWeight: "bold", children: "?" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "3", width: "10", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "5.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".12" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("text", { x: "2.5", y: "11.5", fontSize: "4", fill: s, opacity: ".3", fontWeight: "bold", children: "?" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "9", width: "9", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7", y: "11.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "gallery":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1.5", y: "1.5", width: "5", height: "5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7.5", y: "1.5", width: "5", height: "5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "13.5", y: "1.5", width: "5", height: "5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1.5", y: "9.5", width: "5", height: "5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7.5", y: "9.5", width: "5", height: "5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "13.5", y: "9.5", width: "5", height: "5", rx: ".75", stroke: s, strokeWidth: sw })
      ] });
    case "checkbox":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "4", width: "8", height: "8", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M7.5 8l1.5 1.5 3-3", stroke: s, strokeWidth: sw, opacity: ".35" })
      ] });
    case "radio":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "8", r: "4", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "8", r: "2", fill: s, opacity: ".3" })
      ] });
    case "slider":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "7.5", width: "16", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "7.5", width: "10", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "12", cy: "8", r: "2.5", stroke: s, strokeWidth: sw })
      ] });
    case "datePicker":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "1", width: "16", height: "5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3.5", y: "3", width: "5", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "14", y: "2.5", width: "2.5", height: "2", rx: ".5", fill: s, opacity: ".12" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "7", width: "16", height: "8", rx: "1", stroke: s, strokeWidth: sw, strokeDasharray: "2 1", opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "6", cy: "10", r: ".6", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "10", r: ".6", fill: s, opacity: ".3" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "14", cy: "10", r: ".6", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "6", cy: "13", r: ".6", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "13", r: ".6", fill: s, opacity: ".2" })
      ] });
    case "skeleton":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "2", width: "16", height: "3", rx: "1", fill: s, opacity: ".08" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "7", width: "10", height: "2", rx: ".75", fill: s, opacity: ".08" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "11", width: "13", height: "2", rx: ".75", fill: s, opacity: ".08" })
      ] });
    case "chip":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1.5", y: "5", width: "10", height: "6", rx: "3", fill: s, opacity: ".08", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "7.5", width: "4", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "9.5", y1: "6.5", x2: "10.5", y2: "9.5", stroke: s, strokeWidth: sw, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("line", { x1: "10.5", y1: "6.5", x2: "9.5", y2: "9.5", stroke: s, strokeWidth: sw, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "13", y: "5", width: "5.5", height: "6", rx: "3", stroke: s, strokeWidth: sw, opacity: ".25" })
      ] });
    case "icon":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M10 3l1.5 3 3.5.5-2.5 2.5.5 3.5L10 11l-3 1.5.5-3.5L5 6.5l3.5-.5z", stroke: s, strokeWidth: sw, opacity: ".3" }) });
    case "spinner":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "8", r: "5", stroke: s, strokeWidth: sw, opacity: ".12" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M10 3a5 5 0 0 1 5 5", stroke: s, strokeWidth: sw, opacity: ".35", strokeLinecap: "round" })
      ] });
    case "feature":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "2", width: "5", height: "5", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("path", { d: "M4.5 3.5v3m-1.5-1.5h3", stroke: s, strokeWidth: sw, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "9", y: "2.5", width: "8", height: "1.5", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "9", y: "5.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".12" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "10", width: "5", height: "5", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "9", y: "10.5", width: "7", height: "1.5", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "9", y: "13.5", width: "5", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "team":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "5", cy: "5", r: "2.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2.5", y: "9", width: "5", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "15", cy: "5", r: "2.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "12.5", y: "9", width: "5", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "10", cy: "5", r: "2.5", stroke: s, strokeWidth: sw, opacity: ".5" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "7.5", y: "9", width: "5", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "12", width: "12", height: "1", rx: ".5", fill: s, opacity: ".1" })
      ] });
    case "login":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "3", y: "1", width: "14", height: "14", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6", y: "3", width: "8", height: "1.5", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "5.5", width: "10", height: "3", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "5", y: "9.5", width: "10", height: "3", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "6.5", y: "13.5", width: "7", height: "2", rx: ".75", fill: s, opacity: ".2" })
      ] });
    case "contact":
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "2", y: "1", width: "16", height: "14", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "3", width: "5", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "5", width: "12", height: "2.5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "4", y: "8.5", width: "12", height: "4", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "11", y: "13.5", width: "5", height: "1.5", rx: ".5", fill: s, opacity: ".2" })
      ] });
    default:
      return null;
  }
}
function ComponentGrid({ activeType, onSelect, onDragStart, scrollRef, fadeClass, blankCanvas }) {
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { ref: scrollRef, className: `${styles_module_default4.placeScroll} ${fadeClass || ""}`, children: COMPONENT_REGISTRY.map((section) => /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("div", { className: styles_module_default4.paletteSection, children: [
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { className: styles_module_default4.paletteSectionTitle, children: section.section }),
    section.items.map((item) => /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(
      "button",
      {
        type: "button",
        "aria-pressed": activeType === item.type,
        className: `${styles_module_default4.paletteItem} ${activeType === item.type ? styles_module_default4.active : ""} ${blankCanvas ? styles_module_default4.wireframe : ""}`,
        onClick: () => onSelect(item.type),
        onMouseDown: (e) => {
          if (e.button === 0) onDragStart(item.type, e);
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("span", { className: styles_module_default4.paletteItemIcon, "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(PaletteIconSvg, { type: item.type }) }),
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("span", { className: styles_module_default4.paletteItemLabel, children: item.label })
        ]
      },
      item.type
    ))
  ] }, section.section)) });
}
function RollingCount({ value, suffix }) {
  const [prev, setPrev] = (0, import_react12.useState)(null);
  const [prevSuffix, setPrevSuffix] = (0, import_react12.useState)(suffix);
  const [dir, setDir] = (0, import_react12.useState)("up");
  const cur = (0, import_react12.useRef)(value);
  const curSuffix = (0, import_react12.useRef)(suffix);
  const timer = (0, import_react12.useRef)();
  const suffixChanged = prev !== null && prevSuffix !== suffix;
  (0, import_react12.useEffect)(() => {
    if (value !== cur.current) {
      if (value === 0) {
        cur.current = value;
        curSuffix.current = suffix;
        setPrev(null);
        return;
      }
      setDir(value > cur.current ? "up" : "down");
      setPrev(cur.current);
      setPrevSuffix(curSuffix.current);
      cur.current = value;
      curSuffix.current = suffix;
      clearTimeout(timer.current);
      timer.current = originalSetTimeout(() => setPrev(null), 250);
    } else {
      curSuffix.current = suffix;
    }
  }, [value, suffix]);
  if (prev === null) return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(import_jsx_runtime10.Fragment, { children: [
    value,
    suffix ? ` ${suffix}` : ""
  ] });
  if (suffixChanged) {
    return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("span", { className: styles_module_default4.rollingWrap, children: [
      /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("span", { style: { visibility: "hidden" }, children: [
        value,
        " ",
        suffix
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("span", { className: `${styles_module_default4.rollingNum} ${dir === "up" ? styles_module_default4.exitUp : styles_module_default4.exitDown}`, children: [
        prev,
        " ",
        prevSuffix
      ] }, `o${prev}-${value}`),
      /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("span", { className: `${styles_module_default4.rollingNum} ${dir === "up" ? styles_module_default4.enterUp : styles_module_default4.enterDown}`, children: [
        value,
        " ",
        suffix
      ] }, `n${value}`)
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(import_jsx_runtime10.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("span", { className: styles_module_default4.rollingWrap, children: [
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("span", { style: { visibility: "hidden" }, children: value }),
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("span", { className: `${styles_module_default4.rollingNum} ${dir === "up" ? styles_module_default4.exitUp : styles_module_default4.exitDown}`, children: prev }, `o${prev}-${value}`),
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("span", { className: `${styles_module_default4.rollingNum} ${dir === "up" ? styles_module_default4.enterUp : styles_module_default4.enterDown}`, children: value }, `n${value}`)
    ] }),
    suffix ? ` ${suffix}` : ""
  ] });
}
function DesignPalette({
  activeType,
  onSelect,
  isDarkMode,
  sectionCount,
  onDetectSections,
  visible,
  onExited,
  placementCount,
  onClearPlacements,
  onDragStart,
  blankCanvas,
  onBlankCanvasChange,
  wireframePurpose,
  onWireframePurposeChange,
  Tooltip: Tooltip2
}) {
  const { ref: panelRef, mounted } = usePanelPresence(visible, { onExited });
  const [footerVisible, setFooterVisible] = (0, import_react12.useState)(false);
  const [footerCollapsed, setFooterCollapsed] = (0, import_react12.useState)(true);
  const lastFooterCount = (0, import_react12.useRef)(0);
  const lastFooterSuffix = (0, import_react12.useRef)("");
  const placeScrollRef = (0, import_react12.useRef)(null);
  const [placeFade, setPlaceFade] = (0, import_react12.useState)("");
  const hasFooterContent = placementCount > 0 || sectionCount > 0;
  const totalCount = placementCount + sectionCount;
  if (totalCount > 0) {
    lastFooterCount.current = totalCount;
    lastFooterSuffix.current = blankCanvas ? totalCount === 1 ? "Component" : "Components" : totalCount === 1 ? "Change" : "Changes";
  }
  (0, import_react12.useEffect)(() => {
    if (hasFooterContent) {
      if (!footerVisible) {
        setFooterCollapsed(true);
        setFooterVisible(true);
        originalRequestAnimationFrame(() => {
          originalRequestAnimationFrame(() => {
            setFooterCollapsed(false);
          });
        });
      } else {
        setFooterCollapsed(false);
      }
    } else {
      setFooterCollapsed(true);
      const t = originalSetTimeout(() => setFooterVisible(false), 300);
      return () => clearTimeout(t);
    }
  }, [hasFooterContent]);
  (0, import_react12.useEffect)(() => {
    if (!visible) return;
    const el = placeScrollRef.current;
    if (!el) return;
    const update = () => setPlaceFade(scrollFadeClass(el));
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [visible]);
  if (!mounted) return null;
  const footerParts = [];
  if (placementCount > 0) footerParts.push("placed");
  if (sectionCount > 0) footerParts.push("captured");
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(
    "div",
    {
      className: `${styles_module_default4.palette} ${!isDarkMode ? styles_module_default4.light : ""}`,
      ref: (node) => {
        panelRef.current = node;
        node?.toggleAttribute("inert", !visible);
      },
      "aria-hidden": !visible,
      "data-feedback-toolbar": true,
      "data-agentation-palette": true,
      onClick: (e) => e.stopPropagation(),
      onMouseDown: (e) => e.stopPropagation(),
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("div", { className: styles_module_default4.paletteHeader, children: [
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { className: styles_module_default4.paletteHeaderTitle, children: "Layout Mode" }),
          /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("div", { className: styles_module_default4.paletteHeaderDesc, children: [
            "Rearrange and resize existing elements, add new components, and explore layout ideas. Agent results may vary.",
            " ",
            /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("a", { href: "https://agentation.com/features#layout-mode", target: "_blank", rel: "noopener noreferrer", children: "Learn more." })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(
          "button",
          {
            type: "button",
            "aria-pressed": blankCanvas,
            className: `${styles_module_default4.canvasToggle} ${blankCanvas ? styles_module_default4.active : ""}`,
            onClick: () => onBlankCanvasChange(!blankCanvas),
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("span", { className: styles_module_default4.canvasToggleIcon, "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("svg", { viewBox: "0 0 14 14", width: "14", height: "14", fill: "none", children: [
                /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("rect", { x: "1", y: "1", width: "12", height: "12", rx: "2", stroke: "currentColor", strokeWidth: "1" }),
                /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "4.5", cy: "4.5", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "7", cy: "4.5", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "9.5", cy: "4.5", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "4.5", cy: "7", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "7", cy: "7", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "9.5", cy: "7", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "4.5", cy: "9.5", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "7", cy: "9.5", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("circle", { cx: "9.5", cy: "9.5", r: "0.8", fill: "currentColor", opacity: ".6" })
              ] }) }),
              /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("span", { className: styles_module_default4.canvasToggleLabel, children: "Wireframe New Page" })
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { className: `${styles_module_default4.wireframePurposeWrap} ${!blankCanvas ? styles_module_default4.collapsed : ""}`, "aria-hidden": !blankCanvas, ref: (node) => {
          node?.toggleAttribute("inert", !blankCanvas);
        }, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { className: styles_module_default4.wireframePurposeInner, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
          "textarea",
          {
            className: styles_module_default4.wireframePurposeInput,
            placeholder: "Describe this page to provide additional context for your agent.",
            value: wireframePurpose,
            onChange: (e) => onWireframePurposeChange(e.target.value),
            rows: 2
          }
        ) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
          ComponentGrid,
          {
            activeType,
            onSelect,
            onDragStart,
            scrollRef: placeScrollRef,
            fadeClass: placeFade,
            blankCanvas
          }
        ),
        footerVisible && /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { className: `${styles_module_default4.paletteFooterWrap} ${footerCollapsed ? styles_module_default4.footerHidden : ""}`, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { className: styles_module_default4.paletteFooterInner, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("div", { className: styles_module_default4.paletteFooterInnerContent, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)("div", { className: styles_module_default4.paletteFooter, children: [
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("span", { className: styles_module_default4.paletteFooterCount, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(RollingCount, { value: lastFooterCount.current, suffix: lastFooterSuffix.current }) }),
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)("button", { className: styles_module_default4.paletteFooterClear, onClick: onClearPlacements, children: "Clear" })
        ] }) }) }) })
      ]
    }
  );
}

// src/components/design-mode/rearrange.tsx
var import_react13 = require("react");

// src/components/design-mode/section-detection.ts
var SECTION_TAGS = /* @__PURE__ */ new Set([
  "nav",
  "header",
  "main",
  "section",
  "article",
  "footer",
  "aside"
]);
var SECTION_ROLES = {
  banner: "Header",
  navigation: "Navigation",
  main: "Main Content",
  contentinfo: "Footer",
  complementary: "Sidebar",
  region: "Section"
};
var TAG_LABELS = {
  nav: "Navigation",
  header: "Header",
  main: "Main Content",
  section: "Section",
  article: "Article",
  footer: "Footer",
  aside: "Sidebar"
};
var SKIP_TAGS = /* @__PURE__ */ new Set(["script", "style", "noscript", "link", "meta"]);
var MIN_SECTION_HEIGHT = 40;
function isEffectivelyFixed(el) {
  let current = el;
  while (current && current !== document.body && current !== document.documentElement) {
    const pos = window.getComputedStyle(current).position;
    if (pos === "fixed" || pos === "sticky") return true;
    current = current.parentElement;
  }
  return false;
}
function generateSelector(el) {
  const tag = el.tagName.toLowerCase();
  if (["nav", "header", "footer", "main"].includes(tag)) {
    if (document.querySelectorAll(tag).length === 1) {
      return tag;
    }
  }
  if (el.id) {
    return `#${CSS.escape(el.id)}`;
  }
  if (el.className && typeof el.className === "string") {
    const classes = el.className.split(/\s+/).filter((c) => c.length > 0);
    const meaningful = classes.find(
      (c) => c.length > 2 && !/^[a-zA-Z0-9]{6,}$/.test(c) && !/^[a-z]{1,2}$/.test(c)
    );
    if (meaningful) {
      const selector = `${tag}.${CSS.escape(meaningful)}`;
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    }
  }
  const parent = el.parentElement;
  if (parent) {
    const children = Array.from(parent.children);
    const index = children.indexOf(el) + 1;
    const parentSelector = parent === document.body ? "body" : generateSelector(parent);
    return `${parentSelector} > ${tag}:nth-child(${index})`;
  }
  return tag;
}
function labelSection(el) {
  const tag = el.tagName.toLowerCase();
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;
  const role = el.getAttribute("role");
  if (role && SECTION_ROLES[role]) return SECTION_ROLES[role];
  if (TAG_LABELS[tag]) return TAG_LABELS[tag];
  const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
  if (heading) {
    const text = heading.textContent?.trim();
    if (text && text.length <= 50) return text;
    if (text) return text.slice(0, 47) + "...";
  }
  const { name } = identifyElement(el);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
function getCleanClassName(el) {
  const className = el.className;
  if (typeof className !== "string" || !className) return null;
  const meaningful = className.split(/\s+/).map((c) => c.replace(/[_][a-zA-Z0-9]{5,}.*$/, "")).find((c) => c.length > 2 && !/^[a-z]{1,2}$/.test(c));
  return meaningful || null;
}
function getTextSnippet(el) {
  const text = el.textContent?.trim();
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ");
  if (clean.length <= 30) return clean;
  return clean.slice(0, 30) + "\u2026";
}
function detectPageSections() {
  const main = document.querySelector("main") || document.body;
  const candidates = Array.from(main.children);
  let allCandidates = candidates;
  if (main !== document.body && candidates.length < 3) {
    allCandidates = Array.from(document.body.children);
  }
  const sections = [];
  allCandidates.forEach((el, index) => {
    if (!(el instanceof HTMLElement)) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (el.hasAttribute("data-feedback-toolbar")) return;
    if (el.closest("[data-feedback-toolbar]")) return;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return;
    const rect = el.getBoundingClientRect();
    if (rect.height < MIN_SECTION_HEIGHT) return;
    const isSemantic = SECTION_TAGS.has(tag);
    const hasRole = el.getAttribute("role") && SECTION_ROLES[el.getAttribute("role")];
    const isSignificantDiv = tag === "div" && rect.height >= 60;
    if (!isSemantic && !hasRole && !isSignificantDiv) return;
    const scrollY = window.scrollY;
    const isFixed = isEffectivelyFixed(el);
    const sectionRect = {
      x: rect.x,
      y: isFixed ? rect.y : rect.y + scrollY,
      width: rect.width,
      height: rect.height
    };
    sections.push({
      id: `rs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      label: labelSection(el),
      tagName: tag,
      selector: generateSelector(el),
      role: el.getAttribute("role"),
      className: getCleanClassName(el),
      textSnippet: getTextSnippet(el),
      originalRect: sectionRect,
      currentRect: { ...sectionRect },
      originalIndex: index,
      isFixed
    });
  });
  return sections;
}
function captureElement(el) {
  const scrollY = window.scrollY;
  const rect = el.getBoundingClientRect();
  const isFixed = isEffectivelyFixed(el);
  const sectionRect = {
    x: rect.x,
    y: isFixed ? rect.y : rect.y + scrollY,
    width: rect.width,
    height: rect.height
  };
  const parent = el.parentElement;
  let originalIndex = 0;
  if (parent) {
    originalIndex = Array.from(parent.children).indexOf(el);
  }
  return {
    id: `rs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    label: labelSection(el),
    tagName: el.tagName.toLowerCase(),
    selector: generateSelector(el),
    role: el.getAttribute("role"),
    className: getCleanClassName(el),
    textSnippet: getTextSnippet(el),
    originalRect: sectionRect,
    currentRect: { ...sectionRect },
    originalIndex,
    isFixed
  };
}

// src/components/design-mode/rearrange.tsx
var import_jsx_runtime11 = require("react/jsx-runtime");
var SECTION_COLOR = { bg: "rgba(59, 130, 246, 0.08)", border: "rgba(59, 130, 246, 0.5)", pill: "#3b82f6" };
var HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
var MIN_SIZE2 = 24;
var MIN_CAPTURE_SIZE = 16;
var SNAP_THRESHOLD2 = 5;
function computeSectionSnap(rect, sections, excludeIds, extraRects) {
  let bestDx = Infinity;
  let bestDy = Infinity;
  const mL = rect.x, mR = rect.x + rect.width, mCx = rect.x + rect.width / 2;
  const mT = rect.y, mB = rect.y + rect.height, mCy = rect.y + rect.height / 2;
  const allTargets = [];
  for (const s2 of sections) {
    if (!excludeIds.has(s2.id)) allTargets.push(s2.currentRect);
  }
  if (extraRects) allTargets.push(...extraRects);
  for (const o of allTargets) {
    const oL = o.x, oR = o.x + o.width, oCx = o.x + o.width / 2;
    const oT = o.y, oB = o.y + o.height, oCy = o.y + o.height / 2;
    for (const from of [mL, mR, mCx]) {
      for (const to of [oL, oR, oCx]) {
        const d = to - from;
        if (Math.abs(d) < SNAP_THRESHOLD2 && Math.abs(d) < Math.abs(bestDx)) bestDx = d;
      }
    }
    for (const from of [mT, mB, mCy]) {
      for (const to of [oT, oB, oCy]) {
        const d = to - from;
        if (Math.abs(d) < SNAP_THRESHOLD2 && Math.abs(d) < Math.abs(bestDy)) bestDy = d;
      }
    }
  }
  const dx = Math.abs(bestDx) < SNAP_THRESHOLD2 ? bestDx : 0;
  const dy = Math.abs(bestDy) < SNAP_THRESHOLD2 ? bestDy : 0;
  const guides = [];
  const seen = /* @__PURE__ */ new Set();
  const sL = mL + dx, sR = mR + dx, sCx = mCx + dx;
  const sT = mT + dy, sB = mB + dy, sCy = mCy + dy;
  for (const o of allTargets) {
    const oL = o.x, oR = o.x + o.width, oCx = o.x + o.width / 2;
    const oT = o.y, oB = o.y + o.height, oCy = o.y + o.height / 2;
    for (const xPos of [oL, oCx, oR]) {
      for (const sx of [sL, sCx, sR]) {
        if (Math.abs(sx - xPos) < 0.5) {
          const key = `x:${Math.round(xPos)}`;
          if (!seen.has(key)) {
            seen.add(key);
            guides.push({ axis: "x", pos: xPos });
          }
        }
      }
    }
    for (const yPos of [oT, oCy, oB]) {
      for (const sy of [sT, sCy, sB]) {
        if (Math.abs(sy - yPos) < 0.5) {
          const key = `y:${Math.round(yPos)}`;
          if (!seen.has(key)) {
            seen.add(key);
            guides.push({ axis: "y", pos: yPos });
          }
        }
      }
    }
  }
  return { dx, dy, guides };
}
var SKIP_TAGS2 = /* @__PURE__ */ new Set(["script", "style", "noscript", "link", "meta", "br", "hr"]);
function pickTarget(el) {
  let current = el;
  while (current && current !== document.body && current !== document.documentElement) {
    if (current.closest("[data-feedback-toolbar]")) return null;
    if (SKIP_TAGS2.has(current.tagName.toLowerCase())) {
      current = current.parentElement;
      continue;
    }
    const rect = current.getBoundingClientRect();
    if (rect.width >= MIN_CAPTURE_SIZE && rect.height >= MIN_CAPTURE_SIZE) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}
function RearrangeOverlay({ rearrangeState, onChange, isDarkMode, exiting, className: extraClassName, blankCanvas, extraSnapRects, onSelectionChange, deselectSignal, onDragMove, onDragEnd, clearing }) {
  const { sections } = rearrangeState;
  const rearrangeStateRef = (0, import_react13.useRef)(rearrangeState);
  rearrangeStateRef.current = rearrangeState;
  const [selectedIds, setSelectedIds] = (0, import_react13.useState)(/* @__PURE__ */ new Set());
  (0, import_react13.useEffect)(() => {
    if (clearing) setSelectedIds(/* @__PURE__ */ new Set());
  }, [clearing]);
  const deselectRef = (0, import_react13.useRef)(deselectSignal);
  (0, import_react13.useEffect)(() => {
    if (deselectSignal !== deselectRef.current) {
      deselectRef.current = deselectSignal;
      setSelectedIds(/* @__PURE__ */ new Set());
    }
  }, [deselectSignal]);
  const [editingId, setEditingId] = (0, import_react13.useState)(null);
  const [editExiting, setEditExiting] = (0, import_react13.useState)(false);
  const editHadNoteRef = (0, import_react13.useRef)(false);
  const handleDoubleClick = (0, import_react13.useCallback)((id) => {
    const s2 = sections.find((sec) => sec.id === id);
    if (!s2) return;
    editHadNoteRef.current = !!s2.note;
    setEditingId(id);
    setEditExiting(false);
  }, [sections]);
  const dismissEdit = (0, import_react13.useCallback)(() => {
    if (!editingId) return;
    setEditExiting(true);
    originalSetTimeout(() => {
      setEditingId(null);
      setEditExiting(false);
    }, 150);
  }, [editingId]);
  const submitEdit = (0, import_react13.useCallback)((text) => {
    if (!editingId) return;
    onChange({
      ...rearrangeState,
      sections: sections.map((s2) => s2.id === editingId ? { ...s2, note: text.trim() || void 0 } : s2)
    });
    dismissEdit();
  }, [editingId, sections, rearrangeState, onChange, dismissEdit]);
  (0, import_react13.useEffect)(() => {
    if (exiting && editingId) dismissEdit();
  }, [exiting]);
  const [exitingIds, setExitingIds] = (0, import_react13.useState)(/* @__PURE__ */ new Set());
  const lastNoteTextRef = (0, import_react13.useRef)(/* @__PURE__ */ new Map());
  const [hoverHighlight, setHoverHighlight] = (0, import_react13.useState)(null);
  const [sizeIndicator, setSizeIndicator] = (0, import_react13.useState)(null);
  const [snapGuides, setSnapGuides] = (0, import_react13.useState)([]);
  const [scrollY, setScrollY] = (0, import_react13.useState)(0);
  const interactionRef = (0, import_react13.useRef)(null);
  const seenGhostIdsRef = (0, import_react13.useRef)(/* @__PURE__ */ new Set());
  const firstActionRef = (0, import_react13.useRef)(/* @__PURE__ */ new Map());
  const [dragPositions, setDragPositions] = (0, import_react13.useState)(/* @__PURE__ */ new Map());
  const [exitingConnectors, setExitingConnectors] = (0, import_react13.useState)(/* @__PURE__ */ new Map());
  const prevChangedIdsRef = (0, import_react13.useRef)(/* @__PURE__ */ new Set());
  const lastChangedRectsRef = (0, import_react13.useRef)(/* @__PURE__ */ new Map());
  const onSelectionChangeRef = (0, import_react13.useRef)(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const onDragMoveRef = (0, import_react13.useRef)(onDragMove);
  onDragMoveRef.current = onDragMove;
  const onDragEndRef = (0, import_react13.useRef)(onDragEnd);
  onDragEndRef.current = onDragEnd;
  (0, import_react13.useEffect)(() => {
    if (blankCanvas) setSelectedIds(/* @__PURE__ */ new Set());
  }, [blankCanvas]);
  const [outlinesReady, setOutlinesReady] = (0, import_react13.useState)(
    () => !rearrangeState.sections.some((s2) => {
      const o = s2.originalRect, c = s2.currentRect;
      return Math.abs(o.x - c.x) > 1 || Math.abs(o.y - c.y) > 1 || Math.abs(o.width - c.width) > 1 || Math.abs(o.height - c.height) > 1;
    })
  );
  (0, import_react13.useEffect)(() => {
    if (!outlinesReady) {
      const timer = originalSetTimeout(() => setOutlinesReady(true), 380);
      return () => clearTimeout(timer);
    }
  }, []);
  const capturedSelectors = (0, import_react13.useRef)(/* @__PURE__ */ new Set());
  (0, import_react13.useEffect)(() => {
    capturedSelectors.current = new Set(sections.map((s2) => s2.selector));
  }, [sections]);
  (0, import_react13.useEffect)(() => {
    const onScroll = () => setScrollY(window.scrollY);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  (0, import_react13.useEffect)(() => {
    const handleMouseMove = (e) => {
      if (interactionRef.current) {
        setHoverHighlight(null);
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) {
        setHoverHighlight(null);
        return;
      }
      if (el.closest("[data-feedback-toolbar]")) {
        setHoverHighlight(null);
        return;
      }
      if (el.closest("[data-design-placement]")) {
        setHoverHighlight(null);
        return;
      }
      if (el.closest("[data-annotation-popup]")) {
        setHoverHighlight(null);
        return;
      }
      const target = pickTarget(el);
      if (!target) {
        setHoverHighlight(null);
        return;
      }
      for (const sel of capturedSelectors.current) {
        try {
          const captured = document.querySelector(sel);
          if (captured && (captured === target || target.contains(captured))) {
            setHoverHighlight(null);
            return;
          }
        } catch {
        }
      }
      const rect = target.getBoundingClientRect();
      setHoverHighlight({ x: rect.x, y: rect.y, w: rect.width, h: rect.height });
    };
    document.addEventListener("mousemove", handleMouseMove, { passive: true });
    return () => document.removeEventListener("mousemove", handleMouseMove);
  }, [sections]);
  (0, import_react13.useEffect)(() => {
    const prev = document.body.style.userSelect;
    document.body.style.webkitUserSelect = "none";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.webkitUserSelect = prev;
      document.body.style.userSelect = prev;
    };
  }, []);
  (0, import_react13.useEffect)(() => {
    const handleMouseDown = (e) => {
      if (interactionRef.current) return;
      if (e.button !== 0) return;
      const el = e.composedPath()[0] ?? e.target;
      if (!el || el.closest("[data-feedback-toolbar]")) return;
      if (el.closest("[data-design-placement]")) return;
      if (el.closest("[data-annotation-popup]")) return;
      const target = pickTarget(el);
      let alreadyCaptured = false;
      if (target) {
        for (const sel of capturedSelectors.current) {
          try {
            const captured = document.querySelector(sel);
            if (captured && (captured === target || target.contains(captured))) {
              alreadyCaptured = true;
              break;
            }
          } catch {
          }
        }
      }
      const isShift = !!(e.shiftKey || e.metaKey || e.ctrlKey);
      if (target && !alreadyCaptured) {
        e.preventDefault();
        e.stopPropagation();
        const section = captureElement(target);
        const newSections = [...sections, section];
        const newOrder = [...rearrangeState.originalOrder, section.id];
        onChange({
          ...rearrangeState,
          sections: newSections,
          originalOrder: newOrder
        });
        const newIds = /* @__PURE__ */ new Set([section.id]);
        setSelectedIds(newIds);
        onSelectionChangeRef.current?.(newIds, isShift);
        setHoverHighlight(null);
        const startX = e.clientX;
        const startY = e.clientY;
        const startPos = { x: section.currentRect.x, y: section.currentRect.y };
        const origRect = section.originalRect;
        let moved = false;
        let lastDx = 0, lastDy = 0;
        interactionRef.current = "move";
        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) moved = true;
          if (!moved) return;
          const rect = { x: startPos.x + dx, y: startPos.y + dy, width: section.currentRect.width, height: section.currentRect.height };
          const snap = computeSectionSnap(rect, newSections, /* @__PURE__ */ new Set([section.id]), extraSnapRects);
          setSnapGuides(snap.guides);
          const snappedDx = dx + snap.dx;
          const snappedDy = dy + snap.dy;
          lastDx = snappedDx;
          lastDy = snappedDy;
          const outlineEl = getOverlayRoot().querySelector(`[data-rearrange-section="${section.id}"]`);
          if (outlineEl) outlineEl.style.transform = `translate(${snappedDx}px, ${snappedDy}px)`;
          setDragPositions(/* @__PURE__ */ new Map([[section.id, { x: startPos.x + snappedDx, y: startPos.y + snappedDy, width: section.currentRect.width, height: section.currentRect.height }]]));
          onDragMoveRef.current?.(snappedDx, snappedDy);
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          interactionRef.current = null;
          setSnapGuides([]);
          setDragPositions(/* @__PURE__ */ new Map());
          const outlineEl = getOverlayRoot().querySelector(`[data-rearrange-section="${section.id}"]`);
          if (outlineEl) outlineEl.style.transform = "";
          if (moved) {
            onChange({
              ...rearrangeState,
              sections: newSections.map(
                (s2) => s2.id === section.id ? { ...s2, currentRect: { ...s2.currentRect, x: Math.max(0, startPos.x + lastDx), y: Math.max(0, startPos.y + lastDy) } } : s2
              ),
              originalOrder: newOrder
            });
          }
          onDragEndRef.current?.(lastDx, lastDy, moved);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      } else if (alreadyCaptured && target) {
        e.preventDefault();
        for (const s2 of sections) {
          try {
            const captured = document.querySelector(s2.selector);
            if (captured && captured === target) {
              const newIds = /* @__PURE__ */ new Set([s2.id]);
              setSelectedIds(newIds);
              onSelectionChangeRef.current?.(newIds, isShift);
              return;
            }
          } catch {
          }
        }
        if (!isShift) {
          setSelectedIds(/* @__PURE__ */ new Set());
          onSelectionChangeRef.current?.(/* @__PURE__ */ new Set(), false);
        }
      } else {
        if (!isShift) {
          setSelectedIds(/* @__PURE__ */ new Set());
          onSelectionChangeRef.current?.(/* @__PURE__ */ new Set(), false);
        }
      }
    };
    document.addEventListener("mousedown", handleMouseDown, true);
    return () => document.removeEventListener("mousedown", handleMouseDown, true);
  }, [sections, rearrangeState, onChange]);
  (0, import_react13.useEffect)(() => {
    const handleKeyDown = (e) => {
      const t = e.composedPath()[0] || e.target;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if ((e.key === "Backspace" || e.key === "Delete") && selectedIds.size > 0) {
        e.preventDefault();
        const idsToDelete = new Set(selectedIds);
        setExitingIds((prev) => {
          const next = new Set(prev);
          for (const id of idsToDelete) next.add(id);
          return next;
        });
        setSelectedIds(/* @__PURE__ */ new Set());
        originalSetTimeout(() => {
          const rs = rearrangeStateRef.current;
          onChange({
            ...rs,
            sections: rs.sections.filter((s2) => !idsToDelete.has(s2.id)),
            originalOrder: rs.originalOrder.filter((id) => !idsToDelete.has(id))
          });
          setExitingIds((prev) => {
            const next = new Set(prev);
            for (const id of idsToDelete) next.delete(id);
            return next;
          });
        }, 180);
        return;
      }
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && selectedIds.size > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 20 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        onChange({
          ...rearrangeState,
          sections: sections.map(
            (s2) => selectedIds.has(s2.id) ? { ...s2, currentRect: { ...s2.currentRect, x: Math.max(0, s2.currentRect.x + dx), y: Math.max(0, s2.currentRect.y + dy) } } : s2
          )
        });
        return;
      }
      if (e.key === "Escape" && selectedIds.size > 0) {
        setSelectedIds(/* @__PURE__ */ new Set());
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds, sections, rearrangeState, onChange]);
  const handleOutlineMouseDown = (0, import_react13.useCallback)(
    (e, id) => {
      if (e.button !== 0) return;
      const target = e.target;
      if (target.closest(`.${styles_module_default4.handle}`) || target.closest(`.${styles_module_default4.deleteButton}`)) return;
      e.preventDefault();
      e.stopPropagation();
      let newSelected;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        newSelected = new Set(selectedIds);
        if (newSelected.has(id)) newSelected.delete(id);
        else newSelected.add(id);
      } else if (!selectedIds.has(id)) {
        newSelected = /* @__PURE__ */ new Set([id]);
      } else {
        newSelected = new Set(selectedIds);
      }
      setSelectedIds(newSelected);
      const changed = newSelected.size !== selectedIds.size || [...newSelected].some((x) => !selectedIds.has(x));
      if (changed) onSelectionChangeRef.current?.(newSelected, !!(e.shiftKey || e.metaKey || e.ctrlKey));
      const startX = e.clientX;
      const startY = e.clientY;
      const startPositions = /* @__PURE__ */ new Map();
      for (const s2 of sections) {
        if (newSelected.has(s2.id)) {
          startPositions.set(s2.id, { x: s2.currentRect.x, y: s2.currentRect.y });
        }
      }
      interactionRef.current = "move";
      let moved = false;
      let lastDx = 0, lastDy = 0;
      const dragEls = /* @__PURE__ */ new Map();
      for (const s2 of sections) {
        if (newSelected.has(s2.id)) {
          const outlineEl = getOverlayRoot().querySelector(`[data-rearrange-section="${s2.id}"]`);
          dragEls.set(s2.id, {
            outlineEl,
            curW: s2.currentRect.width,
            curH: s2.currentRect.height
          });
        }
      }
      const onMove = (ev) => {
        const rawDx = ev.clientX - startX;
        const rawDy = ev.clientY - startY;
        if (rawDx === 0 && rawDy === 0) return;
        moved = true;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [id2, { curW, curH }] of dragEls) {
          const start = startPositions.get(id2);
          if (!start) continue;
          const cx = start.x + rawDx, cy = start.y + rawDy;
          minX = Math.min(minX, cx);
          minY = Math.min(minY, cy);
          maxX = Math.max(maxX, cx + curW);
          maxY = Math.max(maxY, cy + curH);
        }
        const snap = computeSectionSnap(
          { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
          sections,
          newSelected,
          extraSnapRects
        );
        const dx = rawDx + snap.dx;
        const dy = rawDy + snap.dy;
        lastDx = dx;
        lastDy = dy;
        setSnapGuides(snap.guides);
        for (const [, { outlineEl }] of dragEls) {
          if (outlineEl) {
            outlineEl.style.transform = `translate(${dx}px, ${dy}px)`;
          }
        }
        const livePos = /* @__PURE__ */ new Map();
        for (const [id2, { curW, curH }] of dragEls) {
          const start = startPositions.get(id2);
          if (start) {
            const pos = { x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy), width: curW, height: curH };
            livePos.set(id2, pos);
          }
        }
        setDragPositions(livePos);
        onDragMoveRef.current?.(dx, dy);
      };
      const onUp = (ev) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        interactionRef.current = null;
        setSnapGuides([]);
        setDragPositions(/* @__PURE__ */ new Map());
        for (const [, { outlineEl }] of dragEls) {
          if (outlineEl) outlineEl.style.transform = "";
        }
        if (moved) {
          const totalDx = ev.clientX - startX;
          const totalDy = ev.clientY - startY;
          if (Math.abs(totalDx) < 5 && Math.abs(totalDy) < 5) {
            onChange({
              ...rearrangeState,
              sections: sections.map((s2) => {
                const start = startPositions.get(s2.id);
                if (!start) return s2;
                return { ...s2, currentRect: { ...s2.currentRect, x: start.x, y: start.y } };
              })
            });
          } else {
            onChange({
              ...rearrangeState,
              sections: sections.map((s2) => {
                const start = startPositions.get(s2.id);
                if (!start) return s2;
                return { ...s2, currentRect: { ...s2.currentRect, x: Math.max(0, start.x + lastDx), y: Math.max(0, start.y + lastDy) } };
              })
            });
            onDragEndRef.current?.(lastDx, lastDy, true);
            return;
          }
        }
        onDragEndRef.current?.(0, 0, false);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [selectedIds, sections, rearrangeState, onChange]
  );
  const handleResizeMouseDown = (0, import_react13.useCallback)(
    (e, id, dir) => {
      e.preventDefault();
      e.stopPropagation();
      const section = sections.find((s2) => s2.id === id);
      if (!section) return;
      setSelectedIds(/* @__PURE__ */ new Set([id]));
      interactionRef.current = "resize";
      const startX = e.clientX;
      const startY = e.clientY;
      const startRect = { ...section.currentRect };
      const origRect = section.originalRect;
      const aspectRatio = startRect.width / startRect.height;
      let lastRect = { ...startRect };
      const resizeOutlineEl = getOverlayRoot().querySelector(`[data-rearrange-section="${id}"]`);
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let nx = startRect.x, ny = startRect.y, nw = startRect.width, nh = startRect.height;
        if (dir.includes("e")) nw = Math.max(MIN_SIZE2, startRect.width + dx);
        if (dir.includes("w")) {
          nw = Math.max(MIN_SIZE2, startRect.width - dx);
          nx = startRect.x + startRect.width - nw;
        }
        if (dir.includes("s")) nh = Math.max(MIN_SIZE2, startRect.height + dy);
        if (dir.includes("n")) {
          nh = Math.max(MIN_SIZE2, startRect.height - dy);
          ny = startRect.y + startRect.height - nh;
        }
        if (ev.shiftKey) {
          const isCorner = dir.length === 2;
          if (isCorner) {
            const wDelta = Math.abs(nw - startRect.width);
            const hDelta = Math.abs(nh - startRect.height);
            if (wDelta > hDelta) {
              nh = nw / aspectRatio;
            } else {
              nw = nh * aspectRatio;
            }
            if (dir.includes("w")) nx = startRect.x + startRect.width - nw;
            if (dir.includes("n")) ny = startRect.y + startRect.height - nh;
          } else {
            if (dir === "e" || dir === "w") {
              nh = nw / aspectRatio;
            } else {
              nw = nh * aspectRatio;
            }
            if (dir === "w") nx = startRect.x + startRect.width - nw;
            if (dir === "n") ny = startRect.y + startRect.height - nh;
          }
        }
        lastRect = { x: nx, y: ny, width: nw, height: nh };
        if (resizeOutlineEl) {
          resizeOutlineEl.style.left = `${nx}px`;
          resizeOutlineEl.style.top = `${ny - scrollY}px`;
          resizeOutlineEl.style.width = `${nw}px`;
          resizeOutlineEl.style.height = `${nh}px`;
        }
        setSizeIndicator({ x: ev.clientX + 12, y: ev.clientY + 12, text: `${Math.round(nw)} \xD7 ${Math.round(nh)}` });
        setDragPositions(/* @__PURE__ */ new Map([[id, lastRect]]));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setSizeIndicator(null);
        interactionRef.current = null;
        setDragPositions(/* @__PURE__ */ new Map());
        onChange({
          ...rearrangeState,
          sections: sections.map((s2) => s2.id === id ? { ...s2, currentRect: lastRect } : s2)
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sections, rearrangeState, onChange, scrollY]
  );
  const handleDelete = (0, import_react13.useCallback)(
    (id) => {
      setExitingIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      originalSetTimeout(() => {
        const rs = rearrangeStateRef.current;
        onChange({
          ...rs,
          sections: rs.sections.filter((s2) => s2.id !== id),
          originalOrder: rs.originalOrder.filter((oid) => oid !== id)
        });
        setExitingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 180);
    },
    [onChange]
  );
  const hasChanged = (s2) => {
    const o = s2.originalRect, c = s2.currentRect;
    return Math.abs(o.x - c.x) > 1 || Math.abs(o.y - c.y) > 1 || Math.abs(o.width - c.width) > 1 || Math.abs(o.height - c.height) > 1;
  };
  const isMoved = (s2) => {
    const o = s2.originalRect, c = s2.currentRect;
    return Math.abs(o.x - c.x) > 1 || Math.abs(o.y - c.y) > 1;
  };
  const isResized = (s2) => {
    const o = s2.originalRect, c = s2.currentRect;
    return Math.abs(o.width - c.width) > 1 || Math.abs(o.height - c.height) > 1;
  };
  for (const s2 of sections) {
    if (!firstActionRef.current.has(s2.id)) {
      if (isMoved(s2)) firstActionRef.current.set(s2.id, "move");
      else if (isResized(s2)) firstActionRef.current.set(s2.id, "resize");
    }
  }
  for (const id of firstActionRef.current.keys()) {
    if (!sections.some((s2) => s2.id === id)) firstActionRef.current.delete(id);
  }
  const visibleSections = sections.filter((s2) => {
    try {
      if (exitingIds.has(s2.id)) return true;
      if (selectedIds.has(s2.id)) return true;
      const el = document.querySelector(s2.selector);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const expected = s2.originalRect;
      const sizeDiff = Math.abs(rect.width - expected.width) + Math.abs(rect.height - expected.height);
      return sizeDiff < 200;
    } catch {
      return false;
    }
  });
  const changedSections = visibleSections.filter((s2) => hasChanged(s2));
  const unchangedSections = visibleSections.filter((s2) => !hasChanged(s2));
  const currentChangedIds = new Set(changedSections.map((s2) => s2.id));
  for (const id of seenGhostIdsRef.current) {
    if (!currentChangedIds.has(id)) seenGhostIdsRef.current.delete(id);
  }
  const changedKey = [...currentChangedIds].sort().join(",");
  for (const s2 of changedSections) {
    lastChangedRectsRef.current.set(s2.id, { currentRect: s2.currentRect, originalRect: s2.originalRect, isFixed: s2.isFixed });
  }
  (0, import_react13.useEffect)(() => {
    const prev = prevChangedIdsRef.current;
    prevChangedIdsRef.current = currentChangedIds;
    const exiting2 = /* @__PURE__ */ new Map();
    for (const id of prev) {
      if (!currentChangedIds.has(id)) {
        if (!sections.some((s2) => s2.id === id)) continue;
        const last = lastChangedRectsRef.current.get(id);
        if (last) {
          exiting2.set(id, { orig: last.originalRect, target: last.currentRect, isFixed: last.isFixed });
          lastChangedRectsRef.current.delete(id);
        }
      }
    }
    if (exiting2.size > 0) {
      setExitingConnectors((prev2) => {
        const next = new Map(prev2);
        for (const [id, data] of exiting2) next.set(id, data);
        return next;
      });
      const timer = originalSetTimeout(() => {
        setExitingConnectors((prev2) => {
          const next = new Map(prev2);
          for (const id of exiting2.keys()) next.delete(id);
          return next;
        });
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [changedKey, sections]);
  const overlayRef = (0, import_react13.useRef)(null);
  const getOverlayRoot = () => overlayRef.current?.getRootNode() ?? document;
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(
      "div",
      {
        ref: overlayRef,
        className: `${styles_module_default4.rearrangeOverlay} ${!isDarkMode ? styles_module_default4.light : ""} ${exiting ? styles_module_default4.overlayExiting : ""}${extraClassName ? ` ${extraClassName}` : ""}`,
        "data-feedback-toolbar": true,
        children: [
          hoverHighlight && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
            "div",
            {
              className: styles_module_default4.hoverHighlight,
              style: { left: hoverHighlight.x, top: hoverHighlight.y, width: hoverHighlight.w, height: hoverHighlight.h }
            }
          ),
          unchangedSections.map((section) => {
            const rect = section.currentRect;
            const screenY = section.isFixed ? rect.y : rect.y - scrollY;
            const color = SECTION_COLOR;
            const isSelected = selectedIds.has(section.id);
            return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(
              "div",
              {
                "data-rearrange-section": section.id,
                className: `${styles_module_default4.sectionOutline} ${isSelected ? styles_module_default4.selected : ""} ${clearing || exiting || exitingIds.has(section.id) ? styles_module_default4.exiting : ""}`,
                style: { left: rect.x, top: screenY, width: rect.width, height: rect.height, borderColor: color.border, backgroundColor: color.bg, ...outlinesReady ? {} : { opacity: 0, animation: "none", transition: "none" } },
                onMouseDown: (e) => handleOutlineMouseDown(e, section.id),
                onDoubleClick: () => handleDoubleClick(section.id),
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: styles_module_default4.sectionLabel, style: { backgroundColor: color.pill }, children: section.label }),
                  /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: `${styles_module_default4.sectionAnnotation} ${section.note ? styles_module_default4.annotationVisible : ""}`, children: (() => {
                    if (section.note) lastNoteTextRef.current.set(section.id, section.note);
                    return section.note || lastNoteTextRef.current.get(section.id) || "";
                  })() }),
                  /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: styles_module_default4.sectionDimensions, children: [
                    Math.round(rect.width),
                    " \xD7 ",
                    Math.round(rect.height)
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
                    "div",
                    {
                      className: styles_module_default4.deleteButton,
                      onMouseDown: (e) => e.stopPropagation(),
                      onClick: () => handleDelete(section.id),
                      children: "\u2715"
                    }
                  ),
                  HANDLES.map((dir) => /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
                    "div",
                    {
                      className: `${styles_module_default4.handle} ${styles_module_default4[`handle${dir.charAt(0).toUpperCase()}${dir.slice(1)}`]}`,
                      onMouseDown: (e) => handleResizeMouseDown(e, section.id, dir)
                    },
                    dir
                  ))
                ]
              },
              section.id
            );
          }),
          changedSections.map((section) => {
            const rect = section.currentRect;
            const screenY = section.isFixed ? rect.y : rect.y - scrollY;
            const isSelected = selectedIds.has(section.id);
            const moved = isMoved(section);
            const resized = isResized(section);
            const settled = !isSelected;
            if (blankCanvas && settled) return null;
            const isNewGhost = !seenGhostIdsRef.current.has(section.id);
            if (isNewGhost) seenGhostIdsRef.current.add(section.id);
            return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(
              "div",
              {
                "data-rearrange-section": section.id,
                className: `${styles_module_default4.ghostOutline} ${isSelected ? styles_module_default4.selected : ""} ${clearing || exiting || exitingIds.has(section.id) ? styles_module_default4.exiting : ""}`,
                style: { left: rect.x, top: screenY, width: rect.width, height: rect.height, ...outlinesReady ? {} : { opacity: 0, animation: "none", transition: "none" }, ...!isNewGhost ? { animation: "none" } : {} },
                onMouseDown: (e) => handleOutlineMouseDown(e, section.id),
                onDoubleClick: () => handleDoubleClick(section.id),
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: styles_module_default4.sectionLabel, style: { backgroundColor: SECTION_COLOR.pill }, children: section.label }),
                  /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: `${styles_module_default4.sectionAnnotation} ${section.note ? styles_module_default4.annotationVisible : ""}`, children: (() => {
                    if (section.note) lastNoteTextRef.current.set(section.id, section.note);
                    return section.note || lastNoteTextRef.current.get(section.id) || "";
                  })() }),
                  /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: styles_module_default4.sectionDimensions, children: [
                    Math.round(rect.width),
                    " \xD7 ",
                    Math.round(rect.height)
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
                    "div",
                    {
                      className: styles_module_default4.deleteButton,
                      onMouseDown: (e) => e.stopPropagation(),
                      onClick: () => handleDelete(section.id),
                      children: "\u2715"
                    }
                  ),
                  HANDLES.map((dir) => /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
                    "div",
                    {
                      className: `${styles_module_default4.handle} ${styles_module_default4[`handle${dir.charAt(0).toUpperCase()}${dir.slice(1)}`]}`,
                      onMouseDown: (e) => handleResizeMouseDown(e, section.id, dir)
                    },
                    dir
                  )),
                  /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("span", { className: styles_module_default4.ghostBadge, children: (() => {
                    const first = firstActionRef.current.get(section.id);
                    if (moved && resized) {
                      const [a, b] = first === "resize" ? ["Resize", "Move"] : ["Move", "Resize"];
                      return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [
                        "Suggested ",
                        a,
                        " ",
                        /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("span", { className: styles_module_default4.ghostBadgeExtra, children: [
                          "& ",
                          b
                        ] })
                      ] });
                    }
                    return `Suggested ${resized ? "Resize" : "Move"}`;
                  })() })
                ]
              },
              section.id
            );
          })
        ]
      }
    ),
    !blankCanvas && (() => {
      const connectorSections = [];
      for (const s2 of changedSections) {
        const livePos = dragPositions.get(s2.id);
        connectorSections.push({ id: s2.id, orig: s2.originalRect, target: livePos || s2.currentRect, isFixed: s2.isFixed, isSelected: selectedIds.has(s2.id), isExiting: exitingIds.has(s2.id) });
      }
      for (const [id, pos] of dragPositions) {
        if (!connectorSections.some((c) => c.id === id)) {
          const s2 = sections.find((sec) => sec.id === id);
          if (s2) connectorSections.push({ id, orig: s2.originalRect, target: pos, isFixed: s2.isFixed, isSelected: selectedIds.has(id) });
        }
      }
      for (const [id, data] of exitingConnectors) {
        if (!connectorSections.some((c) => c.id === id)) {
          connectorSections.push({ id, orig: data.orig, target: data.target, isFixed: data.isFixed, isSelected: false, isExiting: true });
        }
      }
      if (connectorSections.length === 0) return null;
      return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("svg", { className: `${styles_module_default4.connectorSvg} ${clearing || exiting ? styles_module_default4.connectorExiting : ""}`, children: [
        connectorSections.map(({ id, orig, target, isFixed, isSelected, isExiting }) => {
          const ox = orig.x + orig.width / 2;
          const oy = (isFixed ? orig.y : orig.y - scrollY) + orig.height / 2;
          const cx = target.x + target.width / 2;
          const cy = (isFixed ? target.y : target.y - scrollY) + target.height / 2;
          const ddx = cx - ox;
          const ddy = cy - oy;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dist < 2) return null;
          const proximityScale = Math.min(1, dist / 40);
          const perpOffset = Math.min(dist * 0.3, 60);
          const nx = dist > 0 ? -ddy / dist : 0;
          const ny = dist > 0 ? ddx / dist : 0;
          const cpx = (ox + cx) / 2 + nx * perpOffset;
          const cpy = (oy + cy) / 2 + ny * perpOffset;
          const isDragging = dragPositions.has(id);
          const baseOpacity = isDragging || isSelected ? 1 : 0.4;
          const dotBaseOpacity = isDragging || isSelected ? 1 : 0.5;
          return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)("g", { className: isExiting ? styles_module_default4.connectorExiting : "", children: [
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
              "path",
              {
                className: styles_module_default4.connectorLine,
                d: `M ${ox} ${oy} Q ${cpx} ${cpy} ${cx} ${cy}`,
                fill: "none",
                stroke: "rgba(59, 130, 246, 0.45)",
                strokeWidth: "1.5",
                opacity: baseOpacity * proximityScale
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("circle", { className: styles_module_default4.connectorDot, cx: ox, cy: oy, r: 4 * proximityScale, fill: "rgba(59, 130, 246, 0.8)", stroke: "#fff", strokeWidth: "1.5", opacity: dotBaseOpacity * proximityScale, filter: "url(#connDotShadow)" }),
            /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("circle", { className: styles_module_default4.connectorDot, cx, cy, r: 4 * proximityScale, fill: "rgba(59, 130, 246, 0.8)", stroke: "#fff", strokeWidth: "1.5", opacity: dotBaseOpacity * proximityScale, filter: "url(#connDotShadow)" })
          ] }, `conn-${id}`);
        }),
        /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("defs", { children: /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("filter", { id: "connDotShadow", x: "-50%", y: "-50%", width: "200%", height: "200%", children: /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("feDropShadow", { dx: "0", dy: "0.5", stdDeviation: "1", floodOpacity: "0.15" }) }) })
      ] });
    })(),
    editingId && (() => {
      const es = sections.find((s2) => s2.id === editingId);
      if (!es) return null;
      const rect = es.currentRect;
      const screenY = es.isFixed ? rect.y : rect.y - scrollY;
      const centerX = rect.x + rect.width / 2;
      const aboveY = screenY - 8;
      const belowY = screenY + rect.height + 8;
      const fitsAbove = aboveY > 200;
      const fitsBelow = belowY < window.innerHeight - 100;
      const popupLeft = Math.max(160, Math.min(window.innerWidth - 160, centerX));
      let popupStyle;
      if (fitsAbove) {
        popupStyle = { left: popupLeft, bottom: window.innerHeight - aboveY };
      } else if (fitsBelow) {
        popupStyle = { left: popupLeft, top: belowY };
      } else {
        popupStyle = { left: popupLeft, top: Math.max(80, window.innerHeight / 2 - 80) };
      }
      return /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
        AnnotationPopupCSS,
        {
          element: es.label,
          placeholder: "Add a note about this section",
          initialValue: es.note ?? "",
          submitLabel: editHadNoteRef.current ? "Save" : "Set",
          onSubmit: submitEdit,
          onCancel: dismissEdit,
          onDelete: editHadNoteRef.current ? () => {
            submitEdit("");
          } : void 0,
          isExiting: editExiting,
          lightMode: !isDarkMode,
          style: popupStyle
        }
      );
    })(),
    sizeIndicator && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)("div", { className: styles_module_default4.sizeIndicator, style: { left: sizeIndicator.x, top: sizeIndicator.y }, "data-feedback-toolbar": true, children: sizeIndicator.text }),
    snapGuides.map((g, i) => /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
      "div",
      {
        className: styles_module_default4.guideLine,
        style: g.axis === "x" ? { position: "fixed", left: g.pos, top: 0, width: 1, height: "100vh" } : { position: "fixed", left: 0, top: g.pos - scrollY, width: "100vw", height: 1 }
      },
      `${g.axis}-${g.pos}-${i}`
    ))
  ] });
}

// src/components/design-mode/spatial.ts
var SKIP_TAGS3 = /* @__PURE__ */ new Set(["script", "style", "noscript", "link", "meta", "br", "hr"]);
function collectDOMCandidates() {
  const main = document.querySelector("main") || document.body;
  const results = [];
  const topLevel = Array.from(main.children);
  const roots = main !== document.body && topLevel.length < 3 ? Array.from(document.body.children) : topLevel;
  for (const el of roots) {
    if (!(el instanceof HTMLElement)) continue;
    if (SKIP_TAGS3.has(el.tagName.toLowerCase())) continue;
    if (el.hasAttribute("data-feedback-toolbar")) continue;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.height < 10 || rect.width < 10) continue;
    results.push({
      label: labelSection(el),
      selector: generateSelector(el),
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      area: rect.width * rect.height
    });
    for (const child of Array.from(el.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (SKIP_TAGS3.has(child.tagName.toLowerCase())) continue;
      if (child.hasAttribute("data-feedback-toolbar")) continue;
      const childStyle = window.getComputedStyle(child);
      if (childStyle.display === "none" || childStyle.visibility === "hidden") continue;
      const cr = child.getBoundingClientRect();
      if (cr.height < 10 || cr.width < 10) continue;
      results.push({
        label: labelSection(child),
        selector: generateSelector(child),
        top: cr.top,
        bottom: cr.bottom,
        left: cr.left,
        right: cr.right,
        area: cr.width * cr.height
      });
    }
  }
  return results;
}
function explicitToCandidates(items) {
  const scrollY = window.scrollY;
  return items.map(({ label, selector, rect }) => {
    const top = rect.y - scrollY;
    return {
      label,
      selector,
      top,
      bottom: top + rect.height,
      left: rect.x,
      right: rect.x + rect.width,
      area: rect.width * rect.height
    };
  });
}
function toViewportEdges(r) {
  const scrollY = window.scrollY;
  const top = r.y - scrollY;
  const left = r.x;
  return {
    top,
    bottom: top + r.height,
    left,
    right: left + r.width,
    area: r.width * r.height
  };
}
function getSpatialContext(targetRect, siblings) {
  const candidates = siblings ? explicitToCandidates(siblings) : collectDOMCandidates();
  const target = toViewportEdges(targetRect);
  let above = null;
  let below = null;
  let left = null;
  let right = null;
  let containedIn = null;
  for (const c of candidates) {
    if (Math.abs(c.left - target.left) < 2 && Math.abs(c.top - target.top) < 2 && Math.abs(c.right - c.left - targetRect.width) < 2 && Math.abs(c.bottom - c.top - targetRect.height) < 2) {
      continue;
    }
    if (c.left <= target.left + 2 && c.right >= target.right - 2 && c.top <= target.top + 2 && c.bottom >= target.bottom - 2 && c.area > target.area * 1.5) {
      if (!containedIn || c.area < containedIn._area) {
        containedIn = { label: c.label, selector: c.selector, _area: c.area };
      }
    }
    const hOverlap = target.right > c.left + 5 && target.left < c.right - 5;
    const vOverlap = target.bottom > c.top + 5 && target.top < c.bottom - 5;
    if (hOverlap && c.bottom <= target.top + 5) {
      const gap = Math.round(target.top - c.bottom);
      if (!above || gap < above._dist) {
        above = { label: c.label, selector: c.selector, gap: Math.max(0, gap), _dist: gap };
      }
    }
    if (hOverlap && c.top >= target.bottom - 5) {
      const gap = Math.round(c.top - target.bottom);
      if (!below || gap < below._dist) {
        below = { label: c.label, selector: c.selector, gap: Math.max(0, gap), _dist: gap };
      }
    }
    if (vOverlap && c.right <= target.left + 5) {
      const gap = Math.round(target.left - c.right);
      if (!left || gap < left._dist) {
        left = { label: c.label, selector: c.selector, gap: Math.max(0, gap), _dist: gap };
      }
    }
    if (vOverlap && c.left >= target.right - 5) {
      const gap = Math.round(c.left - target.right);
      if (!right || gap < right._dist) {
        right = { label: c.label, selector: c.selector, gap: Math.max(0, gap), _dist: gap };
      }
    }
  }
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const alignment = getAlignment(targetRect, viewportWidth);
  const clean = (n) => {
    if (!n) return null;
    return { label: n.label, selector: n.selector, gap: n.gap };
  };
  const outOfBounds = detectBoundsOverflow(
    target,
    targetRect,
    viewportWidth,
    viewportHeight,
    containedIn ? { label: containedIn.label, selector: containedIn.selector, _area: containedIn._area } : null,
    candidates
  );
  return {
    above: clean(above),
    below: clean(below),
    left: clean(left),
    right: clean(right),
    alignment,
    containedIn: containedIn ? { label: containedIn.label, selector: containedIn.selector } : null,
    outOfBounds
  };
}
function detectBoundsOverflow(targetEdges, targetRect, viewportWidth, viewportHeight, container, candidates) {
  const result = {};
  let hasOverflow = false;
  const vpOverflow = [];
  if (targetEdges.left < -2) vpOverflow.push("left");
  if (targetEdges.right > viewportWidth + 2) vpOverflow.push("right");
  if (targetEdges.top < -2) vpOverflow.push("top");
  if (targetEdges.bottom > viewportHeight + 2) vpOverflow.push("bottom");
  if (vpOverflow.length > 0) {
    result.viewport = vpOverflow;
    hasOverflow = true;
  }
  if (container) {
    const cont = candidates.find(
      (c) => c.label === container.label && c.selector === container.selector && Math.abs(c.area - container._area) < 10
    );
    if (cont) {
      const contOverflow = [];
      if (targetEdges.left < cont.left - 2) contOverflow.push("left");
      if (targetEdges.right > cont.right + 2) contOverflow.push("right");
      if (targetEdges.top < cont.top - 2) contOverflow.push("top");
      if (targetEdges.bottom > cont.bottom + 2) contOverflow.push("bottom");
      if (contOverflow.length > 0) {
        result.container = { label: container.label, edges: contOverflow };
        hasOverflow = true;
      }
    }
  }
  return hasOverflow ? result : null;
}
function getAlignment(rect, viewportWidth) {
  const ratio = rect.width / viewportWidth;
  if (ratio > 0.85) return "full-width";
  const centerX = rect.x + rect.width / 2;
  const viewportCenter = viewportWidth / 2;
  const offset = centerX - viewportCenter;
  const tolerance = viewportWidth * 0.08;
  if (Math.abs(offset) < tolerance) return "center";
  if (offset < 0) return "left";
  return "right";
}
function formatAlignment(alignment) {
  switch (alignment) {
    case "full-width":
      return "full-width";
    case "center":
      return "centered";
    case "left":
      return "left-aligned";
    case "right":
      return "right-aligned";
  }
}
function formatSpatialLines(ctx, options = {}) {
  const lines = [];
  if (ctx.above) {
    lines.push(`Below \`${ctx.above.label}\`${ctx.above.gap > 0 ? ` (${ctx.above.gap}px gap)` : ""}`);
  }
  if (ctx.below) {
    lines.push(`Above \`${ctx.below.label}\`${ctx.below.gap > 0 ? ` (${ctx.below.gap}px gap)` : ""}`);
  }
  if (options.includeLeftRight) {
    if (ctx.left) {
      lines.push(`Right of \`${ctx.left.label}\`${ctx.left.gap > 0 ? ` (${ctx.left.gap}px gap)` : ""}`);
    }
    if (ctx.right) {
      lines.push(`Left of \`${ctx.right.label}\`${ctx.right.gap > 0 ? ` (${ctx.right.gap}px gap)` : ""}`);
    }
  }
  const alignStr = formatAlignment(ctx.alignment);
  if (ctx.containedIn) {
    lines.push(`${alignStr.charAt(0).toUpperCase() + alignStr.slice(1)} in \`${ctx.containedIn.label}\``);
  } else {
    lines.push(`${alignStr.charAt(0).toUpperCase() + alignStr.slice(1)} in page`);
  }
  if (options.includePixelRef && options.pixelRef) {
    lines.push(`Pixel ref: \`${options.pixelRef}\``);
  }
  if (ctx.outOfBounds) {
    if (ctx.outOfBounds.viewport) {
      lines.push(`**Outside viewport** (${ctx.outOfBounds.viewport.join(", ")} edge${ctx.outOfBounds.viewport.length > 1 ? "s" : ""})`);
    }
    if (ctx.outOfBounds.container) {
      lines.push(`**Outside \`${ctx.outOfBounds.container.label}\`** (${ctx.outOfBounds.container.edges.join(", ")} edge${ctx.outOfBounds.container.edges.length > 1 ? "s" : ""})`);
    }
  }
  return lines;
}
function formatPositionSummary(ctx, coords, size) {
  const parts = [];
  if (ctx.above) parts.push(`below \`${ctx.above.label}\``);
  if (ctx.below) parts.push(`above \`${ctx.below.label}\``);
  if (ctx.left) parts.push(`right of \`${ctx.left.label}\``);
  if (ctx.right) parts.push(`left of \`${ctx.right.label}\``);
  if (ctx.containedIn) parts.push(`inside \`${ctx.containedIn.label}\``);
  parts.push(formatAlignment(ctx.alignment));
  if (ctx.outOfBounds?.viewport) {
    parts.push(`**outside viewport** (${ctx.outOfBounds.viewport.join(", ")})`);
  }
  if (ctx.outOfBounds?.container) {
    parts.push(`**outside \`${ctx.outOfBounds.container.label}\`** (${ctx.outOfBounds.container.edges.join(", ")})`);
  }
  const sizeStr = size ? `, ${Math.round(size.width)}\xD7${Math.round(size.height)}px` : "";
  return `at (${Math.round(coords.x)}, ${Math.round(coords.y)})${sizeStr}: ${parts.join(", ")}`;
}
var GROUP_TOLERANCE = 15;
function detectGroups(items) {
  if (items.length < 2) return [];
  const groups = [];
  const used = /* @__PURE__ */ new Set();
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const row = [i];
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(items[i].rect.y - items[j].rect.y) < GROUP_TOLERANCE) {
        row.push(j);
      }
    }
    if (row.length >= 2) {
      const members = row.map((idx) => items[idx]);
      members.sort((a, b) => a.rect.x - b.rect.x);
      const gaps = [];
      for (let k = 0; k < members.length - 1; k++) {
        gaps.push(Math.round(members[k + 1].rect.x - (members[k].rect.x + members[k].rect.width)));
      }
      const avgY = Math.round(members.reduce((sum, m) => sum + m.rect.y, 0) / members.length);
      groups.push({
        labels: members.map((m) => m.label),
        type: "row",
        sharedEdge: avgY,
        gaps,
        avgGap: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0
      });
      row.forEach((idx) => used.add(idx));
    }
  }
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const col = [i];
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(items[i].rect.x - items[j].rect.x) < GROUP_TOLERANCE) {
        col.push(j);
      }
    }
    if (col.length >= 2) {
      const members = col.map((idx) => items[idx]);
      members.sort((a, b) => a.rect.y - b.rect.y);
      const gaps = [];
      for (let k = 0; k < members.length - 1; k++) {
        gaps.push(Math.round(members[k + 1].rect.y - (members[k].rect.y + members[k].rect.height)));
      }
      const avgX = Math.round(members.reduce((sum, m) => sum + m.rect.x, 0) / members.length);
      groups.push({
        labels: members.map((m) => m.label),
        type: "column",
        sharedEdge: avgX,
        gaps,
        avgGap: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0
      });
      col.forEach((idx) => used.add(idx));
    }
  }
  return groups;
}
function analyzeLayoutPatterns(sections) {
  if (sections.length < 2) return [];
  const origGroups = detectGroups(sections.map((s2) => ({ label: s2.label, rect: s2.originalRect })));
  const currGroups = detectGroups(sections.map((s2) => ({ label: s2.label, rect: s2.currentRect })));
  const lines = [];
  const described = /* @__PURE__ */ new Set();
  for (const og of origGroups) {
    const ogSet = new Set(og.labels);
    let bestMatch = null;
    let bestOverlap = 0;
    for (const cg of currGroups) {
      const overlap = cg.labels.filter((l) => ogSet.has(l)).length;
      if (overlap >= 2 && overlap > bestOverlap) {
        bestMatch = cg;
        bestOverlap = overlap;
      }
    }
    if (bestMatch) {
      const sharedLabels = bestMatch.labels.filter((l) => ogSet.has(l));
      const names = sharedLabels.join(", ");
      if (bestMatch.type !== og.type) {
        const fromAxis = og.type === "row" ? "y" : "x";
        const toAxis = bestMatch.type === "row" ? "y" : "x";
        lines.push(
          `**${names}**: ${og.type} (${fromAxis}\u2248${og.sharedEdge}, ${og.avgGap}px gaps) \u2192 ${bestMatch.type} (${toAxis}\u2248${bestMatch.sharedEdge}, ${bestMatch.avgGap}px gaps)`
        );
      } else if (Math.abs(og.sharedEdge - bestMatch.sharedEdge) > 20 || Math.abs(og.avgGap - bestMatch.avgGap) > 5) {
        const axis = og.type === "row" ? "y" : "x";
        const posChange = Math.abs(og.sharedEdge - bestMatch.sharedEdge) > 20 ? ` ${axis}: ${og.sharedEdge} \u2192 ${bestMatch.sharedEdge}` : "";
        const gapChange = Math.abs(og.avgGap - bestMatch.avgGap) > 5 ? ` gaps: ${og.avgGap}px \u2192 ${bestMatch.avgGap}px` : "";
        lines.push(`**${names}**: ${og.type} shifted \u2014${posChange}${gapChange}`);
      }
      sharedLabels.forEach((l) => described.add(l));
    } else {
      const names = og.labels.join(", ");
      const axis = og.type === "row" ? "y" : "x";
      lines.push(`**${names}**: ${og.type} (${axis}\u2248${og.sharedEdge}) dissolved`);
      og.labels.forEach((l) => described.add(l));
    }
  }
  for (const cg of currGroups) {
    if (cg.labels.every((l) => described.has(l))) continue;
    const newLabels = cg.labels.filter((l) => !described.has(l));
    if (newLabels.length < 2) continue;
    const wasGrouped = origGroups.some((og) => {
      const overlap = og.labels.filter((l) => cg.labels.includes(l));
      return overlap.length >= 2;
    });
    if (!wasGrouped) {
      const axis = cg.type === "row" ? "y" : "x";
      lines.push(`**${cg.labels.join(", ")}**: new ${cg.type} (${axis}\u2248${cg.sharedEdge}, ${cg.avgGap}px gaps)`);
      cg.labels.forEach((l) => described.add(l));
    }
  }
  const ungroupedCurr = sections.filter((s2) => !described.has(s2.label));
  if (ungroupedCurr.length >= 2) {
    const byX = {};
    for (const s2 of ungroupedCurr) {
      const x = Math.round(s2.currentRect.x / 5) * 5;
      (byX[x] ?? (byX[x] = [])).push(s2.label);
    }
    for (const [x, labels] of Object.entries(byX)) {
      if (labels.length >= 2) {
        lines.push(`**${labels.join(", ")}**: shared left edge at x\u2248${x}`);
      }
    }
  }
  return lines;
}
function getPageLayout(viewport) {
  if (typeof document === "undefined") return { viewport, contentArea: null };
  const candidates = [];
  const seen = /* @__PURE__ */ new Set();
  const addCandidate = (el) => {
    if (seen.has(el)) return;
    if (!(el instanceof HTMLElement)) return;
    if (el.hasAttribute("data-feedback-toolbar")) return;
    if (SKIP_TAGS3.has(el.tagName.toLowerCase())) return;
    seen.add(el);
    candidates.push(el);
  };
  const main = document.querySelector("main");
  if (main) addCandidate(main);
  const roleMain = document.querySelector("[role='main']");
  if (roleMain) addCandidate(roleMain);
  for (const l1 of Array.from(document.body.children)) {
    addCandidate(l1);
    if (l1.children) {
      for (const l2 of Array.from(l1.children)) {
        addCandidate(l2);
        if (l2.children) {
          for (const l3 of Array.from(l2.children)) {
            addCandidate(l3);
          }
        }
      }
    }
  }
  let bestContainer = null;
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.height < 50) continue;
    const style = getComputedStyle(el);
    if (style.maxWidth && style.maxWidth !== "none" && style.maxWidth !== "0px") {
      if (!bestContainer || rect.width < bestContainer.rect.width) {
        bestContainer = { el, rect };
      }
      continue;
    }
    if (!bestContainer && rect.width < viewport.width - 20 && rect.width > 100) {
      bestContainer = { el, rect };
    }
  }
  if (bestContainer) {
    const { el, rect } = bestContainer;
    return {
      viewport,
      contentArea: {
        width: Math.round(rect.width),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        centerX: Math.round(rect.left + rect.width / 2),
        selector: generateSelector(el)
      }
    };
  }
  return { viewport, contentArea: null };
}
function getElementCSSContext(selector) {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(selector);
  if (!el?.parentElement) return null;
  const ps = getComputedStyle(el.parentElement);
  const result = {
    parentDisplay: ps.display,
    parentSelector: generateSelector(el.parentElement)
  };
  if (ps.display.includes("flex")) {
    result.flexDirection = ps.flexDirection;
  }
  if (ps.display.includes("grid") && ps.gridTemplateColumns !== "none") {
    result.gridCols = ps.gridTemplateColumns;
  }
  if (ps.gap && ps.gap !== "normal" && ps.gap !== "0px") {
    result.gap = ps.gap;
  }
  return result;
}
function formatCSSPosition(rect, layout) {
  const ref = layout.contentArea;
  const containerWidth = ref ? ref.width : layout.viewport.width;
  const containerLeft = ref ? ref.left : 0;
  const containerCenterX = ref ? ref.centerX : Math.round(layout.viewport.width / 2);
  const leftInContainer = Math.round(rect.x - containerLeft);
  const rightInContainer = Math.round(containerLeft + containerWidth - (rect.x + rect.width));
  const widthPct = (rect.width / containerWidth * 100).toFixed(1);
  const centerX = rect.x + rect.width / 2;
  const isCentered = Math.abs(centerX - containerCenterX) < 20;
  const isFullWidth = rect.width / containerWidth > 0.95;
  const parts = [];
  if (isFullWidth) {
    parts.push("`width: 100%` of container");
  } else {
    parts.push(`left \`${leftInContainer}px\` in container, right \`${rightInContainer}px\`, width \`${widthPct}%\` (\`${Math.round(rect.width)}px\`)`);
  }
  if (isCentered && !isFullWidth) {
    parts.push("centered \u2014 `margin-inline: auto`");
  }
  return parts.join(" \u2014 ");
}

// src/components/design-mode/output.ts
function formatReferenceFrame(layout) {
  const { viewport, contentArea } = layout;
  let out = "### Reference Frame\n";
  out += `- Viewport: \`${viewport.width}\xD7${viewport.height}px\`
`;
  if (contentArea) {
    const ca = contentArea;
    out += `- Content area: \`${ca.width}px\` wide, left edge at \`x=${ca.left}\`, right at \`x=${ca.right}\` (\`${ca.selector}\`)
`;
    out += `- Pixel \u2192 CSS translation:
`;
    out += `  - **Horizontal position in container**: \`element.x - ${ca.left}\` \u2192 use as \`margin-left\` or \`left\`
`;
    out += `  - **Width as % of container**: \`element.width / ${ca.width} \xD7 100\` \u2192 use as \`width: X%\`
`;
    out += `  - **Vertical gap between elements**: \`nextElement.y - (prevElement.y + prevElement.height)\` \u2192 use as \`margin-top\` or \`gap\`
`;
    out += `  - **Centered**: if \`|element.centerX - ${ca.centerX}| < 20px\` \u2192 use \`margin-inline: auto\`
`;
  } else {
    out += `- No distinct content container \u2014 elements positioned relative to full viewport
`;
    out += `- Pixel \u2192 CSS translation:
`;
    out += `  - **Width as % of viewport**: \`element.width / ${viewport.width} \xD7 100\` \u2192 use as \`width: X%\`
`;
    out += `  - **Centered**: if \`|(element.x + element.width/2) - ${Math.round(viewport.width / 2)}| < 20px\` \u2192 use \`margin-inline: auto\`
`;
  }
  out += "\n";
  return out;
}
function formatParentContext(selector) {
  const ctx = getElementCSSContext(selector);
  if (!ctx) return null;
  let desc = `\`${ctx.parentDisplay}\``;
  if (ctx.flexDirection) desc += `, flex-direction: \`${ctx.flexDirection}\``;
  if (ctx.gridCols) desc += `, grid-template-columns: \`${ctx.gridCols}\``;
  if (ctx.gap) desc += `, gap: \`${ctx.gap}\``;
  return `Parent: ${desc} (\`${ctx.parentSelector}\`)`;
}
function generateDesignOutput(placements, viewport, options, detailLevel = "standard") {
  if (placements.length === 0) return "";
  const sorted = [...placements].sort((a, b) => {
    if (Math.abs(a.y - b.y) < 20) return a.x - b.x;
    return a.y - b.y;
  });
  let out = "";
  if (options?.blankCanvas) {
    out += `## Wireframe: New Page

`;
    if (options.wireframePurpose) {
      out += `> **Purpose:** ${options.wireframePurpose}
>
`;
    }
    out += `> ${placements.length} component${placements.length !== 1 ? "s" : ""} placed \u2014 this is a standalone wireframe, not related to the current page.
>
> This wireframe is a rough sketch for exploring ideas.

`;
  } else {
    out += `## Design Layout

> ${placements.length} component${placements.length !== 1 ? "s" : ""} placed

`;
  }
  if (detailLevel === "compact") {
    out += "### Components\n";
    sorted.forEach((c, i) => {
      const label = COMPONENT_MAP[c.type]?.label || c.type;
      out += `${i + 1}. **${label}** \u2014 \`${Math.round(c.width)}\xD7${Math.round(c.height)}px\` at \`(${Math.round(c.x)}, ${Math.round(c.y)})\`
`;
      if (c.text) {
        out += `   - Note: "${c.text}"
`;
      }
    });
    return out;
  }
  const layout = getPageLayout(viewport);
  out += formatReferenceFrame(layout);
  out += "### Components\n";
  sorted.forEach((c, i) => {
    const label = COMPONENT_MAP[c.type]?.label || c.type;
    const rect = { x: c.x, y: c.y, width: c.width, height: c.height };
    out += `${i + 1}. **${label}** \u2014 \`${Math.round(c.width)}\xD7${Math.round(c.height)}px\` at \`(${Math.round(c.x)}, ${Math.round(c.y)})\`
`;
    if (c.text) {
      out += `   - Note: "${c.text}"
`;
    }
    const ctx = getSpatialContext(rect);
    const includeLeftRight = detailLevel === "detailed" || detailLevel === "forensic";
    const lines = formatSpatialLines(ctx, { includeLeftRight });
    for (const line of lines) {
      out += `   - ${line}
`;
    }
    const cssPos = formatCSSPosition(rect, layout);
    if (cssPos) {
      out += `   - CSS: ${cssPos}
`;
    }
  });
  out += "\n### Layout Analysis\n";
  const rows = [];
  for (const c of sorted) {
    const existing = rows.find((r) => Math.abs(r.y - c.y) < 30);
    if (existing) {
      existing.items.push(c);
    } else {
      rows.push({ y: c.y, items: [c] });
    }
  }
  rows.sort((a, b) => a.y - b.y);
  rows.forEach((row, i) => {
    row.items.sort((a, b) => a.x - b.x);
    const labels = row.items.map((c) => COMPONENT_MAP[c.type]?.label || c.type);
    if (row.items.length === 1) {
      const c = row.items[0];
      const isFullWidth = c.width > viewport.width * 0.8;
      out += `- Row ${i + 1} (y\u2248${Math.round(row.y)}): ${labels[0]}${isFullWidth ? " \u2014 full width" : ""}
`;
    } else {
      out += `- Row ${i + 1} (y\u2248${Math.round(row.y)}): ${labels.join(" | ")} \u2014 ${row.items.length} items side by side
`;
    }
  });
  if (detailLevel === "detailed" || detailLevel === "forensic") {
    out += "\n### Spacing & Gaps\n";
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const labelA = COMPONENT_MAP[a.type]?.label || a.type;
      const labelB = COMPONENT_MAP[b.type]?.label || b.type;
      const vGap = Math.round(b.y - (a.y + a.height));
      const hGap = Math.round(b.x - (a.x + a.width));
      if (Math.abs(a.y - b.y) < 30) {
        out += `- ${labelA} \u2192 ${labelB}: \`${hGap}px\` horizontal gap
`;
      } else {
        out += `- ${labelA} \u2192 ${labelB}: \`${vGap}px\` vertical gap
`;
      }
    }
    if (detailLevel === "forensic" && sorted.length > 2) {
      out += "\n### All Pairwise Gaps\n";
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i];
          const b = sorted[j];
          const labelA = COMPONENT_MAP[a.type]?.label || a.type;
          const labelB = COMPONENT_MAP[b.type]?.label || b.type;
          const vGap = Math.round(b.y - (a.y + a.height));
          const hGap = Math.round(b.x - (a.x + a.width));
          out += `- ${labelA} \u2194 ${labelB}: h=\`${hGap}px\` v=\`${vGap}px\`
`;
        }
      }
    }
    if (detailLevel === "forensic") {
      out += "\n### Z-Order (placement order)\n";
      placements.forEach((c, i) => {
        const label = COMPONENT_MAP[c.type]?.label || c.type;
        out += `${i}. ${label} at \`(${Math.round(c.x)}, ${Math.round(c.y)})\`
`;
      });
    }
  }
  out += "\n### Suggested Implementation\n";
  const hasNav = sorted.some((c) => c.type === "navigation");
  const hasHero = sorted.some((c) => c.type === "hero");
  const hasSidebar = sorted.some((c) => c.type === "sidebar");
  const hasFooter = sorted.some((c) => c.type === "footer");
  const cards = sorted.filter((c) => c.type === "card");
  const forms = sorted.filter((c) => c.type === "form");
  const tables = sorted.filter((c) => c.type === "table");
  const modals = sorted.filter((c) => c.type === "modal");
  if (hasNav) out += "- Top navigation bar with logo + nav links + CTA\n";
  if (hasHero) out += "- Hero section with heading, subtext, and call-to-action\n";
  if (hasSidebar) out += "- Sidebar layout \u2014 use CSS Grid with sidebar + main content area\n";
  if (cards.length > 1) out += `- ${cards.length}-column card grid \u2014 use CSS Grid or Flexbox
`;
  else if (cards.length === 1) out += "- Card component with image + content area\n";
  if (forms.length > 0) out += `- ${forms.length} form${forms.length > 1 ? "s" : ""} \u2014 add proper labels, validation, and submit handling
`;
  if (tables.length > 0) out += "- Data table \u2014 consider sortable columns and pagination\n";
  if (modals.length > 0) out += "- Modal dialog \u2014 add overlay backdrop and focus trapping\n";
  if (hasFooter) out += "- Multi-column footer with links\n";
  if (detailLevel === "detailed" || detailLevel === "forensic") {
    out += "\n### CSS Suggestions\n";
    if (hasSidebar) {
      const sidebar = sorted.find((c) => c.type === "sidebar");
      out += `- \`display: grid; grid-template-columns: ${Math.round(sidebar.width)}px 1fr;\`
`;
    }
    if (cards.length > 1) {
      const cardW = Math.round(cards[0].width);
      out += `- \`display: grid; grid-template-columns: repeat(${cards.length}, ${cardW}px); gap: 16px;\`
`;
    }
    if (hasNav) {
      out += `- Navigation: \`position: sticky; top: 0; z-index: 50;\`
`;
    }
  }
  return out;
}
function generateRearrangeOutput(state, detailLevel = "standard", viewport) {
  const { sections } = state;
  const changed = [];
  for (const s2 of sections) {
    const o = s2.originalRect;
    const c = s2.currentRect;
    const posMoved = Math.abs(o.x - c.x) > 1 || Math.abs(o.y - c.y) > 1;
    const sizeChanged = Math.abs(o.width - c.width) > 1 || Math.abs(o.height - c.height) > 1;
    const hasNote = !!s2.note;
    if (!posMoved && !sizeChanged && !hasNote) {
      if (detailLevel === "forensic") {
        changed.push({ section: s2, posMoved: false, sizeChanged: false });
      }
      continue;
    }
    changed.push({ section: s2, posMoved, sizeChanged });
  }
  if (changed.length === 0) return "";
  if (detailLevel !== "forensic" && changed.every((e) => !e.posMoved && !e.sizeChanged && !e.section.note))
    return "";
  let out = "## Suggested Layout Changes\n\n";
  const vw = viewport ? viewport.width : typeof window !== "undefined" ? window.innerWidth : 0;
  const vh = viewport ? viewport.height : typeof window !== "undefined" ? window.innerHeight : 0;
  const layout = getPageLayout({ width: vw, height: vh });
  if (detailLevel !== "compact") {
    out += formatReferenceFrame(layout);
  }
  if (detailLevel === "forensic") {
    out += `> Detected at: \`${new Date(state.detectedAt).toISOString()}\`
`;
    out += `> Total sections: ${sections.length}

`;
  }
  const siblingCandidates = (rects) => sections.map((s2) => ({
    label: s2.label,
    selector: s2.selector,
    rect: rects === "original" ? s2.originalRect : s2.currentRect
  }));
  out += "**Changes:**\n";
  for (const { section: s2, posMoved, sizeChanged } of changed) {
    const o = s2.originalRect;
    const c = s2.currentRect;
    if (!posMoved && !sizeChanged) {
      if (s2.note) {
        out += `- **${s2.label}** \u2014 note only
`;
        out += `  - Note: "${s2.note}"
`;
      } else {
        out += `- ${s2.label} \u2014 unchanged at (${Math.round(c.x)}, ${Math.round(c.y)}) ${Math.round(c.width)}\xD7${Math.round(c.height)}px
`;
      }
      continue;
    }
    if (detailLevel === "compact") {
      if (posMoved && sizeChanged) {
        out += `- Suggested: move **${s2.label}** to (${Math.round(c.x)}, ${Math.round(c.y)}) ${Math.round(c.width)}\xD7${Math.round(c.height)}px
`;
      } else if (posMoved) {
        out += `- Suggested: move **${s2.label}** to (${Math.round(c.x)}, ${Math.round(c.y)})
`;
      } else {
        out += `- Suggested: resize **${s2.label}** to ${Math.round(c.width)}\xD7${Math.round(c.height)}px
`;
      }
      if (s2.note) {
        out += `  - Note: "${s2.note}"
`;
      }
      continue;
    }
    if (posMoved && sizeChanged) {
      out += `- Suggested: move and resize **${s2.label}**
`;
    } else if (posMoved) {
      out += `- Suggested: move **${s2.label}**
`;
    } else {
      out += `- Suggested: resize **${s2.label}** from ${Math.round(o.width)}\xD7${Math.round(o.height)}px to ${Math.round(c.width)}\xD7${Math.round(c.height)}px
`;
    }
    if (s2.note) {
      out += `  - Note: "${s2.note}"
`;
    }
    if (posMoved) {
      const origCtx = getSpatialContext(o, siblingCandidates("original"));
      const currCtx = getSpatialContext(c, siblingCandidates("current"));
      const wasSize = sizeChanged ? { width: o.width, height: o.height } : void 0;
      out += `  - Currently ${formatPositionSummary(origCtx, { x: o.x, y: o.y }, wasSize)}
`;
      const nowSize = sizeChanged ? { width: c.width, height: c.height } : void 0;
      const coordStr = `at (${Math.round(c.x)}, ${Math.round(c.y)})`;
      const sizeStr = nowSize ? `, ${Math.round(nowSize.width)}\xD7${Math.round(nowSize.height)}px` : "";
      const includeLeftRight = detailLevel === "detailed" || detailLevel === "forensic";
      const nowLines = formatSpatialLines(currCtx, { includeLeftRight });
      if (nowLines.length > 0) {
        out += `  - Suggested position ${coordStr}${sizeStr}: ${nowLines[0]}
`;
        for (let i = 1; i < nowLines.length; i++) {
          out += `    ${nowLines[i]}
`;
        }
      } else {
        out += `  - Suggested position ${coordStr}${sizeStr}
`;
      }
      const cssPos = formatCSSPosition(c, layout);
      if (cssPos) {
        out += `  - CSS: ${cssPos}
`;
      }
    }
    const parentCtx = formatParentContext(s2.selector);
    if (parentCtx) {
      out += `  - ${parentCtx}
`;
    }
    out += `  - Selector: \`${s2.selector}\`
`;
    if (detailLevel === "detailed" || detailLevel === "forensic") {
      const ident = s2.className ? `${s2.tagName}.${s2.className.split(" ")[0]}` : s2.tagName;
      if (ident !== s2.selector) {
        out += `  - Element: \`${ident}\`
`;
      }
      if (s2.role) out += `  - Role: \`${s2.role}\`
`;
      if (detailLevel === "forensic" && s2.textSnippet) {
        out += `  - Text: "${s2.textSnippet}"
`;
      }
    }
    if (detailLevel === "forensic") {
      out += `  - Original rect: \`{ x: ${Math.round(o.x)}, y: ${Math.round(o.y)}, w: ${Math.round(o.width)}, h: ${Math.round(o.height)} }\`
`;
      out += `  - Current rect: \`{ x: ${Math.round(c.x)}, y: ${Math.round(c.y)}, w: ${Math.round(c.width)}, h: ${Math.round(c.height)} }\`
`;
    }
  }
  if (detailLevel !== "compact") {
    const movedSections = changed.filter((e) => e.posMoved).map((e) => ({
      label: e.section.label,
      originalRect: e.section.originalRect,
      currentRect: e.section.currentRect
    }));
    const patterns = analyzeLayoutPatterns(movedSections);
    if (patterns.length > 0) {
      out += "\n### Layout Summary\n";
      for (const line of patterns) {
        out += `- ${line}
`;
      }
    }
  }
  if (detailLevel !== "compact" && sections.length > 1) {
    out += "\n### All Sections (current positions)\n";
    const sortedSections = [...sections].sort((a, b) => {
      if (Math.abs(a.currentRect.y - b.currentRect.y) < 20) return a.currentRect.x - b.currentRect.x;
      return a.currentRect.y - b.currentRect.y;
    });
    for (const s2 of sortedSections) {
      const r = s2.currentRect;
      const moved = Math.abs(r.x - s2.originalRect.x) > 1 || Math.abs(r.y - s2.originalRect.y) > 1 || Math.abs(r.width - s2.originalRect.width) > 1 || Math.abs(r.height - s2.originalRect.height) > 1;
      out += `- ${s2.label}: \`${Math.round(r.width)}\xD7${Math.round(r.height)}px\` at \`(${Math.round(r.x)}, ${Math.round(r.y)})\`${moved ? " \u2190 suggested" : ""}
`;
    }
  }
  return out;
}

// src/utils/storage.ts
var STORAGE_PREFIX = "feedback-annotations-";
var DEFAULT_RETENTION_DAYS = 7;
function getStorageKey(pathname) {
  return `${STORAGE_PREFIX}${pathname}`;
}
function loadAnnotations(pathname) {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(getStorageKey(pathname));
    if (!stored) return [];
    const data = JSON.parse(stored);
    const cutoff = Date.now() - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1e3;
    return data.filter((a) => !a.timestamp || a.timestamp > cutoff);
  } catch {
    return [];
  }
}
function saveAnnotations(pathname, annotations) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getStorageKey(pathname), JSON.stringify(annotations));
  } catch {
  }
}
function loadAllAnnotations() {
  const result = /* @__PURE__ */ new Map();
  if (typeof window === "undefined") return result;
  try {
    const cutoff = Date.now() - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1e3;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) {
        const pathname = key.slice(STORAGE_PREFIX.length);
        const stored = localStorage.getItem(key);
        if (stored) {
          const data = JSON.parse(stored);
          const filtered = data.filter(
            (a) => !a.timestamp || a.timestamp > cutoff
          );
          if (filtered.length > 0) {
            result.set(pathname, filtered);
          }
        }
      }
    }
  } catch {
  }
  return result;
}
function saveAnnotationsWithSyncMarker(pathname, annotations, sessionId) {
  const marked = annotations.map((annotation) => ({
    ...annotation,
    _syncedTo: sessionId
  }));
  saveAnnotations(pathname, marked);
}
var DESIGN_PREFIX = "agentation-design-";
function loadDesignPlacements(pathname) {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(`${DESIGN_PREFIX}${pathname}`);
    if (!stored) return [];
    return JSON.parse(stored);
  } catch {
    return [];
  }
}
function saveDesignPlacements(pathname, placements) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(`${DESIGN_PREFIX}${pathname}`, JSON.stringify(placements));
  } catch {
  }
}
function clearDesignPlacements(pathname) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(`${DESIGN_PREFIX}${pathname}`);
  } catch {
  }
}
var REARRANGE_PREFIX = "agentation-rearrange-";
function loadRearrangeState(pathname) {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(`${REARRANGE_PREFIX}${pathname}`);
    if (!stored) return null;
    return JSON.parse(stored);
  } catch {
    return null;
  }
}
function saveRearrangeState(pathname, state) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(`${REARRANGE_PREFIX}${pathname}`, JSON.stringify(state));
  } catch {
  }
}
function clearRearrangeState(pathname) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(`${REARRANGE_PREFIX}${pathname}`);
  } catch {
  }
}
var WIREFRAME_PREFIX = "agentation-wireframe-";
function loadWireframeState(pathname) {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(`${WIREFRAME_PREFIX}${pathname}`);
    if (!stored) return null;
    return JSON.parse(stored);
  } catch {
    return null;
  }
}
function saveWireframeState(pathname, state) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(`${WIREFRAME_PREFIX}${pathname}`, JSON.stringify(state));
  } catch {
  }
}
function clearWireframeState(pathname) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(`${WIREFRAME_PREFIX}${pathname}`);
  } catch {
  }
}
var SESSION_PREFIX = "agentation-session-";
function getSessionStorageKey(pathname) {
  return `${SESSION_PREFIX}${pathname}`;
}
function loadSessionId(pathname) {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(getSessionStorageKey(pathname));
  } catch {
    return null;
  }
}
function saveSessionId(pathname, sessionId) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getSessionStorageKey(pathname), sessionId);
  } catch {
  }
}
function clearSessionId(pathname) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(getSessionStorageKey(pathname));
  } catch {
  }
}
var TOOLBAR_HIDDEN_SESSION_KEY = `${SESSION_PREFIX}toolbar-hidden`;
function loadToolbarHidden() {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(TOOLBAR_HIDDEN_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}
function saveToolbarHidden(hidden) {
  if (typeof window === "undefined") return;
  try {
    if (hidden) {
      sessionStorage.setItem(TOOLBAR_HIDDEN_SESSION_KEY, "1");
    } else {
      sessionStorage.removeItem(TOOLBAR_HIDDEN_SESSION_KEY);
    }
  } catch {
  }
}

// src/utils/sync.ts
async function createSession(endpoint, url) {
  const response = await fetch(`${endpoint}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });
  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`);
  }
  return response.json();
}
async function getSession(endpoint, sessionId) {
  const response = await fetch(`${endpoint}/sessions/${sessionId}`);
  if (!response.ok) {
    throw new Error(`Failed to get session: ${response.status}`);
  }
  return response.json();
}
async function syncAnnotation(endpoint, sessionId, annotation) {
  if (!annotation.elementPath && (annotation.element === "body" || annotation.element === "html")) {
    annotation = { ...annotation, elementPath: annotation.element };
  }
  const response = await fetch(`${endpoint}/sessions/${sessionId}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(annotation)
  });
  if (!response.ok) {
    throw new Error(`Failed to sync annotation: ${response.status}`);
  }
  return response.json();
}
async function updateAnnotation(endpoint, annotationId, data) {
  const response = await fetch(`${endpoint}/annotations/${annotationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    throw new Error(`Failed to update annotation: ${response.status}`);
  }
  return response.json();
}
async function deleteAnnotation(endpoint, annotationId) {
  const response = await fetch(`${endpoint}/annotations/${annotationId}`, {
    method: "DELETE"
  });
  if (!response.ok) {
    throw new Error(`Failed to delete annotation: ${response.status}`);
  }
}

// src/utils/react-detection.ts
var FiberTags = {
  FunctionComponent: 0,
  ClassComponent: 1,
  IndeterminateComponent: 2,
  HostRoot: 3,
  HostPortal: 4,
  HostComponent: 5,
  // DOM elements like <div>
  HostText: 6,
  Fragment: 7,
  Mode: 8,
  ContextConsumer: 9,
  ContextProvider: 10,
  ForwardRef: 11,
  Profiler: 12,
  SuspenseComponent: 13,
  MemoComponent: 14,
  SimpleMemoComponent: 15,
  LazyComponent: 16,
  // React 18/19 additions
  IncompleteClassComponent: 17,
  DehydratedFragment: 18,
  SuspenseListComponent: 19,
  // Note: 20 is unused/reserved
  ScopeComponent: 21,
  OffscreenComponent: 22,
  LegacyHiddenComponent: 23,
  CacheComponent: 24,
  TracingMarkerComponent: 25,
  HostHoistable: 26,
  HostSingleton: 27,
  IncompleteFunctionComponent: 28,
  Throw: 29,
  ViewTransitionComponent: 30,
  ActivityComponent: 31
};
var DEFAULT_SKIP_EXACT = /* @__PURE__ */ new Set([
  "Component",
  "PureComponent",
  "Fragment",
  "Suspense",
  "Profiler",
  "StrictMode",
  "Routes",
  "Route",
  "Outlet",
  // Framework internals - exact matches
  "Root",
  "ErrorBoundaryHandler",
  "HotReload",
  "Hot"
]);
var DEFAULT_SKIP_PATTERNS = [
  /Boundary$/,
  // ErrorBoundary, RedirectBoundary
  /BoundaryHandler$/,
  // ErrorBoundaryHandler
  /Provider$/,
  // ThemeProvider, Context.Provider
  /Consumer$/,
  // Context.Consumer
  /^(Inner|Outer)/,
  // InnerLayoutRouter
  /Router$/,
  // AppRouter, BrowserRouter
  /^Client(Page|Segment|Root)/,
  // ClientPageRoot, ClientSegmentRoot
  /^Segment(ViewNode|Node)$/,
  // Next.js App Router internals
  /^LayoutSegment/,
  // Next.js layout segment wrappers
  /^Server(Root|Component|Render)/,
  // ServerRoot (not ServerStatus)
  /^RSC/,
  // RSCComponent
  /Context$/,
  // LayoutRouterContext
  /^Hot(Reload)?$/,
  // HotReload (exact match to avoid false positives)
  /^(Dev|React)(Overlay|Tools|Root)/,
  // DevTools, ReactDevOverlay
  /Overlay$/,
  // ReactDevOverlay, ErrorOverlay
  /Handler$/,
  // ScrollAndFocusHandler, ErrorBoundaryHandler
  /^With[A-Z]/,
  // withRouter, WithAuth (HOCs)
  /Wrapper$/,
  // Generic wrappers
  /^Root$/
  // Generic Root component
];
var DEFAULT_USER_PATTERNS = [
  /Page$/,
  // HomePage, InstallPage
  /View$/,
  // ListView, DetailView
  /Screen$/,
  // HomeScreen
  /Section$/,
  // HeroSection
  /Card$/,
  // ProductCard
  /List$/,
  // UserList
  /Item$/,
  // ListItem, MenuItem
  /Form$/,
  // LoginForm
  /Modal$/,
  // ConfirmModal
  /Dialog$/,
  // AlertDialog
  /Button$/,
  // SubmitButton (but not all buttons)
  /Nav$/,
  // SideNav, TopNav
  /Header$/,
  // PageHeader
  /Footer$/,
  // PageFooter
  /Layout$/,
  // MainLayout (careful - could be framework)
  /Panel$/,
  // SidePanel
  /Tab$/,
  // SettingsTab
  /Menu$/
  // DropdownMenu
];
function resolveConfig(config) {
  const mode = config?.mode ?? "filtered";
  let skipExact = DEFAULT_SKIP_EXACT;
  if (config?.skipExact) {
    const additional = config.skipExact instanceof Set ? config.skipExact : new Set(config.skipExact);
    skipExact = /* @__PURE__ */ new Set([...DEFAULT_SKIP_EXACT, ...additional]);
  }
  return {
    maxComponents: config?.maxComponents ?? 6,
    maxDepth: config?.maxDepth ?? 30,
    mode,
    skipExact,
    skipPatterns: config?.skipPatterns ? [...DEFAULT_SKIP_PATTERNS, ...config.skipPatterns] : DEFAULT_SKIP_PATTERNS,
    userPatterns: config?.userPatterns ?? DEFAULT_USER_PATTERNS,
    filter: config?.filter
  };
}
function normalizeComponentName(name) {
  return name.replace(/([a-z])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase();
}
function getAncestorClasses(element, maxDepth = 10) {
  const classes = /* @__PURE__ */ new Set();
  let current = element;
  let depth = 0;
  while (current && depth < maxDepth) {
    if (current.className && typeof current.className === "string") {
      current.className.split(/\s+/).forEach((cls) => {
        if (cls.length > 1) {
          const normalized = cls.replace(/[_][a-zA-Z0-9]{5,}.*$/, "").toLowerCase();
          if (normalized.length > 1) {
            classes.add(normalized);
          }
        }
      });
    }
    current = current.parentElement;
    depth++;
  }
  return classes;
}
function componentCorrelatesWithDOM(componentName, domClasses) {
  const normalized = normalizeComponentName(componentName);
  for (const cls of domClasses) {
    if (cls === normalized) return true;
    const componentWords = normalized.split("-").filter((w) => w.length > 2);
    const classWords = cls.split("-").filter((w) => w.length > 2);
    for (const cWord of componentWords) {
      for (const dWord of classWords) {
        if (cWord === dWord || cWord.includes(dWord) || dWord.includes(cWord)) {
          return true;
        }
      }
    }
  }
  return false;
}
function shouldIncludeComponent(name, depth, config, domClasses) {
  if (config.filter) {
    return config.filter(name, depth);
  }
  switch (config.mode) {
    case "all":
      return true;
    case "filtered":
      if (config.skipExact.has(name)) {
        return false;
      }
      if (config.skipPatterns.some((p) => p.test(name))) {
        return false;
      }
      return true;
    case "smart":
      if (config.skipExact.has(name)) {
        return false;
      }
      if (config.skipPatterns.some((p) => p.test(name))) {
        return false;
      }
      if (domClasses && componentCorrelatesWithDOM(name, domClasses)) {
        return true;
      }
      if (config.userPatterns.some((p) => p.test(name))) {
        return true;
      }
      return false;
    default:
      return true;
  }
}
var reactDetectionCache = null;
var componentCacheAll = /* @__PURE__ */ new WeakMap();
function hasReactFiber(element) {
  return Object.keys(element).some(
    (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$") || key.startsWith("__reactProps$") || key.startsWith("__reactContainer$")
  );
}
function isReactPage() {
  if (reactDetectionCache !== null) {
    return reactDetectionCache;
  }
  if (typeof document === "undefined") {
    return false;
  }
  if (document.body && hasReactFiber(document.body)) {
    reactDetectionCache = true;
    return true;
  }
  const commonRoots = ["#root", "#app", "#__next", "[data-reactroot]"];
  for (const selector of commonRoots) {
    const el = document.querySelector(selector);
    if (el && hasReactFiber(el)) {
      reactDetectionCache = true;
      return true;
    }
  }
  if (document.body) {
    for (const child of document.body.children) {
      if (hasReactFiber(child)) {
        reactDetectionCache = true;
        return true;
      }
    }
  }
  reactDetectionCache = false;
  return false;
}
var componentCacheAllRef = { map: componentCacheAll };
function getReactFiberKey(element) {
  const keys = Object.keys(element);
  return keys.find(
    (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
  ) || null;
}
function getFiberFromElement(element) {
  const key = getReactFiberKey(element);
  if (!key) return null;
  return element[key];
}
function getComponentNameFromType(type) {
  if (!type) return null;
  if (type.displayName) return type.displayName;
  if (type.name) return type.name;
  return null;
}
function getComponentNameFromFiber(fiber) {
  const { tag, type, elementType } = fiber;
  if (tag === FiberTags.HostComponent || tag === FiberTags.HostText || tag === FiberTags.HostHoistable || tag === FiberTags.HostSingleton) {
    return null;
  }
  if (tag === FiberTags.Fragment || tag === FiberTags.Mode || tag === FiberTags.Profiler || tag === FiberTags.DehydratedFragment) {
    return null;
  }
  if (tag === FiberTags.HostRoot || tag === FiberTags.HostPortal || tag === FiberTags.ScopeComponent || tag === FiberTags.OffscreenComponent || tag === FiberTags.LegacyHiddenComponent || tag === FiberTags.CacheComponent || tag === FiberTags.TracingMarkerComponent || tag === FiberTags.Throw || tag === FiberTags.ViewTransitionComponent || tag === FiberTags.ActivityComponent) {
    return null;
  }
  if (tag === FiberTags.ForwardRef) {
    const elType = elementType;
    if (elType?.render) {
      const innerName = getComponentNameFromType(elType.render);
      if (innerName) return innerName;
    }
    if (elType?.displayName) return elType.displayName;
    return getComponentNameFromType(type);
  }
  if (tag === FiberTags.MemoComponent || tag === FiberTags.SimpleMemoComponent) {
    const elType = elementType;
    if (elType?.type) {
      const innerName = getComponentNameFromType(elType.type);
      if (innerName) return innerName;
    }
    if (elType?.displayName) return elType.displayName;
    return getComponentNameFromType(type);
  }
  if (tag === FiberTags.ContextProvider) {
    const elType = type;
    if (elType?._context?.displayName) {
      return `${elType._context.displayName}.Provider`;
    }
    return null;
  }
  if (tag === FiberTags.ContextConsumer) {
    const elType = type;
    if (elType?.displayName) {
      return `${elType.displayName}.Consumer`;
    }
    return null;
  }
  if (tag === FiberTags.LazyComponent) {
    const elType = elementType;
    if (elType?._status === 1 && elType._result) {
      return getComponentNameFromType(elType._result);
    }
    return null;
  }
  if (tag === FiberTags.SuspenseComponent || tag === FiberTags.SuspenseListComponent) {
    return null;
  }
  if (tag === FiberTags.IncompleteClassComponent || tag === FiberTags.IncompleteFunctionComponent) {
    return getComponentNameFromType(type);
  }
  if (tag === FiberTags.FunctionComponent || tag === FiberTags.ClassComponent || tag === FiberTags.IndeterminateComponent) {
    return getComponentNameFromType(type);
  }
  return null;
}
function isMinifiedName(name) {
  if (name.length <= 2) return true;
  if (name.length <= 3 && name === name.toLowerCase()) return true;
  return false;
}
function getReactComponentName(element, config) {
  const resolved = resolveConfig(config);
  const useCache = resolved.mode === "all";
  if (useCache) {
    const cached = componentCacheAllRef.map.get(element);
    if (cached !== void 0) {
      return cached;
    }
  }
  if (!isReactPage()) {
    const result2 = { path: null, components: [] };
    if (useCache) {
      componentCacheAllRef.map.set(element, result2);
    }
    return result2;
  }
  const domClasses = resolved.mode === "smart" ? getAncestorClasses(element) : void 0;
  const components = [];
  try {
    let fiber = getFiberFromElement(element);
    let depth = 0;
    while (fiber && depth < resolved.maxDepth && components.length < resolved.maxComponents) {
      const name = getComponentNameFromFiber(fiber);
      if (name && !isMinifiedName(name) && shouldIncludeComponent(name, depth, resolved, domClasses)) {
        components.push(name);
      }
      fiber = fiber.return;
      depth++;
    }
  } catch {
    const result2 = { path: null, components: [] };
    if (useCache) {
      componentCacheAllRef.map.set(element, result2);
    }
    return result2;
  }
  if (components.length === 0) {
    const result2 = { path: null, components: [] };
    if (useCache) {
      componentCacheAllRef.map.set(element, result2);
    }
    return result2;
  }
  const path = components.slice().reverse().map((c) => `<${c}>`).join(" ");
  const result = { path, components };
  if (useCache) {
    componentCacheAllRef.map.set(element, result);
  }
  return result;
}

// src/utils/source-location.ts
var React = __toESM(require("react"));
var FIBER_TAGS = {
  FunctionComponent: 0,
  ClassComponent: 1,
  IndeterminateComponent: 2,
  HostRoot: 3,
  HostPortal: 4,
  HostComponent: 5,
  HostText: 6,
  Fragment: 7,
  Mode: 8,
  ContextConsumer: 9,
  ContextProvider: 10,
  ForwardRef: 11,
  Profiler: 12,
  SuspenseComponent: 13,
  MemoComponent: 14,
  SimpleMemoComponent: 15,
  LazyComponent: 16
};
function getFiberFromElement2(element) {
  if (!element || typeof element !== "object") {
    return null;
  }
  const keys = Object.keys(element);
  const fiberKey = keys.find((key) => key.startsWith("__reactFiber$"));
  if (fiberKey) {
    return element[fiberKey] || null;
  }
  const instanceKey = keys.find((key) => key.startsWith("__reactInternalInstance$"));
  if (instanceKey) {
    return element[instanceKey] || null;
  }
  const possibleFiberKey = keys.find((key) => {
    if (!key.startsWith("__react")) return false;
    const value = element[key];
    return value && typeof value === "object" && "_debugSource" in value;
  });
  if (possibleFiberKey) {
    return element[possibleFiberKey] || null;
  }
  return null;
}
function getComponentName(fiber) {
  if (!fiber.type) {
    return null;
  }
  if (typeof fiber.type === "string") {
    return null;
  }
  if (typeof fiber.type === "object" || typeof fiber.type === "function") {
    const type = fiber.type;
    if (type.displayName) {
      return type.displayName;
    }
    if (type.name) {
      return type.name;
    }
  }
  return null;
}
function findDebugSource(fiber, maxDepth = 50) {
  let current = fiber;
  let depth = 0;
  while (current && depth < maxDepth) {
    if (current._debugSource) {
      return {
        source: current._debugSource,
        componentName: getComponentName(current)
      };
    }
    if (current._debugOwner?._debugSource) {
      return {
        source: current._debugOwner._debugSource,
        componentName: getComponentName(current._debugOwner)
      };
    }
    current = current.return;
    depth++;
  }
  return null;
}
function findDebugSourceReact19(fiber) {
  let current = fiber;
  let depth = 0;
  const maxDepth = 50;
  while (current && depth < maxDepth) {
    const anyFiber = current;
    const possibleSourceKeys = [
      "_debugSource",
      "__source",
      "_source",
      "debugSource"
    ];
    for (const key of possibleSourceKeys) {
      const source = anyFiber[key];
      if (source && typeof source === "object" && "fileName" in source) {
        return {
          source,
          componentName: getComponentName(current)
        };
      }
    }
    if (current.memoizedProps) {
      const props = current.memoizedProps;
      if (props.__source && typeof props.__source === "object") {
        const source = props.__source;
        if (source.fileName && source.lineNumber) {
          return {
            source: {
              fileName: source.fileName,
              lineNumber: source.lineNumber,
              columnNumber: source.columnNumber
            },
            componentName: getComponentName(current)
          };
        }
      }
    }
    current = current.return;
    depth++;
  }
  return null;
}
var sourceProbeCache = /* @__PURE__ */ new Map();
function unwrapComponentType(fiber) {
  const tag = fiber.tag;
  const type = fiber.type;
  const elementType = fiber.elementType;
  if (typeof type === "string" || type == null) return null;
  if (typeof type === "function" && type.prototype?.isReactComponent) {
    return null;
  }
  if ((tag === FIBER_TAGS.FunctionComponent || tag === FIBER_TAGS.IndeterminateComponent) && typeof type === "function") {
    return type;
  }
  if (tag === FIBER_TAGS.ForwardRef && elementType) {
    const render = elementType.render;
    if (typeof render === "function") return render;
  }
  if ((tag === FIBER_TAGS.MemoComponent || tag === FIBER_TAGS.SimpleMemoComponent) && elementType) {
    const inner = elementType.type;
    if (typeof inner === "function") return inner;
  }
  if (typeof type === "function") return type;
  return null;
}
function getReactDispatcher() {
  const reactModule = React;
  const r19 = reactModule.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (r19 && "H" in r19) {
    return {
      get: () => r19.H,
      set: (d) => {
        r19.H = d;
      }
    };
  }
  const r18 = reactModule.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  if (r18) {
    const dispatcher = r18.ReactCurrentDispatcher;
    if (dispatcher && "current" in dispatcher) {
      return {
        get: () => dispatcher.current,
        set: (d) => {
          dispatcher.current = d;
        }
      };
    }
  }
  return null;
}
function parseComponentFrame(stack, functionName) {
  const lines = stack.split("\n");
  const skipPatterns = [
    /source-location/,
    /\/dist\/index\./,
    // Our bundled output (dist/index.mjs, dist/index.js)
    /node_modules\//,
    // Any package in node_modules
    /react-dom/,
    /react\.development/,
    /react\.production/,
    /chunk-[A-Z0-9]+/i,
    /\/_next\/static\/chunks\//,
    /\/\.vite\/deps\//,
    /\/_astro\//,
    /\/assets\/[^\s/]+[-.][\w-]{8,}\.m?js(?:[?:]|$)/,
    /react-stack-bottom-frame/,
    /react-reconciler/,
    /scheduler/,
    /<anonymous>/
    // Proxy handler frames
  ];
  const v8Re = /^\s*at\s+(?:.*?\s+\()?(.+?):(\d+):(\d+)\)?$/;
  const webkitRe = /^[^@]*@(.+?):(\d+):(\d+)$/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (skipPatterns.some((p) => p.test(trimmed))) continue;
    if (functionName) {
      const name = functionName.replace(/^bound /, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`(?:at (?:Object\\.)?|^)${name}(?: \\(|@| \\[)`).test(trimmed)) continue;
    }
    const match = v8Re.exec(trimmed) || webkitRe.exec(trimmed);
    if (match) {
      return {
        fileName: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10)
      };
    }
  }
  return null;
}
function cleanSourcePath(rawPath) {
  let path = rawPath;
  path = path.replace(/[?#].*$/, "");
  path = path.replace(/^turbopack:\/\/\/\[project\]\//, "");
  path = path.replace(/^webpack-internal:\/\/\/\.\//, "");
  path = path.replace(/^webpack-internal:\/\/\//, "");
  path = path.replace(/^webpack:\/\/\/\.\//, "");
  path = path.replace(/^webpack:\/\/\//, "");
  path = path.replace(/^turbopack:\/\/\//, "");
  path = path.replace(/^https?:\/\/[^/]+\//, "");
  path = path.replace(/^file:\/\/\//, "/");
  path = path.replace(/^\([^)]+\)\/\.\//, "");
  path = path.replace(/^\.\//, "");
  return path;
}
function probeComponentSource(fiber) {
  const fn = unwrapComponentType(fiber);
  if (!fn) return null;
  if (sourceProbeCache.has(fn)) {
    return sourceProbeCache.get(fn);
  }
  const dispatcher = getReactDispatcher();
  if (!dispatcher) {
    sourceProbeCache.set(fn, null);
    return null;
  }
  const original = dispatcher.get();
  let result = null;
  try {
    const stackCapturingDispatcher = new Proxy(
      {},
      {
        get() {
          throw new Error("probe");
        }
      }
    );
    dispatcher.set(stackCapturingDispatcher);
    try {
      fn({});
    } catch (e) {
      if (e instanceof Error && e.message === "probe" && e.stack) {
        const frame = parseComponentFrame(e.stack, fn.name);
        if (frame) {
          const cleaned = cleanSourcePath(frame.fileName);
          result = {
            fileName: cleaned,
            lineNumber: frame.line,
            columnNumber: frame.column,
            componentName: getComponentName(fiber) || void 0
          };
        }
      }
    }
  } finally {
    dispatcher.set(original);
  }
  sourceProbeCache.set(fn, result);
  return result;
}
function probeSourceWalk(fiber, maxDepth = 15) {
  let current = fiber;
  let depth = 0;
  while (current && depth < maxDepth) {
    const source = probeComponentSource(current);
    if (source) return source;
    current = current.return;
    depth++;
  }
  return null;
}
function getSourceLocation(element) {
  const fiber = getFiberFromElement2(element);
  if (!fiber) {
    return {
      found: false,
      reason: "no-fiber",
      isReactApp: false,
      isProduction: false
    };
  }
  let debugInfo = findDebugSource(fiber);
  if (!debugInfo) {
    debugInfo = findDebugSourceReact19(fiber);
  }
  if (debugInfo?.source) {
    return {
      found: true,
      source: {
        fileName: debugInfo.source.fileName,
        lineNumber: debugInfo.source.lineNumber,
        columnNumber: debugInfo.source.columnNumber,
        componentName: debugInfo.componentName || void 0
      },
      isReactApp: true,
      isProduction: false
    };
  }
  const probed = probeSourceWalk(fiber);
  if (probed) {
    return { found: true, source: probed, isReactApp: true, isProduction: false };
  }
  return {
    found: false,
    reason: "no-debug-source",
    isReactApp: true,
    isProduction: false
  };
}
function formatSourceLocation(source, format = "path") {
  const { fileName, lineNumber, columnNumber } = source;
  let location = `${fileName}:${lineNumber}`;
  if (columnNumber !== void 0) {
    location += `:${columnNumber}`;
  }
  if (format === "vscode") {
    return `vscode://file${fileName.startsWith("/") ? "" : "/"}${location}`;
  }
  return location;
}
function findNearestComponentSource(element, maxAncestors = 10) {
  let current = element;
  let depth = 0;
  while (current && depth < maxAncestors) {
    const result = getSourceLocation(current);
    if (result.found) {
      return result;
    }
    current = current.parentElement;
    depth++;
  }
  return getSourceLocation(element);
}

// src/utils/generate-output.ts
var OUTPUT_DETAIL_OPTIONS = [
  { value: "compact", label: "Compact" },
  { value: "standard", label: "Standard" },
  { value: "detailed", label: "Detailed" },
  { value: "forensic", label: "Forensic" }
];
function generateOutputHeader(pathname, appName) {
  let output = `## Page Feedback: ${pathname}
`;
  const name = appName?.replace(/[\r\n\t]+/g, " ").trim();
  if (name) output += `**App:** ${name.replace(/[\\`*_\[\]<>]/g, "\\$&")}
`;
  return output;
}
function generateOutput(annotations, pathname, detailLevel = "standard", options = {}) {
  if (annotations.length === 0) return "";
  const viewport = typeof window !== "undefined" ? `${window.innerWidth}\xD7${window.innerHeight}` : "unknown";
  let output = generateOutputHeader(pathname, options.appName);
  if (detailLevel === "forensic") {
    output += `
**Environment:**
`;
    output += `- Viewport: ${viewport}
`;
    if (typeof window !== "undefined") {
      output += `- URL: ${window.location.href}
`;
      output += `- User Agent: ${navigator.userAgent}
`;
      output += `- Timestamp: ${(/* @__PURE__ */ new Date()).toISOString()}
`;
      output += `- Device Pixel Ratio: ${window.devicePixelRatio}
`;
    }
    output += `
---
`;
  } else if (detailLevel !== "compact") {
    output += `**Viewport:** ${viewport}
`;
  }
  output += "\n";
  annotations.forEach((a, i) => {
    if (detailLevel === "compact") {
      output += `${i + 1}. **${a.element}**${a.sourceFile ? ` (${a.sourceFile})` : ""}: ${a.comment}`;
      if (a.selectedText) {
        output += ` (re: "${a.selectedText.slice(0, 30)}${a.selectedText.length > 30 ? "..." : ""}")`;
      }
      output += "\n";
    } else if (detailLevel === "forensic") {
      output += `### ${i + 1}. ${a.element}
`;
      if (a.isMultiSelect && a.fullPath) {
        output += `*Forensic data shown for first element of selection*
`;
      }
      if (a.fullPath) {
        output += `**Full DOM Path:** ${a.fullPath}
`;
      }
      if (a.cssClasses) {
        output += `**CSS Classes:** ${a.cssClasses}
`;
      }
      if (a.boundingBox) {
        output += `**Position:** x:${Math.round(a.boundingBox.x)}, y:${Math.round(a.boundingBox.y)} (${Math.round(a.boundingBox.width)}\xD7${Math.round(a.boundingBox.height)}px)
`;
      }
      output += `**Annotation at:** ${a.x.toFixed(1)}% from left, ${Math.round(a.y)}px from top
`;
      if (a.selectedText) {
        output += `**Selected text:** "${a.selectedText}"
`;
      }
      if (a.nearbyText && !a.selectedText) {
        output += `**Context:** ${a.nearbyText.slice(0, 100)}
`;
      }
      if (a.computedStyles) {
        output += `**Computed Styles:** ${a.computedStyles}
`;
      }
      if (a.accessibility) {
        output += `**Accessibility:** ${a.accessibility}
`;
      }
      if (a.nearbyElements) {
        output += `**Nearby Elements:** ${a.nearbyElements}
`;
      }
      if (a.sourceFile) {
        output += `**Source:** ${a.sourceFile}
`;
      }
      if (a.reactComponents) {
        output += `**React:** ${a.reactComponents}
`;
      }
      output += `**Feedback:** ${a.comment}

`;
    } else {
      output += `### ${i + 1}. ${a.element}
`;
      output += `**Location:** ${a.elementPath}
`;
      if (a.sourceFile) {
        output += `**Source:** ${a.sourceFile}
`;
      }
      if (a.reactComponents) {
        output += `**React:** ${a.reactComponents}
`;
      }
      if (detailLevel === "detailed") {
        if (a.cssClasses) {
          output += `**Classes:** ${a.cssClasses}
`;
        }
        if (a.boundingBox) {
          output += `**Position:** ${Math.round(a.boundingBox.x)}px, ${Math.round(a.boundingBox.y)}px (${Math.round(a.boundingBox.width)}\xD7${Math.round(a.boundingBox.height)}px)
`;
        }
      }
      if (a.selectedText) {
        output += `**Selected text:** "${a.selectedText}"
`;
      }
      if (detailLevel === "detailed" && a.nearbyText && !a.selectedText) {
        output += `**Context:** ${a.nearbyText.slice(0, 100)}
`;
      }
      output += `**Feedback:** ${a.comment}

`;
    }
  });
  return output.trim();
}

// src/utils/copy-format.ts
function formatCopyOutput(annotations, markdown, format = "markdown") {
  if (format === "markdown") return markdown;
  return [
    ...new Set(
      annotations.map((annotation) => {
        if (format === "source") return annotation.sourceFile;
        if (format === "classes") return annotation.cssClasses;
        return annotation.attributes?.[format.attribute];
      }).filter((value) => typeof value === "string" && value.length > 0)
    )
  ].join("\n");
}

// src/utils/clipboard.ts
async function copyTextToClipboard(text) {
  if (typeof window === "undefined") return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
  }
  return copyTextViaExecCommand(text);
}
function copyTextViaExecCommand(text) {
  const textarea = document.createElement("textarea");
  let activeElement = document.activeElement;
  while (activeElement?.shadowRoot?.activeElement) {
    activeElement = activeElement.shadowRoot.activeElement;
  }
  const input = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement ? activeElement : null;
  const inputSelection = input && input.selectionStart !== null ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : null;
  const selection = document.getSelection();
  const previousRanges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  try {
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;";
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement && activeElement.isConnected) {
      activeElement.focus({ preventScroll: true });
      if (input && inputSelection) {
        input.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction);
      }
    }
    if (selection) {
      selection.removeAllRanges();
      for (const range of previousRanges) selection.addRange(range);
    }
  }
}

// src/utils/shadow-sync.ts
function pagePath(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url, "http://agentation.invalid");
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return url;
  }
}
function createShadowSync(transport, ids, existing = []) {
  const entries = /* @__PURE__ */ new Map();
  const unclaimed = new Map(existing.map((annotation) => [annotation.id, annotation]));
  let disposed = false;
  async function flush(id, entry) {
    if (disposed || entry.running || entry.timer) return;
    const desired = entry.desired;
    const serverId = ids.get(id);
    if (!desired && !serverId) {
      entries.delete(id);
      ids.delete(id);
      return;
    }
    const signature = desired ? JSON.stringify(desired) : void 0;
    if (desired && serverId && entry.synced === signature) return;
    entry.running = true;
    try {
      if (!desired) {
        await transport.remove(serverId);
        ids.delete(id);
        entry.synced = void 0;
      } else if (!serverId) {
        ids.set(id, "");
        const created = await transport.create(desired);
        ids.set(id, created.id);
        entry.synced = signature;
      } else {
        await transport.update(serverId, desired);
        entry.synced = signature;
      }
      entry.retries = 0;
      entry.running = false;
      if (!disposed && entries.get(id) === entry) void flush(id, entry);
    } catch (error) {
      entry.running = false;
      if (!disposed && entries.get(id) === entry) {
        console.warn("[Agentation] Failed to sync layout feedback:", error);
        if (ids.get(id) && entry.retries < 3) {
          const delay = 500 * 2 ** entry.retries++;
          entry.timer = originalSetTimeout(() => {
            entry.timer = void 0;
            void flush(id, entry);
          }, delay);
        }
      }
    }
  }
  return {
    replace(annotations) {
      const desired = new Map(annotations.map((annotation) => [annotation.id, annotation]));
      for (const [id, annotation] of desired) {
        let entry = entries.get(id);
        if (!entry) {
          entry = { running: false, retries: 0 };
          entries.set(id, entry);
          const saved = [...unclaimed.values()].find((remote) => remote.kind === annotation.kind && pagePath(remote.url) === pagePath(annotation.url) && (annotation.kind === "placement" ? remote.timestamp === annotation.timestamp && remote.element === annotation.element : remote.element === annotation.element));
          if (saved) {
            ids.set(id, saved.id);
            unclaimed.delete(saved.id);
          }
        }
        if (JSON.stringify(entry.desired) !== JSON.stringify(annotation)) {
          entry.retries = 0;
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = void 0;
        }
        entry.desired = annotation;
      }
      for (const [id, entry] of entries) {
        if (!desired.has(id)) entry.desired = void 0;
        void flush(id, entry);
      }
    },
    forget(id) {
      const entry = entries.get(id);
      if (entry?.timer) clearTimeout(entry.timer);
      entries.delete(id);
      ids.delete(id);
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
    }
  };
}

// src/utils/session-resolutions.ts
function subscribeSessionResolutions(endpoint, sessionId, hasPending, onResolved) {
  let disposed = false;
  let disconnect;
  let retry;
  let retryDelay = 1e3;
  let request;
  const apply = (annotation) => {
    if (!disposed && (annotation?.status === "resolved" || annotation?.status === "dismissed")) {
      onResolved(annotation);
    }
  };
  const reconcile = async () => {
    if (disposed || request || !hasPending()) return;
    const current = new AbortController();
    request = current;
    const timeout = originalSetTimeout(() => current.abort(), 5e3);
    try {
      const response = await fetch(`${endpoint}/sessions/${sessionId}`, { signal: current.signal });
      if (!response.ok) return;
      const session = await response.json();
      if (!disposed && !current.signal.aborted && Array.isArray(session.annotations)) {
        session.annotations.forEach(apply);
      }
    } catch {
    } finally {
      clearTimeout(timeout);
      if (request === current) request = void 0;
    }
  };
  const connect = () => {
    if (disposed) return;
    const source = new EventSource(`${endpoint}/sessions/${sessionId}/events`);
    const open = () => {
      retryDelay = 1e3;
      void reconcile();
    };
    const update = (event) => {
      try {
        apply(JSON.parse(event.data).payload);
      } catch {
      }
    };
    const error = () => {
      if (source.readyState !== EventSource.CLOSED || disposed || retry !== void 0) return;
      disconnect?.();
      retry = originalSetTimeout(() => {
        retry = void 0;
        connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 1e4);
    };
    source.addEventListener("open", open);
    source.addEventListener("annotation.updated", update);
    source.addEventListener("error", error);
    disconnect = () => {
      source.removeEventListener("open", open);
      source.removeEventListener("annotation.updated", update);
      source.removeEventListener("error", error);
      source.close();
    };
  };
  connect();
  const interval = originalSetInterval(() => {
    void reconcile();
  }, 1e4);
  return () => {
    disposed = true;
    disconnect?.();
    if (retry !== void 0) clearTimeout(retry);
    clearInterval(interval);
    request?.abort();
  };
}

// src/components/page-toolbar-css/annotation-card/index.tsx
var import_react14 = require("react");

// src/components/page-toolbar-css/annotation-card/styles.module.scss
var css6 = ".styles-module__surface___7qnpJ {\n  padding: 0;\n  width: var(--preview-width, 200px);\n  max-width: calc(100vw - 24px);\n  overflow: auto;\n  opacity: 0;\n  visibility: hidden;\n  pointer-events: none;\n  border-radius: 12px;\n  z-index: inherit;\n  will-change: auto;\n  transform: translateX(-50%);\n  transition: left 200ms cubic-bezier(0.2, 0.8, 0.2, 1), top 200ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), width 200ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 100ms ease-out, visibility 0s 200ms;\n}\n.styles-module__surface___7qnpJ[data-positioning] {\n  transition: none;\n}\n.styles-module__surface___7qnpJ[data-direct-entry] *, .styles-module__surface___7qnpJ[data-direct-entry] *::before, .styles-module__surface___7qnpJ[data-direct-entry] *::after {\n  transition: none !important;\n}\n.styles-module__surface___7qnpJ[data-state=preview], .styles-module__surface___7qnpJ[data-state=edit] {\n  opacity: 1;\n  visibility: visible;\n  transition-delay: 0s;\n}\n.styles-module__surface___7qnpJ[data-state=edit], .styles-module__surface___7qnpJ[data-annotation-popup][data-state=hidden] {\n  width: 280px;\n  border-radius: 16px;\n}\n.styles-module__surface___7qnpJ[data-state=edit] {\n  pointer-events: auto;\n}\n.styles-module__surface___7qnpJ[data-state=preview] {\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);\n}\n[data-agentation-theme=light] .styles-module__surface___7qnpJ[data-state=preview] {\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.06);\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .styles-module__surface___7qnpJ {\n    transition: opacity 100ms ease-out, visibility 0s 100ms;\n  }\n}";
var styles_module_default5 = { "surface": "styles-module__surface___7qnpJ" };

// src/components/page-toolbar-css/annotation-card/index.tsx
var import_jsx_runtime12 = require("react/jsx-runtime");
var AnnotationCard = (0, import_react14.forwardRef)(function AnnotationCard2({
  annotation,
  editing,
  exiting,
  restorePreview,
  editorProps,
  lightMode,
  scrollY,
  onExited
}, ref) {
  const previous = (0, import_react14.useRef)({ annotation, editorProps });
  const displayed = annotation ?? previous.current.annotation;
  const formProps = annotation ? editorProps : previous.current.editorProps;
  const surfaceRef = (0, import_react14.useRef)(null);
  const editorRef = (0, import_react14.useRef)(null);
  const previousId = (0, import_react14.useRef)();
  const previousScroll = (0, import_react14.useRef)(scrollY);
  const mode = editing && !exiting ? "edit" : annotation && (!editing || restorePreview) ? "preview" : "hidden";
  const preview = mode === "preview" || !editing;
  (0, import_react14.useLayoutEffect)(() => {
    if (annotation) previous.current = { annotation, editorProps };
  }, [annotation, editorProps]);
  (0, import_react14.useLayoutEffect)(() => {
    const surface = surfaceRef.current;
    if (!surface || !displayed) return;
    const directEntry = mode === "edit" && (previousId.current !== displayed.id || surface.dataset.state === "hidden" && getComputedStyle(surface).opacity === "0");
    if (directEntry) surface.dataset.directEntry = "true";
    const position = () => {
      const x = displayed.x / 100 * window.innerWidth;
      const y = displayed.isFixed ? displayed.y : displayed.y - scrollY;
      const showingPreview = mode === "preview" || !editing;
      const previewWidth = parseFloat(surface.style.getPropertyValue("--preview-width")) || 200;
      const compactWidth = Math.min(previewWidth, window.innerWidth - 24);
      const previewLeft = Math.max(12, Math.min(
        window.innerWidth - compactWidth - 12,
        x - compactWidth / 2
      ));
      const width = showingPreview ? compactWidth : Math.min(280, window.innerWidth - 24);
      const margin = Math.min(showingPreview ? 12 : 20, (window.innerWidth - width) / 2);
      const above = y > window.innerHeight - (showingPreview ? 101 : 290);
      surface.style.left = `${Math.max(margin, Math.min(window.innerWidth - width - margin, previewLeft))}px`;
      surface.style.right = "auto";
      surface.style.top = `${Math.max(12, Math.min(window.innerHeight - 12, y + (above ? -21 : 21)))}px`;
      surface.style.bottom = "auto";
      surface.style.transform = above ? "translateY(-100%)" : "translateY(0)";
      surface.style.maxHeight = `${Math.max(100, above ? y - 33 : window.innerHeight - y - 33)}px`;
    };
    const jump = previousId.current !== displayed.id || previousScroll.current !== scrollY || surface.dataset.state === "hidden";
    if (jump) surface.dataset.positioning = "true";
    position();
    if (jump || directEntry) surface.getBoundingClientRect();
    delete surface.dataset.positioning;
    delete surface.dataset.directEntry;
    surface.dataset.state = mode;
    surface.inert = mode !== "edit";
    previousId.current = displayed.id;
    previousScroll.current = scrollY;
    const onResize = () => {
      surface.dataset.positioning = "true";
      position();
      surface.getBoundingClientRect();
      delete surface.dataset.positioning;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [
    displayed?.id,
    displayed?.x,
    displayed?.y,
    displayed?.isFixed,
    mode,
    editing,
    scrollY,
    displayed?.comment
  ]);
  (0, import_react14.useLayoutEffect)(() => {
    if (editing && !exiting) editorRef.current?.focus();
  }, [editing, exiting, displayed?.id]);
  useExitCompletion(surfaceRef, exiting, onExited);
  (0, import_react14.useImperativeHandle)(
    ref,
    () => ({
      shake() {
        surfaceRef.current?.animate?.(
          [
            { translate: "0px" },
            { translate: "-3px" },
            { translate: "3px" },
            { translate: "-2px" },
            { translate: "2px" },
            { translate: "0px" }
          ],
          { duration: 250 }
        );
        editorRef.current?.focus();
      }
    }),
    []
  );
  if (!displayed || !formProps) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(
    "div",
    {
      ref: surfaceRef,
      className: `${styles_module_default.popup} ${styles_module_default5.surface} ${lightMode ? styles_module_default.light : ""}`,
      "data-feedback-toolbar": true,
      "data-annotation-card": true,
      "data-annotation-popup": editing ? "" : void 0,
      "data-state": "hidden",
      "aria-hidden": mode === "hidden",
      onClick: (event) => event.stopPropagation(),
      onKeyDownCapture: (event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing || !editing)
          return;
        event.preventDefault();
        event.stopPropagation();
        formProps.onCancel();
      },
      children: /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(
        AnnotationEditor,
        {
          ref: editorRef,
          ...formProps,
          variant: "card",
          preview,
          resetOnPreview: !editing,
          disabled: !editing || exiting
        },
        displayed.id
      )
    }
  );
});

// src/components/page-toolbar-css/annotation-marker/index.tsx
var import_react15 = require("react");

// src/components/page-toolbar-css/annotation-marker/styles.module.scss
var css7 = "@keyframes styles-module__markerIn___x4G8D {\n  0% {\n    opacity: 0;\n    transform: translate(-50%, -50%) scale(0.3);\n  }\n  100% {\n    opacity: 1;\n    transform: translate(-50%, -50%) scale(1);\n  }\n}\n@keyframes styles-module__markerOut___6VhQN {\n  0% {\n    opacity: 1;\n    transform: translate(-50%, -50%) scale(1);\n  }\n  100% {\n    opacity: 0;\n    transform: translate(-50%, -50%) scale(0.3);\n  }\n}\n@keyframes styles-module__renumberRoll___akV9B {\n  0% {\n    transform: translateX(-40%);\n    opacity: 0;\n  }\n  100% {\n    transform: translateX(0);\n    opacity: 1;\n  }\n}\n.styles-module__marker___9CKF7 {\n  padding: 0;\n  border: 0;\n  box-sizing: border-box;\n  font-family: inherit;\n  line-height: 1;\n  text-align: center;\n  appearance: none;\n  position: absolute;\n  width: 22px;\n  height: 22px;\n  background: var(--agentation-color-blue);\n  color: white;\n  border-radius: 50%;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-size: 0.6875rem;\n  font-weight: 600;\n  transform: translate(-50%, -50%) scale(1);\n  opacity: 1;\n  cursor: pointer;\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2), inset 0 0 0 1px rgba(0, 0, 0, 0.04);\n  -webkit-user-select: none;\n  user-select: none;\n  will-change: transform, opacity;\n  contain: layout style;\n  z-index: 1;\n}\n.styles-module__marker___9CKF7 > * {\n  pointer-events: none;\n}\n.styles-module__marker___9CKF7:focus-visible {\n  outline: 2px solid var(--agentation-color-accent);\n  outline-offset: 3px;\n}\n.styles-module__marker___9CKF7:hover, .styles-module__marker___9CKF7:focus-visible, .styles-module__marker___9CKF7.styles-module__previewVisible___imMag {\n  z-index: 2;\n}\n.styles-module__marker___9CKF7:not(.styles-module__enter___8kI3q):not(.styles-module__exit___KBdR3):not(.styles-module__clearing___8rM7K):not(.styles-module__confirm___BtMvq) {\n  transition: background-color 0.15s ease, transform 0.1s ease, z-index 0s 0.1s;\n}\n.styles-module__marker___9CKF7:not(.styles-module__enter___8kI3q):not(.styles-module__exit___KBdR3):not(.styles-module__clearing___8rM7K):not(.styles-module__confirm___BtMvq):hover, .styles-module__marker___9CKF7:not(.styles-module__enter___8kI3q):not(.styles-module__exit___KBdR3):not(.styles-module__clearing___8rM7K):not(.styles-module__confirm___BtMvq):focus-visible, .styles-module__marker___9CKF7:not(.styles-module__enter___8kI3q):not(.styles-module__exit___KBdR3):not(.styles-module__clearing___8rM7K):not(.styles-module__confirm___BtMvq).styles-module__previewVisible___imMag {\n  transition-delay: 0s;\n}\n.styles-module__marker___9CKF7.styles-module__enter___8kI3q {\n  animation: styles-module__markerIn___x4G8D 0.25s cubic-bezier(0.22, 1, 0.36, 1) both;\n}\n.styles-module__marker___9CKF7.styles-module__confirm___BtMvq {\n  animation: styles-module__markerConfirm___RT4Sk 220ms ease-out both;\n}\n.styles-module__marker___9CKF7.styles-module__exit___KBdR3 {\n  animation: styles-module__markerOut___6VhQN 0.2s ease-out both;\n  pointer-events: none;\n}\n.styles-module__marker___9CKF7.styles-module__clearing___8rM7K {\n  animation: styles-module__markerOut___6VhQN 0.15s ease-out both;\n  pointer-events: none;\n}\n.styles-module__marker___9CKF7:not(.styles-module__enter___8kI3q):not(.styles-module__exit___KBdR3):not(.styles-module__clearing___8rM7K):not(.styles-module__confirm___BtMvq):hover {\n  transform: translate(-50%, -50%) scale(1.1);\n}\n.styles-module__marker___9CKF7.styles-module__pending___BiY-U {\n  background-color: var(--agentation-color-blue);\n  cursor: default;\n}\n.styles-module__marker___9CKF7.styles-module__pending___BiY-U.styles-module__exit___KBdR3 {\n  animation-duration: 150ms;\n}\n.styles-module__marker___9CKF7.styles-module__multiSelect___CPfTC {\n  background-color: var(--agentation-color-green);\n  width: 26px;\n  height: 26px;\n  border-radius: 6px;\n  font-size: 0.75rem;\n}\n.styles-module__marker___9CKF7.styles-module__multiSelect___CPfTC.styles-module__pending___BiY-U {\n  background-color: var(--agentation-color-green);\n}\n.styles-module__marker___9CKF7.styles-module__hovered___-mg2N {\n  background-color: var(--agentation-color-red);\n}\n\n.styles-module__renumber___16lvD {\n  display: block;\n  animation: styles-module__renumberRoll___akV9B 0.2s ease-out;\n}\n\n@keyframes styles-module__markerConfirm___RT4Sk {\n  0% {\n    transform: translate(-50%, -50%) scale(1);\n  }\n  25% {\n    transform: translate(-50%, -50%) scale(0.94);\n  }\n  65% {\n    transform: translate(-50%, -50%) scale(1.06);\n  }\n  100% {\n    transform: translate(-50%, -50%) scale(1);\n  }\n}\n.styles-module__number___1JFu9 {\n  display: block;\n}\n\n.styles-module__numberGlyph___qchdk {\n  display: block;\n  opacity: 1;\n  transform: translateY(0);\n  filter: blur(0);\n  transition: opacity 140ms ease-out, transform 180ms cubic-bezier(0.22, 1, 0.36, 1), filter 140ms ease-out;\n}\n\n.styles-module__actionGlyph___AFRt0 {\n  position: absolute;\n  inset: 0;\n  display: grid;\n  place-items: center;\n  opacity: 0;\n  transform: translateY(2px) scale(0.8) rotate(-12deg);\n  filter: blur(1px);\n  transition: opacity 120ms ease-out, transform 160ms cubic-bezier(0.22, 1, 0.36, 1), filter 120ms ease-out;\n}\n\n.styles-module__actionVisible___Kb--l .styles-module__numberGlyph___qchdk {\n  opacity: 0;\n  transform: translateY(-2px) scale(0.8);\n  filter: blur(1px);\n}\n.styles-module__actionVisible___Kb--l .styles-module__actionGlyph___AFRt0 {\n  opacity: 1;\n  transform: translateY(0) scale(1) rotate(0);\n  filter: blur(0);\n}\n\n.styles-module__plus___xslMP {\n  position: absolute;\n  inset: 0;\n  display: grid;\n  place-items: center;\n  opacity: 0;\n  transform: rotate(-90deg) scale(0.6);\n  filter: blur(1px);\n  transition: opacity 100ms ease-out, transform 140ms ease-out, filter 100ms ease-out;\n  pointer-events: none;\n}\n\n.styles-module__pending___BiY-U .styles-module__numberGlyph___qchdk {\n  opacity: 0;\n  transform: translateY(5px);\n  filter: blur(2px);\n}\n.styles-module__pending___BiY-U .styles-module__plus___xslMP {\n  opacity: 1;\n  transform: rotate(0) scale(1);\n  filter: blur(0);\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .styles-module__marker___9CKF7.styles-module__enter___8kI3q, .styles-module__marker___9CKF7.styles-module__exit___KBdR3, .styles-module__marker___9CKF7.styles-module__clearing___8rM7K, .styles-module__marker___9CKF7.styles-module__confirm___BtMvq {\n    animation-duration: 1ms;\n    animation-delay: 0ms !important;\n  }\n  .styles-module__numberGlyph___qchdk, .styles-module__actionGlyph___AFRt0, .styles-module__plus___xslMP {\n    transition: opacity 100ms ease-out;\n    transform: none;\n    filter: none;\n  }\n  .styles-module__pending___BiY-U .styles-module__numberGlyph___qchdk, .styles-module__pending___BiY-U .styles-module__plus___xslMP,\n  .styles-module__actionVisible___Kb--l .styles-module__numberGlyph___qchdk, .styles-module__actionVisible___Kb--l .styles-module__actionGlyph___AFRt0 {\n    transform: none;\n    filter: none;\n  }\n}";
var styles_module_default6 = { "marker": "styles-module__marker___9CKF7", "previewVisible": "styles-module__previewVisible___imMag", "enter": "styles-module__enter___8kI3q", "exit": "styles-module__exit___KBdR3", "clearing": "styles-module__clearing___8rM7K", "confirm": "styles-module__confirm___BtMvq", "markerIn": "styles-module__markerIn___x4G8D", "markerConfirm": "styles-module__markerConfirm___RT4Sk", "markerOut": "styles-module__markerOut___6VhQN", "pending": "styles-module__pending___BiY-U", "multiSelect": "styles-module__multiSelect___CPfTC", "hovered": "styles-module__hovered___-mg2N", "renumber": "styles-module__renumber___16lvD", "renumberRoll": "styles-module__renumberRoll___akV9B", "number": "styles-module__number___1JFu9", "numberGlyph": "styles-module__numberGlyph___qchdk", "actionGlyph": "styles-module__actionGlyph___AFRt0", "actionVisible": "styles-module__actionVisible___Kb--l", "plus": "styles-module__plus___xslMP" };

// src/components/page-toolbar-css/annotation-marker/index.tsx
var import_jsx_runtime13 = require("react/jsx-runtime");
var AnnotationMarker = (0, import_react15.memo)(function AnnotationMarker2({
  annotation,
  pending: pending2 = false,
  globalIndex,
  layerIndex,
  layerSize,
  isExiting,
  isClearing,
  isAnimated,
  isNew,
  isHovered,
  isRemoving,
  onRemoveComplete,
  isEditingAny,
  renumberFrom,
  markerClickBehavior,
  onHoverEnter,
  onEnterComplete,
  onHoverLeave,
  onClick,
  onContextMenu
}) {
  const [hasEntered, setHasEntered] = (0, import_react15.useState)(isAnimated);
  const beganPending = (0, import_react15.useRef)(pending2);
  const [hasConfirmed, setHasConfirmed] = (0, import_react15.useState)(false);
  const confirming = beganPending.current && !pending2 && hasEntered && !hasConfirmed;
  (0, import_react15.useLayoutEffect)(() => {
    if (isExiting) setHasEntered(false);
  }, [isExiting]);
  const markerRef = (0, import_react15.useRef)(null);
  const restingContent = (0, import_react15.useRef)({ action: false, delete: false });
  const action = isHovered && !isEditingAny;
  const deleteHover = action && markerClickBehavior === "delete";
  (0, import_react15.useLayoutEffect)(() => {
    if (!isRemoving) restingContent.current = { action, delete: deleteHover };
  }, [isRemoving, action, deleteHover]);
  const showAction = isRemoving ? restingContent.current.action : action;
  const showDeleteHover = isRemoving ? restingContent.current.delete : deleteHover;
  useExitCompletion(markerRef, isRemoving, () => onRemoveComplete(annotation.id));
  const isMulti = annotation.isMultiSelect;
  const markerColor = isMulti ? "var(--agentation-color-green)" : "var(--agentation-color-accent)";
  const animClass = isClearing ? styles_module_default6.clearing : isExiting || isRemoving ? styles_module_default6.exit : confirming ? styles_module_default6.confirm : !isAnimated && !hasEntered ? styles_module_default6.enter : "";
  const animationDelay = isClearing ? `${Math.min(layerIndex * 20, 120)}ms` : isRemoving || pending2 || confirming ? "0ms" : isExiting ? `${(layerSize - 1 - layerIndex) * 20}ms` : `${isNew ? 0 : layerIndex * 20}ms`;
  return /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)(
    "button",
    {
      ref: markerRef,
      type: "button",
      "aria-label": pending2 ? "Pending annotation" : `${markerClickBehavior === "delete" ? "Delete" : "Edit"} annotation ${globalIndex + 1}: ${annotation.element}`,
      disabled: pending2 || isExiting || isRemoving || isClearing,
      tabIndex: pending2 || isEditingAny ? -1 : 0,
      className: `${styles_module_default6.marker} ${pending2 ? styles_module_default6.pending : ""} ${isMulti ? styles_module_default6.multiSelect : ""} ${animClass} ${!pending2 && showAction ? styles_module_default6.actionVisible : ""} ${showDeleteHover ? styles_module_default6.hovered : ""} ${isHovered && !isEditingAny && !isRemoving ? styles_module_default6.previewVisible : ""}`,
      "data-annotation-marker": pending2 ? void 0 : "",
      "data-annotation-pending": pending2 ? "" : void 0,
      style: {
        left: `${annotation.x}%`,
        top: annotation.y,
        backgroundColor: showDeleteHover ? void 0 : markerColor,
        animationDelay
      },
      onAnimationEnd: (event) => {
        if (event.target !== event.currentTarget) return;
        if (animClass === styles_module_default6.enter || animClass === styles_module_default6.confirm) {
          setHasEntered(true);
          if (!pending2) setHasConfirmed(true);
          if (!pending2) onEnterComplete(annotation.id);
        }
      },
      onMouseOver: () => {
        if (!pending2) onHoverEnter(annotation);
      },
      onMouseOut: (event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          onHoverLeave(annotation.id);
        }
      },
      onFocus: (event) => {
        if (!pending2 && event.currentTarget.matches(":focus-visible")) onHoverEnter(annotation);
      },
      onBlur: () => onHoverLeave(annotation.id),
      onClick: (e) => {
        e.stopPropagation();
        if (!pending2 && !isExiting && !isRemoving) onClick(annotation, e.currentTarget);
      },
      onContextMenu: onContextMenu ? (e) => {
        if (markerClickBehavior === "delete") {
          e.preventDefault();
          e.stopPropagation();
          if (!pending2 && !isExiting && !isRemoving) onContextMenu(annotation, e.currentTarget);
        }
      } : void 0,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(
          "span",
          {
            className: `${styles_module_default6.number} ${renumberFrom !== null && globalIndex >= renumberFrom ? styles_module_default6.renumber : ""}`,
            "aria-hidden": "true",
            children: /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("span", { className: styles_module_default6.numberGlyph, children: globalIndex + 1 })
          },
          globalIndex
        ),
        /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("span", { className: styles_module_default6.actionGlyph, "aria-hidden": "true", children: markerClickBehavior === "delete" ? /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(IconXmark, { size: isMulti ? 18 : 16 }) : /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(IconEdit, { size: 16 }) }),
        beganPending.current && /* @__PURE__ */ (0, import_jsx_runtime13.jsx)("span", { className: styles_module_default6.plus, "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(IconPlus, { size: 12 }) })
      ]
    }
  );
});

// src/components/page-toolbar-css/settings-panel/index.tsx
var import_react17 = require("react");

// src/components/switch/styles.module.scss
var css8 = ".styles-module__switchContainer___Ka-AB {\n  display: flex;\n  align-items: center;\n  position: relative;\n  padding: 2px;\n  width: 24px;\n  height: 16px;\n  border-radius: 8px;\n  background-color: #cdcdcd;\n  transition: background-color 0.15s, opacity 0.15s;\n}\n[data-agentation-theme=dark] .styles-module__switchContainer___Ka-AB {\n  background-color: #484848;\n}\n.styles-module__switchContainer___Ka-AB:has(.styles-module__switchInput___kYDSD:checked) {\n  background-color: var(--agentation-color-blue);\n}\n.styles-module__switchContainer___Ka-AB:has(.styles-module__switchInput___kYDSD:disabled) {\n  opacity: 0.3;\n}\n\n.styles-module__switchInput___kYDSD {\n  position: absolute;\n  z-index: 1;\n  inset: 0;\n  border-radius: inherit;\n  opacity: 0;\n  cursor: pointer;\n}\n.styles-module__switchInput___kYDSD:disabled {\n  cursor: not-allowed;\n}\n\n.styles-module__switchThumb___4sCPH {\n  border-radius: 50%;\n  width: 12px;\n  height: 12px;\n  background-color: #fff;\n  transition: transform 0.15s;\n}\n.styles-module__switchContainer___Ka-AB[data-checked] .styles-module__switchThumb___4sCPH {\n  transform: translateX(8px);\n}";
var styles_module_default7 = { "switchContainer": "styles-module__switchContainer___Ka-AB", "switchInput": "styles-module__switchInput___kYDSD", "switchThumb": "styles-module__switchThumb___4sCPH" };

// src/components/switch/index.tsx
var import_jsx_runtime14 = require("react/jsx-runtime");
var Switch = ({
  className = "",
  checked,
  onChange,
  ...props
}) => {
  return /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)(
    "div",
    {
      className: `${styles_module_default7.switchContainer} ${className}`,
      "data-checked": checked ? "" : void 0,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
          "input",
          {
            className: styles_module_default7.switchInput,
            checked,
            onChange,
            type: "checkbox",
            ...props
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime14.jsx)("div", { className: styles_module_default7.switchThumb })
      ]
    }
  );
};

// src/components/page-toolbar-css/settings-panel/checkbox-field/index.tsx
var import_react16 = require("react");

// src/components/checkbox/styles.module.scss
var css9 = ".styles-module__checkboxContainer___joqZk {\n  display: flex;\n  justify-content: center;\n  align-items: center;\n  position: relative;\n  border: 1px solid rgba(26, 26, 26, 0.2);\n  border-radius: 4px;\n  width: 14px;\n  height: 14px;\n  background-color: #fff;\n  transition: background-color 0.2s ease;\n}\n[data-agentation-theme=dark] .styles-module__checkboxContainer___joqZk {\n  border-color: rgba(255, 255, 255, 0.2);\n  background-color: #252525;\n}\n.styles-module__checkboxContainer___joqZk:has(.styles-module__checkboxInput___ECzzO:checked) {\n  background-color: #1a1a1a;\n}\n[data-agentation-theme=dark] .styles-module__checkboxContainer___joqZk:has(.styles-module__checkboxInput___ECzzO:checked) {\n  background-color: #fff;\n}\n\n.styles-module__checkboxInput___ECzzO {\n  position: absolute;\n  z-index: 1;\n  inset: -1px;\n  border-radius: inherit;\n  opacity: 0;\n  cursor: pointer;\n}\n\n.styles-module__checkboxCheck___fUXpr {\n  color: #fafafa;\n}\n[data-agentation-theme=dark] .styles-module__checkboxCheck___fUXpr {\n  color: #1a1a1a;\n}\n\n.styles-module__checkboxCheckPath___cDyh8 {\n  stroke-dasharray: 9.29px;\n  stroke-dashoffset: 9.29px;\n  color: #fafafa;\n  transition: stroke-dashoffset 0.1s ease;\n}\n[data-agentation-theme=dark] .styles-module__checkboxCheckPath___cDyh8 {\n  color: #1a1a1a;\n}\n.styles-module__checkboxContainer___joqZk[data-checked] .styles-module__checkboxCheckPath___cDyh8 {\n  transition-duration: 0.2s;\n  stroke-dashoffset: 0;\n}";
var styles_module_default8 = { "checkboxContainer": "styles-module__checkboxContainer___joqZk", "checkboxInput": "styles-module__checkboxInput___ECzzO", "checkboxCheck": "styles-module__checkboxCheck___fUXpr", "checkboxCheckPath": "styles-module__checkboxCheckPath___cDyh8" };

// src/components/checkbox/index.tsx
var import_jsx_runtime15 = require("react/jsx-runtime");
var Checkbox = ({
  className = "",
  checked,
  onChange,
  ...props
}) => {
  return /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(
    "div",
    {
      className: `${styles_module_default8.checkboxContainer} ${className}`,
      "data-checked": checked ? "" : void 0,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
          "input",
          {
            className: styles_module_default8.checkboxInput,
            type: "checkbox",
            checked,
            onChange,
            ...props
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
          "svg",
          {
            className: styles_module_default8.checkboxCheck,
            width: "14",
            height: "14",
            viewBox: "0 0 14 14",
            fill: "none",
            children: /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
              "path",
              {
                className: styles_module_default8.checkboxCheckPath,
                d: "M3.94 7L6.13 9.19L10.5 4.81",
                stroke: "currentColor",
                strokeWidth: "1.5",
                strokeLinecap: "round",
                strokeLinejoin: "round"
              }
            )
          }
        )
      ]
    }
  );
};

// src/components/page-toolbar-css/settings-panel/checkbox-field/styles.module.scss
var css10 = ".styles-module__container___w8eAF {\n  display: flex;\n  align-items: center;\n  height: 24px;\n}\n\n.styles-module__label___J5mxE {\n  padding-inline: 8px 2px;\n  line-height: 20px;\n  font-size: 13px;\n  letter-spacing: -0.15px;\n  color: rgba(26, 26, 26, 0.5);\n  -webkit-user-select: none;\n  user-select: none;\n  cursor: pointer;\n}\n[data-agentation-theme=dark] .styles-module__label___J5mxE {\n  color: rgba(255, 255, 255, 0.5);\n}";
var styles_module_default9 = { "container": "styles-module__container___w8eAF", "label": "styles-module__label___J5mxE" };

// src/components/page-toolbar-css/settings-panel/checkbox-field/index.tsx
var import_jsx_runtime16 = require("react/jsx-runtime");
var CheckboxField = ({
  className = "",
  label,
  tooltip,
  checked,
  onChange,
  ...props
}) => {
  const id = (0, import_react16.useId)();
  return /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)("div", { className: `${styles_module_default9.container} ${className}`, ...props, children: [
    /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Checkbox, { id, onChange, checked }),
    /* @__PURE__ */ (0, import_jsx_runtime16.jsx)("label", { className: styles_module_default9.label, htmlFor: id, children: label }),
    tooltip && /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(HelpTooltip, { content: tooltip })
  ] });
};

// src/components/page-toolbar-css/settings-panel/styles.module.scss
var css11 = '@keyframes styles-module__cycleTextIn___VBNTi {\n  0% {\n    opacity: 0;\n    transform: translateY(-6px);\n  }\n  100% {\n    opacity: 1;\n    transform: translateY(0);\n  }\n}\n@keyframes styles-module__scaleIn___QpQ8E {\n  from {\n    opacity: 0;\n    transform: scale(0.85);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1);\n  }\n}\n@keyframes styles-module__mcpPulse___5Q3Jj {\n  0% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 50%, transparent);\n  }\n  70% {\n    box-shadow: 0 0 0 6px color-mix(in srgb, var(--agentation-color-green) 0%, transparent);\n  }\n  100% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 0%, transparent);\n  }\n}\n@keyframes styles-module__mcpPulseError___VHxhx {\n  0% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-red) 50%, transparent);\n  }\n  70% {\n    box-shadow: 0 0 0 6px color-mix(in srgb, var(--agentation-color-red) 0%, transparent);\n  }\n  100% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-red) 0%, transparent);\n  }\n}\n@keyframes styles-module__themeIconIn___qUWMV {\n  0% {\n    opacity: 0;\n    transform: scale(0.8) rotate(-30deg);\n  }\n  100% {\n    opacity: 1;\n    transform: scale(1) rotate(0deg);\n  }\n}\n.styles-module__settingsPanel___qNkn- :where(button, a, input, select, textarea):focus-visible {\n  outline: 2px solid var(--agentation-color-accent);\n  outline-offset: 2px;\n}\n.styles-module__settingsPanel___qNkn- {\n  position: absolute;\n  right: 5px;\n  bottom: calc(100% + 0.5rem);\n  z-index: 1;\n  overflow: hidden;\n  background: #1c1c1c;\n  border-radius: 16px;\n  padding: 12px 0;\n  width: 253px;\n  max-width: calc(100vw - 20px);\n  cursor: default;\n  opacity: 1;\n  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.04);\n  transition: background-color 0.25s ease, box-shadow 0.25s ease;\n}\n.styles-module__settingsPanel___qNkn-::before, .styles-module__settingsPanel___qNkn-::after {\n  content: "";\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  width: 16px;\n  z-index: 2;\n  pointer-events: none;\n}\n.styles-module__settingsPanel___qNkn-::before {\n  left: 0;\n  background: linear-gradient(to right, #1c1c1c 0%, transparent 100%);\n}\n.styles-module__settingsPanel___qNkn-::after {\n  right: 0;\n  background: linear-gradient(to left, #1c1c1c 0%, transparent 100%);\n}\n.styles-module__settingsPanel___qNkn- .styles-module__settingsHeader___Fn1DP,\n.styles-module__settingsPanel___qNkn- .styles-module__settingsBrand___OoKlM,\n.styles-module__settingsPanel___qNkn- .styles-module__settingsVersion___rXmL9,\n.styles-module__settingsPanel___qNkn- .styles-module__settingsSection___n5V-4,\n.styles-module__settingsPanel___qNkn- .styles-module__settingsLabel___VCVOQ,\n.styles-module__settingsPanel___qNkn- .styles-module__cycleButton___XMBx3,\n.styles-module__settingsPanel___qNkn- .styles-module__cycleDot___zgSXY,\n.styles-module__settingsPanel___qNkn- .styles-module__dropdownButton___mKHe8,\n.styles-module__settingsPanel___qNkn- .styles-module__sliderLabel___6K5v1,\n.styles-module__settingsPanel___qNkn- .styles-module__slider___v5z-c,\n.styles-module__settingsPanel___qNkn- .styles-module__themeToggle___3imlT {\n  transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease;\n}\n.styles-module__settingsPanel___qNkn- {\n  opacity: 0;\n  transform: translateY(var(--panel-offset-y, 4px)) scale(0.98);\n  transform-origin: var(--panel-origin, bottom right);\n  filter: blur(2px);\n  pointer-events: none;\n  visibility: hidden;\n  transition: opacity 120ms cubic-bezier(0.25, 0.46, 0.45, 0.94), transform 120ms cubic-bezier(0.25, 0.46, 0.45, 0.94), filter 120ms cubic-bezier(0.25, 0.46, 0.45, 0.94);\n}\n.styles-module__settingsPanel___qNkn-[data-panel-present=true] {\n  visibility: visible;\n}\n.styles-module__settingsPanel___qNkn-[data-panel-open=true] {\n  opacity: 1;\n  transform: translateY(0) scale(1);\n  filter: blur(0);\n  pointer-events: auto;\n  transition-duration: 160ms;\n}\n@media (prefers-reduced-motion: reduce) {\n  .styles-module__settingsPanel___qNkn- {\n    transition: none;\n    transform: none;\n    filter: none;\n  }\n}\n.styles-module__settingsPanel___qNkn-.styles-module__below___Vpv-k {\n  --panel-offset-y: -4px;\n  --panel-origin: top right;\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- {\n  background: #1a1a1a;\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- .styles-module__settingsLabel___VCVOQ {\n  color: rgba(255, 255, 255, 0.6);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- .styles-module__settingsOption___JoyH- {\n  color: rgba(255, 255, 255, 0.85);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- .styles-module__settingsOption___JoyH-:hover {\n  background: rgba(255, 255, 255, 0.1);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- .styles-module__settingsOption___JoyH-.styles-module__selected___k1-Vq {\n  background: rgba(255, 255, 255, 0.15);\n  color: #fff;\n}\n\n.styles-module__settingsPanelContainer___5it-H {\n  overflow: visible;\n  position: relative;\n  display: flex;\n  padding: 0 16px;\n}\n\n.styles-module__settingsPage___BMn-3 {\n  min-width: 100%;\n  flex-basis: 0;\n  flex-shrink: 0;\n  transition: transform 0.2s ease, opacity 0.2s ease;\n  transition-delay: 0s;\n  opacity: 1;\n}\n\n.styles-module__settingsPage___BMn-3.styles-module__slideLeft___qUvW4 {\n  transform: translateX(-24px);\n  opacity: 0;\n  pointer-events: none;\n}\n\n.styles-module__automationsPage___N7By0 {\n  position: absolute;\n  top: 0;\n  left: 24px;\n  width: 100%;\n  height: 100%;\n  padding: 0 16px 4px;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  transition: transform 0.2s ease, opacity 0.2s ease;\n  opacity: 0;\n  pointer-events: none;\n}\n\n.styles-module__automationsPage___N7By0.styles-module__slideIn___uXDSu {\n  transform: translateX(-24px);\n  opacity: 1;\n  pointer-events: auto;\n}\n\n.styles-module__settingsHeader___Fn1DP {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  height: 24px;\n}\n\n.styles-module__settingsBrand___OoKlM {\n  display: flex;\n  align-items: center;\n  font-size: 0.8125rem;\n  font-weight: 500;\n  letter-spacing: -0.0094em;\n  color: #bbb;\n  text-decoration: none;\n}\n\n.styles-module__settingsVersion___rXmL9 {\n  font-size: 11px;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.4);\n  margin-left: 6px;\n  letter-spacing: -0.0094em;\n}\n\n.styles-module__themeToggle___3imlT {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 22px;\n  height: 22px;\n  margin-left: auto;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: rgba(255, 255, 255, 0.4);\n  transition: background-color 0.15s ease, color 0.15s ease;\n  cursor: pointer;\n}\n.styles-module__themeToggle___3imlT:hover {\n  background: rgba(255, 255, 255, 0.1);\n  color: rgba(255, 255, 255, 0.8);\n}\n[data-agentation-theme=light] .styles-module__themeToggle___3imlT {\n  color: rgba(0, 0, 0, 0.4);\n}\n[data-agentation-theme=light] .styles-module__themeToggle___3imlT:hover {\n  background: rgba(0, 0, 0, 0.06);\n  color: rgba(0, 0, 0, 0.7);\n}\n\n.styles-module__themeIconWrapper___pyaYa {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  position: relative;\n  width: 20px;\n  height: 20px;\n}\n\n.styles-module__themeIcon___w7lAm {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  animation: styles-module__themeIconIn___qUWMV 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;\n}\n\n.styles-module__settingsSectionGrow___eZTRw {\n  flex: 1;\n  display: flex;\n  flex-direction: column;\n}\n\n.styles-module__settingsRow___y-tDE {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  min-height: 24px;\n}\n.styles-module__settingsRow___y-tDE.styles-module__settingsRowMarginTop___uLpGb {\n  margin-top: 8px;\n}\n\n.styles-module__settingsRowDisabled___ydl3Q .styles-module__settingsLabel___VCVOQ {\n  color: rgba(255, 255, 255, 0.2);\n}\n[data-agentation-theme=light] .styles-module__settingsRowDisabled___ydl3Q .styles-module__settingsLabel___VCVOQ {\n  color: rgba(0, 0, 0, 0.2);\n}\n\n.styles-module__settingsLabel___VCVOQ {\n  display: flex;\n  align-items: center;\n  column-gap: 2px;\n  line-height: 20px;\n  font-size: 13px;\n  font-weight: 400;\n  letter-spacing: -0.15px;\n  color: rgba(255, 255, 255, 0.5);\n}\n[data-agentation-theme=light] .styles-module__settingsLabel___VCVOQ {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__cycleButton___XMBx3 {\n  display: flex;\n  align-items: center;\n  gap: 0.5rem;\n  padding: 0;\n  border: none;\n  background: transparent;\n  font-size: 0.8125rem;\n  font-weight: 500;\n  color: #fff;\n  cursor: pointer;\n  letter-spacing: -0.0094em;\n}\n[data-agentation-theme=light] .styles-module__cycleButton___XMBx3 {\n  color: rgba(0, 0, 0, 0.85);\n}\n.styles-module__cycleButton___XMBx3:disabled {\n  opacity: 0.35;\n  cursor: not-allowed;\n}\n\n.styles-module__cycleButtonText___mbbnD {\n  display: inline-block;\n  animation: styles-module__cycleTextIn___VBNTi 0.2s ease-out;\n}\n\n.styles-module__cycleDots___ehp6i {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.styles-module__cycleDot___zgSXY {\n  width: 3px;\n  height: 3px;\n  border-radius: 50%;\n  background: rgba(255, 255, 255, 0.3);\n  transform: scale(0.667);\n  transition: background-color 0.25s ease-out, transform 0.25s ease-out;\n}\n.styles-module__cycleDot___zgSXY.styles-module__active___dpAhM {\n  background: #fff;\n  transform: scale(1);\n}\n[data-agentation-theme=light] .styles-module__cycleDot___zgSXY {\n  background: rgba(0, 0, 0, 0.2);\n}\n[data-agentation-theme=light] .styles-module__cycleDot___zgSXY.styles-module__active___dpAhM {\n  background: rgba(0, 0, 0, 0.7);\n}\n\n.styles-module__colorOptions___pbxZx {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  margin-top: 6px;\n  height: 26px;\n}\n\n.styles-module__colorOption___Co955 {\n  padding: 0;\n  position: relative;\n  border-radius: 50%;\n  width: 20px;\n  height: 20px;\n  background-color: #fff;\n  cursor: pointer;\n}\n[data-agentation-theme=dark] .styles-module__colorOption___Co955 {\n  background-color: #1a1a1a;\n}\n.styles-module__colorOption___Co955::before, .styles-module__colorOption___Co955::after {\n  content: "";\n  position: absolute;\n  inset: 0;\n  border-radius: 50%;\n  background-color: var(--swatch);\n  transition: opacity 0.2s, transform 0.2s;\n}\n@supports (color: color(display-p3 0 0 0)) {\n  .styles-module__colorOption___Co955::before, .styles-module__colorOption___Co955::after {\n    --color: var(--swatch-p3);\n  }\n}\n.styles-module__colorOption___Co955::after {\n  z-index: -1;\n  transform: scale(1.2);\n  opacity: 0;\n}\n.styles-module__colorOption___Co955.styles-module__selected___k1-Vq::before {\n  transform: scale(0.8);\n}\n.styles-module__colorOption___Co955.styles-module__selected___k1-Vq::after {\n  opacity: 1;\n}\n\n.styles-module__settingsNavLink___uYIwM {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  width: 100%;\n  height: 24px;\n  padding: 0;\n  border: none;\n  background: transparent;\n  font-family: inherit;\n  line-height: 20px;\n  font-size: 13px;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.5);\n  transition: color 0.15s ease;\n  cursor: pointer;\n}\n.styles-module__settingsNavLink___uYIwM:hover {\n  color: rgba(255, 255, 255, 0.9);\n}\n.styles-module__settingsNavLink___uYIwM svg {\n  color: rgba(255, 255, 255, 0.4);\n  transition: color 0.15s ease;\n}\n.styles-module__settingsNavLink___uYIwM:hover svg {\n  color: #fff;\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___uYIwM {\n  color: rgba(0, 0, 0, 0.5);\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___uYIwM:hover {\n  color: rgba(0, 0, 0, 0.8);\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___uYIwM svg {\n  color: rgba(0, 0, 0, 0.25);\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___uYIwM:hover svg {\n  color: rgba(0, 0, 0, 0.8);\n}\n\n.styles-module__settingsNavLinkRight___XBUzC {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.styles-module__settingsBackButton___fflll {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  height: 24px;\n  border: none;\n  background: transparent;\n  font-family: inherit;\n  line-height: 20px;\n  font-size: 13px;\n  font-weight: 500;\n  letter-spacing: -0.15px;\n  color: #fff;\n  cursor: pointer;\n  transition: transform 0.12s cubic-bezier(0.32, 0.72, 0, 1);\n}\n.styles-module__settingsBackButton___fflll svg {\n  opacity: 0.4;\n  flex-shrink: 0;\n  transition: opacity 0.15s ease, transform 0.18s cubic-bezier(0.32, 0.72, 0, 1);\n}\n.styles-module__settingsBackButton___fflll:hover svg {\n  opacity: 1;\n}\n[data-agentation-theme=light] .styles-module__settingsBackButton___fflll {\n  color: rgba(0, 0, 0, 0.85);\n  border-bottom-color: rgba(0, 0, 0, 0.08);\n}\n\n.styles-module__automationHeader___Avra9 {\n  display: flex;\n  align-items: center;\n  gap: 0.125rem;\n  font-size: 0.8125rem;\n  font-weight: 400;\n  color: #fff;\n}\n[data-agentation-theme=light] .styles-module__automationHeader___Avra9 {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n.styles-module__automationDescription___vFTmJ {\n  font-size: 0.6875rem;\n  font-weight: 300;\n  color: rgba(255, 255, 255, 0.5);\n  margin-top: 2px;\n  line-height: 14px;\n}\n[data-agentation-theme=light] .styles-module__automationDescription___vFTmJ {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__learnMoreLink___cG7OI {\n  color: rgba(255, 255, 255, 0.8);\n  text-decoration-line: underline;\n  text-decoration-style: dotted;\n  text-decoration-color: rgba(255, 255, 255, 0.2);\n  text-underline-offset: 2px;\n  transition: color 0.15s ease;\n}\n.styles-module__learnMoreLink___cG7OI:hover {\n  color: #fff;\n}\n[data-agentation-theme=light] .styles-module__learnMoreLink___cG7OI {\n  color: rgba(0, 0, 0, 0.6);\n  text-decoration-color: rgba(0, 0, 0, 0.2);\n}\n[data-agentation-theme=light] .styles-module__learnMoreLink___cG7OI:hover {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n.styles-module__autoSendContainer___VpkXk {\n  display: flex;\n  align-items: center;\n}\n\n.styles-module__autoSendLabel___ngNdC {\n  padding-inline-end: 8px;\n  font-size: 11px;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.4);\n  transition: color 0.15s, opacity 0.15s;\n  cursor: pointer;\n}\n.styles-module__autoSendLabel___ngNdC.styles-module__active___dpAhM {\n  color: #66b8ff;\n  color: color(display-p3 0.4 0.72 1);\n}\n[data-agentation-theme=light] .styles-module__autoSendLabel___ngNdC {\n  color: rgba(0, 0, 0, 0.4);\n}\n[data-agentation-theme=light] .styles-module__autoSendLabel___ngNdC.styles-module__active___dpAhM {\n  color: var(--agentation-color-blue);\n}\n.styles-module__autoSendLabel___ngNdC.styles-module__disabled___9AZYS {\n  opacity: 0.3;\n  cursor: not-allowed;\n}\n\n.styles-module__mcpStatusDot___8AMxP {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  flex-shrink: 0;\n}\n.styles-module__mcpStatusDot___8AMxP.styles-module__connecting___QEO1r {\n  background-color: var(--agentation-color-yellow);\n  animation: styles-module__mcpPulse___5Q3Jj 1.5s infinite;\n}\n.styles-module__mcpStatusDot___8AMxP.styles-module__connected___WyFkx {\n  background-color: var(--agentation-color-green);\n  animation: styles-module__mcpPulse___5Q3Jj 2.5s ease-in-out infinite;\n}\n.styles-module__mcpStatusDot___8AMxP.styles-module__disconnected___mvmvQ {\n  background-color: var(--agentation-color-red);\n  animation: styles-module__mcpPulseError___VHxhx 2s infinite;\n}\n\n.styles-module__mcpNavIndicator___auBHI {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  flex-shrink: 0;\n}\n.styles-module__mcpNavIndicator___auBHI.styles-module__connected___WyFkx {\n  background-color: var(--agentation-color-green);\n  animation: styles-module__mcpPulse___5Q3Jj 2.5s ease-in-out infinite;\n}\n.styles-module__mcpNavIndicator___auBHI.styles-module__connecting___QEO1r {\n  background-color: var(--agentation-color-yellow);\n  animation: styles-module__mcpPulse___5Q3Jj 1.5s ease-in-out infinite;\n}\n\n.styles-module__webhookUrlInput___WDDDC {\n  display: block;\n  width: 100%;\n  flex: 1;\n  min-height: 60px;\n  box-sizing: border-box;\n  margin-top: 11px;\n  padding: 8px 10px;\n  border: 1px solid rgba(255, 255, 255, 0.1);\n  border-radius: 6px;\n  background: rgba(255, 255, 255, 0.03);\n  font-family: inherit;\n  font-size: 0.75rem;\n  font-weight: 400;\n  color: #fff;\n  outline: none;\n  resize: none;\n  user-select: text;\n  transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;\n}\n.styles-module__webhookUrlInput___WDDDC::placeholder {\n  color: rgba(255, 255, 255, 0.3);\n}\n.styles-module__webhookUrlInput___WDDDC:focus {\n  border-color: rgba(255, 255, 255, 0.3);\n  background: rgba(255, 255, 255, 0.08);\n}\n[data-agentation-theme=light] .styles-module__webhookUrlInput___WDDDC {\n  border-color: rgba(0, 0, 0, 0.1);\n  background: rgba(0, 0, 0, 0.03);\n  color: rgba(0, 0, 0, 0.85);\n}\n[data-agentation-theme=light] .styles-module__webhookUrlInput___WDDDC::placeholder {\n  color: rgba(0, 0, 0, 0.3);\n}\n[data-agentation-theme=light] .styles-module__webhookUrlInput___WDDDC:focus {\n  border-color: rgba(0, 0, 0, 0.25);\n  background: rgba(0, 0, 0, 0.05);\n}\n\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- {\n  background: #fff;\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn-::before {\n  background: linear-gradient(to right, #fff 0%, transparent 100%);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn-::after {\n  background: linear-gradient(to left, #fff 0%, transparent 100%);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsHeader___Fn1DP {\n  border-bottom-color: rgba(0, 0, 0, 0.08);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsBrand___OoKlM {\n  color: #333;\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsVersion___rXmL9 {\n  color: rgba(0, 0, 0, 0.4);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsSection___n5V-4 {\n  border-top-color: rgba(0, 0, 0, 0.08);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsLabel___VCVOQ {\n  color: rgba(0, 0, 0, 0.5);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__cycleButton___XMBx3 {\n  color: rgba(0, 0, 0, 0.85);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__cycleDot___zgSXY {\n  background: rgba(0, 0, 0, 0.2);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__cycleDot___zgSXY.styles-module__active___dpAhM {\n  background: rgba(0, 0, 0, 0.7);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__dropdownButton___mKHe8 {\n  color: rgba(0, 0, 0, 0.85);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__dropdownButton___mKHe8:hover {\n  background: rgba(0, 0, 0, 0.05);\n}\n\n.styles-module__checkboxField___ZrSqv:not(:first-child) {\n  margin-top: 8px;\n}\n\n.styles-module__divider___h6Yux {\n  margin-block: 8px;\n  width: 100%;\n  height: 1px;\n  background-color: rgba(26, 26, 26, 0.07);\n}\n[data-agentation-theme=dark] .styles-module__divider___h6Yux {\n  background-color: rgba(255, 255, 255, 0.07);\n}';
var styles_module_default10 = { "settingsPanel": "styles-module__settingsPanel___qNkn-", "settingsHeader": "styles-module__settingsHeader___Fn1DP", "settingsBrand": "styles-module__settingsBrand___OoKlM", "settingsVersion": "styles-module__settingsVersion___rXmL9", "settingsSection": "styles-module__settingsSection___n5V-4", "settingsLabel": "styles-module__settingsLabel___VCVOQ", "cycleButton": "styles-module__cycleButton___XMBx3", "cycleDot": "styles-module__cycleDot___zgSXY", "dropdownButton": "styles-module__dropdownButton___mKHe8", "sliderLabel": "styles-module__sliderLabel___6K5v1", "slider": "styles-module__slider___v5z-c", "themeToggle": "styles-module__themeToggle___3imlT", "below": "styles-module__below___Vpv-k", "settingsOption": "styles-module__settingsOption___JoyH-", "selected": "styles-module__selected___k1-Vq", "settingsPanelContainer": "styles-module__settingsPanelContainer___5it-H", "settingsPage": "styles-module__settingsPage___BMn-3", "slideLeft": "styles-module__slideLeft___qUvW4", "automationsPage": "styles-module__automationsPage___N7By0", "slideIn": "styles-module__slideIn___uXDSu", "themeIconWrapper": "styles-module__themeIconWrapper___pyaYa", "themeIcon": "styles-module__themeIcon___w7lAm", "themeIconIn": "styles-module__themeIconIn___qUWMV", "settingsSectionGrow": "styles-module__settingsSectionGrow___eZTRw", "settingsRow": "styles-module__settingsRow___y-tDE", "settingsRowMarginTop": "styles-module__settingsRowMarginTop___uLpGb", "settingsRowDisabled": "styles-module__settingsRowDisabled___ydl3Q", "cycleButtonText": "styles-module__cycleButtonText___mbbnD", "cycleTextIn": "styles-module__cycleTextIn___VBNTi", "cycleDots": "styles-module__cycleDots___ehp6i", "active": "styles-module__active___dpAhM", "colorOptions": "styles-module__colorOptions___pbxZx", "colorOption": "styles-module__colorOption___Co955", "settingsNavLink": "styles-module__settingsNavLink___uYIwM", "settingsNavLinkRight": "styles-module__settingsNavLinkRight___XBUzC", "settingsBackButton": "styles-module__settingsBackButton___fflll", "automationHeader": "styles-module__automationHeader___Avra9", "automationDescription": "styles-module__automationDescription___vFTmJ", "learnMoreLink": "styles-module__learnMoreLink___cG7OI", "autoSendContainer": "styles-module__autoSendContainer___VpkXk", "autoSendLabel": "styles-module__autoSendLabel___ngNdC", "disabled": "styles-module__disabled___9AZYS", "mcpStatusDot": "styles-module__mcpStatusDot___8AMxP", "connecting": "styles-module__connecting___QEO1r", "mcpPulse": "styles-module__mcpPulse___5Q3Jj", "connected": "styles-module__connected___WyFkx", "disconnected": "styles-module__disconnected___mvmvQ", "mcpPulseError": "styles-module__mcpPulseError___VHxhx", "mcpNavIndicator": "styles-module__mcpNavIndicator___auBHI", "webhookUrlInput": "styles-module__webhookUrlInput___WDDDC", "checkboxField": "styles-module__checkboxField___ZrSqv", "divider": "styles-module__divider___h6Yux", "scaleIn": "styles-module__scaleIn___QpQ8E" };

// src/components/page-toolbar-css/settings-panel/index.tsx
var import_jsx_runtime17 = require("react/jsx-runtime");
var SettingsPanel = (0, import_react17.memo)(function SettingsPanel2({
  settings,
  onSettingsChange,
  isDarkMode,
  onToggleTheme,
  isDevMode,
  connectionStatus,
  endpoint,
  onExited,
  isOpen,
  toolbarNearBottom,
  settingsPage,
  onSettingsPageChange,
  onHideToolbar
}) {
  const { ref: panelRef } = usePanelPresence(isOpen, { keepMounted: true, onExited });
  const navRef = (0, import_react17.useRef)(null);
  const backRef = (0, import_react17.useRef)(null);
  const focusPageRef = (0, import_react17.useRef)(false);
  (0, import_react17.useLayoutEffect)(() => {
    if (!isOpen || !focusPageRef.current) return;
    focusPageRef.current = false;
    (settingsPage === "automations" ? backRef : navRef).current?.focus();
  }, [isOpen, settingsPage]);
  const themeToggleLabel = isDarkMode ? "Switch to light mode" : "Switch to dark mode";
  return /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
    "div",
    {
      className: `${styles_module_default10.settingsPanel} ${toolbarNearBottom ? styles_module_default10.below : ""}`,
      style: toolbarNearBottom ? { bottom: "auto", top: "calc(100% + 0.5rem)" } : void 0,
      "data-agentation-settings-panel": true,
      ref: (node) => {
        panelRef.current = node;
        node?.toggleAttribute("inert", !isOpen);
      },
      role: "group",
      "aria-label": "Feedback settings",
      "aria-hidden": !isOpen,
      children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.settingsPanelContainer, children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
          "div",
          {
            className: `${styles_module_default10.settingsPage} ${settingsPage === "automations" ? styles_module_default10.slideLeft : ""}`,
            ref: (node) => {
              node?.toggleAttribute("inert", settingsPage !== "main");
            },
            "aria-hidden": settingsPage !== "main",
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.settingsHeader, children: [
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("a", { className: styles_module_default10.settingsBrand, href: "https://agentation.com", target: "_blank", rel: "noopener noreferrer", "aria-label": "Agentation", children: "Agentation" }),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("p", { className: styles_module_default10.settingsVersion, children: [
                  "v",
                  "3.1.2"
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                  "button",
                  {
                    className: styles_module_default10.themeToggle,
                    onClick: onToggleTheme,
                    title: themeToggleLabel,
                    "aria-label": themeToggleLabel,
                    children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: styles_module_default10.themeIconWrapper, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                      "span",
                      {
                        className: styles_module_default10.themeIcon,
                        children: isDarkMode ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(IconSun, { size: 20 }) : /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(IconMoon, { size: 20 })
                      },
                      isDarkMode ? "sun" : "moon"
                    ) })
                  }
                )
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: styles_module_default10.divider }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.settingsSection, children: [
                /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.settingsRow, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.settingsLabel, children: [
                    "Output Detail",
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(HelpTooltip, { content: "Controls how much detail is included in the copied output" })
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
                    "button",
                    {
                      className: styles_module_default10.cycleButton,
                      onClick: () => {
                        const currentIndex = OUTPUT_DETAIL_OPTIONS.findIndex(
                          (opt) => opt.value === settings.outputDetail
                        );
                        const nextIndex = (currentIndex + 1) % OUTPUT_DETAIL_OPTIONS.length;
                        onSettingsChange({
                          outputDetail: OUTPUT_DETAIL_OPTIONS[nextIndex].value
                        });
                      },
                      children: [
                        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                          "span",
                          {
                            className: styles_module_default10.cycleButtonText,
                            children: OUTPUT_DETAIL_OPTIONS.find(
                              (opt) => opt.value === settings.outputDetail
                            )?.label
                          },
                          settings.outputDetail
                        ),
                        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { className: styles_module_default10.cycleDots, children: OUTPUT_DETAIL_OPTIONS.map((option) => /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                          "span",
                          {
                            className: `${styles_module_default10.cycleDot} ${settings.outputDetail === option.value ? styles_module_default10.active : ""}`
                          },
                          option.value
                        )) })
                      ]
                    }
                  )
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
                  "div",
                  {
                    className: `${styles_module_default10.settingsRow} ${styles_module_default10.settingsRowMarginTop} ${!isDevMode ? styles_module_default10.settingsRowDisabled : ""}`,
                    children: [
                      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.settingsLabel, children: [
                        "React Components",
                        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                          HelpTooltip,
                          {
                            content: !isDevMode ? "Disabled \u2014 production builds minify component names, making detection unreliable. Use in development mode." : "Include React component names in annotations"
                          }
                        )
                      ] }),
                      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                        Switch,
                        {
                          "aria-label": "React Components",
                          checked: isDevMode && settings.reactEnabled,
                          onChange: (e) => onSettingsChange({ reactEnabled: e.target.checked }),
                          disabled: !isDevMode
                        }
                      )
                    ]
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
                  "div",
                  {
                    className: `${styles_module_default10.settingsRow} ${styles_module_default10.settingsRowMarginTop}`,
                    children: [
                      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.settingsLabel, children: [
                        "Hide Until Restart",
                        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(HelpTooltip, { content: "Hides the toolbar until you open a new tab" })
                      ] }),
                      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                        Switch,
                        {
                          "aria-label": "Hide Until Restart",
                          checked: false,
                          onChange: (e) => {
                            if (e.target.checked) onHideToolbar();
                          }
                        }
                      )
                    ]
                  }
                )
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: styles_module_default10.divider }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.settingsSection, children: [
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                  "div",
                  {
                    className: `${styles_module_default10.settingsLabel} ${styles_module_default10.settingsLabelMarker}`,
                    children: "Marker Color"
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: styles_module_default10.colorOptions, children: COLOR_OPTIONS.map((color) => /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                  "button",
                  {
                    className: `${styles_module_default10.colorOption} ${settings.annotationColorId === color.id ? styles_module_default10.selected : ""}`,
                    style: {
                      "--swatch": color.srgb,
                      "--swatch-p3": color.p3
                    },
                    onClick: () => onSettingsChange({ annotationColorId: color.id }),
                    title: color.label,
                    "aria-label": color.label,
                    type: "button"
                  },
                  color.id
                )) })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: styles_module_default10.divider }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.settingsSection, children: [
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                  CheckboxField,
                  {
                    className: "checkbox-field",
                    label: "Clear on copy/send",
                    checked: settings.autoClearAfterCopy,
                    onChange: (e) => onSettingsChange({ autoClearAfterCopy: e.target.checked }),
                    tooltip: "Automatically clear annotations after copying"
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                  CheckboxField,
                  {
                    className: styles_module_default10.checkboxField,
                    label: "Block page interactions",
                    checked: settings.blockInteractions,
                    onChange: (e) => onSettingsChange({ blockInteractions: e.target.checked })
                  }
                )
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: styles_module_default10.divider }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
                "button",
                {
                  className: styles_module_default10.settingsNavLink,
                  ref: navRef,
                  onClick: (event) => {
                    focusPageRef.current = event.detail === 0;
                    event.currentTarget.blur();
                    onSettingsPageChange("automations");
                  },
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { children: "Manage MCP & Webhooks" }),
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("span", { className: styles_module_default10.settingsNavLinkRight, children: [
                      endpoint && connectionStatus !== "disconnected" && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                        "span",
                        {
                          className: `${styles_module_default10.mcpNavIndicator} ${styles_module_default10[connectionStatus]}`
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                        "svg",
                        {
                          width: "16",
                          height: "16",
                          viewBox: "0 0 16 16",
                          fill: "none",
                          xmlns: "http://www.w3.org/2000/svg",
                          children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                            "path",
                            {
                              d: "M7.5 12.5L12 8L7.5 3.5",
                              stroke: "currentColor",
                              strokeWidth: "1.5",
                              strokeLinecap: "round",
                              strokeLinejoin: "round"
                            }
                          )
                        }
                      )
                    ] })
                  ]
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
          "div",
          {
            className: `${styles_module_default10.settingsPage} ${styles_module_default10.automationsPage} ${settingsPage === "automations" ? styles_module_default10.slideIn : ""}`,
            ref: (node) => {
              node?.toggleAttribute("inert", settingsPage !== "automations");
            },
            "aria-hidden": settingsPage !== "automations",
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
                "button",
                {
                  className: styles_module_default10.settingsBackButton,
                  ref: backRef,
                  "aria-label": "Back to settings",
                  onClick: (event) => {
                    focusPageRef.current = event.detail === 0;
                    event.currentTarget.blur();
                    onSettingsPageChange("main");
                  },
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(IconChevronLeft, { size: 16 }),
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("span", { children: "Manage MCP & Webhooks" })
                  ]
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: styles_module_default10.divider }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.settingsSection, children: [
                /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.settingsRow, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("span", { className: styles_module_default10.automationHeader, children: [
                    "MCP Connection",
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(HelpTooltip, { content: "Connect via Model Context Protocol to let AI agents like Claude Code receive annotations in real-time." })
                  ] }),
                  endpoint && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                    "div",
                    {
                      className: `${styles_module_default10.mcpStatusDot} ${styles_module_default10[connectionStatus]}`,
                      title: connectionStatus === "connected" ? "Connected" : connectionStatus === "connecting" ? "Connecting..." : "Disconnected"
                    }
                  )
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
                  "p",
                  {
                    className: styles_module_default10.automationDescription,
                    style: { paddingBottom: 6 },
                    children: [
                      "MCP connection allows agents to receive and act on annotations.",
                      " ",
                      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                        "a",
                        {
                          href: "https://agentation.com/mcp",
                          target: "_blank",
                          rel: "noopener noreferrer",
                          className: styles_module_default10.learnMoreLink,
                          children: "Learn more"
                        }
                      )
                    ]
                  }
                )
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("div", { className: styles_module_default10.divider }),
              /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
                "div",
                {
                  className: `${styles_module_default10.settingsSection} ${styles_module_default10.settingsSectionGrow}`,
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.settingsRow, children: [
                      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("span", { className: styles_module_default10.automationHeader, children: [
                        "Webhooks",
                        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(HelpTooltip, { content: "Send annotation data to any URL endpoint when annotations change. Useful for custom integrations." })
                      ] }),
                      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)("div", { className: styles_module_default10.autoSendContainer, children: [
                        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                          "label",
                          {
                            htmlFor: "agentation-auto-send",
                            className: `${styles_module_default10.autoSendLabel} ${settings.webhooksEnabled ? styles_module_default10.active : ""} ${!settings.webhookUrl ? styles_module_default10.disabled : ""}`,
                            children: "Auto-Send"
                          }
                        ),
                        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                          Switch,
                          {
                            id: "agentation-auto-send",
                            checked: settings.webhooksEnabled,
                            onChange: (e) => onSettingsChange({
                              webhooksEnabled: e.target.checked
                            }),
                            disabled: !settings.webhookUrl
                          }
                        )
                      ] })
                    ] }),
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)("p", { className: styles_module_default10.automationDescription, children: "The webhook URL will receive live annotation changes and annotation data." }),
                    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
                      "textarea",
                      {
                        className: styles_module_default10.webhookUrlInput,
                        placeholder: "Webhook URL",
                        "aria-label": "Webhook URL",
                        value: settings.webhookUrl,
                        onKeyDown: (e) => e.stopPropagation(),
                        onChange: (e) => onSettingsChange({ webhookUrl: e.target.value })
                      }
                    )
                  ]
                }
              )
            ]
          }
        )
      ] })
    }
  );
});

// src/components/page-toolbar-css/hover-tooltip.tsx
var import_react18 = require("react");
var import_jsx_runtime18 = require("react/jsx-runtime");
function HoverTooltip({ x, y, elementName, reactComponents }) {
  const ref = (0, import_react18.useRef)(null);
  (0, import_react18.useLayoutEffect)(() => {
    const tooltip = ref.current;
    if (!tooltip) return;
    const position = () => {
      const width = tooltip.offsetWidth;
      const height = tooltip.offsetHeight;
      tooltip.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
      const preferredTop = y - height - 8;
      tooltip.style.top = `${Math.max(8, Math.min(preferredTop, window.innerHeight - height - 8))}px`;
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [x, y, elementName, reactComponents]);
  return /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)("div", { ref, className: `${styles_module_default3.hoverTooltip} ${styles_module_default3.enter}`, children: [
    reactComponents && /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("div", { className: styles_module_default3.hoverReactPath, children: reactComponents }),
    /* @__PURE__ */ (0, import_jsx_runtime18.jsx)("div", { className: styles_module_default3.hoverElementName, children: elementName })
  ] });
}

// src/components/reset.scss
var css12 = '@charset "UTF-8";\n/* Reset box-model and set borders */\n/* ============================================ */\n*,\n::before,\n::after {\n  border-width: 0;\n  border-style: solid;\n  box-sizing: border-box;\n}\n\n/* Document */\n/* ============================================ */\n/**\n * 1. Correct line height in all browsers.\n * 2. Prevent adjustments of font size after orientation changes in iOS.\n * 3. Remove gray overlay on links for iOS.\n * 4. Render kerning consistently in all browsers.\n * 5. Correct font smoothing for macOS.\n */\n:host {\n  /* Inherited properties cross the shadow boundary, so a host page\'s\n     text-transform, letter-spacing or font would otherwise restyle the UI. */\n  font: 400 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  font-variant: normal;\n  color: initial;\n  letter-spacing: normal;\n  word-spacing: normal;\n  text-transform: none;\n  text-align: start;\n  text-indent: 0;\n  text-shadow: none;\n  white-space: normal;\n  direction: ltr;\n  writing-mode: horizontal-tb;\n  hyphens: manual;\n  word-break: normal;\n  overflow-wrap: normal;\n  tab-size: 8;\n  list-style: none;\n  quotes: initial;\n  caret-color: auto;\n  user-select: auto;\n  -webkit-text-fill-color: initial;\n  -webkit-text-stroke: 0;\n  text-rendering: auto;\n  -webkit-text-size-adjust: 100%; /* 2 */\n  -webkit-tap-highlight-color: transparent; /* 3 */\n  font-feature-settings: "kern"; /* 4 */\n  -webkit-font-feature-settings: "kern"; /* 5 */\n  -moz-font-feature-settings: "kern"; /* 5 */\n  -webkit-font-smoothing: antialiased; /* 5 */\n  -moz-osx-font-smoothing: grayscale; /* 5 */\n}\n\n/* Vertical rhythm */\n/* ============================================ */\np,\ntable,\nblockquote,\naddress,\npre,\niframe,\nform,\nfigure,\ndl {\n  margin: 0;\n}\n\n/* Headings */\n/* ============================================ */\nh1,\nh2,\nh3,\nh4,\nh5,\nh6 {\n  margin: 0;\n  font-size: inherit;\n  font-weight: inherit;\n}\n\n/* Lists (enumeration) */\n/* ============================================ */\nul,\nol,\nmenu {\n  list-style: none;\n  margin: 0;\n  padding: 0;\n}\n\n/* Lists (definition) */\n/* ============================================ */\ndd {\n  margin-left: 0;\n}\n\n/* Grouping content */\n/* ============================================ */\n/**\n * 1. Add the correct box sizing in Firefox.\n * 2. Show the overflow in Edge and IE.\n */\nhr {\n  clear: both;\n  margin: 0;\n  border-top-width: 1px;\n  height: 0; /* 1 */\n  box-sizing: content-box; /* 1 */\n  overflow: visible; /* 2 */\n  color: inherit;\n}\n\n/**\n * 1. Correct the inheritance and scaling of font size in all browsers.\n * 2. Correct the odd `em` font sizing in all browsers.\n * 3. Wrap lines by default instead of overflow.\n */\npre {\n  font-family: inherit; /* 1 */\n  font-size: inherit; /* 2 */\n  white-space: pre-line; /* 3 */\n}\n\naddress {\n  font-style: inherit;\n}\n\n/* Text-level semantics */\n/* ============================================ */\n/**\n * Remove the gray background on active links in IE 10.\n */\na {\n  background-color: transparent;\n  text-decoration: none;\n  color: inherit;\n}\n\n/**\n * 1. Remove the bottom border in Chrome 57-\n * 2. Add the correct text decoration in Chrome, Edge, IE, Opera, and Safari.\n */\nabbr[title] {\n  border-bottom: none; /* 1 */\n  text-decoration: none; /* 2 */\n}\n\n/**\n * Add the correct font weight in Chrome, Edge, and Safari.\n */\nb,\nstrong {\n  font-weight: bolder;\n}\n\n/**\n * 1. Correct the inheritance and scaling of font size in all browsers.\n * 2. Correct the odd `em` font sizing in all browsers.\n */\ncode,\nkbd,\nsamp {\n  font-family: "Menlo", "Monaco", "Consolas", "Courier New", monospace; /* 1 */\n  font-size: inherit; /* 2 */\n}\n\n/**\n * Add the correct font size in all browsers.\n */\nsmall {\n  font-size: 80%;\n}\n\n/**\n * Prevent `sub` and `sup` elements from affecting the line height in all browsers.\n */\nsub,\nsup {\n  position: relative;\n  vertical-align: baseline;\n  line-height: 0;\n  font-size: 75%;\n}\n\nsub {\n  bottom: -0.25em;\n}\n\nsup {\n  top: -0.5em;\n}\n\n/* Replaced content */\n/* ============================================ */\n/**\n * Prevent vertical alignment issues.\n */\nsvg,\nimg,\nembed,\nobject,\niframe {\n  vertical-align: bottom;\n}\n\n/*\n * 1. Remove image default bottom space.\n * 2. Prevent image from overflowing the container.\n */\nimg {\n  display: block;\n  max-width: 100%;\n}\n\n/**\n * Prevent alignment issues on Safari.\n */\n@supports (background: -webkit-named-image(i)) {\n  svg {\n    will-change: transform;\n  }\n}\n/* Forms */\n/* ============================================ */\n/**\n * Reset form fields to make them styleable.\n * 1. Make form elements stylable across systems iOS especially.\n * 2. Inherit text-transform from parent.\n */\nbutton,\ninput,\noptgroup,\nselect,\ntextarea {\n  -webkit-appearance: none; /* 1 */\n  appearance: none;\n  border-radius: 0;\n  margin: 0;\n  padding: 0;\n  background: transparent;\n  vertical-align: middle;\n  text-align: inherit;\n  text-transform: inherit; /* 2 */\n  font: inherit;\n  color: inherit;\n}\n\n/**\n * Correct cursors for clickable elements.\n */\nbutton,\n[type=button],\n[type=reset],\n[type=submit] {\n  cursor: pointer;\n}\n\nbutton:disabled,\n[type=button]:disabled,\n[type=reset]:disabled,\n[type=submit]:disabled {\n  cursor: default;\n}\n\n/**\n * Clickable labels and selects.\n */\nselect,\nlabel {\n  cursor: pointer;\n}\n\n/**\n * Improve outlines for Firefox and unify style with input elements & buttons.\n */\n:-moz-focusring {\n  outline: auto;\n}\n\nselect:disabled {\n  opacity: inherit;\n}\n\n/**\n * 1. Remove padding.\n */\noption {\n  padding: 0; /* 1 */\n}\n\n/**\n * Reset to invisible\n */\nfieldset {\n  margin: 0;\n  padding: 0;\n  min-width: 0;\n}\n\nlegend {\n  display: contents;\n  padding: 0;\n}\n\n/**\n * Add the correct vertical alignment in Chrome, Firefox, and Opera.\n */\nprogress {\n  vertical-align: baseline;\n}\n\n/**\n * Remove the default vertical scrollbar in IE 10+.\n */\ntextarea {\n  overflow: auto;\n}\n\n/**\n * Remove increment and decrement buttons in Chrome.\n */\n[type=number]::-webkit-inner-spin-button,\n[type=number]::-webkit-outer-spin-button {\n  -webkit-appearance: none;\n}\n\n/**\n * Correct the outline style in Safari.\n */\n[type=search] {\n  outline-offset: -2px;\n}\n\n/**\n * Remove the inner padding in Chrome and Safari on macOS.\n */\n[type=search]::-webkit-search-decoration {\n  -webkit-appearance: none;\n}\n\n/*\n * Remove the \u2018X\u2019 from Chrome and Safari.\n */\n[type=search]::-webkit-search-decoration,\n[type=search]::-webkit-search-cancel-button,\n[type=search]::-webkit-search-results-button,\n[type=search]::-webkit-search-results-decoration {\n  display: none;\n}\n\n/**\n * 1. Hide file input completely.\n * 2. Remove selected file text.\n * 3. Set cursor to pointer for all browsers.\n */\n[type=file] {\n  opacity: 0; /* 1 */\n  font-size: 0; /* 2 */\n  cursor: pointer; /* 3 */\n}\n\n/**\n	* Fix appearance for Firefox\n	*/\n[type=number] {\n  -moz-appearance: textfield;\n}\n\n/**\n * Set cursor to pointer for all browsers.\n */\n[type=range] {\n  cursor: pointer;\n}\n\n/**\n * Reset slider thumbs to make them styleable.\n */\n[type=range]::-webkit-slider-thumb {\n  -webkit-appearance: none;\n  appearance: none;\n}\n\n[type=range]::-moz-range-thumb {\n  -moz-appearance: none;\n  appearance: none;\n  border-width: 0;\n  border-radius: 0;\n  background-color: transparent;\n}\n\n/* Interactive */\n/* ============================================ */\n/*\n * Add the correct display in Edge, IE 10+, and Firefox.\n */\ndetails {\n  display: block;\n}\n\n/*\n * Add the correct display in all browsers.\n */\nsummary {\n  display: list-item;\n}\n\n/*\n * Remove outline for editable content.\n */\n[contenteditable]:focus {\n  outline: auto;\n}\n\n/* Tables */\n/* ============================================ */\n/**\n1. Correct table border color inheritance in all Chrome and Safari.\n*/\ntable {\n  border-color: inherit; /* 1 */\n  border-collapse: collapse;\n}\n\ncaption {\n  text-align: left;\n}\n\ntd,\nth {\n  vertical-align: top;\n  padding: 0;\n}\n\nth {\n  text-align: left;\n  font-weight: inherit;\n}\n\n/* Misc */\n/* ============================================ */\n/*\n * Make placeholder style consistent across all browsers.\n */\n::placeholder {\n  color: #999;\n  opacity: 1;\n}\n\n/*\n * Hide focus outline but keep it visible for Windows High Contrast Mode.\n */\n:focus {\n  outline-style: solid;\n  outline-color: transparent;\n}\n\n/*\n * Hide input arrow when used with datalist.\n */\n::-webkit-calendar-picker-indicator {\n  display: none !important;\n}';

// src/components/page-toolbar-css/index.tsx
var import_jsx_runtime19 = require("react/jsx-runtime");
var import_react20 = require("react");
var shadowCss = [
  css12,
  css4,
  css,
  css9,
  css5,
  css3,
  css2,
  css7,
  css6,
  css10,
  css11,
  css8
].join("\n");
function identifyElementWithReact(element, reactMode = "filtered", attributeNames) {
  const { name: elementName, path } = identifyElement(element, attributeNames);
  if (reactMode === "off") {
    return { name: elementName, elementName, path, reactComponents: null };
  }
  const reactInfo = getReactComponentName(element, { mode: reactMode });
  return {
    name: reactInfo.path ? `${reactInfo.path} ${elementName}` : elementName,
    elementName,
    path,
    reactComponents: reactInfo.path
  };
}
var hasPlayedEntranceAnimation = false;
var DEFAULT_SETTINGS = {
  outputDetail: "standard",
  autoClearAfterCopy: false,
  annotationColorId: "blue",
  blockInteractions: true,
  reactEnabled: true,
  markerClickBehavior: "edit",
  webhookUrl: "",
  webhooksEnabled: true
};
var isValidUrl = (url) => {
  if (!url || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};
var OUTPUT_TO_REACT_MODE = {
  compact: "off",
  standard: "filtered",
  detailed: "smart",
  forensic: "all"
};
var isPrimaryMultiSelectModifierActive = (event) => event.metaKey || event.ctrlKey;
var COLOR_OPTIONS = [
  { id: "indigo", label: "Indigo", srgb: "#6155F5", p3: "color(display-p3 0.38 0.33 0.96)" },
  { id: "blue", label: "Blue", srgb: "#0088FF", p3: "color(display-p3 0.00 0.53 1.00)" },
  { id: "cyan", label: "Cyan", srgb: "#00C3D0", p3: "color(display-p3 0.00 0.76 0.82)" },
  { id: "green", label: "Green", srgb: "#34C759", p3: "color(display-p3 0.20 0.78 0.35)" },
  { id: "yellow", label: "Yellow", srgb: "#FFCC00", p3: "color(display-p3 1.00 0.80 0.00)" },
  { id: "orange", label: "Orange", srgb: "#FF8D28", p3: "color(display-p3 1.00 0.55 0.16)" },
  { id: "red", label: "Red", srgb: "#FF383C", p3: "color(display-p3 1.00 0.22 0.24)" }
];
var agentationColorTokensCss = [
  ...COLOR_OPTIONS.map(
    (c) => `
    [data-agentation-accent="${c.id}"] {
      --agentation-color-accent: ${c.srgb};
    }
    @supports (color: color(display-p3 0 0 0)) {
      [data-agentation-accent="${c.id}"] {
        --agentation-color-accent: ${c.p3};
      }
    }
  `
  ),
  `:host {
    ${COLOR_OPTIONS.map((c) => `--agentation-color-${c.id}: ${c.srgb};`).join("\n")}
  }`,
  `@supports (color: color(display-p3 0 0 0)) {
    :host {
      ${COLOR_OPTIONS.map((c) => `--agentation-color-${c.id}: ${c.p3};`).join("\n")}
    }
  }`
].join("");
function isElementFixed(element) {
  let outer = element;
  for (let frame = parentFrame(outer.ownerDocument); frame; frame = parentFrame(outer.ownerDocument)) outer = frame;
  let current = outer;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const position = style.position;
    if (position === "fixed" || position === "sticky") {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}
function isRenderableAnnotation(annotation) {
  return annotation.kind !== "placement" && annotation.kind !== "rearrange" && annotation.status !== "resolved" && annotation.status !== "dismissed";
}
function detectSourceFile(element) {
  const result = getSourceLocation(element);
  const loc = result.found ? result : findNearestComponentSource(element);
  if (loc.found && loc.source) {
    return formatSourceLocation(loc.source, "path");
  }
  return void 0;
}
function PageFeedbackToolbarCSS(props = {}) {
  const pathname = usePagePath(props.useHashLocation ?? false);
  const activeState = (0, import_react19.useState)(false);
  const portalHost = useFeedbackPortal(props.portalContainer);
  if (!portalHost) return null;
  return (0, import_react_dom3.createPortal)(/* @__PURE__ */ (0, import_react20.createElement)(
    PageFeedbackToolbarForRoute,
    {
      ...props,
      key: props.useHashLocation ? pathname : void 0,
      pathname,
      activeState,
      portalHost
    }
  ), portalHost);
}
function PageFeedbackToolbarForRoute({
  pathname,
  activeState,
  portalHost,
  useHashLocation = false,
  appName,
  enableKeyboardShortcuts = true,
  identifyingAttributes = DEFAULT_IDENTIFYING_ATTRIBUTES,
  copyFormat = "markdown",
  onOpenSource,
  portalContainer,
  demoAnnotations,
  demoDelay = 1e3,
  enableDemoMode = false,
  onAnnotationAdd,
  onAnnotationDelete,
  onAnnotationUpdate,
  onAnnotationsClear,
  onCopy,
  onSubmit,
  copyToClipboard = true,
  endpoint,
  sessionId: initialSessionId,
  onSessionCreated,
  webhookUrl,
  className: userClassName
}) {
  const [isActive, setIsActive] = activeState;
  const [, updateFrameScroll] = (0, import_react19.useState)(0);
  const [pageEvents] = (0, import_react19.useState)(() => createPageEvents(document, () => updateFrameScroll((value) => value + 1)));
  (0, import_react19.useEffect)(() => {
    pageEvents.start();
    return () => pageEvents.stop();
  }, [pageEvents]);
  const copyAttribute = typeof copyFormat === "object" ? copyFormat.attribute : void 0;
  const attributeNames = (0, import_react19.useMemo)(() => copyAttribute ? [...identifyingAttributes, copyAttribute] : identifyingAttributes, [identifyingAttributes, copyAttribute]);
  const routeAlive = (0, import_react19.useRef)(true);
  (0, import_react19.useLayoutEffect)(() => {
    routeAlive.current = true;
    return () => {
      routeAlive.current = false;
    };
  }, []);
  const routeTask = (0, import_react19.useCallback)(
    (work) => useHashLocation ? runPageTask(JSON.stringify([endpoint, pathname]), work) : work(),
    [endpoint, pathname, useHashLocation]
  );
  const serverIds = (0, import_react19.useRef)(/* @__PURE__ */ new Map());
  const deletedIds = (0, import_react19.useRef)(/* @__PURE__ */ new Set());
  const keepFeedback = (annotation) => isRenderableAnnotation(annotation) && !deletedIds.current.has(annotation.id);
  const syncPageAnnotation = async (...args) => {
    const saved = await syncAnnotation(...args);
    const sent = args[2];
    const localId = sent.id;
    if (localId) {
      serverIds.current.set(localId, saved.id);
      if (deletedIds.current.has(localId)) deletedIds.current.add(saved.id);
    }
    if (!useHashLocation) {
      const pagePath2 = new URL(sent.url || window.location.href).pathname;
      const latest = loadAnnotations(pagePath2).find((a) => a.id === localId);
      try {
        if (deletedIds.current.has(localId)) {
          await deleteAnnotation(args[0], saved.id);
        } else if (latest && latest.comment !== sent.comment) {
          await updateAnnotation(args[0], saved.id, { comment: latest.comment });
          return { ...saved, comment: latest.comment };
        }
      } catch (error) {
        console.warn("[Agentation] Failed to apply changes made during sync:", error);
      }
    }
    return saved;
  };
  const scopeSession = (session) => useHashLocation ? { ...session, annotations: session.annotations.filter((a) => !deletedIds.current.has(a.id) && matchesPage(a.url || session.url, pathname, window.location.origin)) } : session;
  const latestPathname = (0, import_react19.useRef)(pathname);
  latestPathname.current = pathname;
  const applySessionFeedback = (before, incoming, sessionId, pagePath2 = pathname) => {
    const merged = mergeSessionFeedback(before, loadAnnotations(pagePath2), incoming, serverIds.current).filter(keepFeedback);
    if (pagePath2 === latestPathname.current && routeAlive.current) setAnnotations(merged);
    saveAnnotationsWithSyncMarker(pagePath2, merged, sessionId);
  };
  const [annotations, setAnnotations] = (0, import_react19.useState)([]);
  const [showMarkers, setShowMarkers] = (0, import_react19.useState)(true);
  const [isToolbarHidden, setIsToolbarHidden] = (0, import_react19.useState)(() => loadToolbarHidden());
  const [isToolbarHiding, setIsToolbarHiding] = (0, import_react19.useState)(false);
  (0, import_react19.useLayoutEffect)(() => {
    installAnimationFreeze();
  }, []);
  const portalWrapperRef = (0, import_react19.useRef)(null);
  const launcherRef = (0, import_react19.useRef)(null);
  const controlsRef = (0, import_react19.useRef)(null);
  const settingsButtonRef = (0, import_react19.useRef)(null);
  const focusControlsOnOpenRef = (0, import_react19.useRef)(false);
  const focusLauncherOnCloseRef = (0, import_react19.useRef)(false);
  const focusSettingsOnOpenRef = (0, import_react19.useRef)(false);
  (0, import_react19.useLayoutEffect)(() => {
    if (isActive && focusControlsOnOpenRef.current) {
      focusControlsOnOpenRef.current = false;
      controlsRef.current?.querySelector("button:not(:disabled)")?.focus();
    } else if (!isActive && focusLauncherOnCloseRef.current) {
      focusLauncherOnCloseRef.current = false;
      launcherRef.current?.focus();
    }
  }, [isActive]);
  (0, import_react19.useEffect)(() => {
    const stop = (e) => {
      const wrapper = portalWrapperRef.current;
      if (wrapper && e.composedPath().includes(wrapper)) {
        e.stopPropagation();
      }
    };
    const events = ["mousedown", "click", "pointerdown"];
    events.forEach((evt) => portalHost.addEventListener(evt, stop));
    return () => {
      events.forEach((evt) => portalHost.removeEventListener(evt, stop));
    };
  }, [portalHost]);
  const [markersVisible, setMarkersVisible] = (0, import_react19.useState)(false);
  const [markersExiting, setMarkersExiting] = (0, import_react19.useState)(false);
  const [hoverInfo, setHoverInfo] = (0, import_react19.useState)(null);
  const [hoverPosition, setHoverPosition] = (0, import_react19.useState)({ x: 0, y: 0 });
  const [pendingAnnotation, setPendingAnnotation] = (0, import_react19.useState)(null);
  const [copied, setCopied] = (0, import_react19.useState)(false);
  const copyAction = useLatestAction();
  const sendAction = useLatestAction();
  const [sendState, setSendState] = (0, import_react19.useState)("idle");
  const [isClearing, setIsClearing] = (0, import_react19.useState)(false);
  const clearingIds = (0, import_react19.useRef)(/* @__PURE__ */ new Set());
  const pendingClearIds = (0, import_react19.useRef)(/* @__PURE__ */ new Set());
  const clearLayoutTimer = (0, import_react19.useRef)();
  const finishClearBatch = (0, import_react19.useCallback)(() => {
    if (!clearingIds.current.size && !clearLayoutTimer.current) setIsClearing(false);
  }, []);
  (0, import_react19.useEffect)(() => () => clearTimeout(clearLayoutTimer.current), []);
  const [hoveredMarkerId, setHoveredMarkerId] = (0, import_react19.useState)(null);
  const [hoveredTargetElement, setHoveredTargetElement] = (0, import_react19.useState)(null);
  const [hoveredTargetElements, setHoveredTargetElements] = (0, import_react19.useState)([]);
  const [renumberFrom, setRenumberFrom] = (0, import_react19.useState)(null);
  const renumberTimeoutRef = (0, import_react19.useRef)(null);
  (0, import_react19.useEffect)(() => () => {
    if (renumberTimeoutRef.current) clearTimeout(renumberTimeoutRef.current);
  }, []);
  const [editingAnnotation, setEditingAnnotation] = (0, import_react19.useState)(
    null
  );
  const editingTriggerRef = (0, import_react19.useRef)(null);
  const editingFromKeyboardRef = (0, import_react19.useRef)(false);
  const [restoreEditPreview, setRestoreEditPreview] = (0, import_react19.useState)(false);
  (0, import_react19.useLayoutEffect)(() => {
    if (editingAnnotation || !editingTriggerRef.current) return;
    const trigger = editingTriggerRef.current;
    editingTriggerRef.current = null;
    if (pendingAnnotation) return;
    const target = isActive && trigger.isConnected && !trigger.disabled ? trigger : launcherRef.current;
    target?.focus({ preventScroll: true });
  }, [editingAnnotation, isActive, pendingAnnotation]);
  const [editingTargetElement, setEditingTargetElement] = (0, import_react19.useState)(null);
  const [editingTargetElements, setEditingTargetElements] = (0, import_react19.useState)([]);
  const [scrollY, setScrollY] = (0, import_react19.useState)(0);
  const [isScrolling, setIsScrolling] = (0, import_react19.useState)(false);
  const [mounted, setMounted] = (0, import_react19.useState)(false);
  const [isFrozen, setIsFrozen] = (0, import_react19.useState)(false);
  const [showSettings, setShowSettings] = (0, import_react19.useState)(false);
  const [settingsPage, setSettingsPage] = (0, import_react19.useState)(
    "main"
  );
  const [tooltipsHidden, setTooltipsHidden] = (0, import_react19.useState)(false);
  const [isDesignMode, setIsDesignMode] = (0, import_react19.useState)(false);
  const [designOverlayExiting, setDesignOverlayExiting] = (0, import_react19.useState)(false);
  const [designPlacements, setDesignPlacements] = (0, import_react19.useState)([]);
  const [activeDesignComponent, setActiveDesignComponent] = (0, import_react19.useState)(null);
  const designPlacementsLoaded = (0, import_react19.useRef)(false);
  const [blankCanvas, setBlankCanvas] = (0, import_react19.useState)(false);
  const [canvasReady, setCanvasReady] = (0, import_react19.useState)(false);
  const [canvasOpacity, setCanvasOpacity] = (0, import_react19.useState)(1);
  const [canvasPurpose, setCanvasPurpose] = (0, import_react19.useState)("new-page");
  const [wireframePurpose, setWireframePurpose] = (0, import_react19.useState)("");
  const [designInteracting, setDesignInteracting] = (0, import_react19.useState)(false);
  const [rearrangeState, setRearrangeState] = (0, import_react19.useState)(null);
  const rearrangeLoaded = (0, import_react19.useRef)(false);
  const exploreStashRef = (0, import_react19.useRef)({ rearrange: null, placements: [] });
  const wireframeStashRef = (0, import_react19.useRef)({ rearrange: null, placements: [] });
  const [designDeselectSignal, setDesignDeselectSignal] = (0, import_react19.useState)(0);
  const [rearrangeDeselectSignal, setRearrangeDeselectSignal] = (0, import_react19.useState)(0);
  const [clearingPlacements, setClearingPlacements] = (0, import_react19.useState)([]);
  const [clearingRearrange, setClearingRearrange] = (0, import_react19.useState)(null);
  const layoutSnapshot = (0, import_react19.useRef)({ designPlacements, rearrangeState, blankCanvas, wireframePurpose });
  layoutSnapshot.current = { designPlacements, rearrangeState, blankCanvas, wireframePurpose };
  const clearingLayout = (0, import_react19.useRef)({ placements: clearingPlacements, rearrange: clearingRearrange });
  const designSelectedIdsRef = (0, import_react19.useRef)(/* @__PURE__ */ new Set());
  const rearrangeSelectedIdsRef = (0, import_react19.useRef)(/* @__PURE__ */ new Set());
  const crossDragStartRef = (0, import_react19.useRef)(null);
  const designExitTimer = (0, import_react19.useRef)();
  const canvasShouldBeVisible = isDesignMode && isActive && !designOverlayExiting && blankCanvas;
  (0, import_react19.useEffect)(() => {
    if (canvasShouldBeVisible) {
      setCanvasReady(false);
      const raf = originalRequestAnimationFrame(() => {
        setCanvasReady(true);
      });
      return () => cancelAnimationFrame(raf);
    } else {
      setCanvasReady(false);
    }
  }, [canvasShouldBeVisible]);
  const placementAnnotationMap = (0, import_react19.useRef)(/* @__PURE__ */ new Map());
  const existingLayoutAnnotations = (0, import_react19.useRef)([]);
  const rearrangeAnnotationMap = (0, import_react19.useRef)(/* @__PURE__ */ new Map());
  const layoutSync = (0, import_react19.useRef)(null);
  const [isDrawMode, setIsDrawMode] = (0, import_react19.useState)(false);
  const [drawStrokes, setDrawStrokes] = (0, import_react19.useState)([]);
  const drawStrokesRef = (0, import_react19.useRef)(drawStrokes);
  drawStrokesRef.current = drawStrokes;
  const [hoveredDrawingIdx, setHoveredDrawingIdx] = (0, import_react19.useState)(null);
  const drawCanvasRef = (0, import_react19.useRef)(null);
  const isDrawingRef = (0, import_react19.useRef)(false);
  const currentStrokeRef = (0, import_react19.useRef)([]);
  const dimAmountRef = (0, import_react19.useRef)(0);
  const visualHighlightRef = (0, import_react19.useRef)(null);
  const exitingStrokeIdRef = (0, import_react19.useRef)(null);
  const exitingAlphaRef = (0, import_react19.useRef)(1);
  const [tooltipSessionActive, setTooltipSessionActive] = (0, import_react19.useState)(false);
  const tooltipSessionTimerRef = (0, import_react19.useRef)(
    null
  );
  const [pendingMultiSelectElements, setPendingMultiSelectElements] = (0, import_react19.useState)([]);
  const legacyMultiSelectRef = (0, import_react19.useRef)(false);
  const hideTooltipsUntilMouseLeave = () => {
    setTooltipsHidden(true);
  };
  const showTooltipsAgain = () => {
    setTooltipsHidden(false);
  };
  const handleControlsMouseEnter = () => {
    if (!tooltipSessionActive) {
      tooltipSessionTimerRef.current = originalSetTimeout(
        () => setTooltipSessionActive(true),
        850
      );
    }
  };
  const handleControlsMouseLeave = () => {
    if (tooltipSessionTimerRef.current) {
      clearTimeout(tooltipSessionTimerRef.current);
      tooltipSessionTimerRef.current = null;
    }
    setTooltipSessionActive(false);
    showTooltipsAgain();
  };
  (0, import_react19.useEffect)(() => {
    return () => {
      if (tooltipSessionTimerRef.current)
        clearTimeout(tooltipSessionTimerRef.current);
    };
  }, []);
  const [settings, setSettings] = (0, import_react19.useState)(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("feedback-toolbar-settings") ?? "");
      return {
        ...DEFAULT_SETTINGS,
        ...saved,
        annotationColorId: COLOR_OPTIONS.find((c) => c.id === saved.annotationColorId) ? saved.annotationColorId : DEFAULT_SETTINGS.annotationColorId
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  });
  const [isDarkMode, setIsDarkMode] = (0, import_react19.useState)(true);
  const [showEntranceAnimation, setShowEntranceAnimation] = (0, import_react19.useState)(false);
  const updateSettings = (0, import_react19.useCallback)((patch) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);
  const toggleTheme = (0, import_react19.useCallback)(() => {
    portalWrapperRef.current?.classList.add(styles_module_default3.disableTransitions);
    setIsDarkMode((previous) => !previous);
    originalRequestAnimationFrame(() => {
      portalWrapperRef.current?.classList.remove(styles_module_default3.disableTransitions);
    });
  }, []);
  const isDevMode = process.env.NODE_ENV === "development" || isReactPage();
  const effectiveReactMode = isDevMode && settings.reactEnabled ? OUTPUT_TO_REACT_MODE[settings.outputDetail] : "off";
  const [currentSessionId, setCurrentSessionId] = (0, import_react19.useState)(
    useHashLocation ? null : initialSessionId ?? null
  );
  const sessionInitializedRef = (0, import_react19.useRef)(false);
  const [connectionStatus, setConnectionStatus] = (0, import_react19.useState)(endpoint ? "connecting" : "disconnected");
  const [toolbarPosition, setToolbarPosition] = (0, import_react19.useState)(null);
  const [isDraggingToolbar, setIsDraggingToolbar] = (0, import_react19.useState)(false);
  const toolbarDragRef = (0, import_react19.useRef)(null);
  const justFinishedToolbarDragRef = (0, import_react19.useRef)(false);
  const animatedMarkers = (0, import_react19.useRef)(/* @__PURE__ */ new Set());
  const markerKeys = (0, import_react19.useRef)(/* @__PURE__ */ new Map());
  const handleMarkerEntered = (0, import_react19.useCallback)((id) => {
    animatedMarkers.current.add(id);
    if (recentlyAddedIdRef.current === id) recentlyAddedIdRef.current = null;
  }, []);
  const [exitingMarkers, setExitingMarkers] = (0, import_react19.useState)(/* @__PURE__ */ new Set());
  const [pendingExiting, setPendingExiting] = (0, import_react19.useState)(false);
  const [editExiting, setEditExiting] = (0, import_react19.useState)(false);
  const [isDragging, setIsDragging] = (0, import_react19.useState)(false);
  const mouseDownPosRef = (0, import_react19.useRef)(null);
  const dragStartRef = (0, import_react19.useRef)(null);
  const dragRectRef = (0, import_react19.useRef)(null);
  const highlightsContainerRef = (0, import_react19.useRef)(null);
  const justFinishedDragRef = (0, import_react19.useRef)(false);
  const lastElementUpdateRef = (0, import_react19.useRef)(0);
  const recentlyAddedIdRef = (0, import_react19.useRef)(null);
  const prevConnectionStatusRef = (0, import_react19.useRef)(null);
  const DRAG_THRESHOLD = 8;
  const ELEMENT_UPDATE_THROTTLE = 50;
  const popupRef = (0, import_react19.useRef)(null);
  const editPopupRef = (0, import_react19.useRef)(null);
  const scrollTimeoutRef = (0, import_react19.useRef)(null);
  const finishSettingsExit = (0, import_react19.useCallback)(() => setSettingsPage("main"), []);
  (0, import_react19.useEffect)(() => {
    if (!showSettings) setTooltipsHidden(false);
  }, [showSettings]);
  (0, import_react19.useLayoutEffect)(() => {
    if (showSettings && focusSettingsOnOpenRef.current) {
      focusSettingsOnOpenRef.current = false;
      portalWrapperRef.current?.querySelector(
        "[data-agentation-settings-panel] button"
      )?.focus();
    }
  }, [showSettings]);
  const shouldShowMarkers = isActive && showMarkers && !isDesignMode;
  (0, import_react19.useEffect)(() => {
    if (shouldShowMarkers) {
      setMarkersExiting(false);
      setMarkersVisible(true);
      animatedMarkers.current.clear();
    } else if (markersVisible) {
      setMarkersExiting(true);
      const timer = originalSetTimeout(() => {
        setMarkersVisible(false);
        setMarkersExiting(false);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [shouldShowMarkers]);
  (0, import_react19.useEffect)(() => {
    setMounted(true);
    setScrollY(window.scrollY);
    const stored = loadAnnotations(pathname);
    setAnnotations(stored.filter(isRenderableAnnotation));
    if (!hasPlayedEntranceAnimation) {
      setShowEntranceAnimation(true);
      hasPlayedEntranceAnimation = true;
      originalSetTimeout(() => setShowEntranceAnimation(false), 750);
    }
    try {
      const savedTheme = localStorage.getItem("feedback-toolbar-theme");
      if (savedTheme !== null) {
        setIsDarkMode(savedTheme === "dark");
      }
    } catch (e) {
    }
    try {
      const savedPosition = localStorage.getItem("feedback-toolbar-position");
      if (savedPosition) {
        const pos = JSON.parse(savedPosition);
        if (typeof pos.x === "number" && typeof pos.y === "number") {
          setToolbarPosition(pos);
        }
      }
    } catch (e) {
    }
  }, [pathname]);
  (0, import_react19.useEffect)(() => {
    if (mounted) {
      localStorage.setItem(
        "feedback-toolbar-settings",
        JSON.stringify(settings)
      );
    }
  }, [settings, mounted]);
  (0, import_react19.useEffect)(() => {
    if (mounted) {
      localStorage.setItem(
        "feedback-toolbar-theme",
        isDarkMode ? "dark" : "light"
      );
    }
  }, [isDarkMode, mounted]);
  const prevDraggingRef = (0, import_react19.useRef)(false);
  (0, import_react19.useEffect)(() => {
    const wasDragging = prevDraggingRef.current;
    prevDraggingRef.current = isDraggingToolbar;
    if (wasDragging && !isDraggingToolbar && toolbarPosition && mounted) {
      localStorage.setItem(
        "feedback-toolbar-position",
        JSON.stringify(toolbarPosition)
      );
    }
  }, [isDraggingToolbar, toolbarPosition, mounted]);
  (0, import_react19.useEffect)(() => {
    if (!endpoint || !mounted || sessionInitializedRef.current) return;
    sessionInitializedRef.current = true;
    setConnectionStatus("connecting");
    const currentUrl = window.location.href;
    const initSession = async () => {
      try {
        const storedSessionId = loadSessionId(pathname);
        const sessionIdToJoin = initialSessionId || storedSessionId;
        let sessionEstablished = false;
        if (sessionIdToJoin) {
          try {
            const beforeJoin = loadAnnotations(pathname);
            const session = scopeSession(await getSession(endpoint, sessionIdToJoin));
            existingLayoutAnnotations.current = session.annotations.filter((a) => a.kind === "placement" || a.kind === "rearrange");
            if (routeAlive.current) {
              setCurrentSessionId(session.id);
              setConnectionStatus("connected");
            }
            saveSessionId(pathname, session.id);
            sessionEstablished = true;
            const allLocalAnnotations = loadAnnotations(pathname).filter(isRenderableAnnotation);
            const serverIds2 = new Set(session.annotations.map((a) => a.id));
            const localToMerge = allLocalAnnotations.filter((a) => {
              if (serverIds2.has(a.id)) return false;
              return true;
            });
            if (localToMerge.length > 0) {
              const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
              const pageUrl = `${baseUrl}${pathname}`;
              const results = await Promise.allSettled(
                localToMerge.map(
                  (annotation) => syncPageAnnotation(endpoint, session.id, {
                    ...annotation,
                    sessionId: session.id,
                    url: pageUrl
                  })
                )
              );
              const syncedAnnotations = results.map((result, i) => {
                if (result.status === "fulfilled") {
                  return result.value;
                }
                console.warn(
                  "[Agentation] Failed to sync annotation:",
                  result.reason
                );
                return localToMerge[i];
              });
              const allAnnotations = [
                ...session.annotations,
                ...syncedAnnotations
              ];
              applySessionFeedback(beforeJoin, allAnnotations, session.id);
            } else {
              applySessionFeedback(beforeJoin, session.annotations, session.id);
            }
          } catch (joinError) {
            console.warn(
              "[Agentation] Could not join session, creating new:",
              joinError
            );
            clearSessionId(pathname);
          }
        }
        if (!sessionEstablished) {
          const session = await createSession(endpoint, currentUrl);
          saveSessionId(pathname, session.id);
          if (routeAlive.current) {
            setCurrentSessionId(session.id);
            setConnectionStatus("connected");
            onSessionCreated?.(session.id);
          }
          const allAnnotations = useHashLocation ? /* @__PURE__ */ new Map([[pathname, loadAnnotations(pathname)]]) : loadAllAnnotations();
          const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
          const syncPromises = [];
          for (const [pagePath2, annotations2] of allAnnotations) {
            const unsyncedAnnotations = annotations2.filter(
              (a) => isRenderableAnnotation(a) && !a._syncedTo
            );
            if (unsyncedAnnotations.length === 0) continue;
            const pageUrl = `${baseUrl}${pagePath2}`;
            const isCurrentPage = pagePath2 === pathname;
            syncPromises.push(
              (async () => {
                try {
                  const targetSession = isCurrentPage ? session : await createSession(endpoint, pageUrl);
                  const results = await Promise.allSettled(
                    unsyncedAnnotations.map(
                      (annotation) => syncPageAnnotation(endpoint, targetSession.id, {
                        ...annotation,
                        sessionId: targetSession.id,
                        url: pageUrl
                      })
                    )
                  );
                  const syncedAnnotations = results.map((result, i) => {
                    if (result.status === "fulfilled") {
                      return result.value;
                    }
                    console.warn(
                      "[Agentation] Failed to sync annotation:",
                      result.reason
                    );
                    return unsyncedAnnotations[i];
                  });
                  applySessionFeedback(unsyncedAnnotations, syncedAnnotations, targetSession.id, pagePath2);
                } catch (err) {
                  console.warn(
                    `[Agentation] Failed to sync annotations for ${pagePath2}:`,
                    err
                  );
                }
              })()
            );
          }
          await Promise.allSettled(syncPromises);
        }
      } catch (error) {
        if (routeAlive.current) setConnectionStatus("disconnected");
        console.warn(
          "[Agentation] Failed to initialize session, using local storage:",
          error
        );
      }
    };
    void routeTask(initSession);
  }, [endpoint, initialSessionId, mounted, onSessionCreated, pathname, routeTask]);
  (0, import_react19.useEffect)(() => {
    if (!endpoint || !mounted) return;
    const checkHealth = async () => {
      try {
        const response = await fetch(`${endpoint}/health`);
        if (response.ok) {
          setConnectionStatus("connected");
        } else {
          setConnectionStatus("disconnected");
        }
      } catch {
        setConnectionStatus("disconnected");
      }
    };
    checkHealth();
    const interval = originalSetInterval(checkHealth, 1e4);
    return () => clearInterval(interval);
  }, [endpoint, mounted]);
  const currentAnnotationsRef = (0, import_react19.useRef)(annotations);
  const hasPendingFeedbackRef = (0, import_react19.useRef)(false);
  (0, import_react19.useLayoutEffect)(() => {
    currentAnnotationsRef.current = annotations;
    hasPendingFeedbackRef.current = annotations.length > 0 || designPlacements.length > 0 || (rearrangeState?.sections.length ?? 0) > 0;
  }, [annotations, designPlacements.length, rearrangeState?.sections.length]);
  const finishMarkerRemoval = (0, import_react19.useCallback)((id) => {
    const wasClearing = clearingIds.current.has(id);
    if (wasClearing) {
      pendingClearIds.current.delete(id);
      if (pendingClearIds.current.size) return;
    }
    const removed = wasClearing ? new Set(clearingIds.current) : /* @__PURE__ */ new Set([id]);
    if (wasClearing) {
      clearingIds.current.clear();
      finishClearBatch();
    }
    for (const removedId of removed) {
      markerKeys.current.delete(removedId);
      animatedMarkers.current.delete(removedId);
    }
    setAnnotations((previous) => previous.filter((a) => !removed.has(a.id)));
    setExitingMarkers((previous) => new Set([...previous].filter((id2) => !removed.has(id2))));
    const notes = wasClearing ? [] : currentAnnotationsRef.current.filter((a) => a.kind !== "placement" && a.kind !== "rearrange");
    const index = notes.findIndex((a) => a.id === id);
    if (index >= 0 && index < notes.length - 1) {
      setRenumberFrom((previous) => previous === null ? index : Math.min(previous, index));
      if (renumberTimeoutRef.current) clearTimeout(renumberTimeoutRef.current);
      renumberTimeoutRef.current = originalSetTimeout(() => setRenumberFrom(null), 200);
    }
  }, [finishClearBatch]);
  (0, import_react19.useEffect)(() => {
    if (!endpoint || !mounted || !currentSessionId) return;
    const remove = (annotation) => {
      const { id, kind } = annotation;
      if (kind === "placement") {
        for (const [placementId, annotationId] of placementAnnotationMap.current) {
          if (annotationId === id) {
            layoutSync.current?.placements.forget(placementId);
            setDesignPlacements((prev) => prev.filter((p) => p.id !== placementId));
            break;
          }
        }
      } else if (kind === "rearrange") {
        for (const [sectionId, annotationId] of rearrangeAnnotationMap.current) {
          if (annotationId === id) {
            layoutSync.current?.rearrange.forget(sectionId);
            setRearrangeState((prev) => {
              if (!prev) return null;
              const remaining = prev.sections.filter((s2) => s2.id !== sectionId);
              if (remaining.length === 0) return null;
              return { ...prev, sections: remaining };
            });
            break;
          }
        }
      } else {
        if (!currentAnnotationsRef.current.some((a) => a.id === id)) return;
        setExitingMarkers((prev) => new Set(prev).add(id));
      }
    };
    const stop = subscribeSessionResolutions(
      endpoint,
      currentSessionId,
      () => hasPendingFeedbackRef.current,
      remove
    );
    return stop;
  }, [endpoint, mounted, currentSessionId]);
  (0, import_react19.useEffect)(() => {
    if (!endpoint || !mounted) return;
    const wasDisconnected = prevConnectionStatusRef.current === "disconnected";
    const isNowConnected = connectionStatus === "connected";
    prevConnectionStatusRef.current = connectionStatus;
    if (wasDisconnected && isNowConnected) {
      const syncLocalAnnotations = async () => {
        try {
          const localAnnotations = loadAnnotations(pathname).filter(isRenderableAnnotation);
          if (localAnnotations.length === 0) return;
          const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
          const pageUrl = `${baseUrl}${pathname}`;
          let sessionId = currentSessionId;
          let serverAnnotations = [];
          if (sessionId) {
            try {
              const session = scopeSession(await getSession(endpoint, sessionId));
              serverAnnotations = session.annotations;
            } catch {
              sessionId = null;
            }
          }
          if (!sessionId) {
            const newSession = await createSession(endpoint, pageUrl);
            sessionId = newSession.id;
            if (routeAlive.current) setCurrentSessionId(sessionId);
            saveSessionId(pathname, sessionId);
          }
          const serverIds2 = new Set(serverAnnotations.map((a) => a.id));
          const unsyncedLocal = localAnnotations.filter((a) => !serverIds2.has(a.id));
          if (unsyncedLocal.length > 0) {
            const results = await Promise.allSettled(
              unsyncedLocal.map(
                (annotation) => syncPageAnnotation(endpoint, sessionId, {
                  ...annotation,
                  sessionId,
                  url: pageUrl
                })
              )
            );
            const syncedAnnotations = results.map((result, i) => {
              if (result.status === "fulfilled") {
                return result.value;
              }
              console.warn("[Agentation] Failed to sync annotation on reconnect:", result.reason);
              return unsyncedLocal[i];
            });
            const allAnnotations = [...serverAnnotations, ...syncedAnnotations];
            applySessionFeedback(localAnnotations, allAnnotations, sessionId);
          }
        } catch (err) {
          console.warn("[Agentation] Failed to sync on reconnect:", err);
        }
      };
      void routeTask(syncLocalAnnotations);
    }
  }, [connectionStatus, endpoint, mounted, currentSessionId, pathname, routeTask]);
  const hideToolbarTemporarily = (0, import_react19.useCallback)(() => {
    if (isToolbarHiding) return;
    setIsToolbarHiding(true);
    setShowSettings(false);
    setIsActive(false);
    originalSetTimeout(() => {
      saveToolbarHidden(true);
      setIsToolbarHidden(true);
      setIsToolbarHiding(false);
    }, 400);
  }, [isToolbarHiding]);
  (0, import_react19.useEffect)(() => {
    if (!enableDemoMode) return;
    if (!mounted || !demoAnnotations || demoAnnotations.length === 0) return;
    if (annotations.length > 0) return;
    const timeoutIds = [];
    timeoutIds.push(
      originalSetTimeout(() => {
        setIsActive(true);
      }, demoDelay - 200)
    );
    demoAnnotations.forEach((demo, index) => {
      const annotationDelay = demoDelay + index * 300;
      timeoutIds.push(
        originalSetTimeout(() => {
          const element = document.querySelector(demo.selector);
          if (!element) return;
          const rect = viewportRect(element);
          const { name, path } = identifyElement(element);
          const newAnnotation = {
            id: `demo-${Date.now()}-${index}`,
            x: (rect.left + rect.width / 2) / window.innerWidth * 100,
            y: rect.top + rect.height / 2 + window.scrollY,
            comment: demo.comment,
            element: name,
            elementPath: path,
            timestamp: Date.now(),
            selectedText: demo.selectedText,
            boundingBox: {
              x: rect.left,
              y: rect.top + window.scrollY,
              width: rect.width,
              height: rect.height
            },
            nearbyText: getNearbyText(element),
            cssClasses: getElementClasses(element)
          };
          setAnnotations((prev) => [...prev, newAnnotation]);
        }, annotationDelay)
      );
    });
    return () => {
      timeoutIds.forEach(clearTimeout);
    };
  }, [enableDemoMode, mounted, demoAnnotations, demoDelay]);
  (0, import_react19.useEffect)(() => {
    const handleScroll = () => {
      setScrollY(window.scrollY);
      updateFrameScroll((value) => value + 1);
      setIsScrolling(true);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      scrollTimeoutRef.current = originalSetTimeout(() => {
        setIsScrolling(false);
      }, 150);
    };
    pageEvents.addEventListener("scroll", handleScroll, { passive: true, capture: true });
    return () => {
      pageEvents.removeEventListener("scroll", handleScroll, true);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [pageEvents]);
  (0, import_react19.useEffect)(() => {
    if (!mounted) return;
    const saved = annotations.filter((a) => !exitingMarkers.has(a.id));
    if (saved.length > 0) {
      if (currentSessionId) {
        saveAnnotationsWithSyncMarker(pathname, saved, currentSessionId);
      } else {
        saveAnnotations(pathname, saved);
      }
    } else {
      localStorage.removeItem(getStorageKey(pathname));
    }
  }, [annotations, pathname, mounted, currentSessionId, isClearing, exitingMarkers]);
  (0, import_react19.useEffect)(() => {
    if (mounted && !designPlacementsLoaded.current) {
      designPlacementsLoaded.current = true;
      const stored = loadDesignPlacements(pathname);
      if (stored.length > 0) setDesignPlacements(stored);
    }
  }, [mounted, pathname]);
  (0, import_react19.useEffect)(() => {
    if (mounted && designPlacementsLoaded.current && !blankCanvas) {
      const saved = designPlacements.filter((p) => !clearingPlacements.includes(p));
      if (saved.length > 0) {
        saveDesignPlacements(pathname, saved);
      } else {
        clearDesignPlacements(pathname);
      }
    }
  }, [designPlacements, pathname, mounted, blankCanvas, clearingPlacements]);
  (0, import_react19.useEffect)(() => {
    if (mounted && !rearrangeLoaded.current) {
      rearrangeLoaded.current = true;
      const stored = loadRearrangeState(pathname);
      if (stored) {
        const migrated = {
          ...stored,
          sections: stored.sections.map((s2) => ({
            ...s2,
            currentRect: s2.currentRect ?? { ...s2.originalRect }
          }))
        };
        setRearrangeState(migrated);
      }
    }
  }, [mounted, pathname]);
  (0, import_react19.useEffect)(() => {
    if (mounted && rearrangeLoaded.current && !blankCanvas) {
      if (rearrangeState && rearrangeState !== clearingRearrange) {
        saveRearrangeState(pathname, rearrangeState);
      } else {
        clearRearrangeState(pathname);
      }
    }
  }, [rearrangeState, pathname, mounted, blankCanvas, clearingRearrange]);
  const wireframeLoaded = (0, import_react19.useRef)(false);
  (0, import_react19.useEffect)(() => {
    if (mounted && !wireframeLoaded.current) {
      wireframeLoaded.current = true;
      const stored = loadWireframeState(pathname);
      if (stored) {
        wireframeStashRef.current = {
          rearrange: stored.rearrange,
          placements: stored.placements || []
        };
        if (stored.purpose) setWireframePurpose(stored.purpose);
      }
    }
  }, [mounted, pathname]);
  (0, import_react19.useEffect)(() => {
    if (!mounted || !wireframeLoaded.current || isClearing) return;
    const stash = wireframeStashRef.current;
    if (blankCanvas) {
      const hasContent = (rearrangeState?.sections?.length ?? 0) > 0 || designPlacements.length > 0 || wireframePurpose;
      if (hasContent) {
        saveWireframeState(pathname, { rearrange: rearrangeState, placements: designPlacements, purpose: wireframePurpose });
      } else {
        clearWireframeState(pathname);
      }
    } else {
      const hasContent = (stash.rearrange?.sections?.length ?? 0) > 0 || stash.placements.length > 0 || wireframePurpose;
      if (hasContent) {
        saveWireframeState(pathname, { rearrange: stash.rearrange, placements: stash.placements, purpose: wireframePurpose });
      } else {
        clearWireframeState(pathname);
      }
    }
  }, [rearrangeState, designPlacements, wireframePurpose, blankCanvas, pathname, mounted, isClearing]);
  (0, import_react19.useEffect)(() => {
    if (isDesignMode && !rearrangeState) {
      setRearrangeState({
        sections: [],
        originalOrder: [],
        detectedAt: Date.now()
      });
    }
  }, [isDesignMode, rearrangeState]);
  (0, import_react19.useEffect)(() => {
    if (!endpoint || !currentSessionId) return;
    const transport = {
      create: (annotation) => routeTask(() => syncAnnotation(endpoint, currentSessionId, annotation)),
      update: (id, annotation) => routeTask(() => updateAnnotation(endpoint, id, annotation)),
      remove: (id) => routeTask(() => deleteAnnotation(endpoint, id))
    };
    placementAnnotationMap.current = /* @__PURE__ */ new Map();
    rearrangeAnnotationMap.current = /* @__PURE__ */ new Map();
    const queues = {
      placements: createShadowSync(transport, placementAnnotationMap.current, existingLayoutAnnotations.current.filter((a) => a.kind === "placement")),
      rearrange: createShadowSync(transport, rearrangeAnnotationMap.current, existingLayoutAnnotations.current.filter((a) => a.kind === "rearrange"))
    };
    layoutSync.current = queues;
    return () => {
      queues.placements.dispose();
      queues.rearrange.dispose();
      if (layoutSync.current === queues) layoutSync.current = null;
    };
  }, [endpoint, currentSessionId, pathname, routeTask]);
  (0, import_react19.useEffect)(() => {
    const pageUrl = window.location.pathname + window.location.search + window.location.hash;
    layoutSync.current?.placements.replace(designPlacements.filter((p) => !clearingPlacements.includes(p)).map((p) => ({
      id: p.id,
      x: p.x / window.innerWidth * 100,
      y: p.y,
      comment: `Place ${p.type} at (${Math.round(p.x)}, ${Math.round(p.y)}), ${p.width}\xD7${p.height}px${p.text ? ` \u2014 "${p.text}"` : ""}`,
      element: `[design:${p.type}]`,
      elementPath: "[placement]",
      timestamp: p.timestamp,
      url: pageUrl,
      intent: "change",
      severity: "important",
      kind: "placement",
      placement: { componentType: p.type, width: p.width, height: p.height, scrollY: p.scrollY, text: p.text }
    })));
  }, [designPlacements, endpoint, currentSessionId, pathname, clearingPlacements]);
  (0, import_react19.useEffect)(() => {
    const queues = layoutSync.current;
    if (!queues) return;
    if (rearrangeState === clearingRearrange) {
      queues.rearrange.replace([]);
      return;
    }
    const timer = originalSetTimeout(() => {
      const pageUrl = window.location.pathname + window.location.search + window.location.hash;
      const annotations2 = [];
      for (const section of rearrangeState?.sections ?? []) {
        const orig = section.originalRect;
        const curr = section.currentRect;
        const hasMoved = Math.abs(orig.x - curr.x) > 1 || Math.abs(orig.y - curr.y) > 1 || Math.abs(orig.width - curr.width) > 1 || Math.abs(orig.height - curr.height) > 1;
        if (!hasMoved && !section.note) continue;
        const notePart = section.note ? ` \u2014 "${section.note}"` : "";
        annotations2.push({
          id: section.id,
          x: curr.x / window.innerWidth * 100,
          y: curr.y,
          comment: hasMoved ? `Move ${section.label} section (${section.tagName}) \u2014 from (${Math.round(orig.x)},${Math.round(orig.y)}) ${Math.round(orig.width)}\xD7${Math.round(orig.height)} to (${Math.round(curr.x)},${Math.round(curr.y)}) ${Math.round(curr.width)}\xD7${Math.round(curr.height)}${notePart}` : `Note on ${section.label} section (${section.tagName})${notePart}`,
          element: section.selector,
          elementPath: "[rearrange]",
          timestamp: rearrangeState.detectedAt,
          url: pageUrl,
          intent: "change",
          severity: "important",
          kind: "rearrange",
          rearrange: { selector: section.selector, label: section.label, tagName: section.tagName, originalRect: orig, currentRect: curr }
        });
      }
      queues.rearrange.replace(annotations2);
    }, 300);
    return () => clearTimeout(timer);
  }, [rearrangeState, endpoint, currentSessionId, pathname, clearingRearrange]);
  const openDesignMode = (0, import_react19.useCallback)(() => {
    clearTimeout(designExitTimer.current);
    setDesignOverlayExiting(false);
    setIsDesignMode(true);
  }, []);
  (0, import_react19.useEffect)(() => () => clearTimeout(designExitTimer.current), []);
  const closeDesignMode = (0, import_react19.useCallback)(() => {
    setDesignOverlayExiting(true);
    setIsDesignMode(false);
    setActiveDesignComponent(null);
    clearTimeout(designExitTimer.current);
    designExitTimer.current = originalSetTimeout(() => {
      setDesignOverlayExiting(false);
    }, 300);
  }, []);
  const deactivate = (0, import_react19.useCallback)(() => {
    const root = launcherRef.current?.getRootNode();
    focusLauncherOnCloseRef.current = !!root?.activeElement && !!portalWrapperRef.current?.contains(root.activeElement);
    if (focusLauncherOnCloseRef.current) root?.activeElement?.blur();
    setShowSettings(false);
    if (isDesignMode) {
      setDesignOverlayExiting(true);
      setIsDesignMode(false);
      setActiveDesignComponent(null);
      clearTimeout(designExitTimer.current);
      designExitTimer.current = originalSetTimeout(() => {
        setDesignOverlayExiting(false);
      }, 300);
    }
    setIsActive(false);
  }, [isDesignMode]);
  const freezeAnimations = (0, import_react19.useCallback)(() => {
    if (isFrozen) return;
    freeze();
    setIsFrozen(true);
  }, [isFrozen]);
  const unfreezeAnimations = (0, import_react19.useCallback)(() => {
    if (!isFrozen) return;
    unfreeze();
    setIsFrozen(false);
  }, [isFrozen]);
  const toggleFreeze = (0, import_react19.useCallback)(() => {
    if (isFrozen) {
      unfreezeAnimations();
    } else {
      freezeAnimations();
    }
  }, [isFrozen, freezeAnimations, unfreezeAnimations]);
  const createMultiSelectPendingAnnotation = (0, import_react19.useCallback)((items = pendingMultiSelectElements) => {
    const selection = items.filter((item) => item.element.isConnected);
    if (selection.length === 0) {
      setPendingMultiSelectElements([]);
      return;
    }
    const firstItem = selection[0];
    const firstEl = firstItem.element;
    const isMulti = selection.length > 1;
    const freshRects = selection.map(
      (item) => viewportRect(item.element)
    );
    if (!isMulti) {
      const rect = freshRects[0];
      const isFixed = isElementFixed(firstEl);
      setPendingAnnotation({
        id: Date.now().toString(),
        x: rect.left / window.innerWidth * 100,
        y: isFixed ? rect.top : rect.top + window.scrollY,
        clientY: rect.top,
        element: firstItem.name,
        elementPath: firstItem.path,
        boundingBox: {
          x: rect.left,
          y: isFixed ? rect.top : rect.top + window.scrollY,
          width: rect.width,
          height: rect.height
        },
        isFixed,
        fullPath: getFullElementPath(firstEl),
        accessibility: getAccessibilityInfo(firstEl),
        computedStyles: getForensicComputedStyles(firstEl),
        computedStylesObj: getDetailedComputedStyles(firstEl),
        nearbyElements: getNearbyElements(firstEl),
        cssClasses: getElementClasses(firstEl),
        nearbyText: getNearbyText(firstEl),
        reactComponents: firstItem.reactComponents,
        targetElement: firstEl,
        sourceFile: detectSourceFile(firstEl),
        attributes: captureElementAttributes(firstEl, attributeNames)
      });
    } else {
      const bounds = {
        left: Math.min(...freshRects.map((r) => r.left)),
        top: Math.min(...freshRects.map((r) => r.top)),
        right: Math.max(...freshRects.map((r) => r.right)),
        bottom: Math.max(...freshRects.map((r) => r.bottom))
      };
      const names = selection.slice(0, 5).map((item) => item.name).join(", ");
      const suffix = selection.length > 5 ? ` +${selection.length - 5} more` : "";
      const elementBoundingBoxes = freshRects.map((rect) => ({
        x: rect.left,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height
      }));
      const lastItem = selection[selection.length - 1];
      const lastEl = lastItem.element;
      const lastRect = freshRects[freshRects.length - 1];
      const lastCenterX = lastRect.left + lastRect.width / 2;
      const lastCenterY = lastRect.top + lastRect.height / 2;
      const lastIsFixed = isElementFixed(lastEl);
      setPendingAnnotation({
        id: Date.now().toString(),
        x: lastCenterX / window.innerWidth * 100,
        y: lastIsFixed ? lastCenterY : lastCenterY + window.scrollY,
        clientY: lastCenterY,
        element: `${selection.length} elements: ${names}${suffix}`,
        elementPath: "multi-select",
        boundingBox: {
          x: bounds.left,
          y: bounds.top + window.scrollY,
          width: bounds.right - bounds.left,
          height: bounds.bottom - bounds.top
        },
        isMultiSelect: true,
        isFixed: lastIsFixed,
        elementBoundingBoxes,
        multiSelectElements: selection.map((item) => item.element),
        targetElement: lastEl,
        // Anchor marker/popup to last clicked element
        fullPath: getFullElementPath(firstEl),
        accessibility: getAccessibilityInfo(firstEl),
        computedStyles: getForensicComputedStyles(firstEl),
        computedStylesObj: getDetailedComputedStyles(firstEl),
        nearbyElements: getNearbyElements(firstEl),
        cssClasses: getElementClasses(firstEl),
        nearbyText: getNearbyText(firstEl),
        sourceFile: detectSourceFile(firstEl),
        attributes: captureElementAttributes(firstEl, attributeNames)
      });
    }
    setPendingMultiSelectElements([]);
    setHoverInfo(null);
  }, [pendingMultiSelectElements, attributeNames]);
  (0, import_react19.useEffect)(() => {
    if (!isActive) {
      setPendingAnnotation(null);
      setEditingAnnotation(null);
      setEditingTargetElement(null);
      setEditingTargetElements([]);
      setHoverInfo(null);
      setShowSettings(false);
      setPendingMultiSelectElements([]);
      legacyMultiSelectRef.current = false;
      if (isFrozen) {
        unfreezeAnimations();
      }
    }
  }, [isActive, isFrozen, unfreezeAnimations]);
  (0, import_react19.useEffect)(() => {
    return () => {
      unfreeze();
    };
  }, []);
  (0, import_react19.useEffect)(() => {
    if (!isActive) return;
    const textElementsSelector = [
      "p",
      "span",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "li",
      "td",
      "th",
      "label",
      "blockquote",
      "figcaption",
      "caption",
      "legend",
      "dt",
      "dd",
      "pre",
      "code",
      "em",
      "strong",
      "b",
      "i",
      "u",
      "s",
      "a",
      "time",
      "address",
      "cite",
      "q",
      "abbr",
      "dfn",
      "mark",
      "small",
      "sub",
      "sup",
      "[contenteditable]"
    ].join(", ");
    const style = document.createElement("style");
    style.id = "agentation-cursor";
    style.textContent = `
      body { cursor: crosshair !important; }
      body :is(${textElementsSelector}) { cursor: text !important; }
    `;
    document.head.appendChild(style);
    return () => {
      const existingStyle = document.getElementById("agentation-cursor");
      if (existingStyle) existingStyle.remove();
    };
  }, [isActive]);
  (0, import_react19.useEffect)(() => {
    if (hoveredDrawingIdx !== null && isActive) {
      document.documentElement.setAttribute("data-drawing-hover", "");
      return () => document.documentElement.removeAttribute("data-drawing-hover");
    }
  }, [hoveredDrawingIdx, isActive]);
  (0, import_react19.useEffect)(() => {
    if (!isActive || pendingAnnotation || editingAnnotation || isDrawMode || isDesignMode) return;
    let lastMouse = null;
    const evaluateHover = (x, y, piercing) => {
      const normalElement = deepElementFromPoint(x, y);
      const elementUnder = piercing ? pierceElementFromPoint(x, y) : normalElement;
      if (!elementUnder || closestCrossingShadow(
        elementUnder,
        "[data-feedback-toolbar], [data-annotation-popup], [data-annotation-marker]"
      )) {
        setHoverInfo(null);
        return;
      }
      const { name, elementName, path, reactComponents } = identifyElementWithReact(elementUnder, effectiveReactMode, attributeNames);
      setHoverInfo({
        element: name,
        elementName,
        elementPath: path,
        rect: viewportRect(elementUnder),
        reactComponents,
        isPiercing: piercing && elementUnder !== normalElement
      });
      setHoverPosition({ x, y });
    };
    const handleMouseMove = (e) => {
      const target = e.composedPath()[0] || e.target;
      if (closestCrossingShadow(
        target,
        "[data-feedback-toolbar], [data-annotation-popup], [data-annotation-marker]"
      )) {
        lastMouse = null;
        setHoverInfo(null);
        return;
      }
      lastMouse = { x: e.clientX, y: e.clientY };
      evaluateHover(e.clientX, e.clientY, isPrimaryMultiSelectModifierActive(e));
    };
    const handleKeyChange = (e) => {
      if ((e.key === "Meta" || e.key === "Control") && lastMouse) {
        evaluateHover(lastMouse.x, lastMouse.y, isPrimaryMultiSelectModifierActive(e));
      }
    };
    const clearHover = () => {
      lastMouse = null;
      setHoverInfo(null);
    };
    pageEvents.addEventListener("mousemove", handleMouseMove);
    pageEvents.addEventListener("keydown", handleKeyChange);
    pageEvents.addEventListener("keyup", handleKeyChange);
    pageEvents.addEventListener("mouseleave", clearHover);
    window.addEventListener("blur", clearHover);
    return () => {
      pageEvents.removeEventListener("mousemove", handleMouseMove);
      pageEvents.removeEventListener("keydown", handleKeyChange);
      pageEvents.removeEventListener("keyup", handleKeyChange);
      pageEvents.removeEventListener("mouseleave", clearHover);
      window.removeEventListener("blur", clearHover);
    };
  }, [isActive, pendingAnnotation, editingAnnotation, isDrawMode, isDesignMode, effectiveReactMode, attributeNames]);
  const startEditAnnotation = (0, import_react19.useCallback)((annotation, trigger) => {
    if (editingAnnotation && !editExiting) {
      editPopupRef.current?.shake();
      return;
    }
    if (pendingAnnotation && !pendingExiting) {
      const draft = portalWrapperRef.current?.querySelector(
        "[data-annotation-popup]:not([data-annotation-card]) textarea"
      );
      if (draft?.value.trim()) {
        popupRef.current?.shake();
        return;
      }
      setPendingExiting(true);
    }
    editingTriggerRef.current = trigger ?? null;
    editingFromKeyboardRef.current = trigger?.matches(":focus-visible") ?? false;
    setRestoreEditPreview(false);
    setEditExiting(false);
    setEditingAnnotation(annotation);
    setHoveredMarkerId(null);
    setHoveredTargetElement(null);
    setHoveredTargetElements([]);
    if (annotation.elementBoundingBoxes?.length) {
      const elements = [];
      for (const bb of annotation.elementBoundingBoxes) {
        const centerX = bb.x + bb.width / 2;
        const centerY = bb.y + bb.height / 2 - window.scrollY;
        const el = annotationElementFromPoint(centerX, centerY, bb);
        if (el) elements.push(el);
      }
      setEditingTargetElements(elements);
      setEditingTargetElement(null);
    } else if (annotation.boundingBox) {
      const bb = annotation.boundingBox;
      const centerX = bb.x + bb.width / 2;
      const centerY = annotation.isFixed ? bb.y + bb.height / 2 : bb.y + bb.height / 2 - window.scrollY;
      const el = annotationElementFromPoint(centerX, centerY, bb);
      if (el) {
        const elRect = viewportRect(el);
        const widthRatio = elRect.width / bb.width;
        const heightRatio = elRect.height / bb.height;
        if (widthRatio < 0.5 || heightRatio < 0.5) {
          setEditingTargetElement(null);
        } else {
          setEditingTargetElement(el);
        }
      } else {
        setEditingTargetElement(null);
      }
      setEditingTargetElements([]);
    } else {
      setEditingTargetElement(null);
      setEditingTargetElements([]);
    }
  }, [pendingAnnotation, pendingExiting, editingAnnotation, editExiting]);
  (0, import_react19.useEffect)(() => {
    if (!isActive || isDrawMode || isDesignMode) return;
    const handleClick = (e) => {
      if (justFinishedDragRef.current) {
        justFinishedDragRef.current = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const target = e.composedPath()[0] || e.target;
      if (closestCrossingShadow(target, "[data-feedback-toolbar]")) return;
      if (closestCrossingShadow(target, "[data-annotation-popup]")) return;
      if (closestCrossingShadow(target, "[data-annotation-marker]")) return;
      if (isPrimaryMultiSelectModifierActive(e) && !pendingAnnotation && !editingAnnotation) {
        e.preventDefault();
        e.stopPropagation();
        legacyMultiSelectRef.current = e.shiftKey;
        const elementUnder2 = pierceElementFromPoint(e.clientX, e.clientY);
        if (!elementUnder2) return;
        const rect2 = viewportRect(elementUnder2);
        const { name: name2, path: path2, reactComponents: reactComponents2 } = identifyElementWithReact(
          elementUnder2,
          effectiveReactMode,
          attributeNames
        );
        const existingIndex = pendingMultiSelectElements.findIndex(
          (item) => item.element === elementUnder2
        );
        if (existingIndex >= 0) {
          setPendingMultiSelectElements(
            (prev) => prev.filter((_, i) => i !== existingIndex)
          );
        } else {
          setPendingMultiSelectElements((prev) => [
            ...prev,
            {
              element: elementUnder2,
              rect: rect2,
              name: name2,
              path: path2,
              reactComponents: reactComponents2 ?? void 0
            }
          ]);
        }
        return;
      }
      const isInteractive = closestCrossingShadow(
        target,
        "button, a, input, select, textarea, [role='button'], [onclick]"
      );
      if (settings.blockInteractions) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (pendingAnnotation && !pendingExiting) {
        if (isInteractive && !settings.blockInteractions) {
          return;
        }
        e.preventDefault();
        popupRef.current?.shake();
        return;
      }
      if (editingAnnotation && !editExiting) {
        if (isInteractive && !settings.blockInteractions) {
          return;
        }
        e.preventDefault();
        editPopupRef.current?.shake();
        return;
      }
      e.preventDefault();
      const elementUnder = deepElementFromPoint(e.clientX, e.clientY);
      if (!elementUnder) return;
      const { name, path, reactComponents } = identifyElementWithReact(
        elementUnder,
        effectiveReactMode,
        attributeNames
      );
      const rect = viewportRect(elementUnder);
      const x = e.clientX / window.innerWidth * 100;
      const isFixed = isElementFixed(elementUnder);
      const y = isFixed ? e.clientY : e.clientY + window.scrollY;
      const selection = elementUnder.ownerDocument.defaultView?.getSelection();
      let selectedText;
      if (selection && selection.toString().trim().length > 0) {
        selectedText = selection.toString().trim().slice(0, 500);
      }
      const computedStylesObj = getDetailedComputedStyles(elementUnder);
      const computedStylesStr = getForensicComputedStyles(elementUnder);
      setPendingExiting(false);
      setPendingAnnotation({
        id: Date.now().toString(),
        x,
        y,
        clientY: e.clientY,
        element: name,
        elementPath: path,
        selectedText,
        boundingBox: {
          x: rect.left,
          y: isFixed ? rect.top : rect.top + window.scrollY,
          width: rect.width,
          height: rect.height
        },
        nearbyText: getNearbyText(elementUnder),
        cssClasses: getElementClasses(elementUnder),
        isFixed,
        fullPath: getFullElementPath(elementUnder),
        accessibility: getAccessibilityInfo(elementUnder),
        computedStyles: computedStylesStr,
        computedStylesObj,
        nearbyElements: getNearbyElements(elementUnder),
        reactComponents: reactComponents ?? void 0,
        sourceFile: detectSourceFile(elementUnder),
        attributes: captureElementAttributes(elementUnder, attributeNames),
        frame: captureFrameContext(elementUnder, e.clientX, e.clientY),
        targetElement: elementUnder
        // Store for live position queries
      });
      setHoverInfo(null);
    };
    pageEvents.addEventListener("click", handleClick, true);
    return () => pageEvents.removeEventListener("click", handleClick, true);
  }, [
    isActive,
    isDrawMode,
    isDesignMode,
    pendingAnnotation,
    pendingExiting,
    editingAnnotation,
    editExiting,
    settings.blockInteractions,
    effectiveReactMode,
    attributeNames,
    pendingMultiSelectElements
  ]);
  (0, import_react19.useEffect)(() => {
    if (!isActive) return;
    const handleKeyUp = (e) => {
      const releasedPrimary = (e.key === "Meta" || e.key === "Control") && !isPrimaryMultiSelectModifierActive(e);
      const releasedLegacyShift = e.key === "Shift" && legacyMultiSelectRef.current;
      if ((releasedPrimary || releasedLegacyShift) && !dragStartRef.current && pendingMultiSelectElements.length > 0) {
        createMultiSelectPendingAnnotation();
      }
    };
    const handleBlur = () => {
      legacyMultiSelectRef.current = false;
      setPendingMultiSelectElements([]);
      setHoverInfo(null);
      mouseDownPosRef.current = null;
      dragStartRef.current = null;
      setIsDragging(false);
      highlightsContainerRef.current?.replaceChildren();
    };
    pageEvents.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      pageEvents.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [isActive, pendingMultiSelectElements, createMultiSelectPendingAnnotation]);
  (0, import_react19.useEffect)(() => {
    if (!isActive || pendingAnnotation || isDrawMode || isDesignMode) return;
    const handleMouseDown = (e) => {
      if (e.button !== 0) return;
      justFinishedDragRef.current = false;
      const target = e.composedPath()[0] || e.target;
      if (closestCrossingShadow(target, "[data-feedback-toolbar]")) return;
      if (closestCrossingShadow(target, "[data-annotation-marker]")) return;
      if (closestCrossingShadow(target, "[data-annotation-popup]")) return;
      const textTags = /* @__PURE__ */ new Set([
        "P",
        "SPAN",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
        "LI",
        "TD",
        "TH",
        "LABEL",
        "BLOCKQUOTE",
        "FIGCAPTION",
        "CAPTION",
        "LEGEND",
        "DT",
        "DD",
        "PRE",
        "CODE",
        "EM",
        "STRONG",
        "B",
        "I",
        "U",
        "S",
        "A",
        "TIME",
        "ADDRESS",
        "CITE",
        "Q",
        "ABBR",
        "DFN",
        "MARK",
        "SMALL",
        "SUB",
        "SUP"
      ]);
      if (!isPrimaryMultiSelectModifierActive(e) && (textTags.has(target.tagName) || target.isContentEditable)) {
        return;
      }
      e.preventDefault();
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
    };
    pageEvents.addEventListener("mousedown", handleMouseDown);
    return () => pageEvents.removeEventListener("mousedown", handleMouseDown);
  }, [isActive, pendingAnnotation, isDrawMode, isDesignMode]);
  (0, import_react19.useEffect)(() => {
    if (!isActive || pendingAnnotation) return;
    const handleMouseMove = (e) => {
      if (!mouseDownPosRef.current) return;
      const dx = e.clientX - mouseDownPosRef.current.x;
      const dy = e.clientY - mouseDownPosRef.current.y;
      const distance = dx * dx + dy * dy;
      const thresholdSq = DRAG_THRESHOLD * DRAG_THRESHOLD;
      if (!isDragging && distance >= thresholdSq) {
        dragStartRef.current = mouseDownPosRef.current;
        setIsDragging(true);
        e.preventDefault();
      }
      if ((isDragging || distance >= thresholdSq) && dragStartRef.current) {
        if (dragRectRef.current) {
          const left2 = Math.min(dragStartRef.current.x, e.clientX);
          const top2 = Math.min(dragStartRef.current.y, e.clientY);
          const width = Math.abs(e.clientX - dragStartRef.current.x);
          const height = Math.abs(e.clientY - dragStartRef.current.y);
          dragRectRef.current.style.transform = `translate(${left2}px, ${top2}px)`;
          dragRectRef.current.style.width = `${width}px`;
          dragRectRef.current.style.height = `${height}px`;
        }
        const now = Date.now();
        if (now - lastElementUpdateRef.current < ELEMENT_UPDATE_THROTTLE) {
          return;
        }
        lastElementUpdateRef.current = now;
        const startX = dragStartRef.current.x;
        const startY = dragStartRef.current.y;
        const left = Math.min(startX, e.clientX);
        const top = Math.min(startY, e.clientY);
        const right = Math.max(startX, e.clientX);
        const bottom = Math.max(startY, e.clientY);
        const midX = (left + right) / 2;
        const midY = (top + bottom) / 2;
        const candidateElements = /* @__PURE__ */ new Set();
        const points = [
          [left, top],
          [right, top],
          [left, bottom],
          [right, bottom],
          [midX, midY],
          [midX, top],
          [midX, bottom],
          [left, midY],
          [right, midY]
        ];
        for (const [x, y] of points) {
          const elements = document.elementsFromPoint(x, y);
          for (const el of elements) {
            if (el instanceof HTMLElement) candidateElements.add(el);
          }
        }
        const nearbyElements = pageEvents.querySelectorAll(
          "button, a, input, img, p, h1, h2, h3, h4, h5, h6, li, label, td, th, div, span, section, article, aside, nav"
        );
        for (const el of nearbyElements) {
          if (el instanceof HTMLElement) {
            const rect = viewportRect(el);
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const centerInside = centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
            const overlapX = Math.min(rect.right, right) - Math.max(rect.left, left);
            const overlapY = Math.min(rect.bottom, bottom) - Math.max(rect.top, top);
            const overlapArea = overlapX > 0 && overlapY > 0 ? overlapX * overlapY : 0;
            const elementArea = rect.width * rect.height;
            const overlapRatio = elementArea > 0 ? overlapArea / elementArea : 0;
            if (centerInside || overlapRatio > 0.5) {
              candidateElements.add(el);
            }
          }
        }
        const allMatching = [];
        const meaningfulTags = /* @__PURE__ */ new Set([
          "BUTTON",
          "A",
          "INPUT",
          "IMG",
          "P",
          "H1",
          "H2",
          "H3",
          "H4",
          "H5",
          "H6",
          "LI",
          "LABEL",
          "TD",
          "TH",
          "SECTION",
          "ARTICLE",
          "ASIDE",
          "NAV"
        ]);
        for (const el of candidateElements) {
          if (closestCrossingShadow(el, "[data-feedback-toolbar]") || closestCrossingShadow(el, "[data-annotation-marker]"))
            continue;
          const rect = viewportRect(el);
          if (rect.width > window.innerWidth * 0.8 && rect.height > window.innerHeight * 0.5)
            continue;
          if (rect.width < 10 || rect.height < 10) continue;
          if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top) {
            const tagName = el.tagName;
            let shouldInclude = meaningfulTags.has(tagName);
            if (!shouldInclude && (tagName === "DIV" || tagName === "SPAN")) {
              const hasText = el.textContent && el.textContent.trim().length > 0;
              const isInteractive = el.onclick !== null || el.getAttribute("role") === "button" || el.getAttribute("role") === "link" || el.classList.contains("clickable") || el.hasAttribute("data-clickable");
              if ((hasText || isInteractive) && !el.querySelector("p, h1, h2, h3, h4, h5, h6, button, a")) {
                shouldInclude = true;
              }
            }
            if (shouldInclude) {
              let dominated = false;
              for (const existingRect of allMatching) {
                if (existingRect.left <= rect.left && existingRect.right >= rect.right && existingRect.top <= rect.top && existingRect.bottom >= rect.bottom) {
                  dominated = true;
                  break;
                }
              }
              if (!dominated) allMatching.push(rect);
            }
          }
        }
        if (highlightsContainerRef.current) {
          const container = highlightsContainerRef.current;
          while (container.children.length > allMatching.length) {
            container.removeChild(container.lastChild);
          }
          allMatching.forEach((rect, i) => {
            let div = container.children[i];
            if (!div) {
              div = document.createElement("div");
              div.className = styles_module_default3.selectedElementHighlight;
              container.appendChild(div);
            }
            div.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
            div.style.width = `${rect.width}px`;
            div.style.height = `${rect.height}px`;
          });
        }
      }
    };
    pageEvents.addEventListener("mousemove", handleMouseMove, { passive: true });
    return () => pageEvents.removeEventListener("mousemove", handleMouseMove);
  }, [isActive, pendingAnnotation, isDragging, DRAG_THRESHOLD]);
  (0, import_react19.useEffect)(() => {
    if (!isActive) return;
    const handleMouseUp = (e) => {
      const wasDragging = isDragging;
      const dragStart = dragStartRef.current;
      if (isDragging && dragStart) {
        justFinishedDragRef.current = true;
        const left = Math.min(dragStart.x, e.clientX);
        const top = Math.min(dragStart.y, e.clientY);
        const right = Math.max(dragStart.x, e.clientX);
        const bottom = Math.max(dragStart.y, e.clientY);
        const allMatching = [];
        const selector = "button, a, input, img, p, h1, h2, h3, h4, h5, h6, li, label, td, th";
        pageEvents.querySelectorAll(selector).forEach((el) => {
          if (!(el instanceof HTMLElement)) return;
          if (closestCrossingShadow(el, "[data-feedback-toolbar]") || closestCrossingShadow(el, "[data-annotation-marker]"))
            return;
          const rect = viewportRect(el);
          if (rect.width > window.innerWidth * 0.8 && rect.height > window.innerHeight * 0.5)
            return;
          if (rect.width < 10 || rect.height < 10) return;
          if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top) {
            allMatching.push({ element: el, rect });
          }
        });
        const finalElements = allMatching.filter(
          ({ element: el }) => !allMatching.some(
            ({ element: other }) => other !== el && el.contains(other)
          )
        );
        const x = e.clientX / window.innerWidth * 100;
        const y = e.clientY + window.scrollY;
        const shouldAccumulateMultiSelect = (isPrimaryMultiSelectModifierActive(e) || pendingMultiSelectElements.length > 0) && !pendingAnnotation && !editingAnnotation;
        if (finalElements.length > 0) {
          if (shouldAccumulateMultiSelect) {
            const combined = [...pendingMultiSelectElements];
            for (const { element, rect } of finalElements) {
              if (combined.some((item) => item.element === element)) continue;
              const { name, path, reactComponents } = identifyElementWithReact(element, effectiveReactMode, attributeNames);
              combined.push({ element, rect, name, path, reactComponents: reactComponents ?? void 0 });
            }
            legacyMultiSelectRef.current = e.shiftKey;
            if (isPrimaryMultiSelectModifierActive(e)) setPendingMultiSelectElements(combined);
            else createMultiSelectPendingAnnotation(combined);
          } else {
            const bounds = finalElements.reduce(
              (acc, { rect }) => ({
                left: Math.min(acc.left, rect.left),
                top: Math.min(acc.top, rect.top),
                right: Math.max(acc.right, rect.right),
                bottom: Math.max(acc.bottom, rect.bottom)
              }),
              {
                left: Infinity,
                top: Infinity,
                right: -Infinity,
                bottom: -Infinity
              }
            );
            const elementNames = finalElements.slice(0, 5).map(({ element }) => identifyElement(element).name).join(", ");
            const suffix = finalElements.length > 5 ? ` +${finalElements.length - 5} more` : "";
            const firstElement = finalElements[0].element;
            const firstElementComputedStyles = getDetailedComputedStyles(firstElement);
            const firstElementComputedStylesStr = getForensicComputedStyles(firstElement);
            setPendingAnnotation({
              id: Date.now().toString(),
              x,
              y,
              clientY: e.clientY,
              element: `${finalElements.length} elements: ${elementNames}${suffix}`,
              elementPath: "multi-select",
              boundingBox: {
                x: bounds.left,
                y: bounds.top + window.scrollY,
                width: bounds.right - bounds.left,
                height: bounds.bottom - bounds.top
              },
              isMultiSelect: true,
              // Forensic data from first element
              fullPath: getFullElementPath(firstElement),
              accessibility: getAccessibilityInfo(firstElement),
              computedStyles: firstElementComputedStylesStr,
              computedStylesObj: firstElementComputedStyles,
              nearbyElements: getNearbyElements(firstElement),
              cssClasses: getElementClasses(firstElement),
              nearbyText: getNearbyText(firstElement),
              sourceFile: detectSourceFile(firstElement),
              attributes: captureElementAttributes(firstElement, attributeNames)
            });
          }
        } else if (shouldAccumulateMultiSelect && !isPrimaryMultiSelectModifierActive(e)) {
          createMultiSelectPendingAnnotation();
        } else if (!shouldAccumulateMultiSelect) {
          const width = Math.abs(right - left);
          const height = Math.abs(bottom - top);
          if (width > 20 && height > 20) {
            setPendingAnnotation({
              id: Date.now().toString(),
              x,
              y,
              clientY: e.clientY,
              element: "Area selection",
              elementPath: `region at (${Math.round(left)}, ${Math.round(top)})`,
              boundingBox: {
                x: left,
                y: top + window.scrollY,
                width,
                height
              },
              isMultiSelect: true
            });
          }
        }
        setHoverInfo(null);
      } else if (wasDragging) {
        justFinishedDragRef.current = true;
      }
      mouseDownPosRef.current = null;
      dragStartRef.current = null;
      setIsDragging(false);
      if (highlightsContainerRef.current) {
        highlightsContainerRef.current.innerHTML = "";
      }
    };
    pageEvents.addEventListener("mouseup", handleMouseUp);
    return () => pageEvents.removeEventListener("mouseup", handleMouseUp);
  }, [
    isActive,
    isDragging,
    pendingAnnotation,
    editingAnnotation,
    effectiveReactMode,
    attributeNames,
    pendingMultiSelectElements,
    createMultiSelectPendingAnnotation
  ]);
  const fireWebhook = (0, import_react19.useCallback)(
    async (event, payload, force) => {
      const targetUrl = settings.webhookUrl || webhookUrl;
      if (!targetUrl || !settings.webhooksEnabled && !force) return false;
      try {
        const response = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event,
            timestamp: Date.now(),
            url: typeof window !== "undefined" ? window.location.href : void 0,
            ...payload
          })
        });
        return response.ok;
      } catch (error) {
        console.warn("[Agentation] Webhook failed:", error);
        return false;
      }
    },
    [webhookUrl, settings.webhookUrl, settings.webhooksEnabled]
  );
  const addAnnotation = (0, import_react19.useCallback)(
    (comment) => {
      if (!pendingAnnotation || pendingAnnotation.isSubmitted) return;
      const newAnnotation = {
        id: pendingAnnotation.id,
        x: pendingAnnotation.x,
        y: pendingAnnotation.y,
        comment,
        element: pendingAnnotation.element,
        elementPath: pendingAnnotation.elementPath,
        timestamp: Date.now(),
        selectedText: pendingAnnotation.selectedText,
        boundingBox: pendingAnnotation.boundingBox,
        nearbyText: pendingAnnotation.nearbyText,
        cssClasses: pendingAnnotation.cssClasses,
        isMultiSelect: pendingAnnotation.isMultiSelect,
        isFixed: pendingAnnotation.isFixed,
        fullPath: pendingAnnotation.fullPath,
        accessibility: pendingAnnotation.accessibility,
        computedStyles: pendingAnnotation.computedStyles,
        nearbyElements: pendingAnnotation.nearbyElements,
        reactComponents: pendingAnnotation.reactComponents,
        sourceFile: pendingAnnotation.sourceFile,
        attributes: pendingAnnotation.attributes,
        frame: pendingAnnotation.frame,
        elementBoundingBoxes: pendingAnnotation.elementBoundingBoxes,
        // Protocol fields for server sync
        ...endpoint && currentSessionId ? {
          sessionId: currentSessionId,
          url: typeof window !== "undefined" ? window.location.href : void 0,
          status: "pending"
        } : {}
      };
      setAnnotations((prev) => [...prev, newAnnotation]);
      setPendingAnnotation({ ...pendingAnnotation, isSubmitted: true });
      recentlyAddedIdRef.current = newAnnotation.id;
      onAnnotationAdd?.(newAnnotation);
      fireWebhook("annotation.add", { annotation: newAnnotation });
      setPendingExiting(true);
      window.getSelection()?.removeAllRanges();
      if (endpoint && currentSessionId) {
        routeTask(async () => {
          const serverAnnotation = await syncPageAnnotation(endpoint, currentSessionId, newAnnotation);
          if (useHashLocation) {
            const saved = loadAnnotations(pathname);
            saveAnnotationsWithSyncMarker(pathname, saved.map((a) => a.id === newAnnotation.id ? { ...a, id: serverAnnotation.id } : a), currentSessionId);
          }
          if (!routeAlive.current || deletedIds.current.has(newAnnotation.id)) return;
          if (serverAnnotation.id !== newAnnotation.id) {
            markerKeys.current.set(serverAnnotation.id, newAnnotation.id);
            if (recentlyAddedIdRef.current === newAnnotation.id) recentlyAddedIdRef.current = serverAnnotation.id;
            setAnnotations(
              (prev) => prev.map(
                (a) => a.id === newAnnotation.id ? { ...a, id: serverAnnotation.id } : a
              )
            );
            if (animatedMarkers.current.delete(newAnnotation.id)) {
              animatedMarkers.current.add(serverAnnotation.id);
            }
          }
        }).catch((error) => {
          console.warn("[Agentation] Failed to sync annotation:", error);
        });
      }
    },
    [
      pendingAnnotation,
      onAnnotationAdd,
      fireWebhook,
      endpoint,
      currentSessionId,
      routeTask,
      pathname,
      useHashLocation
    ]
  );
  const cancelAnnotation = (0, import_react19.useCallback)(() => {
    setPendingExiting(true);
  }, []);
  const finishPendingExit = (0, import_react19.useCallback)(() => {
    setPendingAnnotation(null);
    setPendingExiting(false);
  }, []);
  const deleteAnnotation2 = (0, import_react19.useCallback)(
    (id) => {
      if (deletedIds.current.has(id)) return;
      deletedIds.current.add(id);
      const deletedAnnotation = annotations.find((a) => a.id === id);
      if (editingAnnotation?.id === id) {
        setRestoreEditPreview(false);
        setEditExiting(true);
      }
      setExitingMarkers((prev) => new Set(prev).add(id));
      if (deletedAnnotation) {
        onAnnotationDelete?.(deletedAnnotation);
        fireWebhook("annotation.delete", { annotation: deletedAnnotation });
      }
      if (endpoint) {
        routeTask(() => deleteAnnotation(endpoint, serverIds.current.get(id) ?? id)).catch((error) => {
          console.warn(
            "[Agentation] Failed to delete annotation from server:",
            error
          );
        });
      }
    },
    [annotations, editingAnnotation, onAnnotationDelete, fireWebhook, endpoint, routeTask]
  );
  const handleMarkerHover = (0, import_react19.useCallback)(
    (annotation) => {
      if (!annotation) {
        setHoveredMarkerId(null);
        setHoveredTargetElement(null);
        setHoveredTargetElements([]);
        return;
      }
      setHoveredMarkerId(annotation.id);
      if (annotation.elementBoundingBoxes?.length) {
        const elements = [];
        for (const bb of annotation.elementBoundingBoxes) {
          const centerX = bb.x + bb.width / 2;
          const centerY = bb.y + bb.height / 2 - window.scrollY;
          const el = annotationElementFromPoint(centerX, centerY, bb);
          if (el) elements.push(el);
        }
        setHoveredTargetElements(elements);
        setHoveredTargetElement(null);
      } else if (annotation.boundingBox) {
        const bb = annotation.boundingBox;
        const centerX = bb.x + bb.width / 2;
        const centerY = annotation.isFixed ? bb.y + bb.height / 2 : bb.y + bb.height / 2 - window.scrollY;
        const el = annotationElementFromPoint(centerX, centerY, bb);
        if (el) {
          const elRect = viewportRect(el);
          const widthRatio = elRect.width / bb.width;
          const heightRatio = elRect.height / bb.height;
          if (widthRatio < 0.5 || heightRatio < 0.5) {
            setHoveredTargetElement(null);
          } else {
            setHoveredTargetElement(el);
          }
        } else {
          setHoveredTargetElement(null);
        }
        setHoveredTargetElements([]);
      } else {
        setHoveredTargetElement(null);
        setHoveredTargetElements([]);
      }
    },
    []
  );
  const updateAnnotation2 = (0, import_react19.useCallback)(
    (newComment) => {
      if (!editingAnnotation) return;
      const updatedAnnotation = { ...editingAnnotation, comment: newComment };
      setEditingAnnotation(updatedAnnotation);
      setAnnotations(
        (prev) => prev.map(
          (a) => a.id === editingAnnotation.id ? updatedAnnotation : a
        )
      );
      onAnnotationUpdate?.(updatedAnnotation);
      fireWebhook("annotation.update", { annotation: updatedAnnotation });
      if (endpoint) {
        routeTask(() => updateAnnotation(endpoint, serverIds.current.get(editingAnnotation.id) ?? editingAnnotation.id, {
          comment: newComment
        })).catch((error) => {
          console.warn(
            "[Agentation] Failed to update annotation on server:",
            error
          );
        });
      }
      setRestoreEditPreview(editingFromKeyboardRef.current || !!editingTriggerRef.current?.matches(":hover"));
      setEditExiting(true);
    },
    [editingAnnotation, onAnnotationUpdate, fireWebhook, endpoint, routeTask]
  );
  const cancelEditAnnotation = (0, import_react19.useCallback)(() => {
    setRestoreEditPreview(editingFromKeyboardRef.current || !!editingTriggerRef.current?.matches(":hover"));
    setEditExiting(true);
  }, []);
  const finishEditExit = (0, import_react19.useCallback)(() => {
    if (restoreEditPreview && editingAnnotation && !pendingAnnotation) setHoveredMarkerId(editingAnnotation.id);
    setEditingAnnotation(null);
    setEditingTargetElement(null);
    setEditingTargetElements([]);
    setEditExiting(false);
  }, [restoreEditPreview, editingAnnotation, pendingAnnotation]);
  const clearLayout = (0, import_react19.useCallback)((placements, rearrange) => {
    if (!placements.length && !rearrange) return;
    setIsClearing(true);
    const layoutBatch = {
      placements: [...clearingLayout.current.placements, ...placements],
      rearrange: rearrange ?? clearingLayout.current.rearrange
    };
    clearingLayout.current = layoutBatch;
    setClearingPlacements(layoutBatch.placements);
    setClearingRearrange(layoutBatch.rearrange);
    clearTimeout(clearLayoutTimer.current);
    clearLayoutTimer.current = originalSetTimeout(() => {
      setDesignPlacements((previous) => previous.filter((p) => !layoutBatch.placements.includes(p)));
      setRearrangeState((previous) => previous === layoutBatch.rearrange ? null : previous);
      clearingLayout.current = { placements: [], rearrange: null };
      setClearingPlacements([]);
      setClearingRearrange(null);
      clearLayoutTimer.current = void 0;
      finishClearBatch();
    }, 200);
  }, [finishClearBatch]);
  const clearAll = (0, import_react19.useCallback)(() => {
    if (!routeAlive.current) return;
    const live = new Map(currentAnnotationsRef.current.map((note) => [note.id, note]));
    const batch = [];
    for (const note of annotations) {
      const now = live.get(serverIds.current.get(note.id) ?? note.id) ?? live.get(note.id);
      if (now && now.comment === note.comment && !deletedIds.current.has(now.id) && !batch.includes(now)) batch.push(now);
    }
    const count = batch.length;
    const currentLayout = layoutSnapshot.current;
    const placements = designPlacements.filter((p) => currentLayout.designPlacements.includes(p) && !clearingLayout.current.placements.includes(p));
    const rearrange = rearrangeState === currentLayout.rearrangeState && rearrangeState !== clearingLayout.current.rearrange ? rearrangeState : null;
    const strokes = drawStrokes.filter((stroke) => drawStrokesRef.current.includes(stroke));
    if (count === 0 && strokes.length === 0 && placements.length === 0 && !rearrange) return;
    for (const annotation of batch) {
      deletedIds.current.add(annotation.id);
      clearingIds.current.add(annotation.id);
      pendingClearIds.current.add(annotation.id);
    }
    setExitingMarkers((previous) => /* @__PURE__ */ new Set([...previous, ...batch.map((a) => a.id)]));
    onAnnotationsClear?.(batch);
    fireWebhook("annotations.clear", { annotations: batch });
    if (endpoint) {
      Promise.all(
        batch.map(
          (a) => routeTask(() => deleteAnnotation(endpoint, serverIds.current.get(a.id) ?? a.id)).catch((error) => {
            console.warn(
              "[Agentation] Failed to delete annotation from server:",
              error
            );
          })
        )
      );
    }
    setIsClearing(true);
    setDrawStrokes((previous) => previous.filter((stroke) => !strokes.includes(stroke)));
    if (strokes.length > 0 && strokes.length === drawStrokesRef.current.length) {
      const canvas = drawCanvasRef.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    }
    clearLayout(placements, rearrange);
    if (blankCanvas === currentLayout.blankCanvas && wireframePurpose === currentLayout.wireframePurpose && designPlacements === currentLayout.designPlacements && rearrangeState === currentLayout.rearrangeState) {
      if (blankCanvas) setBlankCanvas(false);
      if (wireframePurpose) setWireframePurpose("");
      wireframeStashRef.current = { rearrange: null, placements: [] };
      clearWireframeState(pathname);
    }
    finishClearBatch();
  }, [pathname, annotations, drawStrokes, designPlacements, rearrangeState, blankCanvas, wireframePurpose, onAnnotationsClear, fireWebhook, endpoint, routeTask, finishClearBatch, clearLayout]);
  const copyOutput = (0, import_react19.useCallback)(async () => {
    const action = copyAction.start();
    const displayUrl = typeof window !== "undefined" ? window.location.pathname + window.location.search + window.location.hash : pathname;
    const wireframeOnly = isDesignMode && blankCanvas;
    let output;
    if (wireframeOnly) {
      if (designPlacements.length === 0 && !rearrangeState && !wireframePurpose) return;
      output = appName ? generateOutputHeader(displayUrl, appName) : "";
    } else {
      output = generateOutput(
        annotations,
        displayUrl,
        settings.outputDetail,
        { appName }
      );
      if (!output && drawStrokes.length === 0 && designPlacements.length === 0 && !rearrangeState) return;
      if (!output) output = generateOutputHeader(displayUrl, appName);
    }
    if (!wireframeOnly && drawStrokes.length > 0) {
      const linkedDrawingIndices = /* @__PURE__ */ new Set();
      for (const a of annotations) {
        if (a.drawingIndex != null) linkedDrawingIndices.add(a.drawingIndex);
      }
      const canvas = drawCanvasRef.current;
      if (canvas) canvas.style.visibility = "hidden";
      const strokeDescriptions = [];
      const scrollY2 = window.scrollY;
      for (let strokeIdx = 0; strokeIdx < drawStrokes.length; strokeIdx++) {
        if (linkedDrawingIndices.has(strokeIdx)) continue;
        const stroke = drawStrokes[strokeIdx];
        if (stroke.points.length < 2) continue;
        const viewportPoints = stroke.fixed ? stroke.points : stroke.points.map((p) => ({ x: p.x, y: p.y - scrollY2 }));
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of viewportPoints) {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        }
        const bboxW = maxX - minX;
        const bboxH = maxY - minY;
        const bboxDiag = Math.hypot(bboxW, bboxH);
        const start = viewportPoints[0];
        const end = viewportPoints[viewportPoints.length - 1];
        const startEndDist = Math.hypot(end.x - start.x, end.y - start.y);
        let gesture;
        const closedLoop = startEndDist < bboxDiag * 0.35;
        const aspectRatio = bboxW / Math.max(bboxH, 1);
        if (closedLoop && bboxDiag > 20) {
          const edgeThreshold = Math.max(bboxW, bboxH) * 0.15;
          let edgePoints = 0;
          for (const p of viewportPoints) {
            const nearLeft = p.x - minX < edgeThreshold;
            const nearRight = maxX - p.x < edgeThreshold;
            const nearTop = p.y - minY < edgeThreshold;
            const nearBottom = maxY - p.y < edgeThreshold;
            if ((nearLeft || nearRight) && (nearTop || nearBottom)) edgePoints++;
          }
          gesture = edgePoints > viewportPoints.length * 0.15 ? "box" : "circle";
        } else if (aspectRatio > 3 && bboxH < 40) {
          gesture = "underline";
        } else if (startEndDist > bboxDiag * 0.5) {
          gesture = "arrow";
        } else {
          gesture = "drawing";
        }
        const sampleCount = Math.min(10, viewportPoints.length);
        const step = Math.max(1, Math.floor(viewportPoints.length / sampleCount));
        const seenElements = /* @__PURE__ */ new Set();
        const elementNames = [];
        const samplePoints = [start];
        for (let i = step; i < viewportPoints.length - 1; i += step) {
          samplePoints.push(viewportPoints[i]);
        }
        samplePoints.push(end);
        for (const p of samplePoints) {
          const el = deepElementFromPoint(p.x, p.y);
          if (!el || seenElements.has(el)) continue;
          if (closestCrossingShadow(el, "[data-feedback-toolbar]")) continue;
          seenElements.add(el);
          const { name } = identifyElement(el);
          if (!elementNames.includes(name)) {
            elementNames.push(name);
          }
        }
        const region = `${Math.round(minX)},${Math.round(minY)} \u2192 ${Math.round(maxX)},${Math.round(maxY)}`;
        let desc;
        if ((gesture === "circle" || gesture === "box") && elementNames.length > 0) {
          const verb = gesture === "box" ? "Boxed" : "Circled";
          desc = `${verb} **${elementNames[0]}**${elementNames.length > 1 ? ` (and ${elementNames.slice(1).join(", ")})` : ""} (region: ${region})`;
        } else if (gesture === "underline" && elementNames.length > 0) {
          desc = `Underlined **${elementNames[0]}** (${region})`;
        } else if (gesture === "arrow" && elementNames.length >= 2) {
          desc = `Arrow from **${elementNames[0]}** to **${elementNames[elementNames.length - 1]}** (${Math.round(start.x)},${Math.round(start.y)} \u2192 ${Math.round(end.x)},${Math.round(end.y)})`;
        } else if (elementNames.length > 0) {
          desc = `${gesture === "arrow" ? "Arrow" : "Drawing"} near **${elementNames.join("**, **")}** (region: ${region})`;
        } else {
          desc = `Drawing at ${region}`;
        }
        strokeDescriptions.push(desc);
      }
      if (canvas) canvas.style.visibility = "";
      if (strokeDescriptions.length > 0) {
        output += `
**Drawings:**
`;
        strokeDescriptions.forEach((d, i) => {
          output += `${i + 1}. ${d}
`;
        });
      }
    }
    if (designPlacements.length > 0 || wireframeOnly && wireframePurpose) {
      output += "\n" + generateDesignOutput(designPlacements, {
        width: window.innerWidth,
        height: window.innerHeight
      }, { blankCanvas, wireframePurpose: wireframePurpose || void 0 }, settings.outputDetail);
    }
    if (rearrangeState) {
      const rearrangeOutput = generateRearrangeOutput(rearrangeState, settings.outputDetail, {
        width: window.innerWidth,
        height: window.innerHeight
      });
      if (rearrangeOutput) {
        output += "\n" + rearrangeOutput;
      }
    }
    output = formatCopyOutput(annotations, output, copyFormat);
    if (!output) {
      setCopied(false);
      return;
    }
    const copiedOk = !copyToClipboard || await copyTextToClipboard(output);
    onCopy?.(output);
    if (!copyAction.isCurrent(action)) return;
    setCopied(copiedOk);
    if (!copiedOk) return;
    copyAction.schedule(action, () => setCopied(false), 2e3);
    if (settings.autoClearAfterCopy) {
      copyAction.schedule(action, clearAll, 500);
    }
  }, [
    annotations,
    drawStrokes,
    designPlacements,
    rearrangeState,
    blankCanvas,
    isDesignMode,
    canvasPurpose,
    wireframePurpose,
    pathname,
    settings.outputDetail,
    effectiveReactMode,
    attributeNames,
    settings.autoClearAfterCopy,
    clearAll,
    copyAction,
    copyToClipboard,
    copyFormat,
    appName,
    onCopy
  ]);
  const hasWebhookTarget = isValidUrl(settings.webhookUrl) || isValidUrl(webhookUrl || "");
  const canSend = onSubmit != null || hasWebhookTarget && !settings.webhooksEnabled;
  const toolbarContentWidth = isActive ? canSend ? 337 : 297 : 44;
  const sendToWebhook = (0, import_react19.useCallback)(async () => {
    const action = sendAction.start();
    const submissionUrl = typeof window !== "undefined" ? window.location.href : pathname;
    const displayUrl = typeof window !== "undefined" ? window.location.pathname + window.location.search + window.location.hash : pathname;
    let output = generateOutput(
      annotations,
      displayUrl,
      settings.outputDetail,
      { appName }
    );
    if (!output && designPlacements.length === 0 && !rearrangeState) return;
    if (!output) output = generateOutputHeader(displayUrl, appName);
    if (designPlacements.length > 0) {
      output += "\n" + generateDesignOutput(designPlacements, {
        width: window.innerWidth,
        height: window.innerHeight
      }, { blankCanvas, wireframePurpose: wireframePurpose || void 0 }, settings.outputDetail);
    }
    if (rearrangeState) {
      const rearrangeOutput = generateRearrangeOutput(rearrangeState, settings.outputDetail, {
        width: window.innerWidth,
        height: window.innerHeight
      });
      if (rearrangeOutput) {
        output += "\n" + rearrangeOutput;
      }
    }
    setSendState("sending");
    let callbackOk = true;
    try {
      await onSubmit?.(output, annotations);
    } catch (error) {
      console.warn("[Agentation] Submit callback failed:", error);
      callbackOk = false;
    }
    if (!sendAction.isCurrent(action)) return;
    const webhookOk = hasWebhookTarget ? await fireWebhook("submit", { output, annotations, url: submissionUrl }, true) : true;
    const success = callbackOk && webhookOk && canSend;
    if (!sendAction.isCurrent(action)) return;
    setSendState(success ? "sent" : "failed");
    sendAction.schedule(action, () => setSendState("idle"), 2500);
    if (success && settings.autoClearAfterCopy) {
      sendAction.schedule(action, clearAll, 500);
    }
  }, [
    onSubmit,
    appName,
    fireWebhook,
    annotations,
    designPlacements,
    rearrangeState,
    blankCanvas,
    canvasPurpose,
    pathname,
    settings.outputDetail,
    effectiveReactMode,
    attributeNames,
    settings.autoClearAfterCopy,
    clearAll,
    hasWebhookTarget,
    canSend,
    sendAction
  ]);
  (0, import_react19.useEffect)(() => {
    const DRAG_THRESHOLD2 = 10;
    const endDrag = (released = false) => {
      if (toolbarDragRef.current?.dragging) {
        justFinishedToolbarDragRef.current = released;
        setIsDraggingToolbar(false);
      }
      toolbarDragRef.current = null;
    };
    const handleMouseMove = (e) => {
      const dragStartPos = toolbarDragRef.current;
      if (!dragStartPos) return;
      if ((e.buttons & 1) === 0) {
        endDrag();
        return;
      }
      const deltaX = e.clientX - dragStartPos.x;
      const deltaY = e.clientY - dragStartPos.y;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      if (!dragStartPos.dragging && distance > DRAG_THRESHOLD2) {
        dragStartPos.dragging = true;
        setIsDraggingToolbar(true);
      }
      if (dragStartPos.dragging) {
        let newX = dragStartPos.toolbarX + deltaX;
        let newY = dragStartPos.toolbarY + deltaY;
        const padding = 20;
        const wrapperWidth = 337;
        const toolbarHeight = 44;
        const contentWidth = toolbarContentWidth;
        const contentOffset = wrapperWidth - contentWidth;
        const minX = padding - contentOffset;
        const maxX = window.innerWidth - padding - wrapperWidth;
        newX = Math.max(minX, Math.min(maxX, newX));
        newY = Math.max(
          padding,
          Math.min(window.innerHeight - toolbarHeight - padding, newY)
        );
        setToolbarPosition({ x: newX, y: newY });
      }
    };
    const handleMouseUp = () => endDrag(true);
    const handleBlur = () => endDrag();
    pageEvents.addEventListener("mousemove", handleMouseMove);
    pageEvents.addEventListener("mouseup", handleMouseUp, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      pageEvents.removeEventListener("mousemove", handleMouseMove);
      pageEvents.removeEventListener("mouseup", handleMouseUp, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, [toolbarContentWidth]);
  const handleToolbarMouseDown = (0, import_react19.useCallback)(
    (e) => {
      justFinishedToolbarDragRef.current = false;
      toolbarDragRef.current = null;
      if (e.button !== 0 || e.target.closest("button") && (e.target.closest("button") !== launcherRef.current || isActive) || e.target.closest("[data-agentation-settings-panel]")) {
        return;
      }
      const toolbarParent = e.currentTarget.parentElement;
      if (!toolbarParent) return;
      const rect = viewportRect(toolbarParent);
      toolbarDragRef.current = {
        x: e.clientX,
        y: e.clientY,
        // A viewport correction may still be moving. Grab what is on screen,
        // not the destination stored in state.
        toolbarX: rect.left,
        toolbarY: rect.top,
        dragging: false
      };
    },
    [isActive]
  );
  (0, import_react19.useLayoutEffect)(() => {
    if (!toolbarPosition) return;
    const constrainPosition = () => {
      const padding = 20;
      const wrapperWidth = 337;
      const toolbarHeight = 44;
      let newX = toolbarPosition.x;
      let newY = toolbarPosition.y;
      const contentWidth = toolbarContentWidth;
      const contentOffset = wrapperWidth - contentWidth;
      const minX = padding - contentOffset;
      const maxX = window.innerWidth - padding - wrapperWidth;
      newX = Math.max(minX, Math.min(maxX, newX));
      newY = Math.max(
        padding,
        Math.min(window.innerHeight - toolbarHeight - padding, newY)
      );
      if (newX !== toolbarPosition.x || newY !== toolbarPosition.y) {
        setToolbarPosition({ x: newX, y: newY });
      }
    };
    constrainPosition();
    window.addEventListener("resize", constrainPosition);
    return () => window.removeEventListener("resize", constrainPosition);
  }, [toolbarPosition, toolbarContentWidth]);
  (0, import_react19.useEffect)(() => {
    if (!enableKeyboardShortcuts) return;
    const handleKeyDown = (e) => {
      if (e.defaultPrevented || e.isComposing || e.altKey) return;
      const target = e.composedPath()[0] || e.target;
      const isTyping = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
      if (e.key === "Escape") {
        if (portalContainer && !pendingAnnotation && !editingAnnotation && (isActive || showSettings || isDesignMode || isDrawMode || pendingMultiSelectElements.length)) {
          e.preventDefault();
          e.stopPropagation();
        }
        if (showSettings) {
          e.preventDefault();
          setShowSettings(false);
          settingsButtonRef.current?.focus();
          return;
        }
        if (isDesignMode) {
          if (activeDesignComponent) {
            setActiveDesignComponent(null);
          } else {
            closeDesignMode();
          }
          return;
        }
        if (isDrawMode) {
          setIsDrawMode(false);
          return;
        }
        if (pendingMultiSelectElements.length > 0) {
          setPendingMultiSelectElements([]);
          return;
        }
        if (pendingAnnotation || editingAnnotation) {
        } else if (isActive) {
          hideTooltipsUntilMouseLeave();
          deactivate();
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        hideTooltipsUntilMouseLeave();
        if (isActive) {
          deactivate();
        } else {
          launcherRef.current?.blur();
          focusControlsOnOpenRef.current = true;
          setIsActive(true);
        }
        return;
      }
      if (!isActive || isTyping || e.metaKey || e.ctrlKey) return;
      if (e.repeat) return;
      if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        hideTooltipsUntilMouseLeave();
        toggleFreeze();
      }
      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        hideTooltipsUntilMouseLeave();
        if (isDrawMode) setIsDrawMode(false);
        if (showSettings) setShowSettings(false);
        if (pendingAnnotation) cancelAnnotation();
        if (isDesignMode) {
          closeDesignMode();
        } else {
          openDesignMode();
        }
      }
      if (e.key === "h" || e.key === "H") {
        if (annotations.length > 0) {
          e.preventDefault();
          hideTooltipsUntilMouseLeave();
          setShowMarkers((prev) => !prev);
        }
      }
      if (e.key === "c" || e.key === "C") {
        if (annotations.length > 0 || designPlacements.length > 0 || rearrangeState) {
          e.preventDefault();
          hideTooltipsUntilMouseLeave();
          copyOutput();
        }
      }
      if (e.key === "x" || e.key === "X") {
        if (annotations.length > 0 || designPlacements.length > 0 || rearrangeState) {
          e.preventDefault();
          hideTooltipsUntilMouseLeave();
          clearAll();
          if (designPlacements.length > 0) setDesignPlacements([]);
          if (rearrangeState) setRearrangeState(null);
        }
      }
      if (e.key === "s" || e.key === "S") {
        if (annotations.length > 0 && canSend && sendState === "idle") {
          e.preventDefault();
          hideTooltipsUntilMouseLeave();
          sendToWebhook();
        }
      }
    };
    const capture = !!portalContainer;
    pageEvents.addEventListener("keydown", handleKeyDown, capture);
    return () => pageEvents.removeEventListener("keydown", handleKeyDown, capture);
  }, [
    enableKeyboardShortcuts,
    portalContainer,
    editingAnnotation,
    isActive,
    isDrawMode,
    isDesignMode,
    activeDesignComponent,
    designPlacements,
    rearrangeState,
    pendingAnnotation,
    annotations.length,
    canSend,
    sendState,
    sendToWebhook,
    toggleFreeze,
    copyOutput,
    clearAll,
    pendingMultiSelectElements,
    showSettings,
    deactivate,
    openDesignMode,
    closeDesignMode
  ]);
  const hasAnnotations = annotations.length > 0;
  const projectFrameAnnotation2 = createFrameProjector();
  const markerAnnotations = annotations.filter(
    (a) => a.kind !== "placement" && a.kind !== "rearrange"
  );
  const visibleAnnotations = markerAnnotations.flatMap((annotation, index) => {
    const projected = projectFrameAnnotation2(annotation);
    return projected ? [{ annotation: projected, index }] : [];
  });
  const pendingMarker = pendingAnnotation && !pendingAnnotation.isSubmitted ? projectFrameAnnotation2({ ...pendingAnnotation, comment: "", timestamp: 0 }) : null;
  const renderedMarkers = [
    ...markersVisible ? visibleAnnotations.map((item) => ({ ...item, pending: false })) : [],
    ...pendingMarker ? [{ annotation: pendingMarker, index: markerAnnotations.length, pending: true }] : []
  ];
  (0, import_react19.useEffect)(() => {
    const renderedIds = new Set(markersVisible && !isToolbarHidden ? visibleAnnotations.map(({ annotation }) => annotation.id) : []);
    if (recentlyAddedIdRef.current && !renderedIds.has(recentlyAddedIdRef.current)) {
      recentlyAddedIdRef.current = null;
    }
    for (const id of exitingMarkers) {
      if (!renderedIds.has(id)) finishMarkerRemoval(id);
    }
  });
  (0, import_react19.useEffect)(() => {
    if (editingAnnotation && exitingMarkers.has(editingAnnotation.id)) {
      setRestoreEditPreview(false);
      setEditExiting(true);
    }
  }, [editingAnnotation, exitingMarkers]);
  const handleMarkerEnter = (0, import_react19.useCallback)((annotation) => {
    if (!markersExiting && annotation.id !== recentlyAddedIdRef.current) {
      handleMarkerHover(annotation);
    }
  }, [markersExiting, handleMarkerHover]);
  const handleMarkerLeave = (0, import_react19.useCallback)((id) => {
    if (hoveredMarkerId === id) handleMarkerHover(null);
  }, [hoveredMarkerId, handleMarkerHover]);
  const handleMarkerClick = (0, import_react19.useCallback)((annotation, trigger) => {
    if (editingAnnotation && !editExiting) {
      editPopupRef.current?.shake();
      return;
    }
    if (pendingExiting) finishPendingExit();
    if (settings.markerClickBehavior === "delete") deleteAnnotation2(annotation.id);
    else startEditAnnotation(annotation, trigger);
  }, [settings.markerClickBehavior, deleteAnnotation2, startEditAnnotation, pendingExiting, finishPendingExit, editingAnnotation, editExiting]);
  const cardAnnotation = editingAnnotation ?? (shouldShowMarkers && !pendingAnnotation && !isClearing ? annotations.find((a) => a.id === hoveredMarkerId && !exitingMarkers.has(a.id)) : null);
  const freezeLabel = isFrozen ? "Resume animations" : "Pause animations";
  const designModeLabel = isDesignMode ? "Exit layout mode" : "Layout mode";
  const markersLabel = showMarkers ? "Hide markers" : "Show markers";
  const metadataCopy = copyFormat !== "markdown";
  const missingCopyMetadata = metadataCopy && !formatCopyOutput(annotations, "", copyFormat);
  const copyLabel = typeof copyFormat === "object" ? `Copy ${copyFormat.attribute}` : copyFormat === "source" ? "Copy source paths" : copyFormat === "classes" ? "Copy classes" : isDesignMode && blankCanvas ? "Copy layout" : "Copy feedback";
  const controlTabIndex = isActive ? 0 : -1;
  if (!mounted) return null;
  if (isToolbarHidden) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(ShadowRoot, { host: "agentation-toolbar", className: userClassName, children: [
    /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("style", { "data-agentation-styles": "toolbar", children: [
      shadowCss,
      agentationColorTokensCss
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { ref: portalWrapperRef, className: styles_module_default3.positionContext, style: { display: "contents" }, "data-agentation-theme": isDarkMode ? "dark" : "light", "data-agentation-accent": settings.annotationColorId, "data-agentation-root": "", children: [
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        "div",
        {
          className: styles_module_default3.toolbar,
          "data-feedback-toolbar": true,
          "data-agentation-toolbar": true,
          "data-dragging": isDraggingToolbar || void 0,
          style: toolbarPosition ? {
            left: toolbarPosition.x,
            top: toolbarPosition.y,
            right: "auto",
            bottom: "auto"
          } : void 0,
          children: /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(
            "div",
            {
              className: `${styles_module_default3.toolbarContainer} ${isActive ? styles_module_default3.expanded : styles_module_default3.collapsed} ${showEntranceAnimation ? styles_module_default3.entrance : ""} ${isToolbarHiding ? styles_module_default3.hiding : ""} ${canSend ? styles_module_default3.serverConnected : ""}`,
              onMouseDown: handleToolbarMouseDown,
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(
                  "div",
                  {
                    className: `${styles_module_default3.controlsContent} ${isActive ? styles_module_default3.visible : styles_module_default3.hidden} ${toolbarPosition && toolbarPosition.y < 100 ? styles_module_default3.tooltipBelow : ""} ${tooltipsHidden || showSettings ? styles_module_default3.tooltipsHidden : ""} ${tooltipSessionActive ? styles_module_default3.tooltipsInSession : ""}`,
                    ref: (node) => {
                      controlsRef.current = node;
                      node?.toggleAttribute("inert", !isActive);
                    },
                    role: "group",
                    "aria-label": "Feedback controls",
                    "aria-hidden": !isActive,
                    onMouseEnter: handleControlsMouseEnter,
                    onMouseLeave: handleControlsMouseLeave,
                    children: [
                      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(
                        "div",
                        {
                          className: `${styles_module_default3.buttonWrapper} ${toolbarPosition && toolbarPosition.x < 120 ? styles_module_default3.buttonWrapperAlignLeft : ""}`,
                          children: [
                            /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                              "button",
                              {
                                className: styles_module_default3.controlButton,
                                onClick: (e) => {
                                  e.stopPropagation();
                                  hideTooltipsUntilMouseLeave();
                                  toggleFreeze();
                                },
                                "data-active": isFrozen,
                                "aria-label": freezeLabel,
                                "aria-pressed": isFrozen,
                                tabIndex: controlTabIndex,
                                children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(IconPausePlayAnimated, { size: 24, isPaused: isFrozen })
                              }
                            ),
                            /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("span", { className: styles_module_default3.buttonTooltip, children: [
                              freezeLabel,
                              enableKeyboardShortcuts && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: styles_module_default3.shortcut, children: "P" })
                            ] })
                          ]
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { className: styles_module_default3.buttonWrapper, children: [
                        /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                          "button",
                          {
                            className: `${styles_module_default3.controlButton} ${!isDarkMode ? styles_module_default3.light : ""}`,
                            onClick: (e) => {
                              e.stopPropagation();
                              hideTooltipsUntilMouseLeave();
                              if (isDrawMode) setIsDrawMode(false);
                              if (showSettings) setShowSettings(false);
                              if (pendingAnnotation) cancelAnnotation();
                              if (isDesignMode) {
                                closeDesignMode();
                              } else {
                                openDesignMode();
                              }
                            },
                            "data-active": isDesignMode,
                            "aria-label": designModeLabel,
                            "aria-pressed": isDesignMode,
                            tabIndex: controlTabIndex,
                            style: isDesignMode && blankCanvas ? { color: "#f97316", background: "rgba(249, 115, 22, 0.25)" } : void 0,
                            children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(IconLayout, { size: 21 })
                          }
                        ),
                        /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("span", { className: styles_module_default3.buttonTooltip, children: [
                          designModeLabel,
                          enableKeyboardShortcuts && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: styles_module_default3.shortcut, children: "L" })
                        ] })
                      ] }),
                      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { className: styles_module_default3.buttonWrapper, children: [
                        /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                          "button",
                          {
                            className: styles_module_default3.controlButton,
                            onClick: (e) => {
                              e.stopPropagation();
                              hideTooltipsUntilMouseLeave();
                              setShowMarkers(!showMarkers);
                            },
                            disabled: !hasAnnotations || isDesignMode,
                            "aria-label": markersLabel,
                            tabIndex: controlTabIndex,
                            children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(IconEyeAnimated, { size: 24, isOpen: showMarkers })
                          }
                        ),
                        /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("span", { className: styles_module_default3.buttonTooltip, children: [
                          markersLabel,
                          enableKeyboardShortcuts && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: styles_module_default3.shortcut, children: "H" })
                        ] })
                      ] }),
                      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { className: styles_module_default3.buttonWrapper, children: [
                        /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                          "button",
                          {
                            className: `${styles_module_default3.controlButton} ${copied ? styles_module_default3.statusShowing : ""}`,
                            onClick: (e) => {
                              e.stopPropagation();
                              hideTooltipsUntilMouseLeave();
                              copyOutput();
                            },
                            disabled: missingCopyMetadata || (isDesignMode && blankCanvas ? designPlacements.length === 0 && !rearrangeState?.sections?.length : !hasAnnotations && drawStrokes.length === 0 && designPlacements.length === 0 && !rearrangeState?.sections?.length),
                            "data-active": copied,
                            "aria-label": copyLabel,
                            tabIndex: controlTabIndex,
                            children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(IconCopyAnimated, { size: 24, copied, tint: isDesignMode && blankCanvas && (designPlacements.length > 0 || !!rearrangeState?.sections?.length) ? "#f97316" : void 0 })
                          }
                        ),
                        /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("span", { className: styles_module_default3.buttonTooltip, children: [
                          missingCopyMetadata ? "No matching metadata" : copyLabel,
                          enableKeyboardShortcuts && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: styles_module_default3.shortcut, children: "C" })
                        ] })
                      ] }),
                      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(
                        "div",
                        {
                          className: `${styles_module_default3.buttonWrapper} ${styles_module_default3.sendButtonWrapper} ${isActive && canSend ? styles_module_default3.sendButtonVisible : ""}`,
                          children: [
                            /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(
                              "button",
                              {
                                className: `${styles_module_default3.controlButton} ${sendState === "sent" || sendState === "failed" ? styles_module_default3.statusShowing : ""}`,
                                onClick: (e) => {
                                  e.stopPropagation();
                                  hideTooltipsUntilMouseLeave();
                                  sendToWebhook();
                                },
                                disabled: !hasAnnotations || !canSend || sendState === "sending",
                                "data-no-hover": sendState === "sent" || sendState === "failed",
                                tabIndex: isActive && canSend ? 0 : -1,
                                "aria-label": "Send Annotations",
                                "aria-hidden": !canSend,
                                children: [
                                  /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(IconSendArrow, { size: 24, state: sendState }),
                                  hasAnnotations && sendState === "idle" && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                                    "span",
                                    {
                                      className: styles_module_default3.buttonBadge,
                                      children: annotations.length
                                    }
                                  )
                                ]
                              }
                            ),
                            /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("span", { className: styles_module_default3.buttonTooltip, children: [
                              "Send Annotations",
                              enableKeyboardShortcuts && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: styles_module_default3.shortcut, children: "S" })
                            ] })
                          ]
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { className: styles_module_default3.buttonWrapper, children: [
                        /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                          "button",
                          {
                            className: styles_module_default3.controlButton,
                            onClick: (e) => {
                              e.stopPropagation();
                              hideTooltipsUntilMouseLeave();
                              clearAll();
                            },
                            disabled: !hasAnnotations && drawStrokes.length === 0 && designPlacements.length === 0 && !rearrangeState?.sections?.length,
                            "data-danger": true,
                            "aria-label": "Clear all",
                            tabIndex: controlTabIndex,
                            children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(IconTrashAlt, { size: 24 })
                          }
                        ),
                        /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("span", { className: styles_module_default3.buttonTooltip, children: [
                          "Clear all",
                          enableKeyboardShortcuts && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: styles_module_default3.shortcut, children: "X" })
                        ] })
                      ] }),
                      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { className: styles_module_default3.buttonWrapper, children: [
                        /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                          "button",
                          {
                            ref: settingsButtonRef,
                            "aria-label": "Settings",
                            "aria-expanded": showSettings,
                            tabIndex: controlTabIndex,
                            className: styles_module_default3.controlButton,
                            onClick: (e) => {
                              e.stopPropagation();
                              hideTooltipsUntilMouseLeave();
                              if (isDesignMode) closeDesignMode();
                              focusSettingsOnOpenRef.current = !showSettings && e.detail === 0;
                              setShowSettings(!showSettings);
                            },
                            children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(IconGear, { size: 24 })
                          }
                        ),
                        endpoint && connectionStatus !== "disconnected" && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                          "span",
                          {
                            className: `${styles_module_default3.mcpIndicator} ${styles_module_default3[connectionStatus]} ${showSettings ? styles_module_default3.hidden : ""}`,
                            title: connectionStatus === "connected" ? "MCP Connected" : "MCP Connecting..."
                          }
                        ),
                        /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: styles_module_default3.buttonTooltip, children: "Settings" })
                      ] }),
                      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                        "div",
                        {
                          className: styles_module_default3.divider
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { className: styles_module_default3.togglePlaceholder, "aria-hidden": "true" })
                    ]
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(
                  "div",
                  {
                    className: `${styles_module_default3.buttonWrapper} ${styles_module_default3.toggleWrapper} ${toolbarPosition && toolbarPosition.y < 100 ? styles_module_default3.tooltipBelow : ""} ${!isActive || tooltipsHidden || showSettings ? styles_module_default3.tooltipsHidden : ""} ${tooltipSessionActive ? styles_module_default3.tooltipsInSession : ""} ${toolbarPosition && typeof window !== "undefined" && toolbarPosition.x > window.innerWidth - 120 ? styles_module_default3.buttonWrapperAlignRight : ""}`,
                    onMouseEnter: handleControlsMouseEnter,
                    onMouseLeave: handleControlsMouseLeave,
                    children: [
                      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                        "button",
                        {
                          ref: launcherRef,
                          type: "button",
                          className: `${styles_module_default3.toggleContent} ${isActive ? styles_module_default3.expandedToggle : ""}`,
                          "aria-label": isActive ? "Exit" : "Start feedback mode",
                          "aria-expanded": isActive,
                          "aria-keyshortcuts": enableKeyboardShortcuts ? "Meta+Shift+F Control+Shift+F" : void 0,
                          title: isActive ? void 0 : enableKeyboardShortcuts ? "Start feedback mode (\u2318\u21E7F / Ctrl+Shift+F)" : "Start feedback mode",
                          onClick: (e) => {
                            if (justFinishedToolbarDragRef.current) {
                              justFinishedToolbarDragRef.current = false;
                              e.preventDefault();
                              return;
                            }
                            e.stopPropagation();
                            if (isActive) {
                              hideTooltipsUntilMouseLeave();
                              deactivate();
                            } else {
                              e.currentTarget.blur();
                              focusControlsOnOpenRef.current = e.detail === 0;
                              setIsActive(true);
                            }
                          },
                          children: /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("span", { className: styles_module_default3.toggleIcon, children: [
                            /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(ToolbarToggleIcon, { active: isActive }),
                            markerAnnotations.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: `${styles_module_default3.badge} ${isActive ? styles_module_default3.fadeOut : ""} ${showEntranceAnimation ? styles_module_default3.entrance : ""}`, children: markerAnnotations.length })
                          ] })
                        }
                      ),
                      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("span", { className: styles_module_default3.buttonTooltip, "aria-hidden": !isActive, children: [
                        "Exit",
                        enableKeyboardShortcuts && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: styles_module_default3.shortcut, children: "Esc" })
                      ] })
                    ]
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                  DesignPalette,
                  {
                    visible: isDesignMode && isActive,
                    activeType: activeDesignComponent,
                    onSelect: (type) => {
                      setActiveDesignComponent(activeDesignComponent === type ? null : type);
                    },
                    isDarkMode,
                    sectionCount: rearrangeState?.sections.length ?? 0,
                    onDetectSections: () => {
                      const sections = detectPageSections();
                      const existing = rearrangeState?.sections ?? [];
                      const existingSelectors = new Set(existing.map((s2) => s2.selector));
                      const newSections = sections.filter((s2) => !existingSelectors.has(s2.selector));
                      const merged = [...existing, ...newSections];
                      const mergedOrder = [...rearrangeState?.originalOrder ?? [], ...newSections.map((s2) => s2.id)];
                      setRearrangeState({
                        sections: merged,
                        originalOrder: mergedOrder,
                        detectedAt: Date.now()
                      });
                    },
                    placementCount: designPlacements.length,
                    onClearPlacements: () => {
                      clearLayout(designPlacements, rearrangeState);
                    },
                    blankCanvas,
                    onBlankCanvasChange: (on) => {
                      const emptyRearrange = { sections: [], originalOrder: [], detectedAt: Date.now() };
                      if (on) {
                        exploreStashRef.current = { rearrange: rearrangeState, placements: designPlacements };
                        setRearrangeState(wireframeStashRef.current.rearrange || emptyRearrange);
                        setDesignPlacements(wireframeStashRef.current.placements);
                        setActiveDesignComponent(null);
                      } else {
                        wireframeStashRef.current = { rearrange: rearrangeState, placements: designPlacements };
                        setRearrangeState(exploreStashRef.current.rearrange || emptyRearrange);
                        setDesignPlacements(exploreStashRef.current.placements);
                      }
                      setBlankCanvas(on);
                    },
                    wireframePurpose,
                    onWireframePurposeChange: setWireframePurpose,
                    Tooltip: HelpTooltip,
                    onDragStart: (type, e) => {
                      e.preventDefault();
                      const def = DEFAULT_SIZES[type];
                      let preview = null;
                      let didDrag = false;
                      const startX = e.clientX;
                      const startY = e.clientY;
                      const toolbar = e.target.closest("[data-feedback-toolbar]");
                      const toolbarTop = toolbar?.getBoundingClientRect().top ?? window.innerHeight;
                      const onMove = (ev) => {
                        const dx = ev.clientX - startX;
                        const dy = ev.clientY - startY;
                        if (!didDrag && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
                          didDrag = true;
                          preview = document.createElement("div");
                          preview.className = `${styles_module_default4.dragPreview}${blankCanvas ? ` ${styles_module_default4.dragPreviewWireframe}` : ""}`;
                          portalWrapperRef.current?.appendChild(preview);
                        }
                        if (!preview) return;
                        const dist = Math.max(0, toolbarTop - ev.clientY);
                        const progress = Math.min(1, dist / 180);
                        const eased = 1 - Math.pow(1 - progress, 2);
                        const minW = 28;
                        const minH = 20;
                        const maxW = Math.min(140, def.width * 0.18);
                        const maxH = Math.min(90, def.height * 0.18);
                        const w = minW + (maxW - minW) * eased;
                        const h = minH + (maxH - minH) * eased;
                        preview.style.width = `${w}px`;
                        preview.style.height = `${h}px`;
                        preview.style.left = `${ev.clientX - w / 2}px`;
                        preview.style.top = `${ev.clientY - h / 2}px`;
                        preview.style.opacity = `${0.5 + 0.5 * eased}`;
                        preview.textContent = eased > 0.25 ? type : "";
                      };
                      const onUp = (ev) => {
                        window.removeEventListener("mousemove", onMove);
                        window.removeEventListener("mouseup", onUp);
                        if (preview) preview.remove();
                        if (didDrag) {
                          const w = def.width;
                          const h = def.height;
                          const scrollY2 = window.scrollY;
                          const x = Math.max(0, ev.clientX - w / 2);
                          const y = Math.max(0, ev.clientY + scrollY2 - h / 2);
                          const placement = {
                            id: `dp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                            type,
                            x,
                            y,
                            width: w,
                            height: h,
                            scrollY: scrollY2,
                            timestamp: Date.now()
                          };
                          setDesignPlacements((prev) => [...prev, placement]);
                          setActiveDesignComponent(null);
                          designSelectedIdsRef.current = /* @__PURE__ */ new Set();
                          setDesignDeselectSignal((n) => n + 1);
                        }
                      };
                      window.addEventListener("mousemove", onMove);
                      window.addEventListener("mouseup", onUp);
                    }
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                  SettingsPanel,
                  {
                    settings,
                    onSettingsChange: updateSettings,
                    isDarkMode,
                    onToggleTheme: toggleTheme,
                    isDevMode,
                    connectionStatus,
                    endpoint,
                    onExited: finishSettingsExit,
                    isOpen: isActive && showSettings,
                    toolbarNearBottom: !!toolbarPosition && toolbarPosition.y < 230,
                    settingsPage,
                    onSettingsPageChange: setSettingsPage,
                    onHideToolbar: hideToolbarTemporarily
                  }
                )
              ]
            }
          )
        }
      ),
      (isDesignMode || designOverlayExiting) && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        "div",
        {
          className: `${styles_module_default4.blankCanvas} ${canvasReady ? styles_module_default4.visible : ""} ${designInteracting ? styles_module_default4.gridActive : ""}`,
          style: { "--canvas-opacity": canvasOpacity },
          "data-feedback-toolbar": true
        }
      ),
      isDesignMode && blankCanvas && canvasReady && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { className: styles_module_default4.wireframeNotice, "data-feedback-toolbar": true, children: [
        /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { className: styles_module_default4.wireframeOpacityRow, children: [
          /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: styles_module_default4.wireframeOpacityLabel, children: "Toggle Opacity" }),
          /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
            "input",
            {
              type: "range",
              className: styles_module_default4.wireframeOpacitySlider,
              min: 0,
              max: 1,
              step: 0.01,
              value: canvasOpacity,
              onChange: (e) => setCanvasOpacity(Number(e.target.value))
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)("div", { className: styles_module_default4.wireframeNoticeTitleRow, children: [
          /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: styles_module_default4.wireframeNoticeTitle, children: "Wireframe Mode" }),
          /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("span", { className: styles_module_default4.wireframeNoticeDivider }),
          /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
            "button",
            {
              className: styles_module_default4.wireframeStartOver,
              onClick: () => {
                clearLayout(designPlacements, rearrangeState);
                wireframeStashRef.current = { rearrange: null, placements: [] };
                setWireframePurpose("");
                clearWireframeState(pathname);
              },
              children: "Start Over"
            }
          )
        ] }),
        "Drag components onto the canvas.",
        /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("br", {}),
        "Copied output will only include the wireframed layout."
      ] }),
      (isDesignMode || designOverlayExiting) && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        DesignMode,
        {
          placements: designPlacements,
          onChange: setDesignPlacements,
          activeComponent: designOverlayExiting ? null : activeDesignComponent,
          onActiveComponentChange: setActiveDesignComponent,
          isDarkMode,
          exiting: designOverlayExiting,
          onInteractionChange: setDesignInteracting,
          passthrough: !activeDesignComponent,
          extraSnapRects: rearrangeState?.sections.map((s2) => s2.currentRect),
          deselectSignal: designDeselectSignal,
          clearingPlacements,
          wireframe: blankCanvas,
          onSelectionChange: (ids, isShift) => {
            designSelectedIdsRef.current = ids;
            if (!isShift) {
              rearrangeSelectedIdsRef.current = /* @__PURE__ */ new Set();
              setRearrangeDeselectSignal((n) => n + 1);
            }
          },
          onDragMove: (dx, dy) => {
            const selIds = rearrangeSelectedIdsRef.current;
            if (!selIds.size || !rearrangeState) return;
            if (!crossDragStartRef.current) {
              crossDragStartRef.current = /* @__PURE__ */ new Map();
              for (const s2 of rearrangeState.sections) {
                if (selIds.has(s2.id)) {
                  crossDragStartRef.current.set(s2.id, { x: s2.currentRect.x, y: s2.currentRect.y });
                }
              }
            }
            for (const s2 of rearrangeState.sections) {
              if (!selIds.has(s2.id)) continue;
              const start = crossDragStartRef.current.get(s2.id);
              if (!start) continue;
              const outlineEl = portalWrapperRef.current?.querySelector(`[data-rearrange-section="${s2.id}"]`);
              if (outlineEl) outlineEl.style.transform = `translate(${dx}px, ${dy}px)`;
            }
          },
          onDragEnd: (dx, dy, committed) => {
            const selIds = rearrangeSelectedIdsRef.current;
            const starts = crossDragStartRef.current;
            crossDragStartRef.current = null;
            if (!selIds.size || !rearrangeState || !starts) return;
            for (const id of selIds) {
              const el = portalWrapperRef.current?.querySelector(`[data-rearrange-section="${id}"]`);
              if (el) el.style.transform = "";
            }
            if (committed) {
              setRearrangeState((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  sections: prev.sections.map((s2) => {
                    const start = starts.get(s2.id);
                    if (!start) return s2;
                    return { ...s2, currentRect: { ...s2.currentRect, x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) } };
                  })
                };
              });
            }
          }
        }
      ),
      (isDesignMode || designOverlayExiting) && rearrangeState && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        RearrangeOverlay,
        {
          rearrangeState,
          onChange: setRearrangeState,
          isDarkMode,
          exiting: designOverlayExiting,
          blankCanvas,
          extraSnapRects: designPlacements.map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height })),
          clearing: rearrangeState === clearingRearrange,
          deselectSignal: rearrangeDeselectSignal,
          onSelectionChange: (ids, isShift) => {
            rearrangeSelectedIdsRef.current = ids;
            if (!isShift) {
              designSelectedIdsRef.current = /* @__PURE__ */ new Set();
              setDesignDeselectSignal((n) => n + 1);
            }
          },
          onDragMove: (dx, dy) => {
            const selIds = designSelectedIdsRef.current;
            if (!selIds.size) return;
            if (!crossDragStartRef.current) {
              crossDragStartRef.current = /* @__PURE__ */ new Map();
              for (const p of designPlacements) {
                if (selIds.has(p.id)) {
                  crossDragStartRef.current.set(p.id, { x: p.x, y: p.y });
                }
              }
            }
            for (const id of selIds) {
              const el = portalWrapperRef.current?.querySelector(`[data-design-placement="${id}"]`);
              if (el) el.style.transform = `translate(${dx}px, ${dy}px)`;
            }
          },
          onDragEnd: (dx, dy, committed) => {
            const selIds = designSelectedIdsRef.current;
            const starts = crossDragStartRef.current;
            crossDragStartRef.current = null;
            if (!selIds.size || !starts) return;
            for (const id of selIds) {
              const el = portalWrapperRef.current?.querySelector(`[data-design-placement="${id}"]`);
              if (el) el.style.transform = "";
            }
            if (committed) {
              setDesignPlacements((prev) => prev.map((p) => {
                const start = starts.get(p.id);
                if (!start) return p;
                return { ...p, x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) };
              }));
            }
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        "canvas",
        {
          ref: drawCanvasRef,
          className: `${styles_module_default3.drawCanvas} ${isDrawMode ? styles_module_default3.active : ""}`,
          "aria-hidden": "true",
          style: { opacity: shouldShowMarkers ? 1 : 0, transition: "opacity 0.15s ease" },
          "data-feedback-toolbar": true
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { className: styles_module_default3.markersLayer, "data-feedback-toolbar": true, children: renderedMarkers.filter(({ annotation }) => !annotation.isFixed).map(({ annotation, index, pending: pending2 }, layerIndex, arr) => /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        AnnotationMarker,
        {
          annotation,
          pending: pending2,
          globalIndex: index,
          layerIndex,
          layerSize: arr.length,
          isExiting: pending2 ? pendingExiting : markersExiting,
          isClearing: clearingIds.current.has(annotation.id),
          isAnimated: animatedMarkers.current.has(annotation.id),
          isNew: recentlyAddedIdRef.current === annotation.id,
          onEnterComplete: handleMarkerEntered,
          isHovered: !markersExiting && hoveredMarkerId === annotation.id,
          isRemoving: exitingMarkers.has(annotation.id),
          onRemoveComplete: finishMarkerRemoval,
          isEditingAny: !!editingAnnotation,
          renumberFrom,
          markerClickBehavior: settings.markerClickBehavior,
          onHoverEnter: handleMarkerEnter,
          onHoverLeave: handleMarkerLeave,
          onClick: handleMarkerClick,
          onContextMenu: startEditAnnotation
        },
        markerKeys.current.get(annotation.id) ?? annotation.id
      )) }),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { className: styles_module_default3.fixedMarkersLayer, "data-feedback-toolbar": true, children: renderedMarkers.filter(({ annotation }) => annotation.isFixed).map(({ annotation, index, pending: pending2 }, layerIndex, arr) => /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        AnnotationMarker,
        {
          annotation,
          pending: pending2,
          globalIndex: index,
          layerIndex,
          layerSize: arr.length,
          isExiting: pending2 ? pendingExiting : markersExiting,
          isClearing: clearingIds.current.has(annotation.id),
          isAnimated: animatedMarkers.current.has(annotation.id),
          isNew: recentlyAddedIdRef.current === annotation.id,
          onEnterComplete: handleMarkerEntered,
          isHovered: !markersExiting && hoveredMarkerId === annotation.id,
          isRemoving: exitingMarkers.has(annotation.id),
          onRemoveComplete: finishMarkerRemoval,
          isEditingAny: !!editingAnnotation,
          renumberFrom,
          markerClickBehavior: settings.markerClickBehavior,
          onHoverEnter: handleMarkerEnter,
          onHoverLeave: handleMarkerLeave,
          onClick: handleMarkerClick,
          onContextMenu: startEditAnnotation
        },
        markerKeys.current.get(annotation.id) ?? annotation.id
      )) }),
      isActive && hoverInfo && !pendingAnnotation && !editingAnnotation && !isScrolling && !isDragging && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        HoverTooltip,
        {
          x: hoverPosition.x,
          y: hoverPosition.y,
          elementName: hoverInfo.elementName,
          reactComponents: hoverInfo.reactComponents
        }
      ),
      isActive && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(
        "div",
        {
          className: styles_module_default3.overlay,
          "data-feedback-toolbar": true,
          style: pendingAnnotation || editingAnnotation ? { zIndex: "inherit" } : void 0,
          children: [
            hoverInfo?.rect && !pendingAnnotation && !isScrolling && !isDragging && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
              "div",
              {
                className: `${styles_module_default3.hoverHighlight} ${styles_module_default3.enter}`,
                style: {
                  left: hoverInfo.rect.left,
                  top: hoverInfo.rect.top,
                  width: hoverInfo.rect.width,
                  height: hoverInfo.rect.height,
                  borderColor: "color-mix(in srgb, var(--agentation-color-accent) 50%, transparent)",
                  backgroundColor: "color-mix(in srgb, var(--agentation-color-accent) 4%, transparent)",
                  ...hoverInfo.isPiercing ? { borderStyle: "dashed" } : {}
                }
              }
            ),
            pendingMultiSelectElements.filter((item) => item.element.isConnected).map((item, index) => {
              const rect = viewportRect(item.element);
              const isMulti = pendingMultiSelectElements.length > 1;
              return /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                "div",
                {
                  className: isMulti ? styles_module_default3.multiSelectOutline : styles_module_default3.singleSelectOutline,
                  style: {
                    position: "fixed",
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    ...isMulti ? {} : {
                      borderColor: "color-mix(in srgb, var(--agentation-color-accent) 60%, transparent)",
                      backgroundColor: "color-mix(in srgb, var(--agentation-color-accent) 5%, transparent)"
                    }
                  }
                },
                index
              );
            }),
            hoveredMarkerId && !pendingAnnotation && (() => {
              const hoveredAnnotation = annotations.find(
                (a) => a.id === hoveredMarkerId
              );
              if (!hoveredAnnotation?.boundingBox) return null;
              if (hoveredAnnotation.elementBoundingBoxes?.length) {
                if (hoveredTargetElements.length > 0) {
                  return hoveredTargetElements.filter((el) => el.isConnected).map((el, index) => {
                    const rect2 = viewportRect(el);
                    return /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                      "div",
                      {
                        className: `${styles_module_default3.multiSelectOutline} ${styles_module_default3.enter}`,
                        style: {
                          left: rect2.left,
                          top: rect2.top,
                          width: rect2.width,
                          height: rect2.height
                        }
                      },
                      `hover-outline-live-${index}`
                    );
                  });
                }
                return hoveredAnnotation.elementBoundingBoxes.map(
                  (bb2, index) => /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                    "div",
                    {
                      className: `${styles_module_default3.multiSelectOutline} ${styles_module_default3.enter}`,
                      style: {
                        left: bb2.x,
                        top: bb2.y - scrollY,
                        width: bb2.width,
                        height: bb2.height
                      }
                    },
                    `hover-outline-${index}`
                  )
                );
              }
              const rect = hoveredTargetElement && hoveredTargetElement.isConnected ? viewportRect(hoveredTargetElement) : null;
              const bb = rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : {
                x: hoveredAnnotation.boundingBox.x,
                y: hoveredAnnotation.isFixed ? hoveredAnnotation.boundingBox.y : hoveredAnnotation.boundingBox.y - scrollY,
                width: hoveredAnnotation.boundingBox.width,
                height: hoveredAnnotation.boundingBox.height
              };
              const isMulti = hoveredAnnotation.isMultiSelect;
              return /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                "div",
                {
                  className: `${isMulti ? styles_module_default3.multiSelectOutline : styles_module_default3.singleSelectOutline} ${styles_module_default3.enter}`,
                  style: {
                    left: bb.x,
                    top: bb.y,
                    width: bb.width,
                    height: bb.height,
                    ...isMulti ? {} : {
                      borderColor: "color-mix(in srgb, var(--agentation-color-accent) 60%, transparent)",
                      backgroundColor: "color-mix(in srgb, var(--agentation-color-accent) 5%, transparent)"
                    }
                  }
                }
              );
            })(),
            pendingAnnotation && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(import_jsx_runtime19.Fragment, { children: [
              pendingAnnotation.multiSelectElements?.length ? (
                // Modifier-click multi-select: show individual boxes with live positions
                pendingAnnotation.multiSelectElements.filter((el) => el.isConnected).map((el, index) => {
                  const rect = viewportRect(el);
                  return /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                    "div",
                    {
                      className: `${styles_module_default3.multiSelectOutline} ${pendingExiting ? styles_module_default3.exit : styles_module_default3.enter}`,
                      style: {
                        left: rect.left,
                        top: rect.top,
                        width: rect.width,
                        height: rect.height
                      }
                    },
                    `pending-multi-${index}`
                  );
                })
              ) : (
                // Single element or drag multi-select: show single box
                pendingAnnotation.targetElement && pendingAnnotation.targetElement.isConnected ? (
                  // Single-click: use live getBoundingClientRect for consistent positioning
                  (() => {
                    const rect = viewportRect(pendingAnnotation.targetElement);
                    return /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                      "div",
                      {
                        className: `${styles_module_default3.singleSelectOutline} ${pendingExiting ? styles_module_default3.exit : styles_module_default3.enter}`,
                        style: {
                          left: rect.left,
                          top: rect.top,
                          width: rect.width,
                          height: rect.height,
                          borderColor: "color-mix(in srgb, var(--agentation-color-accent) 60%, transparent)",
                          backgroundColor: "color-mix(in srgb, var(--agentation-color-accent) 5%, transparent)"
                        }
                      }
                    );
                  })()
                ) : (
                  // Drag selection or fallback: use stored boundingBox
                  pendingAnnotation.boundingBox && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                    "div",
                    {
                      className: `${pendingAnnotation.isMultiSelect ? styles_module_default3.multiSelectOutline : styles_module_default3.singleSelectOutline} ${pendingExiting ? styles_module_default3.exit : styles_module_default3.enter}`,
                      style: {
                        left: pendingAnnotation.boundingBox.x,
                        top: pendingAnnotation.boundingBox.y - scrollY,
                        width: pendingAnnotation.boundingBox.width,
                        height: pendingAnnotation.boundingBox.height,
                        ...pendingAnnotation.isMultiSelect ? {} : {
                          borderColor: "color-mix(in srgb, var(--agentation-color-accent) 60%, transparent)",
                          backgroundColor: "color-mix(in srgb, var(--agentation-color-accent) 5%, transparent)"
                        }
                      }
                    }
                  )
                )
              ),
              (() => {
                const positioned = projectFrameAnnotation2(pendingAnnotation) ?? pendingAnnotation;
                const markerX = positioned.x;
                const markerY = positioned.isFixed ? positioned.y : positioned.y - scrollY;
                return /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(import_jsx_runtime19.Fragment, { children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                  AnnotationPopupCSS,
                  {
                    ref: popupRef,
                    element: pendingAnnotation.element,
                    selectedText: pendingAnnotation.selectedText,
                    allowEmpty: typeof copyFormat === "object" && !!pendingAnnotation.attributes?.[copyFormat.attribute],
                    onOpenSource: onOpenSource && pendingAnnotation.sourceFile ? () => onOpenSource(pendingAnnotation.sourceFile) : void 0,
                    computedStyles: pendingAnnotation.computedStylesObj,
                    placeholder: typeof copyFormat === "object" && pendingAnnotation.attributes?.[copyFormat.attribute] ? "Add a note (optional)" : pendingAnnotation.element === "Area selection" ? "What should change in this area?" : pendingAnnotation.isMultiSelect ? "Feedback for this group of elements..." : "What should change?",
                    onSubmit: addAnnotation,
                    onExitComplete: finishPendingExit,
                    onCancel: cancelAnnotation,
                    isExiting: pendingExiting,
                    lightMode: !isDarkMode,
                    accentColor: pendingAnnotation.isMultiSelect ? "var(--agentation-color-green)" : "var(--agentation-color-accent)",
                    style: {
                      // Popup is 280px wide, centered with translateX(-50%), so 140px each side
                      // Clamp so popup stays 20px from viewport edges
                      left: Math.max(
                        160,
                        Math.min(
                          window.innerWidth - 160,
                          markerX / 100 * window.innerWidth
                        )
                      ),
                      // Position popup above or below marker to keep marker visible
                      ...markerY > window.innerHeight - 290 ? { bottom: window.innerHeight - markerY + 20 } : { top: markerY + 20 }
                    }
                  },
                  pendingAnnotation.id
                ) });
              })()
            ] }),
            editingAnnotation && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(import_jsx_runtime19.Fragment, { children: editingAnnotation.elementBoundingBoxes?.length ? (
              // Modifier-click: show individual element boxes (use live rects when available)
              (() => {
                if (editingTargetElements.length > 0) {
                  return editingTargetElements.filter((el) => el.isConnected).map((el, index) => {
                    const rect = viewportRect(el);
                    return /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                      "div",
                      {
                        className: `${styles_module_default3.multiSelectOutline} ${styles_module_default3.enter}`,
                        style: {
                          left: rect.left,
                          top: rect.top,
                          width: rect.width,
                          height: rect.height
                        }
                      },
                      `edit-multi-live-${index}`
                    );
                  });
                }
                return editingAnnotation.elementBoundingBoxes.map(
                  (bb, index) => /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                    "div",
                    {
                      className: `${styles_module_default3.multiSelectOutline} ${styles_module_default3.enter}`,
                      style: {
                        left: bb.x,
                        top: bb.y - scrollY,
                        width: bb.width,
                        height: bb.height
                      }
                    },
                    `edit-multi-${index}`
                  )
                );
              })()
            ) : (
              // Single element or drag multi-select: show single box
              (() => {
                const rect = editingTargetElement && editingTargetElement.isConnected ? viewportRect(editingTargetElement) : null;
                const bb = rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : editingAnnotation.boundingBox ? {
                  x: editingAnnotation.boundingBox.x,
                  y: editingAnnotation.isFixed ? editingAnnotation.boundingBox.y : editingAnnotation.boundingBox.y - scrollY,
                  width: editingAnnotation.boundingBox.width,
                  height: editingAnnotation.boundingBox.height
                } : null;
                if (!bb) return null;
                return /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                  "div",
                  {
                    className: `${editingAnnotation.isMultiSelect ? styles_module_default3.multiSelectOutline : styles_module_default3.singleSelectOutline} ${styles_module_default3.enter}`,
                    style: {
                      left: bb.x,
                      top: bb.y,
                      width: bb.width,
                      height: bb.height,
                      ...editingAnnotation.isMultiSelect ? {} : {
                        borderColor: "color-mix(in srgb, var(--agentation-color-accent) 60%, transparent)",
                        backgroundColor: "color-mix(in srgb, var(--agentation-color-accent) 5%, transparent)"
                      }
                    }
                  }
                );
              })()
            ) }),
            isDragging && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(import_jsx_runtime19.Fragment, { children: [
              /* @__PURE__ */ (0, import_jsx_runtime19.jsx)("div", { ref: dragRectRef, className: styles_module_default3.dragSelection }),
              /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
                "div",
                {
                  ref: highlightsContainerRef,
                  className: styles_module_default3.highlightsContainer
                }
              )
            ] })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
        AnnotationCard,
        {
          ref: editPopupRef,
          annotation: cardAnnotation ? projectFrameAnnotation2(cardAnnotation) ?? editingAnnotation : null,
          editing: !!editingAnnotation,
          exiting: editExiting,
          restorePreview: restoreEditPreview,
          scrollY,
          lightMode: !isDarkMode,
          onExited: finishEditExit,
          editorProps: cardAnnotation ? {
            element: cardAnnotation.element,
            selectedText: cardAnnotation.selectedText,
            allowEmpty: typeof copyFormat === "object" && !!cardAnnotation.attributes?.[copyFormat.attribute],
            onOpenSource: onOpenSource && cardAnnotation.sourceFile ? () => onOpenSource(cardAnnotation.sourceFile) : void 0,
            computedStyles: parseComputedStylesString(cardAnnotation.computedStyles),
            placeholder: "Edit your feedback...",
            initialValue: cardAnnotation.comment,
            submitLabel: "Save",
            onSubmit: updateAnnotation2,
            onCancel: cancelEditAnnotation,
            onDelete: () => deleteAnnotation2(cardAnnotation.id),
            accentColor: cardAnnotation.isMultiSelect ? "var(--agentation-color-green)" : "var(--agentation-color-accent)"
          } : void 0
        }
      )
    ] })
  ] });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Agentation,
  AnimatedBunny,
  AnnotationPopupCSS,
  IconChatEllipsis,
  IconCheck,
  IconCheckSmall,
  IconCheckSmallAnimated,
  IconCheckmark,
  IconCheckmarkCircle,
  IconCheckmarkLarge,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconCopyAlt,
  IconCopyAnimated,
  IconEdit,
  IconEye,
  IconEyeAlt,
  IconEyeAnimated,
  IconEyeClosed,
  IconEyeMinus,
  IconGear,
  IconHelp,
  IconLayout,
  IconListSparkle,
  IconMoon,
  IconPause,
  IconPauseAlt,
  IconPausePlayAnimated,
  IconPlayAlt,
  IconPlus,
  IconSendAnimated,
  IconSendArrow,
  IconSun,
  IconTrash,
  IconTrashAlt,
  IconXmark,
  IconXmarkLarge,
  PageFeedbackToolbarCSS,
  closestCrossingShadow,
  getElementClasses,
  getElementPath,
  getNearbyText,
  getShadowHost,
  getStorageKey,
  identifyAnimationElement,
  identifyElement,
  isInShadowDOM,
  loadAnnotations,
  saveAnnotations
});
//# sourceMappingURL=index.js.map