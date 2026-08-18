"use client";

// src/components/page-toolbar-css/index.tsx
import { useState as useState6, useCallback as useCallback5, useEffect as useEffect6, useLayoutEffect, useRef as useRef6 } from "react";
import { createPortal as createPortal2 } from "react-dom";

// src/components/annotation-popup-css/index.tsx
import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";

// src/components/annotation-popup-css/styles.module.scss
var css = '.styles-module__popup___IhzrD svg[fill=none] {\n  fill: none !important;\n}\n.styles-module__popup___IhzrD svg[fill=none] :not([fill]) {\n  fill: none !important;\n}\n\n@keyframes styles-module__popupEnter___AuQDN {\n  from {\n    opacity: 0;\n    transform: translateX(-50%) scale(0.95) translateY(4px);\n  }\n  to {\n    opacity: 1;\n    transform: translateX(-50%) scale(1) translateY(0);\n  }\n}\n@keyframes styles-module__popupExit___JJKQX {\n  from {\n    opacity: 1;\n    transform: translateX(-50%) scale(1) translateY(0);\n  }\n  to {\n    opacity: 0;\n    transform: translateX(-50%) scale(0.95) translateY(4px);\n  }\n}\n@keyframes styles-module__shake___jdbWe {\n  0%, 100% {\n    transform: translateX(-50%) scale(1) translateY(0) translateX(0);\n  }\n  20% {\n    transform: translateX(-50%) scale(1) translateY(0) translateX(-3px);\n  }\n  40% {\n    transform: translateX(-50%) scale(1) translateY(0) translateX(3px);\n  }\n  60% {\n    transform: translateX(-50%) scale(1) translateY(0) translateX(-2px);\n  }\n  80% {\n    transform: translateX(-50%) scale(1) translateY(0) translateX(2px);\n  }\n}\n.styles-module__popup___IhzrD {\n  position: fixed;\n  transform: translateX(-50%);\n  width: 280px;\n  padding: 0.75rem 1rem 14px;\n  background: #1a1a1a;\n  border-radius: 16px;\n  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);\n  z-index: 100001;\n  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  will-change: transform, opacity;\n  opacity: 0;\n}\n.styles-module__popup___IhzrD.styles-module__enter___L7U7N {\n  animation: styles-module__popupEnter___AuQDN 0.2s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;\n}\n.styles-module__popup___IhzrD.styles-module__entered___COX-w {\n  opacity: 1;\n  transform: translateX(-50%) scale(1) translateY(0);\n}\n.styles-module__popup___IhzrD.styles-module__exit___5eGjE {\n  animation: styles-module__popupExit___JJKQX 0.15s ease-in forwards;\n}\n.styles-module__popup___IhzrD.styles-module__entered___COX-w.styles-module__shake___jdbWe {\n  animation: styles-module__shake___jdbWe 0.25s ease-out;\n}\n\n.styles-module__header___wWsSi {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin-bottom: 0.5625rem;\n}\n\n.styles-module__element___fTV2z {\n  font-size: 0.75rem;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.5);\n  max-width: 100%;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  flex: 1;\n}\n\n.styles-module__headerToggle___WpW0b {\n  display: flex;\n  align-items: center;\n  gap: 0.25rem;\n  background: none;\n  border: none;\n  padding: 0;\n  cursor: pointer;\n  flex: 1;\n  min-width: 0;\n  text-align: left;\n}\n.styles-module__headerToggle___WpW0b .styles-module__element___fTV2z {\n  flex: 1;\n}\n\n.styles-module__chevron___ZZJlR {\n  color: rgba(255, 255, 255, 0.5);\n  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);\n  flex-shrink: 0;\n}\n.styles-module__chevron___ZZJlR.styles-module__expanded___2Hxgv {\n  transform: rotate(90deg);\n}\n\n.styles-module__stylesWrapper___pnHgy {\n  display: grid;\n  grid-template-rows: 0fr;\n  transition: grid-template-rows 0.3s cubic-bezier(0.16, 1, 0.3, 1);\n}\n.styles-module__stylesWrapper___pnHgy.styles-module__expanded___2Hxgv {\n  grid-template-rows: 1fr;\n}\n\n.styles-module__stylesInner___YYZe2 {\n  overflow: hidden;\n}\n\n.styles-module__stylesBlock___VfQKn {\n  background: rgba(255, 255, 255, 0.05);\n  border-radius: 0.375rem;\n  padding: 0.5rem 0.625rem;\n  margin-bottom: 0.5rem;\n  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;\n  font-size: 0.6875rem;\n  line-height: 1.5;\n}\n\n.styles-module__styleLine___1YQiD {\n  color: rgba(255, 255, 255, 0.85);\n  word-break: break-word;\n}\n\n.styles-module__styleProperty___84L1i {\n  color: #c792ea;\n}\n\n.styles-module__styleValue___q51-h {\n  color: rgba(255, 255, 255, 0.85);\n}\n\n.styles-module__timestamp___Dtpsv {\n  font-size: 0.625rem;\n  font-weight: 500;\n  color: rgba(255, 255, 255, 0.35);\n  font-variant-numeric: tabular-nums;\n  margin-left: 0.5rem;\n  flex-shrink: 0;\n}\n\n.styles-module__quote___mcMmQ {\n  font-size: 12px;\n  font-style: italic;\n  color: rgba(255, 255, 255, 0.6);\n  margin-bottom: 0.5rem;\n  padding: 0.4rem 0.5rem;\n  background: rgba(255, 255, 255, 0.05);\n  border-radius: 0.25rem;\n  line-height: 1.45;\n}\n\n.styles-module__textarea___jrSae {\n  box-sizing: border-box;\n  width: 100%;\n  padding: 0.5rem 0.625rem;\n  font-size: 0.8125rem;\n  font-family: inherit;\n  background: rgba(255, 255, 255, 0.05);\n  color: #fff;\n  border: 1px solid rgba(255, 255, 255, 0.15);\n  border-radius: 8px;\n  resize: none;\n  outline: none;\n  transition: border-color 0.15s ease;\n}\n.styles-module__textarea___jrSae:focus {\n  border-color: var(--agentation-color-blue);\n}\n.styles-module__textarea___jrSae.styles-module__green___99l3h:focus {\n  border-color: var(--agentation-color-green);\n}\n.styles-module__textarea___jrSae::placeholder {\n  color: rgba(255, 255, 255, 0.35);\n}\n.styles-module__textarea___jrSae::-webkit-scrollbar {\n  width: 6px;\n}\n.styles-module__textarea___jrSae::-webkit-scrollbar-track {\n  background: transparent;\n}\n.styles-module__textarea___jrSae::-webkit-scrollbar-thumb {\n  background: rgba(255, 255, 255, 0.2);\n  border-radius: 3px;\n}\n\n.styles-module__actions___D6x3f {\n  display: flex;\n  justify-content: flex-end;\n  gap: 0.375rem;\n  margin-top: 0.5rem;\n}\n\n.styles-module__cancel___hRjnL,\n.styles-module__submit___K-mIR {\n  padding: 0.4rem 0.875rem;\n  font-size: 0.75rem;\n  font-weight: 500;\n  border-radius: 1rem;\n  border: none;\n  cursor: pointer;\n  transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;\n}\n\n.styles-module__cancel___hRjnL {\n  background: transparent;\n  color: rgba(255, 255, 255, 0.5);\n}\n.styles-module__cancel___hRjnL:hover {\n  background: rgba(255, 255, 255, 0.1);\n  color: rgba(255, 255, 255, 0.8);\n}\n\n.styles-module__submit___K-mIR {\n  color: white;\n}\n.styles-module__submit___K-mIR:hover:not(:disabled) {\n  filter: brightness(0.9);\n}\n.styles-module__submit___K-mIR:disabled {\n  cursor: not-allowed;\n}\n\n.styles-module__deleteWrapper___oSjdo {\n  margin-right: auto;\n}\n\n.styles-module__deleteButton___4VuAE {\n  cursor: pointer;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n  border-radius: 50%;\n  border: none;\n  background: transparent;\n  color: rgba(255, 255, 255, 0.4);\n  transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;\n}\n.styles-module__deleteButton___4VuAE:hover {\n  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);\n  color: var(--agentation-color-red);\n}\n.styles-module__deleteButton___4VuAE:active {\n  transform: scale(0.92);\n}\n\n.styles-module__light___6AaSQ.styles-module__popup___IhzrD {\n  background: #fff;\n  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.06);\n}\n.styles-module__light___6AaSQ .styles-module__element___fTV2z {\n  color: rgba(0, 0, 0, 0.6);\n}\n.styles-module__light___6AaSQ .styles-module__timestamp___Dtpsv {\n  color: rgba(0, 0, 0, 0.4);\n}\n.styles-module__light___6AaSQ .styles-module__chevron___ZZJlR {\n  color: rgba(0, 0, 0, 0.4);\n}\n.styles-module__light___6AaSQ .styles-module__stylesBlock___VfQKn {\n  background: rgba(0, 0, 0, 0.03);\n}\n.styles-module__light___6AaSQ .styles-module__styleLine___1YQiD {\n  color: rgba(0, 0, 0, 0.75);\n}\n.styles-module__light___6AaSQ .styles-module__styleProperty___84L1i {\n  color: #7c3aed;\n}\n.styles-module__light___6AaSQ .styles-module__styleValue___q51-h {\n  color: rgba(0, 0, 0, 0.75);\n}\n.styles-module__light___6AaSQ .styles-module__quote___mcMmQ {\n  color: rgba(0, 0, 0, 0.55);\n  background: rgba(0, 0, 0, 0.04);\n}\n.styles-module__light___6AaSQ .styles-module__textarea___jrSae {\n  background: rgba(0, 0, 0, 0.03);\n  color: #1a1a1a;\n  border-color: rgba(0, 0, 0, 0.12);\n}\n.styles-module__light___6AaSQ .styles-module__textarea___jrSae::placeholder {\n  color: rgba(0, 0, 0, 0.4);\n}\n.styles-module__light___6AaSQ .styles-module__textarea___jrSae::-webkit-scrollbar-thumb {\n  background: rgba(0, 0, 0, 0.15);\n}\n.styles-module__light___6AaSQ .styles-module__cancel___hRjnL {\n  color: rgba(0, 0, 0, 0.5);\n}\n.styles-module__light___6AaSQ .styles-module__cancel___hRjnL:hover {\n  background: rgba(0, 0, 0, 0.06);\n  color: rgba(0, 0, 0, 0.75);\n}\n.styles-module__light___6AaSQ .styles-module__deleteButton___4VuAE {\n  color: rgba(0, 0, 0, 0.4);\n}\n.styles-module__light___6AaSQ .styles-module__deleteButton___4VuAE:hover {\n  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);\n  color: var(--agentation-color-red);\n}';
var classNames = { "popup": "styles-module__popup___IhzrD", "enter": "styles-module__enter___L7U7N", "popupEnter": "styles-module__popupEnter___AuQDN", "entered": "styles-module__entered___COX-w", "exit": "styles-module__exit___5eGjE", "popupExit": "styles-module__popupExit___JJKQX", "shake": "styles-module__shake___jdbWe", "header": "styles-module__header___wWsSi", "element": "styles-module__element___fTV2z", "headerToggle": "styles-module__headerToggle___WpW0b", "chevron": "styles-module__chevron___ZZJlR", "expanded": "styles-module__expanded___2Hxgv", "stylesWrapper": "styles-module__stylesWrapper___pnHgy", "stylesInner": "styles-module__stylesInner___YYZe2", "stylesBlock": "styles-module__stylesBlock___VfQKn", "styleLine": "styles-module__styleLine___1YQiD", "styleProperty": "styles-module__styleProperty___84L1i", "styleValue": "styles-module__styleValue___q51-h", "timestamp": "styles-module__timestamp___Dtpsv", "quote": "styles-module__quote___mcMmQ", "textarea": "styles-module__textarea___jrSae", "green": "styles-module__green___99l3h", "actions": "styles-module__actions___D6x3f", "cancel": "styles-module__cancel___hRjnL", "submit": "styles-module__submit___K-mIR", "deleteWrapper": "styles-module__deleteWrapper___oSjdo", "deleteButton": "styles-module__deleteButton___4VuAE", "light": "styles-module__light___6AaSQ" };
if (typeof document !== "undefined") {
  let style = document.getElementById("feedback-tool-styles-annotation-popup-css-styles");
  if (!style) {
    style = document.createElement("style");
    style.id = "feedback-tool-styles-annotation-popup-css-styles";
    document.head.appendChild(style);
  }
  style.textContent = css;
}
var styles_module_default = classNames;

// src/components/icon-transitions.module.scss
var css2 = ".icon-transitions-module__iconState___uqK9J {\n  transition: opacity 0.2s ease, transform 0.2s ease;\n  transform-origin: center;\n}\n\n.icon-transitions-module__iconStateFast___HxlMm {\n  transition: opacity 0.15s ease, transform 0.15s ease;\n  transform-origin: center;\n}\n\n.icon-transitions-module__iconFade___nPwXg {\n  transition: opacity 0.2s ease;\n}\n\n.icon-transitions-module__iconFadeFast___Ofb2t {\n  transition: opacity 0.15s ease;\n}\n\n.icon-transitions-module__visible___PlHsU {\n  opacity: 1 !important;\n}\n\n.icon-transitions-module__visibleScaled___8Qog- {\n  opacity: 1 !important;\n  transform: scale(1);\n}\n\n.icon-transitions-module__hidden___ETykt {\n  opacity: 0 !important;\n}\n\n.icon-transitions-module__hiddenScaled___JXn-m {\n  opacity: 0 !important;\n  transform: scale(0.8);\n}\n\n.icon-transitions-module__sending___uaLN- {\n  opacity: 0.5 !important;\n  transform: scale(0.8);\n}";
var classNames2 = { "iconState": "icon-transitions-module__iconState___uqK9J", "iconStateFast": "icon-transitions-module__iconStateFast___HxlMm", "iconFade": "icon-transitions-module__iconFade___nPwXg", "iconFadeFast": "icon-transitions-module__iconFadeFast___Ofb2t", "visible": "icon-transitions-module__visible___PlHsU", "visibleScaled": "icon-transitions-module__visibleScaled___8Qog-", "hidden": "icon-transitions-module__hidden___ETykt", "hiddenScaled": "icon-transitions-module__hiddenScaled___JXn-m", "sending": "icon-transitions-module__sending___uaLN-" };
if (typeof document !== "undefined") {
  let style = document.getElementById("feedback-tool-styles-components-icon-transitions");
  if (!style) {
    style = document.createElement("style");
    style.id = "feedback-tool-styles-components-icon-transitions";
    document.head.appendChild(style);
  }
  style.textContent = css2;
}
var icon_transitions_module_default = classNames2;

// src/components/icons.tsx
import { jsx, jsxs } from "react/jsx-runtime";
var IconClose = ({ size = 16 }) => /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", children: /* @__PURE__ */ jsx(
  "path",
  {
    d: "M4 4l8 8M12 4l-8 8",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round"
  }
) });
var IconPlus = ({ size = 16 }) => /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", children: /* @__PURE__ */ jsx(
  "path",
  {
    d: "M8 3v10M3 8h10",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round"
  }
) });
var IconCheck = ({ size = 16 }) => /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", children: /* @__PURE__ */ jsx(
  "path",
  {
    d: "M3 8l3.5 3.5L13 5",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }
) });
var IconCheckSmall = ({ size = 14 }) => /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 14 14", fill: "none", children: /* @__PURE__ */ jsx(
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
}) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", style, children: [
  /* @__PURE__ */ jsxs("g", { clipPath: "url(#clip0_list_sparkle)", children: [
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M11.5 12L5.5 12",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M18.5 6.75L5.5 6.75",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M9.25 17.25L5.5 17.25",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M16 12.75L16.5179 13.9677C16.8078 14.6494 17.3506 15.1922 18.0323 15.4821L19.25 16L18.0323 16.5179C17.3506 16.8078 16.8078 17.3506 16.5179 18.0323L16 19.25L15.4821 18.0323C15.1922 17.3506 14.6494 16.8078 13.9677 16.5179L12.75 16L13.9677 15.4821C14.6494 15.1922 15.1922 14.6494 15.4821 13.9677L16 12.75Z",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinejoin: "round"
      }
    )
  ] }),
  /* @__PURE__ */ jsx("defs", { children: /* @__PURE__ */ jsx("clipPath", { id: "clip0_list_sparkle", children: /* @__PURE__ */ jsx("rect", { width: "24", height: "24", fill: "white" }) }) })
] });
var IconHelp = ({
  size = 20,
  ...props
}) => /* @__PURE__ */ jsxs(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 20 20",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    ...props,
    children: [
      /* @__PURE__ */ jsx(
        "circle",
        {
          cx: "10",
          cy: "10",
          r: "5.375",
          stroke: "currentColor",
          strokeWidth: "1.25"
        }
      ),
      /* @__PURE__ */ jsx(
        "path",
        {
          d: "M8.5 8.5C8.73 7.85 9.31 7.49 10 7.5C10.86 7.51 11.5 8.13 11.5 9C11.5 10.08 10 10.5 10 10.5V10.75",
          stroke: "currentColor",
          strokeWidth: "1.25",
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }
      ),
      /* @__PURE__ */ jsx("circle", { cx: "10", cy: "12.625", r: "0.625", fill: "currentColor" })
    ]
  }
);
var IconCheckSmallAnimated = ({ size = 14 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 14 14", fill: "none", children: [
  /* @__PURE__ */ jsx("style", { children: `
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
  /* @__PURE__ */ jsx(
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
var IconCopyAlt = ({ size = 16 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M4.75 11.25C4.75 10.4216 5.42157 9.75 6.25 9.75H12.75C13.5784 9.75 14.25 10.4216 14.25 11.25V17.75C14.25 18.5784 13.5784 19.25 12.75 19.25H6.25C5.42157 19.25 4.75 18.5784 4.75 17.75V11.25Z",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }
  ),
  /* @__PURE__ */ jsx(
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
}) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", style: tint ? { color: tint, transition: "color 0.3s ease" } : void 0, children: [
  /* @__PURE__ */ jsxs(
    "g",
    {
      className: `${icon_transitions_module_default.iconState} ${copied ? icon_transitions_module_default.hiddenScaled : icon_transitions_module_default.visibleScaled}`,
      children: [
        /* @__PURE__ */ jsx(
          "path",
          {
            d: "M4.75 11.25C4.75 10.4216 5.42157 9.75 6.25 9.75H12.75C13.5784 9.75 14.25 10.4216 14.25 11.25V17.75C14.25 18.5784 13.5784 19.25 12.75 19.25H6.25C5.42157 19.25 4.75 18.5784 4.75 17.75V11.25Z",
            stroke: "currentColor",
            strokeWidth: "1.5"
          }
        ),
        /* @__PURE__ */ jsx(
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
  /* @__PURE__ */ jsxs(
    "g",
    {
      className: `${icon_transitions_module_default.iconState} ${copied ? icon_transitions_module_default.visibleScaled : icon_transitions_module_default.hiddenScaled}`,
      children: [
        /* @__PURE__ */ jsx(
          "path",
          {
            d: "M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z",
            stroke: "var(--agentation-color-green)",
            strokeWidth: "1.5",
            strokeLinecap: "round",
            strokeLinejoin: "round"
          }
        ),
        /* @__PURE__ */ jsx(
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
  return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
    /* @__PURE__ */ jsx(
      "g",
      {
        className: `${icon_transitions_module_default.iconStateFast} ${showArrow ? icon_transitions_module_default.visibleScaled : isSending ? icon_transitions_module_default.sending : icon_transitions_module_default.hiddenScaled}`,
        children: /* @__PURE__ */ jsx(
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
    /* @__PURE__ */ jsxs(
      "g",
      {
        className: `${icon_transitions_module_default.iconStateFast} ${showCheck ? icon_transitions_module_default.visibleScaled : icon_transitions_module_default.hiddenScaled}`,
        children: [
          /* @__PURE__ */ jsx(
            "path",
            {
              d: "M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z",
              stroke: "var(--agentation-color-green)",
              strokeWidth: "1.5",
              strokeLinecap: "round",
              strokeLinejoin: "round"
            }
          ),
          /* @__PURE__ */ jsx(
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
    /* @__PURE__ */ jsxs(
      "g",
      {
        className: `${icon_transitions_module_default.iconStateFast} ${showError ? icon_transitions_module_default.visibleScaled : icon_transitions_module_default.hiddenScaled}`,
        children: [
          /* @__PURE__ */ jsx(
            "path",
            {
              d: "M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z",
              stroke: "var(--agentation-color-red)",
              strokeWidth: "1.5",
              strokeLinecap: "round",
              strokeLinejoin: "round"
            }
          ),
          /* @__PURE__ */ jsx(
            "path",
            {
              d: "M12 8V12",
              stroke: "var(--agentation-color-red)",
              strokeWidth: "1.5",
              strokeLinecap: "round"
            }
          ),
          /* @__PURE__ */ jsx(
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
}) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 22 21", fill: "none", children: [
  /* @__PURE__ */ jsxs("g", { className: `${icon_transitions_module_default.iconState} ${sent ? icon_transitions_module_default.hiddenScaled : icon_transitions_module_default.visibleScaled}`, children: [
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M9.5 5H6.5C4.84315 5 3.5 6.34315 3.5 8V15C3.5 16.6569 4.84315 18 6.5 18H13.5C15.1569 18 16.5 16.6569 16.5 15V12",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    ),
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M13.5 8.5L18.5 3.5M18.5 3.5L14.4524 3.5M18.5 3.5L18.5 7.54762",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M7.5 13.75H12.5",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    ),
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M7.5 10.75H10.5",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    )
  ] }),
  /* @__PURE__ */ jsxs("g", { className: `${icon_transitions_module_default.iconState} ${sent ? icon_transitions_module_default.visibleScaled : icon_transitions_module_default.hiddenScaled}`, children: [
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M11 19C6.58172 19 3 15.4182 3 11C3 6.58172 6.58172 3 11 3C15.4182 3 19 6.58172 19 11C19 15.4182 15.4182 19 11 19Z",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ jsx(
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
var IconEye = ({ size = 16 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M4.91516 12.7108C4.63794 12.2883 4.63705 11.7565 4.91242 11.3328C5.84146 9.9033 8.30909 6.74994 12 6.74994C15.6909 6.74994 18.1585 9.9033 19.0876 11.3328C19.3629 11.7565 19.3621 12.2883 19.0848 12.7108C18.1537 14.13 15.6873 17.2499 12 17.2499C8.31272 17.2499 5.8463 14.13 4.91516 12.7108Z",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ jsx(
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
var IconEyeAlt = ({ size = 24 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M3.91752 12.7539C3.65127 12.2996 3.65037 11.7515 3.9149 11.2962C4.9042 9.59346 7.72688 5.49994 12 5.49994C16.2731 5.49994 19.0958 9.59346 20.0851 11.2962C20.3496 11.7515 20.3487 12.2996 20.0825 12.7539C19.0908 14.4459 16.2694 18.4999 12 18.4999C7.73064 18.4999 4.90918 14.4459 3.91752 12.7539Z",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ jsx(
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
var IconEyeClosed = ({ size = 24 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M18.6025 9.28503C18.9174 8.9701 19.4364 8.99481 19.7015 9.35271C20.1484 9.95606 20.4943 10.507 20.7342 10.9199C21.134 11.6086 21.1329 12.4454 20.7303 13.1328C20.2144 14.013 19.2151 15.5225 17.7723 16.8193C16.3293 18.1162 14.3852 19.2497 12.0008 19.25C11.4192 19.25 10.8638 19.1823 10.3355 19.0613C9.77966 18.934 9.63498 18.2525 10.0382 17.8493C10.2412 17.6463 10.5374 17.573 10.8188 17.6302C11.1993 17.7076 11.5935 17.75 12.0008 17.75C13.8848 17.7497 15.4867 16.8568 16.7693 15.7041C18.0522 14.5511 18.9606 13.1867 19.4363 12.375C19.5656 12.1543 19.5659 11.8943 19.4373 11.6729C19.2235 11.3049 18.921 10.8242 18.5364 10.3003C18.3085 9.98991 18.3302 9.5573 18.6025 9.28503ZM12.0008 4.75C12.5814 4.75006 13.1358 4.81803 13.6632 4.93953C14.2182 5.06741 14.362 5.74812 13.9593 6.15091C13.7558 6.35435 13.4589 6.42748 13.1771 6.36984C12.7983 6.29239 12.4061 6.25006 12.0008 6.25C10.1167 6.25 8.51415 7.15145 7.23028 8.31543C5.94678 9.47919 5.03918 10.8555 4.56426 11.6729C4.43551 11.8945 4.43582 12.1542 4.56524 12.375C4.77587 12.7343 5.07189 13.2012 5.44718 13.7105C5.67623 14.0213 5.65493 14.4552 5.38193 14.7282C5.0671 15.0431 4.54833 15.0189 4.28292 14.6614C3.84652 14.0736 3.50813 13.5369 3.27129 13.1328C2.86831 12.4451 2.86717 11.6088 3.26739 10.9199C3.78185 10.0345 4.77959 8.51239 6.22247 7.2041C7.66547 5.89584 9.61202 4.75 12.0008 4.75Z",
      fill: "currentColor"
    }
  ),
  /* @__PURE__ */ jsx(
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
}) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsxs("g", { className: `${icon_transitions_module_default.iconFade} ${isOpen ? icon_transitions_module_default.visible : icon_transitions_module_default.hidden}`, children: [
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M3.91752 12.7539C3.65127 12.2996 3.65037 11.7515 3.9149 11.2962C4.9042 9.59346 7.72688 5.49994 12 5.49994C16.2731 5.49994 19.0958 9.59346 20.0851 11.2962C20.3496 11.7515 20.3487 12.2996 20.0825 12.7539C19.0908 14.4459 16.2694 18.4999 12 18.4999C7.73064 18.4999 4.90918 14.4459 3.91752 12.7539Z",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ jsx(
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
  /* @__PURE__ */ jsxs("g", { className: `${icon_transitions_module_default.iconFade} ${isOpen ? icon_transitions_module_default.hidden : icon_transitions_module_default.visible}`, children: [
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M18.6025 9.28503C18.9174 8.9701 19.4364 8.99481 19.7015 9.35271C20.1484 9.95606 20.4943 10.507 20.7342 10.9199C21.134 11.6086 21.1329 12.4454 20.7303 13.1328C20.2144 14.013 19.2151 15.5225 17.7723 16.8193C16.3293 18.1162 14.3852 19.2497 12.0008 19.25C11.4192 19.25 10.8638 19.1823 10.3355 19.0613C9.77966 18.934 9.63498 18.2525 10.0382 17.8493C10.2412 17.6463 10.5374 17.573 10.8188 17.6302C11.1993 17.7076 11.5935 17.75 12.0008 17.75C13.8848 17.7497 15.4867 16.8568 16.7693 15.7041C18.0522 14.5511 18.9606 13.1867 19.4363 12.375C19.5656 12.1543 19.5659 11.8943 19.4373 11.6729C19.2235 11.3049 18.921 10.8242 18.5364 10.3003C18.3085 9.98991 18.3302 9.5573 18.6025 9.28503ZM12.0008 4.75C12.5814 4.75006 13.1358 4.81803 13.6632 4.93953C14.2182 5.06741 14.362 5.74812 13.9593 6.15091C13.7558 6.35435 13.4589 6.42748 13.1771 6.36984C12.7983 6.29239 12.4061 6.25006 12.0008 6.25C10.1167 6.25 8.51415 7.15145 7.23028 8.31543C5.94678 9.47919 5.03918 10.8555 4.56426 11.6729C4.43551 11.8945 4.43582 12.1542 4.56524 12.375C4.77587 12.7343 5.07189 13.2012 5.44718 13.7105C5.67623 14.0213 5.65493 14.4552 5.38193 14.7282C5.0671 15.0431 4.54833 15.0189 4.28292 14.6614C3.84652 14.0736 3.50813 13.5369 3.27129 13.1328C2.86831 12.4451 2.86717 11.6088 3.26739 10.9199C3.78185 10.0345 4.77959 8.51239 6.22247 7.2041C7.66547 5.89584 9.61202 4.75 12.0008 4.75Z",
        fill: "currentColor"
      }
    ),
    /* @__PURE__ */ jsx(
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
}) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsxs("g", { className: `${icon_transitions_module_default.iconFadeFast} ${isPaused ? icon_transitions_module_default.hidden : icon_transitions_module_default.visible}`, children: [
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M8 6L8 18",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    ),
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M16 18L16 6",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round"
      }
    )
  ] }),
  /* @__PURE__ */ jsx(
    "path",
    {
      className: `${icon_transitions_module_default.iconFadeFast} ${isPaused ? icon_transitions_module_default.visible : icon_transitions_module_default.hidden}`,
      d: "M17.75 10.701C18.75 11.2783 18.75 12.7217 17.75 13.299L8.75 18.4952C7.75 19.0725 6.5 18.3509 6.5 17.1962L6.5 6.80384C6.5 5.64914 7.75 4.92746 8.75 5.50481L17.75 10.701Z",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }
  )
] });
var IconEyeMinus = ({ size = 16 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M4.91516 12.7108C4.63794 12.2883 4.63705 11.7565 4.91242 11.3328C5.84146 9.9033 8.30909 6.74994 12 6.74994C15.6909 6.74994 18.1585 9.9033 19.0876 11.3328C19.3629 11.7565 19.3621 12.2883 19.0848 12.7108C18.1537 14.13 15.6873 17.2499 12 17.2499C8.31272 17.2499 5.8463 14.13 4.91516 12.7108Z",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M9 12H15",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round"
    }
  )
] });
var IconGear = ({ size = 16 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M10.6504 5.81117C10.9939 4.39628 13.0061 4.39628 13.3496 5.81117C13.5715 6.72517 14.6187 7.15891 15.4219 6.66952C16.6652 5.91193 18.0881 7.33479 17.3305 8.57815C16.8411 9.38134 17.2748 10.4285 18.1888 10.6504C19.6037 10.9939 19.6037 13.0061 18.1888 13.3496C17.2748 13.5715 16.8411 14.6187 17.3305 15.4219C18.0881 16.6652 16.6652 18.0881 15.4219 17.3305C14.6187 16.8411 13.5715 17.2748 13.3496 18.1888C13.0061 19.6037 10.9939 19.6037 10.6504 18.1888C10.4285 17.2748 9.38135 16.8411 8.57815 17.3305C7.33479 18.0881 5.91193 16.6652 6.66952 15.4219C7.15891 14.6187 6.72517 13.5715 5.81117 13.3496C4.39628 13.0061 4.39628 10.9939 5.81117 10.6504C6.72517 10.4285 7.15891 9.38134 6.66952 8.57815C5.91193 7.33479 7.33479 5.91192 8.57815 6.66952C9.38135 7.15891 10.4285 6.72517 10.6504 5.81117Z",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ jsx("circle", { cx: "12", cy: "12", r: "2.5", stroke: "currentColor", strokeWidth: "1.5" })
] });
var IconPauseAlt = ({ size = 16 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M9.25 5.75C9.80228 5.75 10.25 6.19772 10.25 6.75L10.25 17.25C10.25 17.8023 9.80228 18.25 9.25 18.25L6.75 18.25C6.19772 18.25 5.75 17.8023 5.75 17.25L5.75 6.75C5.75 6.19772 6.19772 5.75 6.75 5.75L9.25 5.75Z",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }
  ),
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M17.25 5.75C17.8023 5.75 18.25 6.19772 18.25 6.75L18.25 17.25C18.25 17.8023 17.8023 18.25 17.25 18.25L14.75 18.25C14.1977 18.25 13.75 17.8023 13.75 17.25L13.75 6.75C13.75 6.19772 14.1977 5.75 14.75 5.75L17.25 5.75Z",
      stroke: "currentColor",
      strokeWidth: "1.5"
    }
  )
] });
var IconPause = ({ size = 24 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M8 6L8 18",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round"
    }
  ),
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M16 18L16 6",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round"
    }
  )
] });
var IconPlayAlt = ({ size = 16 }) => /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: /* @__PURE__ */ jsx(
  "path",
  {
    d: "M17.75 10.701C18.75 11.2783 18.75 12.7217 17.75 13.299L8.75 18.4952C7.75 19.0725 6.5 18.3509 6.5 17.1962L6.5 6.80384C6.5 5.64914 7.75 4.92746 8.75 5.50481L17.75 10.701Z",
    stroke: "currentColor",
    strokeWidth: "1.5"
  }
) });
var IconTrashAlt = ({ size = 16 }) => /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: /* @__PURE__ */ jsx(
  "path",
  {
    d: "M13.5 4C14.7426 4 15.75 5.00736 15.75 6.25V7H18.5C18.9142 7 19.25 7.33579 19.25 7.75C19.25 8.16421 18.9142 8.5 18.5 8.5H17.9678L17.6328 16.2217C17.61 16.7475 17.5912 17.1861 17.5469 17.543C17.5015 17.9087 17.4225 18.2506 17.2461 18.5723C16.9747 19.0671 16.5579 19.4671 16.0518 19.7168C15.7227 19.8791 15.3772 19.9422 15.0098 19.9717C14.6514 20.0004 14.2126 20 13.6865 20H10.3135C9.78735 20 9.34856 20.0004 8.99023 19.9717C8.62278 19.9422 8.27729 19.8791 7.94824 19.7168C7.44205 19.4671 7.02532 19.0671 6.75391 18.5723C6.57751 18.2506 6.49853 17.9087 6.45312 17.543C6.40883 17.1861 6.39005 16.7475 6.36719 16.2217L6.03223 8.5H5.5C5.08579 8.5 4.75 8.16421 4.75 7.75C4.75 7.33579 5.08579 7 5.5 7H8.25V6.25C8.25 5.00736 9.25736 4 10.5 4H13.5ZM7.86621 16.1562C7.89013 16.7063 7.90624 17.0751 7.94141 17.3584C7.97545 17.6326 8.02151 17.7644 8.06934 17.8516C8.19271 18.0763 8.38239 18.2577 8.6123 18.3711C8.70153 18.4151 8.83504 18.4545 9.11035 18.4766C9.39482 18.4994 9.76335 18.5 10.3135 18.5H13.6865C14.2367 18.5 14.6052 18.4994 14.8896 18.4766C15.165 18.4545 15.2985 18.4151 15.3877 18.3711C15.6176 18.2577 15.8073 18.0763 15.9307 17.8516C15.9785 17.7644 16.0245 17.6326 16.0586 17.3584C16.0938 17.0751 16.1099 16.7063 16.1338 16.1562L16.4668 8.5H7.5332L7.86621 16.1562ZM9.97656 10.75C10.3906 10.7371 10.7371 11.0626 10.75 11.4766L10.875 15.4766C10.8879 15.8906 10.5624 16.2371 10.1484 16.25C9.73443 16.2629 9.38794 15.9374 9.375 15.5234L9.25 11.5234C9.23706 11.1094 9.56255 10.7629 9.97656 10.75ZM14.0244 10.75C14.4384 10.7635 14.7635 11.1105 14.75 11.5244L14.6201 15.5244C14.6066 15.9384 14.2596 16.2634 13.8457 16.25C13.4317 16.2365 13.1067 15.8896 13.1201 15.4756L13.251 11.4756C13.2645 11.0617 13.6105 10.7366 14.0244 10.75ZM10.5 5.5C10.0858 5.5 9.75 5.83579 9.75 6.25V7H14.25V6.25C14.25 5.83579 13.9142 5.5 13.5 5.5H10.5Z",
    fill: "currentColor"
  }
) });
var IconChatEllipsis = ({
  size = 16,
  style = {}
}) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", style, children: [
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M18.8875 19.25L19.6112 19.0533C19.6823 19.3148 19.6068 19.5943 19.4137 19.7844C19.2206 19.9746 18.9399 20.0457 18.6795 19.9706L18.8875 19.25ZM14.9631 18.244L15.263 18.9314L14.9631 18.244ZM18.0914 15.6309L17.4669 15.2156L18.0914 15.6309ZM4.75 11.8041H5.5C5.5 15.2664 8.39065 18.1081 12 18.1081V18.8581V19.6081C7.60123 19.6081 4 16.1334 4 11.8041H4.75ZM19.25 11.8041H18.5C18.5 8.34166 15.6094 5.5 12 5.5V4.75V4C16.3988 4 20 7.47476 20 11.8041H19.25ZM12 4.75V5.5C8.39065 5.5 5.5 8.34166 5.5 11.8041H4.75H4C4 7.47476 7.60123 4 12 4V4.75ZM18.0914 15.6309L17.4669 15.2156C18.1213 14.2315 18.5 13.0612 18.5 11.8041H19.25H20C20 13.3681 19.5276 14.8257 18.716 16.0462L18.0914 15.6309ZM18.8875 19.25L18.1638 19.4467L17.2953 16.2517L18.019 16.055L18.7428 15.8583L19.6112 19.0533L18.8875 19.25ZM12 18.8581V18.1081C12.9509 18.1081 13.8518 17.9105 14.6632 17.5565L14.9631 18.244L15.263 18.9314C14.2652 19.3667 13.1603 19.6081 12 19.6081V18.8581ZM15.3144 18.2188L15.5224 17.4982L19.0955 18.5294L18.8875 19.25L18.6795 19.9706L15.1064 18.9394L15.3144 18.2188ZM14.9631 18.244L14.6632 17.5565C14.925 17.4423 15.2286 17.4134 15.5224 17.4982L15.3144 18.2188L15.1064 18.9394C15.1677 18.957 15.223 18.9489 15.263 18.9314L14.9631 18.244ZM18.0914 15.6309L18.716 16.0462C18.7451 16.0024 18.7636 15.9351 18.7428 15.8583L18.019 16.055L17.2953 16.2517C17.1957 15.8853 17.2716 15.5093 17.4669 15.2156L18.0914 15.6309Z",
      fill: "currentColor"
    }
  ),
  /* @__PURE__ */ jsx("circle", { cx: "15", cy: "11.75", r: "1", fill: "currentColor" }),
  /* @__PURE__ */ jsx("circle", { cx: "12", cy: "11.75", r: "1", fill: "currentColor" }),
  /* @__PURE__ */ jsx("circle", { cx: "9", cy: "11.75", r: "1", fill: "currentColor" })
] });
var IconCheckmark = ({ size = 16 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsx("g", { clipPath: "url(#clip0_2_45)", children: /* @__PURE__ */ jsx(
    "path",
    {
      d: "M16.25 8.75L10 15.25L7.25 12.25",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ) }),
  /* @__PURE__ */ jsx("defs", { children: /* @__PURE__ */ jsx("clipPath", { id: "clip0_2_45", children: /* @__PURE__ */ jsx("rect", { width: "24", height: "24", fill: "white" }) }) })
] });
var IconCheckmarkLarge = ({ size = 16 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsx("g", { clipPath: "url(#clip0_2_37)", children: /* @__PURE__ */ jsx(
    "path",
    {
      d: "M17.5962 7.75L9.42308 16.25L6.15385 12.6538",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ) }),
  /* @__PURE__ */ jsx("defs", { children: /* @__PURE__ */ jsx("clipPath", { id: "clip0_2_37", children: /* @__PURE__ */ jsx("rect", { width: "24", height: "24", fill: "white" }) }) })
] });
var IconCheckmarkCircle = ({ size = 24 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsxs("g", { clipPath: "url(#clip0_checkmark_circle)", children: [
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ jsx(
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
  /* @__PURE__ */ jsx("defs", { children: /* @__PURE__ */ jsx("clipPath", { id: "clip0_checkmark_circle", children: /* @__PURE__ */ jsx("rect", { width: "24", height: "24", fill: "white" }) }) })
] });
var IconXmark = ({ size = 16 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsxs("g", { clipPath: "url(#clip0_2_53)", children: [
    /* @__PURE__ */ jsx(
      "path",
      {
        d: "M16.25 16.25L7.75 7.75",
        stroke: "currentColor",
        strokeWidth: "1.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }
    ),
    /* @__PURE__ */ jsx(
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
  /* @__PURE__ */ jsx("defs", { children: /* @__PURE__ */ jsx("clipPath", { id: "clip0_2_53", children: /* @__PURE__ */ jsx("rect", { width: "24", height: "24", fill: "white" }) }) })
] });
var IconXmarkLarge = ({ size = 24 }) => /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: /* @__PURE__ */ jsx(
  "path",
  {
    d: "M16.7198 6.21973C17.0127 5.92683 17.4874 5.92683 17.7803 6.21973C18.0732 6.51262 18.0732 6.9874 17.7803 7.28027L13.0606 12L17.7803 16.7197C18.0732 17.0126 18.0732 17.4874 17.7803 17.7803C17.4875 18.0731 17.0127 18.0731 16.7198 17.7803L12.0001 13.0605L7.28033 17.7803C6.98746 18.0731 6.51268 18.0731 6.21979 17.7803C5.92689 17.4874 5.92689 17.0126 6.21979 16.7197L10.9395 12L6.21979 7.28027C5.92689 6.98738 5.92689 6.51262 6.21979 6.21973C6.51268 5.92683 6.98744 5.92683 7.28033 6.21973L12.0001 10.9395L16.7198 6.21973Z",
    fill: "currentColor"
  }
) });
var IconSun = ({ size = 16 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 20 20", fill: "none", children: [
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M9.99999 12.7082C11.4958 12.7082 12.7083 11.4956 12.7083 9.99984C12.7083 8.50407 11.4958 7.2915 9.99999 7.2915C8.50422 7.2915 7.29166 8.50407 7.29166 9.99984C7.29166 11.4956 8.50422 12.7082 9.99999 12.7082Z",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M10 3.9585V5.05698",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M10 14.9429V16.0414",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M5.7269 5.72656L6.50682 6.50649",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M13.4932 13.4932L14.2731 14.2731",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M3.95834 10H5.05683",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M14.9432 10H16.0417",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ jsx(
    "path",
    {
      d: "M5.7269 14.2731L6.50682 13.4932",
      stroke: "currentColor",
      strokeWidth: "1.25",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }
  ),
  /* @__PURE__ */ jsx(
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
var IconMoon = ({ size = 16 }) => /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 20 20", fill: "none", children: /* @__PURE__ */ jsx(
  "path",
  {
    d: "M15.5 10.4955C15.4037 11.5379 15.0124 12.5314 14.3721 13.3596C13.7317 14.1878 12.8688 14.8165 11.8841 15.1722C10.8995 15.5278 9.83397 15.5957 8.81217 15.3679C7.79038 15.1401 6.8546 14.6259 6.11434 13.8857C5.37408 13.1454 4.85995 12.2096 4.63211 11.1878C4.40427 10.166 4.47215 9.10048 4.82781 8.11585C5.18346 7.13123 5.81218 6.26825 6.64039 5.62791C7.4686 4.98756 8.46206 4.59634 9.5045 4.5C8.89418 5.32569 8.60049 6.34302 8.67685 7.36695C8.75321 8.39087 9.19454 9.35339 9.92058 10.0794C10.6466 10.8055 11.6091 11.2468 12.6331 11.3231C13.657 11.3995 14.6743 11.1058 15.5 10.4955Z",
    stroke: "currentColor",
    strokeWidth: "1.13793",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }
) });
var IconEdit = ({ size = 16 }) => /* @__PURE__ */ jsx(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    children: /* @__PURE__ */ jsx(
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
var IconTrash = ({ size = 24 }) => /* @__PURE__ */ jsx(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    children: /* @__PURE__ */ jsx(
      "path",
      {
        d: "M13.5 4C14.7426 4 15.75 5.00736 15.75 6.25V7H18.5C18.9142 7 19.25 7.33579 19.25 7.75C19.25 8.16421 18.9142 8.5 18.5 8.5H17.9678L17.6328 16.2217C17.61 16.7475 17.5912 17.1861 17.5469 17.543C17.5015 17.9087 17.4225 18.2506 17.2461 18.5723C16.9747 19.0671 16.5579 19.4671 16.0518 19.7168C15.7227 19.8791 15.3772 19.9422 15.0098 19.9717C14.6514 20.0004 14.2126 20 13.6865 20H10.3135C9.78735 20 9.34856 20.0004 8.99023 19.9717C8.62278 19.9422 8.27729 19.8791 7.94824 19.7168C7.44205 19.4671 7.02532 19.0671 6.75391 18.5723C6.57751 18.2506 6.49853 17.9087 6.45312 17.543C6.40883 17.1861 6.39005 16.7475 6.36719 16.2217L6.03223 8.5H5.5C5.08579 8.5 4.75 8.16421 4.75 7.75C4.75 7.33579 5.08579 7 5.5 7H8.25V6.25C8.25 5.00736 9.25736 4 10.5 4H13.5ZM7.86621 16.1562C7.89013 16.7063 7.90624 17.0751 7.94141 17.3584C7.97545 17.6326 8.02151 17.7644 8.06934 17.8516C8.19271 18.0763 8.38239 18.2577 8.6123 18.3711C8.70153 18.4151 8.83504 18.4545 9.11035 18.4766C9.39482 18.4994 9.76335 18.5 10.3135 18.5H13.6865C14.2367 18.5 14.6052 18.4994 14.8896 18.4766C15.165 18.4545 15.2985 18.4151 15.3877 18.3711C15.6176 18.2577 15.8073 18.0763 15.9307 17.8516C15.9785 17.7644 16.0245 17.6326 16.0586 17.3584C16.0938 17.0751 16.1099 16.7063 16.1338 16.1562L16.4668 8.5H7.5332L7.86621 16.1562ZM9.97656 10.75C10.3906 10.7371 10.7371 11.0626 10.75 11.4766L10.875 15.4766C10.8879 15.8906 10.5624 16.2371 10.1484 16.25C9.73443 16.2629 9.38794 15.9374 9.375 15.5234L9.25 11.5234C9.23706 11.1094 9.56255 10.7629 9.97656 10.75ZM14.0244 10.75C14.4383 10.7635 14.7635 11.1105 14.75 11.5244L14.6201 15.5244C14.6066 15.9384 14.2596 16.2634 13.8457 16.25C13.4317 16.2365 13.1067 15.8896 13.1201 15.4756L13.251 11.4756C13.2645 11.0617 13.6105 10.7366 14.0244 10.75ZM10.5 5.5C10.0858 5.5 9.75 5.83579 9.75 6.25V7H14.25V6.25C14.25 5.83579 13.9142 5.5 13.5 5.5H10.5Z",
        fill: "currentColor"
      }
    )
  }
);
var IconChevronLeft = ({ size = 16 }) => /* @__PURE__ */ jsx(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    children: /* @__PURE__ */ jsx(
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
var IconChevronRight = ({ size = 16 }) => /* @__PURE__ */ jsx(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    children: /* @__PURE__ */ jsx(
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
}) => /* @__PURE__ */ jsxs(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 28 28",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    children: [
      /* @__PURE__ */ jsx("style", { children: `
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
      /* @__PURE__ */ jsx("rect", { width: "28", height: "28", fill: "transparent" }),
      /* @__PURE__ */ jsx(
        "path",
        {
          className: "bunny-ear-left",
          d: "M3.738 10.2164L7.224 2.007H9.167L5.676 10.2164H3.738ZM10.791 6.42705C10.791 5.90346 10.726 5.42764 10.596 4.99959C10.47 4.57155 10.292 4.16643 10.063 3.78425C9.833 3.39825 9.56 3.01797 9.243 2.64343C8.926 2.26507 8.767 2.07589 8.767 2.07589L10.24 0.957996C10.24 0.957996 10.433 1.17203 10.819 1.60007C11.209 2.0243 11.559 2.49056 11.869 2.99886C12.178 3.50717 12.413 4.04222 12.574 4.60403C12.734 5.16584 12.814 5.77352 12.814 6.42705C12.814 7.10734 12.73 7.7303 12.562 8.29593C12.394 8.85774 12.153 9.3966 11.84 9.9126C11.526 10.4247 11.181 10.8833 10.802 11.2884C10.428 11.6974 10.24 11.9018 10.24 11.9018L8.767 10.7839C8.767 10.7839 8.924 10.5948 9.237 10.2164C9.554 9.8419 9.83 9.4597 10.063 9.06985C10.3 8.6762 10.479 8.26726 10.602 7.84304C10.728 7.41499 10.791 6.943 10.791 6.42705Z",
          fill: color
        }
      ),
      /* @__PURE__ */ jsx(
        "path",
        {
          className: "bunny-ear-right",
          d: "M15.003 10.2164L18.489 2.007H20.432L16.941 10.2164H15.003ZM22.056 6.42705C22.056 5.90346 21.991 5.42764 21.861 4.99959C21.735 4.57155 21.557 4.16643 21.328 3.78425C21.098 3.39825 20.825 3.01797 20.508 2.64343C20.191 2.26507 20.032 2.07589 20.032 2.07589L21.505 0.957996C21.505 0.957996 21.698 1.17203 22.084 1.60007C22.474 2.0243 22.824 2.49056 23.133 2.99886C23.443 3.50717 23.678 4.04222 23.839 4.60403C23.999 5.16584 24.079 5.77352 24.079 6.42705C24.079 7.10734 23.995 7.7303 23.827 8.29593C23.659 8.85774 23.418 9.3966 23.105 9.9126C22.791 10.4247 22.445 10.8833 22.067 11.2884C21.693 11.6974 21.505 11.9018 21.505 11.9018L20.032 10.7839C20.032 10.7839 20.189 10.5948 20.502 10.2164C20.819 9.8419 21.094 9.4597 21.328 9.06985C21.565 8.6762 21.744 8.26726 21.866 7.84304C21.993 7.41499 22.056 6.943 22.056 6.42705Z",
          fill: color
        }
      ),
      /* @__PURE__ */ jsx(
        "path",
        {
          className: "bunny-face",
          d: "M2.03 20.4328C2.03 20.9564 2.093 21.4322 2.219 21.8602C2.345 22.2883 2.523 22.6953 2.752 23.0813C2.981 23.4635 3.254 23.8419 3.572 24.2164C3.889 24.5948 4.047 24.7839 4.047 24.7839L2.574 25.9018C2.574 25.9018 2.379 25.6878 1.989 25.2598C1.603 24.8355 1.256 24.3693 0.946 23.861C0.636 23.3527 0.401 22.8176 0.241 22.2558C0.08 21.694 0 21.0863 0 20.4328C0 19.7525 0.084 19.1314 0.252 18.5696C0.421 18.004 0.661 17.4651 0.975 16.953C1.288 16.4371 1.632 15.9765 2.007 15.5714C2.385 15.1625 2.574 14.958 2.574 14.958L4.047 16.0759C4.047 16.0759 3.889 16.2651 3.572 16.6434C3.258 17.018 2.983 17.4021 2.746 17.7957C2.513 18.1855 2.335 18.5945 2.213 19.0225C2.091 19.4467 2.03 19.9168 2.03 20.4328ZM23.687 20.4271C23.687 19.9035 23.622 19.4276 23.492 18.9996C23.366 18.5715 23.188 18.1664 22.959 17.7843C22.729 17.3982 22.456 17.018 22.139 16.6434C21.822 16.2651 21.663 16.0759 21.663 16.0759L23.136 14.958C23.136 14.958 23.329 15.172 23.715 15.6001C24.105 16.0243 24.455 16.4906 24.765 16.9989C25.074 17.5072 25.309 18.0422 25.47 18.604C25.63 19.1658 25.71 19.7735 25.71 20.4271C25.71 21.1073 25.626 21.7303 25.458 22.2959C25.29 22.8577 25.049 23.3966 24.736 23.9126C24.422 24.4247 24.077 24.8833 23.698 25.2884C23.324 25.6974 23.136 25.9018 23.136 25.9018L21.663 24.7839C21.663 24.7839 21.82 24.5948 22.133 24.2164C22.45 23.8419 22.726 23.4597 22.959 23.0698C23.196 22.6762 23.375 22.2673 23.498 21.843C23.624 21.415 23.687 20.943 23.687 20.4271Z",
          fill: color
        }
      ),
      /* @__PURE__ */ jsx(
        "circle",
        {
          className: "bunny-eye-left",
          cx: "8.277",
          cy: "20.466",
          r: "1.8",
          fill: color
        }
      ),
      /* @__PURE__ */ jsx(
        "circle",
        {
          className: "bunny-eye-right",
          cx: "19.878",
          cy: "20.466",
          r: "1.8",
          fill: color
        }
      ),
      /* @__PURE__ */ jsx(
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
var IconLayout = ({ size = 24 }) => /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [
  /* @__PURE__ */ jsx(
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
  /* @__PURE__ */ jsx(
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
  /* @__PURE__ */ jsx(
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
  if (!w[STATE_KEY]) {
    w[STATE_KEY] = {
      frozen: false,
      installed: false,
      origSetTimeout: null,
      origSetInterval: null,
      origRAF: null,
      pausedAnimations: [],
      frozenTimeoutQueue: [],
      frozenRAFQueue: []
    };
  }
  return w[STATE_KEY];
}
var _s = getState();
if (typeof window !== "undefined" && !_s.installed) {
  _s.origSetTimeout = window.setTimeout.bind(window);
  _s.origSetInterval = window.setInterval.bind(window);
  _s.origRAF = window.requestAnimationFrame.bind(window);
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

// src/components/annotation-popup-css/index.tsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function focusBypassingTraps(el) {
  if (!el) return;
  const trap = (e) => e.stopImmediatePropagation();
  document.addEventListener("focusin", trap, true);
  document.addEventListener("focusout", trap, true);
  try {
    el.focus();
  } finally {
    document.removeEventListener("focusin", trap, true);
    document.removeEventListener("focusout", trap, true);
  }
}
var AnnotationPopupCSS = forwardRef(
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
    style,
    accentColor = "#3c82f7",
    isExiting = false,
    lightMode = false,
    computedStyles
  }, ref) {
    const [text, setText] = useState(initialValue);
    const [isShaking, setIsShaking] = useState(false);
    const [animState, setAnimState] = useState("initial");
    const [isFocused, setIsFocused] = useState(false);
    const [isStylesExpanded, setIsStylesExpanded] = useState(false);
    const textareaRef = useRef(null);
    const popupRef = useRef(null);
    const cancelTimerRef = useRef(null);
    const shakeTimerRef = useRef(null);
    useEffect(() => {
      if (isExiting && animState !== "exit") {
        setAnimState("exit");
      }
    }, [isExiting, animState]);
    useEffect(() => {
      originalSetTimeout(() => {
        setAnimState("enter");
      }, 0);
      const enterTimer = originalSetTimeout(() => {
        setAnimState("entered");
      }, 200);
      const focusTimer = originalSetTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          focusBypassingTraps(textarea);
          textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
          textarea.scrollTop = textarea.scrollHeight;
        }
      }, 50);
      return () => {
        clearTimeout(enterTimer);
        clearTimeout(focusTimer);
        if (cancelTimerRef.current) clearTimeout(cancelTimerRef.current);
        if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
      };
    }, []);
    const shake = useCallback(() => {
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
      setIsShaking(true);
      shakeTimerRef.current = originalSetTimeout(() => {
        setIsShaking(false);
        focusBypassingTraps(textareaRef.current);
      }, 250);
    }, []);
    useImperativeHandle(ref, () => ({
      shake
    }), [shake]);
    const handleCancel = useCallback(() => {
      setAnimState("exit");
      cancelTimerRef.current = originalSetTimeout(() => {
        onCancel();
      }, 150);
    }, [onCancel]);
    const handleSubmit = useCallback(() => {
      if (!text.trim()) return;
      onSubmit(text.trim());
    }, [text, onSubmit]);
    const handleKeyDown = useCallback(
      (e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSubmit();
        }
        if (e.key === "Escape") {
          handleCancel();
        }
      },
      [handleSubmit, handleCancel]
    );
    const popupClassName = [
      styles_module_default.popup,
      lightMode ? styles_module_default.light : "",
      animState === "enter" ? styles_module_default.enter : "",
      animState === "entered" ? styles_module_default.entered : "",
      animState === "exit" ? styles_module_default.exit : "",
      isShaking ? styles_module_default.shake : ""
    ].filter(Boolean).join(" ");
    return /* @__PURE__ */ jsxs2(
      "div",
      {
        ref: popupRef,
        className: popupClassName,
        "data-annotation-popup": true,
        style,
        onClick: (e) => e.stopPropagation(),
        children: [
          /* @__PURE__ */ jsxs2("div", { className: styles_module_default.header, children: [
            computedStyles && Object.keys(computedStyles).length > 0 ? /* @__PURE__ */ jsxs2(
              "button",
              {
                className: styles_module_default.headerToggle,
                onClick: () => {
                  const wasExpanded = isStylesExpanded;
                  setIsStylesExpanded(!isStylesExpanded);
                  if (wasExpanded) {
                    originalSetTimeout(() => focusBypassingTraps(textareaRef.current), 0);
                  }
                },
                type: "button",
                children: [
                  /* @__PURE__ */ jsx2(
                    "svg",
                    {
                      className: `${styles_module_default.chevron} ${isStylesExpanded ? styles_module_default.expanded : ""}`,
                      width: "14",
                      height: "14",
                      viewBox: "0 0 14 14",
                      fill: "none",
                      xmlns: "http://www.w3.org/2000/svg",
                      children: /* @__PURE__ */ jsx2(
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
                  /* @__PURE__ */ jsx2("span", { className: styles_module_default.element, children: element })
                ]
              }
            ) : /* @__PURE__ */ jsx2("span", { className: styles_module_default.element, children: element }),
            timestamp && /* @__PURE__ */ jsx2("span", { className: styles_module_default.timestamp, children: timestamp })
          ] }),
          computedStyles && Object.keys(computedStyles).length > 0 && /* @__PURE__ */ jsx2("div", { className: `${styles_module_default.stylesWrapper} ${isStylesExpanded ? styles_module_default.expanded : ""}`, children: /* @__PURE__ */ jsx2("div", { className: styles_module_default.stylesInner, children: /* @__PURE__ */ jsx2("div", { className: styles_module_default.stylesBlock, children: Object.entries(computedStyles).map(([key, value]) => /* @__PURE__ */ jsxs2("div", { className: styles_module_default.styleLine, children: [
            /* @__PURE__ */ jsx2("span", { className: styles_module_default.styleProperty, children: key.replace(/([A-Z])/g, "-$1").toLowerCase() }),
            ": ",
            /* @__PURE__ */ jsx2("span", { className: styles_module_default.styleValue, children: value }),
            ";"
          ] }, key)) }) }) }),
          selectedText && /* @__PURE__ */ jsxs2("div", { className: styles_module_default.quote, children: [
            "\u201C",
            selectedText.slice(0, 80),
            selectedText.length > 80 ? "..." : "",
            "\u201D"
          ] }),
          /* @__PURE__ */ jsx2(
            "textarea",
            {
              ref: textareaRef,
              className: styles_module_default.textarea,
              style: { borderColor: isFocused ? accentColor : void 0 },
              placeholder,
              value: text,
              onChange: (e) => setText(e.target.value),
              onFocus: () => setIsFocused(true),
              onBlur: () => setIsFocused(false),
              rows: 2,
              onKeyDown: handleKeyDown
            }
          ),
          /* @__PURE__ */ jsxs2("div", { className: styles_module_default.actions, children: [
            onDelete && /* @__PURE__ */ jsx2("div", { className: styles_module_default.deleteWrapper, children: /* @__PURE__ */ jsx2("button", { className: styles_module_default.deleteButton, onClick: onDelete, type: "button", children: /* @__PURE__ */ jsx2(IconTrash, { size: 22 }) }) }),
            /* @__PURE__ */ jsx2("button", { className: styles_module_default.cancel, onClick: handleCancel, children: "Cancel" }),
            /* @__PURE__ */ jsx2(
              "button",
              {
                className: styles_module_default.submit,
                style: {
                  backgroundColor: accentColor,
                  opacity: text.trim() ? 1 : 0.4
                },
                onClick: handleSubmit,
                disabled: !text.trim(),
                children: submitLabel
              }
            )
          ] })
        ]
      }
    );
  }
);

// src/components/tooltip/index.tsx
import { useEffect as useEffect2, useRef as useRef2, useState as useState2 } from "react";
import { createPortal } from "react-dom";
import { Fragment, jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
var Tooltip = ({
  content,
  children,
  ...props
}) => {
  const [visible, setVisible] = useState2(false);
  const [shouldRender, setShouldRender] = useState2(false);
  const [position, setPosition] = useState2({ top: 0, right: 0 });
  const triggerRef = useRef2(null);
  const timeoutRef = useRef2(null);
  const exitTimeoutRef = useRef2(null);
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
  useEffect2(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (exitTimeoutRef.current) clearTimeout(exitTimeoutRef.current);
    };
  }, []);
  return /* @__PURE__ */ jsxs3(Fragment, { children: [
    /* @__PURE__ */ jsx3(
      "span",
      {
        ref: triggerRef,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
        ...props,
        children
      }
    ),
    shouldRender && createPortal(
      /* @__PURE__ */ jsx3(
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
var classNames3 = { "tooltip": "styles-module__tooltip___mcXL2", "tooltipIcon": "styles-module__tooltipIcon___Nq2nD" };
if (typeof document !== "undefined") {
  let style = document.getElementById("feedback-tool-styles-help-tooltip-styles");
  if (!style) {
    style = document.createElement("style");
    style.id = "feedback-tool-styles-help-tooltip-styles";
    document.head.appendChild(style);
  }
  style.textContent = css3;
}
var styles_module_default2 = classNames3;

// src/components/help-tooltip/index.tsx
import { jsx as jsx4 } from "react/jsx-runtime";
var HelpTooltip = ({ content }) => {
  return /* @__PURE__ */ jsx4(Tooltip, { className: styles_module_default2.tooltip, content, children: /* @__PURE__ */ jsx4(IconHelp, { className: styles_module_default2.tooltipIcon }) });
};

// src/components/design-mode/index.tsx
import { useState as useState3, useCallback as useCallback2, useEffect as useEffect3, useRef as useRef3 } from "react";

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
import { jsx as jsx5, jsxs as jsxs4 } from "react/jsx-runtime";
function Bar({ w, h = 3, strong }) {
  return /* @__PURE__ */ jsx5(
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
  return /* @__PURE__ */ jsx5(
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
  return /* @__PURE__ */ jsx5(
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
  return /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", height: "100%", padding: `0 ${pad}px`, gap: width * 0.02 }, children: [
    /* @__PURE__ */ jsx5(Block, { w: Math.max(20, height * 0.5), h: Math.max(12, height * 0.4), radius: 2 }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, display: "flex", gap: width * 0.03, marginLeft: width * 0.04 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: width * 0.06 }),
      /* @__PURE__ */ jsx5(Bar, { w: width * 0.07 }),
      /* @__PURE__ */ jsx5(Bar, { w: width * 0.05 }),
      /* @__PURE__ */ jsx5(Bar, { w: width * 0.06 })
    ] }),
    /* @__PURE__ */ jsx5(Block, { w: width * 0.1, h: Math.min(28, height * 0.5), radius: 4 })
  ] });
}
function HeroSkeleton({ width, height, text }) {
  return /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: height * 0.05 }, children: [
    text ? /* @__PURE__ */ jsx5("span", { style: { fontSize: Math.min(20, height * 0.08), fontWeight: 600, color: "var(--agd-text-3)", textAlign: "center", maxWidth: "80%" }, children: text }) : /* @__PURE__ */ jsx5(Bar, { w: width * 0.5, h: Math.max(6, height * 0.04), strong: true }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.6 }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.4 }),
    /* @__PURE__ */ jsx5(Block, { w: Math.min(140, width * 0.2), h: Math.min(36, height * 0.12), radius: 6, style: { marginTop: height * 0.06 } })
  ] });
}
function SidebarSkeleton({ width, height }) {
  const items = Math.max(3, Math.floor(height / 36));
  return /* @__PURE__ */ jsxs4("div", { style: { padding: width * 0.08, display: "flex", flexDirection: "column", gap: height * 0.03 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.6, h: 4, strong: true }),
    Array.from({ length: items }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ jsx5(Block, { w: 10, h: 10, radius: 2 }),
      /* @__PURE__ */ jsx5(Bar, { w: width * (0.4 + i * 17 % 30 / 100) })
    ] }, i))
  ] });
}
function FooterSkeleton({ width, height }) {
  const cols = Math.max(2, Math.min(4, Math.floor(width / 160)));
  return /* @__PURE__ */ jsx5("div", { style: { display: "flex", padding: `${height * 0.12}px ${width * 0.03}px`, gap: width * 0.05 }, children: Array.from({ length: cols }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 4 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: "60%", h: 3, strong: true }),
    /* @__PURE__ */ jsx5(Bar, { w: "80%", h: 2 }),
    /* @__PURE__ */ jsx5(Bar, { w: "70%", h: 2 }),
    /* @__PURE__ */ jsx5(Bar, { w: "60%", h: 2 })
  ] }, i)) });
}
function ModalSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ jsxs4("div", { style: { padding: "10px 12px", borderBottom: "1px solid var(--agd-stroke)", display: "flex", alignItems: "center", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: width * 0.3, h: 4, strong: true }),
      /* @__PURE__ */ jsx5("div", { style: { width: 14, height: 14, border: "1px solid var(--agd-stroke)", borderRadius: 3 } })
    ] }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, padding: 12, display: "flex", flexDirection: "column", gap: 6 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: "90%" }),
      /* @__PURE__ */ jsx5(Bar, { w: "70%" }),
      /* @__PURE__ */ jsx5(Bar, { w: "80%" })
    ] }),
    /* @__PURE__ */ jsxs4("div", { style: { padding: "10px 12px", borderTop: "1px solid var(--agd-stroke)", display: "flex", justifyContent: "flex-end", gap: 8 }, children: [
      /* @__PURE__ */ jsx5(Block, { w: 70, h: 26, radius: 4 }),
      /* @__PURE__ */ jsx5(Block, { w: 70, h: 26, radius: 4, style: { background: "var(--agd-bar)" } })
    ] })
  ] });
}
function CardSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ jsx5("div", { style: { height: "40%", background: "var(--agd-fill)", borderBottom: "1px dashed var(--agd-stroke)" } }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, padding: 10, display: "flex", flexDirection: "column", gap: 5 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: "70%", h: 4, strong: true }),
      /* @__PURE__ */ jsx5(Bar, { w: "95%", h: 2 }),
      /* @__PURE__ */ jsx5(Bar, { w: "85%", h: 2 }),
      /* @__PURE__ */ jsx5(Bar, { w: "50%", h: 2 })
    ] })
  ] });
}
function TextSkeleton({ width, height, text }) {
  if (text) {
    return /* @__PURE__ */ jsx5("div", { style: { padding: 4, fontSize: Math.min(14, height * 0.3), lineHeight: 1.5, color: "var(--agd-text-3)", wordBreak: "break-word", overflow: "hidden" }, children: text });
  }
  const lines = Math.max(2, Math.floor(height / 18));
  return /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", gap: 6, padding: 4 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.6, h: 5, strong: true }),
    Array.from({ length: lines }, (_, i) => /* @__PURE__ */ jsx5(Bar, { w: `${70 + i * 13 % 25}%`, h: 2 }, i))
  ] });
}
function ImageSkeleton({ width, height }) {
  return /* @__PURE__ */ jsx5("div", { style: { height: "100%", position: "relative" }, children: /* @__PURE__ */ jsxs4("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", fill: "none", children: [
    /* @__PURE__ */ jsx5("line", { x1: "0", y1: "0", x2: width, y2: height, stroke: "var(--agd-stroke)", strokeWidth: "1" }),
    /* @__PURE__ */ jsx5("line", { x1: width, y1: "0", x2: "0", y2: height, stroke: "var(--agd-stroke)", strokeWidth: "1" }),
    /* @__PURE__ */ jsx5("circle", { cx: width * 0.3, cy: height * 0.3, r: Math.min(width, height) * 0.08, fill: "var(--agd-fill)", stroke: "var(--agd-stroke)", strokeWidth: "0.8" })
  ] }) });
}
function TableSkeleton({ width, height }) {
  const cols = Math.max(2, Math.min(5, Math.floor(width / 100)));
  const rows = Math.max(2, Math.min(6, Math.floor(height / 32)));
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ jsx5("div", { style: { display: "flex", borderBottom: "1px solid var(--agd-stroke)", padding: "6px 0" }, children: Array.from({ length: cols }, (_, i) => /* @__PURE__ */ jsx5("div", { style: { flex: 1, padding: "0 8px" }, children: /* @__PURE__ */ jsx5(Bar, { w: "70%", h: 3, strong: true }) }, i)) }),
    Array.from({ length: rows }, (_, r) => /* @__PURE__ */ jsx5("div", { style: { display: "flex", borderBottom: "1px solid rgba(255,255,255,0.03)", padding: "6px 0" }, children: Array.from({ length: cols }, (_2, c) => /* @__PURE__ */ jsx5("div", { style: { flex: 1, padding: "0 8px" }, children: /* @__PURE__ */ jsx5(Bar, { w: `${50 + (r * 7 + c * 13) % 40}%`, h: 2 }) }, c)) }, r))
  ] });
}
function ListSkeleton({ width, height }) {
  const items = Math.max(2, Math.floor(height / 28));
  return /* @__PURE__ */ jsx5("div", { style: { display: "flex", flexDirection: "column", gap: 4, padding: 4 }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }, children: [
    /* @__PURE__ */ jsx5(Circle, { size: 8 }),
    /* @__PURE__ */ jsx5(Bar, { w: `${55 + i * 17 % 35}%`, h: 2 })
  ] }, i)) });
}
function ButtonSkeleton({ width, height, text }) {
  return /* @__PURE__ */ jsx5("div", { style: {
    height: "100%",
    borderRadius: Math.min(8, height / 3),
    border: "1px solid var(--agd-stroke)",
    background: "var(--agd-fill)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  }, children: text ? /* @__PURE__ */ jsx5("span", { style: { fontSize: Math.min(13, height * 0.4), fontWeight: 500, color: "var(--agd-text-3)", letterSpacing: "-0.01em" }, children: text }) : /* @__PURE__ */ jsx5(Bar, { w: Math.max(20, width * 0.5), h: 3, strong: true }) });
}
function InputSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", gap: 4, height: "100%", justifyContent: "center" }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: Math.min(80, width * 0.3), h: 2 }),
    /* @__PURE__ */ jsx5("div", { style: {
      height: Math.min(36, height * 0.6),
      borderRadius: 4,
      border: "1px dashed var(--agd-stroke)",
      background: "var(--agd-fill)",
      display: "flex",
      alignItems: "center",
      paddingLeft: 8
    }, children: /* @__PURE__ */ jsx5(Bar, { w: "40%", h: 2 }) })
  ] });
}
function FormSkeleton({ width, height }) {
  const fields = Math.max(2, Math.min(5, Math.floor(height / 56)));
  return /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", gap: height * 0.04, padding: 8 }, children: [
    Array.from({ length: fields }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: 60 + i * 17 % 30, h: 2 }),
      /* @__PURE__ */ jsx5(Block, { w: "100%", h: 28, radius: 4 })
    ] }, i)),
    /* @__PURE__ */ jsx5(Block, { w: Math.min(120, width * 0.35), h: 30, radius: 6, style: { marginTop: 8, alignSelf: "flex-end", background: "var(--agd-bar)" } })
  ] });
}
function TabsSkeleton({ width, height }) {
  const tabCount = Math.max(2, Math.min(4, Math.floor(width / 120)));
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ jsx5("div", { style: { display: "flex", gap: 2, borderBottom: "1px solid var(--agd-stroke)" }, children: Array.from({ length: tabCount }, (_, i) => /* @__PURE__ */ jsx5("div", { style: { padding: "8px 12px", borderBottom: i === 0 ? "2px solid var(--agd-bar-strong)" : "none" }, children: /* @__PURE__ */ jsx5(Bar, { w: 60, h: 3, strong: i === 0 }) }, i)) }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, padding: 12, display: "flex", flexDirection: "column", gap: 6 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: "80%", h: 2 }),
      /* @__PURE__ */ jsx5(Bar, { w: "65%", h: 2 }),
      /* @__PURE__ */ jsx5(Bar, { w: "75%", h: 2 })
    ] })
  ] });
}
function AvatarSkeleton({ width, height }) {
  const r = Math.min(width, height) / 2;
  return /* @__PURE__ */ jsxs4("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: [
    /* @__PURE__ */ jsx5("circle", { cx: width / 2, cy: height / 2, r: r - 1, stroke: "var(--agd-stroke)", fill: "var(--agd-fill)", strokeWidth: "1.5", strokeDasharray: "3 2" }),
    /* @__PURE__ */ jsx5("circle", { cx: width / 2, cy: height * 0.38, r: r * 0.28, stroke: "var(--agd-stroke)", fill: "var(--agd-fill)", strokeWidth: "0.8" }),
    /* @__PURE__ */ jsx5(
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
  return /* @__PURE__ */ jsx5("div", { style: {
    height: "100%",
    borderRadius: height / 2,
    border: "1px solid var(--agd-stroke)",
    background: "var(--agd-fill)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  }, children: /* @__PURE__ */ jsx5(Bar, { w: Math.max(16, width * 0.5), h: 2, strong: true }) });
}
function HeaderSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: height * 0.08 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.5, h: Math.max(5, height * 0.06), strong: true }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.35 })
  ] });
}
function SectionSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", height: "100%", gap: height * 0.04, padding: width * 0.04 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.3, h: 4, strong: true }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.7 }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.5 }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, display: "flex", gap: width * 0.03, marginTop: height * 0.06 }, children: [
      /* @__PURE__ */ jsx5(Block, { w: "33%", h: "100%", radius: 4 }),
      /* @__PURE__ */ jsx5(Block, { w: "33%", h: "100%", radius: 4 }),
      /* @__PURE__ */ jsx5(Block, { w: "33%", h: "100%", radius: 4 })
    ] })
  ] });
}
function GridSkeleton({ width, height }) {
  const cols = Math.max(2, Math.min(4, Math.floor(width / 140)));
  const rows = Math.max(1, Math.min(3, Math.floor(height / 120)));
  return /* @__PURE__ */ jsx5("div", { style: { display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, gap: 6, height: "100%" }, children: Array.from({ length: cols * rows }, (_, i) => /* @__PURE__ */ jsx5(Block, { w: "100%", h: "100%", radius: 4 }, i)) });
}
function DropdownSkeleton({ width, height }) {
  const items = Math.max(2, Math.floor((height - 32) / 28));
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ jsx5("div", { style: { padding: "6px 8px", borderBottom: "1px solid var(--agd-stroke)" }, children: /* @__PURE__ */ jsx5(Bar, { w: width * 0.5, h: 3, strong: true }) }),
    /* @__PURE__ */ jsx5("div", { style: { flex: 1, padding: 4, display: "flex", flexDirection: "column", gap: 2 }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ jsx5("div", { style: { padding: "4px 6px", borderRadius: 3, background: i === 0 ? "var(--agd-fill)" : "transparent" }, children: /* @__PURE__ */ jsx5(Bar, { w: `${50 + i * 17 % 35}%`, h: 2, strong: i === 0 }) }, i)) })
  ] });
}
function ToggleSkeleton({ width, height }) {
  const r = Math.min(width, height) / 2;
  return /* @__PURE__ */ jsxs4("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: [
    /* @__PURE__ */ jsx5("rect", { x: "1", y: "1", width: width - 2, height: height - 2, rx: r, stroke: "var(--agd-stroke)", strokeWidth: "1" }),
    /* @__PURE__ */ jsx5("circle", { cx: width - r, cy: height / 2, r: r * 0.7, fill: "var(--agd-bar)" })
  ] });
}
function SearchSkeleton({ width, height }) {
  const r = Math.min(height / 2, 20);
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", borderRadius: r, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", padding: `0 ${r * 0.6}px`, gap: 6 }, children: [
    /* @__PURE__ */ jsx5(Circle, { size: Math.min(14, height * 0.4) }),
    /* @__PURE__ */ jsx5(Bar, { w: "50%", h: 2 })
  ] });
}
function ToastSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", borderRadius: 8, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", padding: "0 10px", gap: 8 }, children: [
    /* @__PURE__ */ jsx5(Circle, { size: Math.min(20, height * 0.5) }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 3 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: "60%", h: 3, strong: true }),
      /* @__PURE__ */ jsx5(Bar, { w: "80%", h: 2 })
    ] }),
    /* @__PURE__ */ jsx5("div", { style: { width: 14, height: 14, border: "1px solid var(--agd-stroke)", borderRadius: 3, flexShrink: 0 } })
  ] });
}
function ProgressSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: [
    /* @__PURE__ */ jsx5("rect", { x: "0", y: "0", width, height, rx: height / 2, stroke: "var(--agd-stroke)", strokeWidth: "0.8" }),
    /* @__PURE__ */ jsx5("rect", { x: "1", y: "1", width: width * 0.65, height: height - 2, rx: (height - 2) / 2, fill: "var(--agd-bar)" })
  ] });
}
function ChartSkeleton({ width, height }) {
  const bars = Math.max(3, Math.min(7, Math.floor(width / 50)));
  const barW = width / (bars * 2);
  return /* @__PURE__ */ jsx5("div", { style: { height: "100%", display: "flex", alignItems: "flex-end", justifyContent: "space-around", padding: "0 4px", borderBottom: "1px solid var(--agd-stroke)" }, children: Array.from({ length: bars }, (_, i) => {
    const h = 30 + (i * 37 + 17) % 55;
    return /* @__PURE__ */ jsx5(Block, { w: barW, h: `${h}%`, radius: 2 }, i);
  }) });
}
function VideoSkeleton({ width, height }) {
  const btnR = Math.min(width, height) * 0.12;
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }, children: [
    /* @__PURE__ */ jsx5(Block, { w: "100%", h: "100%", radius: 4 }),
    /* @__PURE__ */ jsx5("div", { style: { position: "absolute", width: btnR * 2, height: btnR * 2, borderRadius: "50%", border: "1.5px solid var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ jsx5("div", { style: { width: 0, height: 0, borderLeft: `${btnR * 0.6}px solid var(--agd-bar-strong)`, borderTop: `${btnR * 0.4}px solid transparent`, borderBottom: `${btnR * 0.4}px solid transparent`, marginLeft: btnR * 0.15 } }) })
  ] });
}
function TooltipSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center" }, children: [
    /* @__PURE__ */ jsx5("div", { style: { flex: 1, width: "100%", borderRadius: 6, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ jsx5(Bar, { w: "60%", h: 2 }) }),
    /* @__PURE__ */ jsx5("div", { style: { width: 8, height: 8, background: "var(--agd-fill)", border: "1px dashed var(--agd-stroke)", borderTop: "none", borderLeft: "none", transform: "rotate(45deg)", marginTop: -5 } })
  ] });
}
function BreadcrumbSkeleton({ width, height }) {
  const items = Math.max(2, Math.min(4, Math.floor(width / 80)));
  return /* @__PURE__ */ jsx5("div", { style: { display: "flex", alignItems: "center", height: "100%", gap: 4 }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", gap: 4 }, children: [
    i > 0 && /* @__PURE__ */ jsx5("span", { style: { color: "var(--agd-stroke)", fontSize: 10 }, children: "/" }),
    /* @__PURE__ */ jsx5(Bar, { w: 40 + i * 13 % 20, h: 2, strong: i === items - 1 })
  ] }, i)) });
}
function PaginationSkeleton({ width, height }) {
  const count = Math.max(3, Math.min(5, Math.floor(width / 40)));
  const sz = Math.min(28, height * 0.8);
  return /* @__PURE__ */ jsx5("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: 4 }, children: Array.from({ length: count }, (_, i) => /* @__PURE__ */ jsx5(Block, { w: sz, h: sz, radius: 4, style: i === 1 ? { background: "var(--agd-bar)" } : void 0 }, i)) });
}
function DividerSkeleton({ width }) {
  return /* @__PURE__ */ jsx5("div", { style: { display: "flex", alignItems: "center", height: "100%" }, children: /* @__PURE__ */ jsx5("div", { style: { width: "100%", height: 1, background: "var(--agd-stroke)" } }) });
}
function AccordionSkeleton({ width, height }) {
  const items = Math.max(2, Math.min(4, Math.floor(height / 40)));
  return /* @__PURE__ */ jsx5("div", { style: { display: "flex", flexDirection: "column", height: "100%" }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { borderBottom: "1px solid var(--agd-stroke)", padding: "8px 6px", display: "flex", alignItems: "center", justifyContent: "space-between", flex: i === 0 ? 2 : 1 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: `${40 + i * 17 % 25}%`, h: 3, strong: true }),
    /* @__PURE__ */ jsx5("span", { style: { fontSize: 8, color: "var(--agd-stroke)" }, children: i === 0 ? "\u25BC" : "\u25B6" })
  ] }, i)) });
}
function CarouselSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column", gap: 6 }, children: [
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, display: "flex", gap: 6, alignItems: "center" }, children: [
      /* @__PURE__ */ jsx5("span", { style: { fontSize: 12, color: "var(--agd-stroke)" }, children: "\u2039" }),
      /* @__PURE__ */ jsx5(Block, { w: "100%", h: "100%", radius: 4 }),
      /* @__PURE__ */ jsx5("span", { style: { fontSize: 12, color: "var(--agd-stroke)" }, children: "\u203A" })
    ] }),
    /* @__PURE__ */ jsxs4("div", { style: { display: "flex", justifyContent: "center", gap: 4 }, children: [
      /* @__PURE__ */ jsx5(Circle, { size: 5 }),
      /* @__PURE__ */ jsx5(Circle, { size: 5 }),
      /* @__PURE__ */ jsx5(Circle, { size: 5 })
    ] })
  ] });
}
function PricingSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", padding: 10, gap: height * 0.04 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.4, h: 3, strong: true }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.3, h: 6, strong: true }),
    /* @__PURE__ */ jsx5("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 4, width: "100%", padding: "8px 0" }, children: Array.from({ length: 4 }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", gap: 4 }, children: [
      /* @__PURE__ */ jsx5(Circle, { size: 5 }),
      /* @__PURE__ */ jsx5(Bar, { w: `${50 + i * 17 % 35}%`, h: 2 })
    ] }, i)) }),
    /* @__PURE__ */ jsx5(Block, { w: width * 0.7, h: Math.min(32, height * 0.1), radius: 6, style: { background: "var(--agd-bar)" } })
  ] });
}
function TestimonialSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column", padding: 10, gap: 8 }, children: [
    /* @__PURE__ */ jsx5("span", { style: { fontSize: 18, lineHeight: 1, color: "var(--agd-stroke)", fontFamily: "serif" }, children: "\u201C" }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 4 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: "90%", h: 2 }),
      /* @__PURE__ */ jsx5(Bar, { w: "75%", h: 2 }),
      /* @__PURE__ */ jsx5(Bar, { w: "60%", h: 2 })
    ] }),
    /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ jsx5(Circle, { size: 20 }),
      /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", gap: 2 }, children: [
        /* @__PURE__ */ jsx5(Bar, { w: 60, h: 3, strong: true }),
        /* @__PURE__ */ jsx5(Bar, { w: 40, h: 2 })
      ] })
    ] })
  ] });
}
function CtaSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: height * 0.08 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.5, h: Math.max(4, height * 0.05), strong: true }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.35 }),
    /* @__PURE__ */ jsx5(Block, { w: Math.min(140, width * 0.25), h: Math.min(32, height * 0.15), radius: 6, style: { marginTop: height * 0.04, background: "var(--agd-bar)" } })
  ] });
}
function AlertSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", borderRadius: 6, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", padding: "0 10px", gap: 8 }, children: [
    /* @__PURE__ */ jsx5("div", { style: { width: 16, height: 16, borderRadius: "50%", border: "1.5px solid var(--agd-bar-strong)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }, children: /* @__PURE__ */ jsx5("div", { style: { width: 2, height: 6, background: "var(--agd-bar-strong)", borderRadius: 1 } }) }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 3 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: "40%", h: 3, strong: true }),
      /* @__PURE__ */ jsx5(Bar, { w: "70%", h: 2 })
    ] })
  ] });
}
function BannerSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", background: "var(--agd-fill)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "0 12px" }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.4, h: 3, strong: true }),
    /* @__PURE__ */ jsx5(Block, { w: 60, h: Math.min(24, height * 0.6), radius: 4 })
  ] });
}
function StatSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: height * 0.06 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.5, h: 2 }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.4, h: Math.max(8, height * 0.18), strong: true }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.3, h: 2 })
  ] });
}
function StepperSkeleton({ width, height }) {
  const steps = Math.max(3, Math.min(5, Math.floor(width / 100)));
  const dotR = Math.min(12, height * 0.35);
  return /* @__PURE__ */ jsx5("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", height: "100%", padding: "0 8px" }, children: Array.from({ length: steps }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", gap: 0, flex: 1 }, children: [
    /* @__PURE__ */ jsx5("div", { style: { width: dotR, height: dotR, borderRadius: "50%", border: "1.5px solid var(--agd-stroke)", background: i === 0 ? "var(--agd-bar)" : "transparent", flexShrink: 0 } }),
    i < steps - 1 && /* @__PURE__ */ jsx5("div", { style: { flex: 1, height: 1, background: "var(--agd-stroke)", margin: "0 4px" } })
  ] }, i)) });
}
function TagSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", borderRadius: 4, border: "1px solid var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, padding: "0 6px" }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: Math.max(16, width * 0.5), h: 2, strong: true }),
    /* @__PURE__ */ jsx5("div", { style: { width: 8, height: 8, borderRadius: "50%", border: "1px solid var(--agd-stroke)", flexShrink: 0 } })
  ] });
}
function RatingSkeleton({ width, height }) {
  const stars = 5;
  const sz = Math.min(height * 0.7, width / (stars * 1.5));
  return /* @__PURE__ */ jsx5("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: sz * 0.2 }, children: Array.from({ length: stars }, (_, i) => /* @__PURE__ */ jsx5("svg", { width: sz, height: sz, viewBox: "0 0 16 16", fill: "none", children: /* @__PURE__ */ jsx5("path", { d: "M8 1.5l2 4 4.5.7-3.25 3.1.75 4.5L8 11.4l-4 2.4.75-4.5L1.5 6.2 6 5.5z", stroke: "var(--agd-stroke)", strokeWidth: "0.8", fill: i < 3 ? "var(--agd-bar)" : "none" }) }, i)) });
}
function MapSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", position: "relative", borderRadius: 4, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", overflow: "hidden" }, children: [
    /* @__PURE__ */ jsxs4("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", style: { position: "absolute", inset: 0 }, children: [
      /* @__PURE__ */ jsx5("line", { x1: 0, y1: height * 0.3, x2: width, y2: height * 0.7, stroke: "var(--agd-stroke)", strokeWidth: "0.5", opacity: ".2" }),
      /* @__PURE__ */ jsx5("line", { x1: 0, y1: height * 0.6, x2: width, y2: height * 0.2, stroke: "var(--agd-stroke)", strokeWidth: "0.5", opacity: ".15" }),
      /* @__PURE__ */ jsx5("line", { x1: width * 0.4, y1: 0, x2: width * 0.6, y2: height, stroke: "var(--agd-stroke)", strokeWidth: "0.5", opacity: ".15" })
    ] }),
    /* @__PURE__ */ jsx5("div", { style: { position: "absolute", left: "50%", top: "40%", transform: "translate(-50%, -100%)" }, children: /* @__PURE__ */ jsxs4("svg", { width: "16", height: "22", viewBox: "0 0 16 22", fill: "none", children: [
      /* @__PURE__ */ jsx5("path", { d: "M8 0C3.6 0 0 3.6 0 8c0 6 8 14 8 14s8-8 8-14c0-4.4-3.6-8-8-8z", fill: "var(--agd-bar)", opacity: ".4" }),
      /* @__PURE__ */ jsx5("circle", { cx: "8", cy: "8", r: "3", fill: "var(--agd-fill)" })
    ] }) })
  ] });
}
function TimelineSkeleton({ width, height }) {
  const items = Math.max(3, Math.min(5, Math.floor(height / 60)));
  return /* @__PURE__ */ jsxs4("div", { style: { display: "flex", height: "100%", padding: "8px 0" }, children: [
    /* @__PURE__ */ jsx5("div", { style: { width: 16, display: "flex", flexDirection: "column", alignItems: "center" }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }, children: [
      /* @__PURE__ */ jsx5(Circle, { size: 8 }),
      i < items - 1 && /* @__PURE__ */ jsx5("div", { style: { flex: 1, width: 1, background: "var(--agd-stroke)" } })
    ] }, i)) }),
    /* @__PURE__ */ jsx5("div", { style: { flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-around", paddingLeft: 8 }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", gap: 3 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: `${35 + i * 13 % 25}%`, h: 3, strong: true }),
      /* @__PURE__ */ jsx5(Bar, { w: `${50 + i * 17 % 30}%`, h: 2 })
    ] }, i)) })
  ] });
}
function FileUploadSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", borderRadius: 8, border: "2px dashed var(--agd-stroke)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: height * 0.06 }, children: [
    /* @__PURE__ */ jsxs4("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "none", children: [
      /* @__PURE__ */ jsx5("path", { d: "M12 16V4m0 0l-4 4m4-4l4 4", stroke: "var(--agd-stroke)", strokeWidth: "1.5" }),
      /* @__PURE__ */ jsx5("path", { d: "M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2", stroke: "var(--agd-stroke)", strokeWidth: "1.5" })
    ] }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.4, h: 2 }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.25, h: 2 })
  ] });
}
function CodeBlockSkeleton({ width, height }) {
  const lines = Math.max(3, Math.min(8, Math.floor(height / 20)));
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", borderRadius: 6, background: "var(--agd-fill)", border: "1px solid var(--agd-stroke)", padding: 8, display: "flex", flexDirection: "column", gap: 4 }, children: [
    /* @__PURE__ */ jsxs4("div", { style: { display: "flex", gap: 3, marginBottom: 4 }, children: [
      /* @__PURE__ */ jsx5(Circle, { size: 6 }),
      /* @__PURE__ */ jsx5(Circle, { size: 6 }),
      /* @__PURE__ */ jsx5(Circle, { size: 6 })
    ] }),
    Array.from({ length: lines }, (_, i) => /* @__PURE__ */ jsx5("div", { style: { display: "flex", gap: 6, paddingLeft: i > 0 && i < lines - 1 ? 12 : 0 }, children: /* @__PURE__ */ jsx5(Bar, { w: `${25 + i * 23 % 50}%`, h: 2, strong: i === 0 }) }, i))
  ] });
}
function CalendarSkeleton({ width, height }) {
  const cols = 7;
  const rows = 5;
  const cellSz = Math.min((width - 16) / cols, (height - 40) / (rows + 1));
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px" }, children: [
      /* @__PURE__ */ jsx5("span", { style: { fontSize: 8, color: "var(--agd-stroke)" }, children: "\u2039" }),
      /* @__PURE__ */ jsx5(Bar, { w: width * 0.3, h: 3, strong: true }),
      /* @__PURE__ */ jsx5("span", { style: { fontSize: 8, color: "var(--agd-stroke)" }, children: "\u203A" })
    ] }),
    /* @__PURE__ */ jsxs4("div", { style: { display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 2, padding: "0 4px", flex: 1 }, children: [
      Array.from({ length: cols }, (_, i) => /* @__PURE__ */ jsx5("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: cellSz * 0.6 }, children: /* @__PURE__ */ jsx5(Bar, { w: cellSz * 0.5, h: 2 }) }, `h${i}`)),
      Array.from({ length: cols * rows }, (_, i) => /* @__PURE__ */ jsx5("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: cellSz }, children: /* @__PURE__ */ jsx5("div", { style: { width: cellSz * 0.6, height: cellSz * 0.6, borderRadius: "50%", background: i === 12 ? "var(--agd-bar)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ jsx5("div", { style: { width: 2, height: 2, borderRadius: 1, background: "var(--agd-bar-strong)", opacity: i === 12 ? 1 : 0.3 } }) }) }, i))
    ] })
  ] });
}
function NotificationSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", borderRadius: 8, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", padding: "0 10px", gap: 8 }, children: [
    /* @__PURE__ */ jsx5(Circle, { size: Math.min(32, height * 0.55) }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 3 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: "50%", h: 3, strong: true }),
      /* @__PURE__ */ jsx5(Bar, { w: "75%", h: 2 })
    ] }),
    /* @__PURE__ */ jsx5(Bar, { w: 30, h: 2 })
  ] });
}
function ProductCardSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column" }, children: [
    /* @__PURE__ */ jsx5("div", { style: { height: "50%", background: "var(--agd-fill)", borderBottom: "1px dashed var(--agd-stroke)" } }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, padding: 10, display: "flex", flexDirection: "column", gap: 5 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: "65%", h: 4, strong: true }),
      /* @__PURE__ */ jsx5(Bar, { w: "40%", h: 3 }),
      /* @__PURE__ */ jsx5("div", { style: { flex: 1 } }),
      /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" }, children: [
        /* @__PURE__ */ jsx5(Bar, { w: "30%", h: 5, strong: true }),
        /* @__PURE__ */ jsx5(Block, { w: Math.min(70, width * 0.3), h: 26, radius: 4, style: { background: "var(--agd-bar)" } })
      ] })
    ] })
  ] });
}
function ProfileSkeleton({ width, height }) {
  const avatarSz = Math.min(48, height * 0.3);
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: height * 0.06 }, children: [
    /* @__PURE__ */ jsx5(Circle, { size: avatarSz }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.45, h: 4, strong: true }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.3, h: 2 }),
    /* @__PURE__ */ jsxs4("div", { style: { display: "flex", gap: width * 0.08, marginTop: height * 0.04 }, children: [
      /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }, children: [
        /* @__PURE__ */ jsx5(Bar, { w: 20, h: 3, strong: true }),
        /* @__PURE__ */ jsx5(Bar, { w: 28, h: 2 })
      ] }),
      /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }, children: [
        /* @__PURE__ */ jsx5(Bar, { w: 20, h: 3, strong: true }),
        /* @__PURE__ */ jsx5(Bar, { w: 28, h: 2 })
      ] }),
      /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }, children: [
        /* @__PURE__ */ jsx5(Bar, { w: 20, h: 3, strong: true }),
        /* @__PURE__ */ jsx5(Bar, { w: 28, h: 2 })
      ] })
    ] })
  ] });
}
function DrawerSkeleton({ width, height }) {
  const panelW = Math.max(width * 0.6, 80);
  const items = Math.max(3, Math.floor(height / 40));
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex" }, children: [
    /* @__PURE__ */ jsx5("div", { style: { width: width - panelW, background: "var(--agd-fill)", opacity: 0.3 } }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, borderLeft: "1px solid var(--agd-stroke)", display: "flex", flexDirection: "column", padding: width * 0.04 }, children: [
      /* @__PURE__ */ jsxs4("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: height * 0.06 }, children: [
        /* @__PURE__ */ jsx5(Bar, { w: panelW * 0.4, h: 4, strong: true }),
        /* @__PURE__ */ jsx5("div", { style: { width: 12, height: 12, border: "1px solid var(--agd-stroke)", borderRadius: 3 } })
      ] }),
      Array.from({ length: items }, (_, i) => /* @__PURE__ */ jsx5("div", { style: { padding: "6px 0" }, children: /* @__PURE__ */ jsx5(Bar, { w: `${50 + i * 17 % 35}%`, h: 2, strong: i === 0 }) }, i))
    ] })
  ] });
}
function PopoverSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center" }, children: [
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, width: "100%", borderRadius: 8, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", padding: 10, display: "flex", flexDirection: "column", gap: 5 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: "70%", h: 3, strong: true }),
      /* @__PURE__ */ jsx5(Bar, { w: "90%", h: 2 }),
      /* @__PURE__ */ jsx5(Bar, { w: "60%", h: 2 })
    ] }),
    /* @__PURE__ */ jsx5("div", { style: { width: 10, height: 10, background: "var(--agd-fill)", border: "1px dashed var(--agd-stroke)", borderTop: "none", borderLeft: "none", transform: "rotate(45deg)", marginTop: -6 } })
  ] });
}
function LogoSkeleton({ width, height }) {
  const iconSz = Math.min(height * 0.7, width * 0.3);
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", alignItems: "center", gap: width * 0.08 }, children: [
    /* @__PURE__ */ jsx5(Block, { w: iconSz, h: iconSz, radius: iconSz * 0.25 }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.45, h: Math.max(4, height * 0.2), strong: true })
  ] });
}
function FaqSkeleton({ width, height }) {
  const items = Math.max(2, Math.min(5, Math.floor(height / 56)));
  return /* @__PURE__ */ jsx5("div", { style: { display: "flex", flexDirection: "column", height: "100%" }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { borderBottom: "1px solid var(--agd-stroke)", padding: "8px 6px", display: "flex", alignItems: "center", justifyContent: "space-between", flex: i === 0 ? 2 : 1 }, children: [
    /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ jsx5("span", { style: { fontSize: 9, fontWeight: 700, color: "var(--agd-stroke)" }, children: "Q" }),
      /* @__PURE__ */ jsx5(Bar, { w: width * (0.3 + i * 13 % 25 / 100), h: 3, strong: true })
    ] }),
    /* @__PURE__ */ jsx5("span", { style: { fontSize: 8, color: "var(--agd-stroke)" }, children: i === 0 ? "\u25BC" : "\u25B6" })
  ] }, i)) });
}
function GallerySkeleton({ width, height }) {
  const cols = Math.max(2, Math.min(4, Math.floor(width / 120)));
  const rows = Math.max(1, Math.min(3, Math.floor(height / 120)));
  return /* @__PURE__ */ jsx5("div", { style: { display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, gap: 4, height: "100%" }, children: Array.from({ length: cols * rows }, (_, i) => /* @__PURE__ */ jsx5("div", { style: { borderRadius: 4, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", position: "relative", overflow: "hidden" }, children: /* @__PURE__ */ jsxs4("svg", { width: "100%", height: "100%", viewBox: "0 0 100 100", preserveAspectRatio: "none", fill: "none", children: [
    /* @__PURE__ */ jsx5("line", { x1: "0", y1: "0", x2: "100", y2: "100", stroke: "var(--agd-stroke)", strokeWidth: "0.5" }),
    /* @__PURE__ */ jsx5("line", { x1: "100", y1: "0", x2: "0", y2: "100", stroke: "var(--agd-stroke)", strokeWidth: "0.5" })
  ] }) }, i)) });
}
function CheckboxSkeleton({ width, height }) {
  const sz = Math.min(width, height);
  return /* @__PURE__ */ jsxs4("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: [
    /* @__PURE__ */ jsx5("rect", { x: "1", y: (height - sz + 2) / 2, width: sz - 2, height: sz - 2, rx: sz * 0.15, stroke: "var(--agd-stroke)", strokeWidth: "1.5" }),
    /* @__PURE__ */ jsx5("path", { d: `M${sz * 0.25} ${height / 2}l${sz * 0.2} ${sz * 0.2} ${sz * 0.3}-${sz * 0.35}`, stroke: "var(--agd-bar)", strokeWidth: "1.5", fill: "none", strokeLinecap: "round", strokeLinejoin: "round" })
  ] });
}
function RadioSkeleton({ width, height }) {
  const r = Math.min(width, height) / 2 - 1;
  return /* @__PURE__ */ jsxs4("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: [
    /* @__PURE__ */ jsx5("circle", { cx: width / 2, cy: height / 2, r, stroke: "var(--agd-stroke)", strokeWidth: "1.5" }),
    /* @__PURE__ */ jsx5("circle", { cx: width / 2, cy: height / 2, r: r * 0.45, fill: "var(--agd-bar)" })
  ] });
}
function SliderSkeleton({ width, height }) {
  const trackH = Math.max(2, height * 0.12);
  const thumbR = Math.min(height * 0.35, 10);
  const fillW = width * 0.55;
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", alignItems: "center", position: "relative" }, children: [
    /* @__PURE__ */ jsx5("div", { style: { width: "100%", height: trackH, borderRadius: trackH / 2, background: "var(--agd-fill)", border: "1px solid var(--agd-stroke)", position: "relative" }, children: /* @__PURE__ */ jsx5("div", { style: { width: fillW, height: "100%", borderRadius: trackH / 2, background: "var(--agd-bar)" } }) }),
    /* @__PURE__ */ jsx5("div", { style: { position: "absolute", left: fillW - thumbR, width: thumbR * 2, height: thumbR * 2, borderRadius: "50%", border: "1.5px solid var(--agd-stroke)", background: "var(--agd-fill)" } })
  ] });
}
function DatePickerSkeleton({ width, height }) {
  const inputH = Math.min(36, height * 0.15);
  const cols = 7;
  const rows = 4;
  const cellSz = Math.min((width - 16) / cols, (height - inputH - 40) / (rows + 1));
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column", gap: 4 }, children: [
    /* @__PURE__ */ jsxs4("div", { style: { height: inputH, borderRadius: 4, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", padding: "0 8px", justifyContent: "space-between" }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: "40%", h: 2 }),
      /* @__PURE__ */ jsxs4("svg", { width: "12", height: "12", viewBox: "0 0 16 16", fill: "none", children: [
        /* @__PURE__ */ jsx5("rect", { x: "2", y: "3", width: "12", height: "11", rx: "1", stroke: "var(--agd-stroke)", strokeWidth: "1" }),
        /* @__PURE__ */ jsx5("line", { x1: "2", y1: "6", x2: "14", y2: "6", stroke: "var(--agd-stroke)", strokeWidth: "0.5" })
      ] })
    ] }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, borderRadius: 6, border: "1px dashed var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", flexDirection: "column" }, children: [
      /* @__PURE__ */ jsxs4("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 6px" }, children: [
        /* @__PURE__ */ jsx5("span", { style: { fontSize: 7, color: "var(--agd-stroke)" }, children: "\u2039" }),
        /* @__PURE__ */ jsx5(Bar, { w: width * 0.25, h: 2, strong: true }),
        /* @__PURE__ */ jsx5("span", { style: { fontSize: 7, color: "var(--agd-stroke)" }, children: "\u203A" })
      ] }),
      /* @__PURE__ */ jsx5("div", { style: { display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 1, padding: "0 4px", flex: 1 }, children: Array.from({ length: cols * rows }, (_, i) => /* @__PURE__ */ jsx5("div", { style: { display: "flex", alignItems: "center", justifyContent: "center", height: cellSz }, children: /* @__PURE__ */ jsx5("div", { style: { width: cellSz * 0.5, height: cellSz * 0.5, borderRadius: "50%", background: i === 10 ? "var(--agd-bar)" : "transparent" }, children: /* @__PURE__ */ jsx5("div", { style: { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ jsx5("div", { style: { width: 1.5, height: 1.5, borderRadius: 1, background: "var(--agd-bar-strong)", opacity: i === 10 ? 1 : 0.25 } }) }) }) }, i)) })
    ] })
  ] });
}
function SkeletonSkeletonRenderer({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column", gap: height * 0.08, padding: 4 }, children: [
    /* @__PURE__ */ jsx5("div", { style: { width: "100%", height: height * 0.2, borderRadius: 4, background: "var(--agd-fill)" } }),
    /* @__PURE__ */ jsx5("div", { style: { width: "70%", height: Math.max(6, height * 0.1), borderRadius: 3, background: "var(--agd-fill)" } }),
    /* @__PURE__ */ jsx5("div", { style: { width: "90%", height: Math.max(4, height * 0.06), borderRadius: 3, background: "var(--agd-fill)" } }),
    /* @__PURE__ */ jsx5("div", { style: { width: "50%", height: Math.max(4, height * 0.06), borderRadius: 3, background: "var(--agd-fill)" } })
  ] });
}
function ChipSkeleton({ width, height }) {
  return /* @__PURE__ */ jsx5("div", { style: { height: "100%", display: "flex", alignItems: "center", gap: 6 }, children: /* @__PURE__ */ jsxs4("div", { style: { height: "100%", flex: 1, borderRadius: height / 2, border: "1px solid var(--agd-stroke)", background: "var(--agd-fill)", display: "flex", alignItems: "center", padding: `0 ${height * 0.3}px`, gap: 4 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: "60%", h: 2, strong: true }),
    /* @__PURE__ */ jsx5("div", { style: { width: Math.max(6, height * 0.3), height: Math.max(6, height * 0.3), borderRadius: "50%", border: "1px solid var(--agd-stroke)", flexShrink: 0, marginLeft: "auto" } })
  ] }) });
}
function IconSkeleton({ width, height }) {
  const sz = Math.min(width, height);
  return /* @__PURE__ */ jsx5("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: /* @__PURE__ */ jsx5(
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
  return /* @__PURE__ */ jsxs4("svg", { width: "100%", height: "100%", viewBox: `0 0 ${width} ${height}`, fill: "none", children: [
    /* @__PURE__ */ jsx5("circle", { cx: width / 2, cy: height / 2, r, stroke: "var(--agd-stroke)", strokeWidth: "1.5", opacity: ".2" }),
    /* @__PURE__ */ jsx5("path", { d: `M${width / 2} ${height / 2 - r}a${r} ${r} 0 0 1 ${r} ${r}`, stroke: "var(--agd-bar-strong)", strokeWidth: "1.5", strokeLinecap: "round" })
  ] });
}
function FeatureSkeleton({ width, height }) {
  const iconSz = Math.min(36, height * 0.25, width * 0.12);
  const items = Math.max(1, Math.min(3, Math.floor(height / 80)));
  return /* @__PURE__ */ jsx5("div", { style: { display: "flex", flexDirection: "column", height: "100%", justifyContent: "space-around", padding: 8 }, children: Array.from({ length: items }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { display: "flex", gap: width * 0.04, alignItems: "flex-start" }, children: [
    /* @__PURE__ */ jsx5(Block, { w: iconSz, h: iconSz, radius: iconSz * 0.25 }),
    /* @__PURE__ */ jsxs4("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 4 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: `${40 + i * 13 % 20}%`, h: 3, strong: true }),
      /* @__PURE__ */ jsx5(Bar, { w: `${60 + i * 17 % 25}%`, h: 2 })
    ] })
  ] }, i)) });
}
function TeamSkeleton({ width, height }) {
  const cols = Math.max(2, Math.min(4, Math.floor(width / 120)));
  const avatarSz = Math.min(36, height * 0.25);
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: height * 0.06, padding: height * 0.06 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.3, h: 4, strong: true }),
    /* @__PURE__ */ jsx5("div", { style: { display: "flex", gap: width * 0.06, justifyContent: "center", flex: 1, alignItems: "center" }, children: Array.from({ length: cols }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }, children: [
      /* @__PURE__ */ jsx5(Circle, { size: avatarSz }),
      /* @__PURE__ */ jsx5(Bar, { w: width * 0.12, h: 3, strong: true }),
      /* @__PURE__ */ jsx5(Bar, { w: width * 0.08, h: 2 })
    ] }, i)) })
  ] });
}
function LoginSkeleton({ width, height }) {
  const fields = Math.max(2, Math.min(3, Math.floor(height / 80)));
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", padding: width * 0.06, gap: height * 0.04 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.5, h: Math.max(5, height * 0.04), strong: true }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.35, h: 2 }),
    /* @__PURE__ */ jsx5("div", { style: { width: "100%", display: "flex", flexDirection: "column", gap: height * 0.03, marginTop: height * 0.04 }, children: Array.from({ length: fields }, (_, i) => /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", gap: 3 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: Math.min(60, width * 0.2), h: 2 }),
      /* @__PURE__ */ jsx5(Block, { w: "100%", h: Math.min(32, height * 0.1), radius: 4 })
    ] }, i)) }),
    /* @__PURE__ */ jsx5(Block, { w: "100%", h: Math.min(36, height * 0.12), radius: 6, style: { marginTop: height * 0.03, background: "var(--agd-bar)" } }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.4, h: 2 })
  ] });
}
function ContactSkeleton({ width, height }) {
  return /* @__PURE__ */ jsxs4("div", { style: { height: "100%", display: "flex", flexDirection: "column", padding: width * 0.04, gap: height * 0.03 }, children: [
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.4, h: 4, strong: true }),
    /* @__PURE__ */ jsx5(Bar, { w: width * 0.6, h: 2 }),
    /* @__PURE__ */ jsxs4("div", { style: { display: "flex", gap: 6, marginTop: height * 0.03 }, children: [
      /* @__PURE__ */ jsxs4("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 3 }, children: [
        /* @__PURE__ */ jsx5(Bar, { w: 50, h: 2 }),
        /* @__PURE__ */ jsx5(Block, { w: "100%", h: Math.min(28, height * 0.1), radius: 4 })
      ] }),
      /* @__PURE__ */ jsxs4("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 3 }, children: [
        /* @__PURE__ */ jsx5(Bar, { w: 40, h: 2 }),
        /* @__PURE__ */ jsx5(Block, { w: "100%", h: Math.min(28, height * 0.1), radius: 4 })
      ] })
    ] }),
    /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", gap: 3 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: 50, h: 2 }),
      /* @__PURE__ */ jsx5(Block, { w: "100%", h: Math.min(28, height * 0.1), radius: 4 })
    ] }),
    /* @__PURE__ */ jsxs4("div", { style: { display: "flex", flexDirection: "column", gap: 3, flex: 1 }, children: [
      /* @__PURE__ */ jsx5(Bar, { w: 60, h: 2 }),
      /* @__PURE__ */ jsx5(Block, { w: "100%", h: "100%", radius: 4 })
    ] }),
    /* @__PURE__ */ jsx5(Block, { w: Math.min(120, width * 0.3), h: Math.min(30, height * 0.1), radius: 6, style: { alignSelf: "flex-end", background: "var(--agd-bar)" } })
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
    return /* @__PURE__ */ jsx5("div", { style: { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }, children: /* @__PURE__ */ jsx5("span", { style: { fontSize: 10, fontWeight: 600, color: "var(--agd-text-3)", textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.5 }, children: type }) });
  }
  return /* @__PURE__ */ jsx5("div", { style: { width: "100%", height: "100%", padding: 8, position: "relative", pointerEvents: "none" }, children: /* @__PURE__ */ jsx5(Renderer, { width, height, text }) });
}

// src/components/design-mode/styles.module.scss
var css4 = 'svg[fill=none] {\n  fill: none !important;\n}\n\n.styles-module__overlayExiting___iEmYr {\n  opacity: 0 !important;\n  transition: opacity 0.25s ease !important;\n  pointer-events: none !important;\n}\n\n.styles-module__overlay___aWh-q {\n  position: fixed;\n  inset: 0;\n  z-index: 99995;\n  pointer-events: auto;\n  cursor: default;\n  animation: styles-module__overlayFadeIn___aECVy 0.15s ease;\n  --agd-stroke: rgba(59, 130, 246, 0.35);\n  --agd-fill: rgba(59, 130, 246, 0.06);\n  --agd-bar: rgba(59, 130, 246, 0.18);\n  --agd-bar-strong: rgba(59, 130, 246, 0.28);\n  --agd-text-3: rgba(255, 255, 255, 0.6);\n  --agd-surface: #fff;\n}\n.styles-module__overlay___aWh-q.styles-module__light___ORIft {\n  --agd-surface: #fff;\n}\n.styles-module__overlay___aWh-q:not(.styles-module__light___ORIft) {\n  --agd-surface: #141414;\n}\n.styles-module__overlay___aWh-q.styles-module__wireframe___itvQU {\n  --agd-stroke: rgba(249, 115, 22, 0.35);\n  --agd-fill: rgba(249, 115, 22, 0.06);\n  --agd-bar: rgba(249, 115, 22, 0.18);\n  --agd-bar-strong: rgba(249, 115, 22, 0.28);\n}\n.styles-module__overlay___aWh-q.styles-module__placing___45yD8 {\n  cursor: crosshair;\n}\n.styles-module__overlay___aWh-q.styles-module__passthrough___xaFeE {\n  pointer-events: none;\n}\n\n.styles-module__blankCanvas___t2Eue {\n  position: fixed;\n  inset: 0;\n  z-index: 99994;\n  background: #fff;\n  opacity: 0;\n  pointer-events: none;\n  transition: opacity 0.25s ease;\n}\n.styles-module__blankCanvas___t2Eue.styles-module__visible___OKKqX {\n  opacity: var(--canvas-opacity, 1);\n  pointer-events: auto;\n}\n.styles-module__blankCanvas___t2Eue::after {\n  content: "";\n  position: absolute;\n  inset: 0;\n  background-image: radial-gradient(circle, rgba(0, 0, 0, 0.08) 1px, transparent 1px);\n  background-size: 24px 24px;\n  background-position: 12px 12px;\n  pointer-events: none;\n  transition: opacity 0.2s ease;\n}\n.styles-module__blankCanvas___t2Eue.styles-module__gridActive___OZ-cf::after {\n  opacity: 1;\n  background-image: radial-gradient(circle, rgba(0, 0, 0, 0.22) 1px, transparent 1px);\n}\n\n.styles-module__paletteHeader___-Q5gQ {\n  padding: 0 1rem 0.375rem;\n}\n\n.styles-module__paletteHeaderTitle___oHqZC {\n  font-size: 0.8125rem;\n  font-weight: 500;\n  color: #fff;\n  letter-spacing: -0.0094em;\n}\n.styles-module__light___ORIft .styles-module__paletteHeaderTitle___oHqZC {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n.styles-module__paletteHeaderDesc___6i74T {\n  font-size: 0.6875rem;\n  font-weight: 300;\n  color: rgba(255, 255, 255, 0.45);\n  margin-top: 2px;\n  line-height: 14px;\n}\n.styles-module__light___ORIft .styles-module__paletteHeaderDesc___6i74T {\n  color: rgba(0, 0, 0, 0.45);\n}\n.styles-module__paletteHeaderDesc___6i74T a {\n  color: rgba(255, 255, 255, 0.8);\n  text-decoration: underline dotted;\n  text-decoration-color: rgba(255, 255, 255, 0.2);\n  text-underline-offset: 2px;\n  transition: color 0.15s ease;\n}\n.styles-module__paletteHeaderDesc___6i74T a:hover {\n  color: #fff;\n}\n.styles-module__light___ORIft .styles-module__paletteHeaderDesc___6i74T a {\n  color: rgba(0, 0, 0, 0.6);\n  text-decoration-color: rgba(0, 0, 0, 0.2);\n}\n.styles-module__light___ORIft .styles-module__paletteHeaderDesc___6i74T a:hover {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n.styles-module__wireframePurposeWrap___To-tS {\n  display: grid;\n  grid-template-rows: 1fr;\n  transition: grid-template-rows 0.2s ease, opacity 0.15s ease;\n  opacity: 1;\n}\n.styles-module__wireframePurposeWrap___To-tS.styles-module__collapsed___Ms9vS {\n  grid-template-rows: 0fr;\n  opacity: 0;\n}\n\n.styles-module__wireframePurposeInner___Lrahs {\n  overflow: hidden;\n}\n\n.styles-module__wireframePurposeInput___7EtBN {\n  display: block;\n  width: calc(100% - 2rem);\n  margin: 0.25rem 1rem 0.375rem;\n  padding: 0.375rem 0.5rem;\n  font-size: 0.8125rem;\n  font-family: inherit;\n  color: rgba(255, 255, 255, 0.85);\n  background: rgba(255, 255, 255, 0.03);\n  border: 1px solid rgba(255, 255, 255, 0.1);\n  border-radius: 0.375rem;\n  resize: none;\n  outline: none;\n  transition: border-color 0.15s ease;\n  letter-spacing: -0.0094em;\n}\n.styles-module__wireframePurposeInput___7EtBN::placeholder {\n  color: rgba(255, 255, 255, 0.3);\n}\n.styles-module__wireframePurposeInput___7EtBN:focus {\n  border-color: rgba(255, 255, 255, 0.3);\n  background: rgba(255, 255, 255, 0.05);\n}\n.styles-module__light___ORIft .styles-module__wireframePurposeInput___7EtBN {\n  color: rgba(0, 0, 0, 0.7);\n  background: rgba(0, 0, 0, 0.03);\n  border-color: rgba(0, 0, 0, 0.1);\n}\n.styles-module__light___ORIft .styles-module__wireframePurposeInput___7EtBN::placeholder {\n  color: rgba(0, 0, 0, 0.3);\n}\n.styles-module__light___ORIft .styles-module__wireframePurposeInput___7EtBN:focus {\n  border-color: rgba(0, 0, 0, 0.25);\n  background: rgba(0, 0, 0, 0.05);\n}\n\n.styles-module__canvasToggle___-QqSy {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 0.375rem;\n  margin: 0.25rem 1rem 0.25rem;\n  padding: 0.375rem 0.5rem;\n  border-radius: 0.5rem;\n  cursor: pointer;\n  border: 1px dashed rgba(255, 255, 255, 0.1);\n  background: transparent;\n  transition: background 0.15s ease, border-color 0.15s ease;\n}\n.styles-module__canvasToggle___-QqSy:hover {\n  background: rgba(255, 255, 255, 0.04);\n  border-color: rgba(255, 255, 255, 0.15);\n}\n.styles-module__canvasToggle___-QqSy.styles-module__active___hosp7 {\n  background: #f97316;\n  border-color: transparent;\n  border-style: solid;\n  box-shadow: none;\n}\n.styles-module__light___ORIft .styles-module__canvasToggle___-QqSy {\n  border-color: rgba(0, 0, 0, 0.08);\n}\n.styles-module__light___ORIft .styles-module__canvasToggle___-QqSy:hover {\n  background: rgba(0, 0, 0, 0.02);\n  border-color: rgba(0, 0, 0, 0.12);\n}\n.styles-module__light___ORIft .styles-module__canvasToggle___-QqSy.styles-module__active___hosp7 {\n  background: #f97316;\n  border-color: transparent;\n  border-style: solid;\n  box-shadow: none;\n}\n\n.styles-module__canvasToggleIcon___7pJ82 {\n  width: 14px;\n  height: 14px;\n  flex-shrink: 0;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  color: rgba(255, 255, 255, 0.35);\n}\n.styles-module__active___hosp7 .styles-module__canvasToggleIcon___7pJ82 {\n  color: rgba(255, 255, 255, 0.85);\n}\n.styles-module__light___ORIft .styles-module__canvasToggleIcon___7pJ82 {\n  color: rgba(0, 0, 0, 0.25);\n}\n.styles-module__light___ORIft .styles-module__active___hosp7 .styles-module__canvasToggleIcon___7pJ82 {\n  color: rgba(255, 255, 255, 0.85);\n}\n\n.styles-module__canvasToggleLabel___OanpY {\n  font-size: 0.8125rem;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.6);\n  letter-spacing: -0.0094em;\n}\n.styles-module__active___hosp7 .styles-module__canvasToggleLabel___OanpY {\n  color: #fff;\n}\n.styles-module__light___ORIft .styles-module__canvasToggleLabel___OanpY {\n  color: rgba(0, 0, 0, 0.5);\n}\n.styles-module__light___ORIft .styles-module__active___hosp7 .styles-module__canvasToggleLabel___OanpY {\n  color: #fff;\n}\n\n.styles-module__canvasPurposeWrap___hj6zk {\n  display: grid;\n  grid-template-rows: 1fr;\n  transition: grid-template-rows 0.2s ease, opacity 0.15s ease;\n  opacity: 1;\n}\n.styles-module__canvasPurposeWrap___hj6zk.styles-module__collapsed___Ms9vS {\n  grid-template-rows: 0fr;\n  opacity: 0;\n}\n\n.styles-module__canvasPurposeInner___VWiyu {\n  overflow: hidden;\n}\n\n.styles-module__canvasPurposeToggle___byDH2 {\n  display: flex;\n  align-items: center;\n  gap: 0.5rem;\n  cursor: pointer;\n  margin: 0.375rem 1rem 0.375rem 1.1875rem;\n}\n.styles-module__canvasPurposeToggle___byDH2 input[type=checkbox] {\n  position: absolute;\n  opacity: 0;\n  width: 0;\n  height: 0;\n}\n\n.styles-module__canvasPurposeCheck___xqd7l {\n  position: relative;\n  width: 14px;\n  height: 14px;\n  border: 1px solid rgba(255, 255, 255, 0.2);\n  border-radius: 4px;\n  background: rgba(255, 255, 255, 0.05);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  flex-shrink: 0;\n  transition: background 0.25s ease, border-color 0.25s ease;\n}\n.styles-module__canvasPurposeCheck___xqd7l svg {\n  color: #1a1a1a;\n  opacity: 1;\n  transition: opacity 0.15s ease;\n}\n.styles-module__canvasPurposeCheck___xqd7l.styles-module__checked___-1JGH {\n  border-color: rgba(255, 255, 255, 0.3);\n  background: rgb(255, 255, 255);\n}\n.styles-module__light___ORIft .styles-module__canvasPurposeCheck___xqd7l {\n  border: 1px solid rgba(0, 0, 0, 0.15);\n  background: #fff;\n}\n.styles-module__light___ORIft .styles-module__canvasPurposeCheck___xqd7l.styles-module__checked___-1JGH {\n  border-color: #1a1a1a;\n  background: #1a1a1a;\n}\n.styles-module__light___ORIft .styles-module__canvasPurposeCheck___xqd7l.styles-module__checked___-1JGH svg {\n  color: #fff;\n}\n\n.styles-module__canvasPurposeLabel___Zu-tD {\n  font-size: 0.8125rem;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.5);\n  letter-spacing: -0.0094em;\n  display: flex;\n  align-items: center;\n  gap: 0.25rem;\n}\n.styles-module__light___ORIft .styles-module__canvasPurposeLabel___Zu-tD {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__canvasPurposeHelp___jijwR {\n  position: relative;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  cursor: help;\n}\n.styles-module__canvasPurposeHelp___jijwR svg {\n  color: rgba(255, 255, 255, 0.2);\n  transform: translateY(2px);\n  transition: color 0.15s ease;\n}\n.styles-module__canvasPurposeHelp___jijwR:hover svg {\n  color: rgba(255, 255, 255, 0.5);\n}\n.styles-module__light___ORIft .styles-module__canvasPurposeHelp___jijwR svg {\n  color: rgba(0, 0, 0, 0.2);\n}\n.styles-module__light___ORIft .styles-module__canvasPurposeHelp___jijwR:hover svg {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__placement___zcxv8 {\n  position: absolute;\n  border: 1.5px dashed rgba(59, 130, 246, 0.4);\n  border-radius: 6px;\n  background: rgba(59, 130, 246, 0.08);\n  cursor: grab;\n  transition: box-shadow 0.15s, border-color 0.15s, opacity 0.15s ease, transform 0.15s ease;\n  user-select: none;\n  pointer-events: auto;\n  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);\n  animation: styles-module__placementEnter___TdRhf 0.25s cubic-bezier(0.34, 1.2, 0.64, 1);\n}\n.styles-module__placement___zcxv8:active {\n  cursor: grabbing;\n}\n.styles-module__placement___zcxv8:hover {\n  border-color: rgba(59, 130, 246, 0.5);\n  background: rgba(59, 130, 246, 0.1);\n  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.12);\n}\n.styles-module__placement___zcxv8.styles-module__selected___6yrp6 {\n  border-color: #3c82f7;\n  border-style: solid;\n  background: rgba(59, 130, 246, 0.1);\n  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);\n}\n.styles-module__placement___zcxv8.styles-module__selected___6yrp6:hover {\n  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);\n}\n.styles-module__wireframe___itvQU .styles-module__placement___zcxv8 {\n  border-color: rgba(249, 115, 22, 0.4);\n  background: rgba(249, 115, 22, 0.08);\n}\n.styles-module__wireframe___itvQU .styles-module__placement___zcxv8:hover {\n  border-color: rgba(249, 115, 22, 0.5);\n  background: rgba(249, 115, 22, 0.1);\n  box-shadow: 0 2px 8px rgba(249, 115, 22, 0.12);\n}\n.styles-module__wireframe___itvQU .styles-module__placement___zcxv8.styles-module__selected___6yrp6 {\n  border-color: #f97316;\n  background: rgba(249, 115, 22, 0.1);\n  box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.15), 0 2px 8px rgba(249, 115, 22, 0.15);\n}\n.styles-module__wireframe___itvQU .styles-module__placement___zcxv8.styles-module__selected___6yrp6:hover {\n  box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.15), 0 2px 8px rgba(249, 115, 22, 0.15);\n}\n.styles-module__placement___zcxv8.styles-module__dragging___le6KZ {\n  opacity: 0.85;\n  z-index: 50;\n}\n.styles-module__placement___zcxv8.styles-module__exiting___YrM8F {\n  opacity: 0;\n  transform: scale(0.97);\n  pointer-events: none;\n  animation: none;\n  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.32, 0.72, 0, 1);\n}\n\n.styles-module__placementContent___f64A4 {\n  width: 100%;\n  height: 100%;\n  overflow: hidden;\n  pointer-events: none;\n}\n\n.styles-module__placementLabel___0KvWl {\n  position: absolute;\n  top: -18px;\n  left: 0;\n  font-size: 10px;\n  font-weight: 600;\n  color: rgba(59, 130, 246, 0.7);\n  white-space: nowrap;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  text-shadow: 0 0 4px rgba(255, 255, 255, 0.8), 0 0 8px rgba(255, 255, 255, 0.5);\n}\n.styles-module__selected___6yrp6 .styles-module__placementLabel___0KvWl {\n  color: #3c82f7;\n}\n.styles-module__wireframe___itvQU .styles-module__placementLabel___0KvWl {\n  color: rgba(249, 115, 22, 0.7);\n}\n.styles-module__wireframe___itvQU .styles-module__selected___6yrp6 .styles-module__placementLabel___0KvWl {\n  color: #f97316;\n}\n\n.styles-module__placementAnnotation___78pTr {\n  position: absolute;\n  bottom: -18px;\n  left: 0;\n  right: 0;\n  font-weight: 450;\n  color: rgba(0, 0, 0, 0.5);\n  font-size: 10px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  text-shadow: 0 0 4px rgba(255, 255, 255, 0.9), 0 0 8px rgba(255, 255, 255, 0.6);\n  opacity: 0;\n  transform: translateY(-2px);\n  transition: opacity 0.2s ease, transform 0.2s ease;\n}\n.styles-module__placementAnnotation___78pTr.styles-module__annotationVisible___mrUyA {\n  opacity: 1;\n  transform: translateY(0);\n}\n\n.styles-module__sectionAnnotation___aUIs0 {\n  position: absolute;\n  bottom: -18px;\n  left: 0;\n  right: 0;\n  font-weight: 450;\n  color: rgba(59, 130, 246, 0.6);\n  font-size: 10px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  text-shadow: 0 0 4px rgba(255, 255, 255, 0.9), 0 0 8px rgba(255, 255, 255, 0.6);\n  opacity: 0;\n  transform: translateY(-2px);\n  transition: opacity 0.2s ease, transform 0.2s ease;\n}\n.styles-module__sectionAnnotation___aUIs0.styles-module__annotationVisible___mrUyA {\n  opacity: 1;\n  transform: translateY(0);\n}\n\n.styles-module__handle___Ikbxm {\n  position: absolute;\n  width: 8px;\n  height: 8px;\n  background: #fff;\n  border: 1.5px solid #3c82f7;\n  border-radius: 2px;\n  z-index: 12;\n  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.12);\n  opacity: 0;\n  transform: scale(0.3);\n  pointer-events: none;\n  will-change: opacity, transform;\n  transition: opacity 0.2s ease-out, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);\n}\n.styles-module__placement___zcxv8:hover .styles-module__handle___Ikbxm, .styles-module__sectionOutline___s0hy-:hover .styles-module__handle___Ikbxm, .styles-module__ghostOutline___po-kO:hover .styles-module__handle___Ikbxm, .styles-module__placement___zcxv8:active .styles-module__handle___Ikbxm, .styles-module__sectionOutline___s0hy-:active .styles-module__handle___Ikbxm, .styles-module__ghostOutline___po-kO:active .styles-module__handle___Ikbxm, .styles-module__selected___6yrp6 .styles-module__handle___Ikbxm {\n  opacity: 1;\n  transform: scale(1);\n  pointer-events: auto;\n}\n.styles-module__sectionOutline___s0hy- .styles-module__handle___Ikbxm {\n  border-color: inherit;\n}\n.styles-module__wireframe___itvQU .styles-module__handle___Ikbxm {\n  border-color: #f97316;\n}\n\n.styles-module__handleNw___4TMIj {\n  top: -4px;\n  left: -4px;\n  cursor: nw-resize;\n}\n\n.styles-module__handleNe___mnsTh {\n  top: -4px;\n  right: -4px;\n  cursor: ne-resize;\n}\n\n.styles-module__handleSe___oSFnk {\n  bottom: -4px;\n  right: -4px;\n  cursor: se-resize;\n}\n\n.styles-module__handleSw___pi--Z {\n  bottom: -4px;\n  left: -4px;\n  cursor: sw-resize;\n}\n\n.styles-module__handleN___aBA-Q, .styles-module__handleE___0hM5u, .styles-module__handleS___JjDRv, .styles-module__handleW___ERWGQ {\n  opacity: 0 !important;\n  pointer-events: none !important;\n}\n\n.styles-module__edgeHandle___XxXdT {\n  position: absolute;\n  z-index: 11;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n.styles-module__edgeHandle___XxXdT::after {\n  content: "";\n  position: absolute;\n  border-radius: 4px;\n  background: #3c82f7;\n}\n.styles-module__wireframe___itvQU .styles-module__edgeHandle___XxXdT::after {\n  background: #f97316;\n}\n.styles-module__edgeHandle___XxXdT::after {\n  opacity: 0;\n  transition: opacity 0.1s ease, transform 0.1s ease;\n  transform: scale(0.8);\n}\n.styles-module__edgeHandle___XxXdT:hover::after {\n  opacity: 0.85;\n  transform: scale(1);\n}\n.styles-module__edgeHandle___XxXdT svg {\n  position: relative;\n  z-index: 1;\n  opacity: 0;\n  transition: opacity 0.1s ease;\n  filter: drop-shadow(0 0 2px var(--agd-surface));\n}\n.styles-module__edgeHandle___XxXdT:hover svg {\n  opacity: 1;\n}\n\n.styles-module__edgeN___-JJDj, .styles-module__edgeS___66lMX {\n  left: 12px;\n  right: 12px;\n  height: 12px;\n  cursor: n-resize;\n}\n.styles-module__edgeN___-JJDj::after, .styles-module__edgeS___66lMX::after {\n  width: 24px;\n  height: 4px;\n}\n\n.styles-module__edgeN___-JJDj {\n  top: -6px;\n}\n\n.styles-module__edgeS___66lMX {\n  bottom: -6px;\n  cursor: s-resize;\n}\n\n.styles-module__edgeE___1bGDa, .styles-module__edgeW___lHQNo {\n  top: 12px;\n  bottom: 12px;\n  width: 12px;\n  cursor: e-resize;\n}\n.styles-module__edgeE___1bGDa::after, .styles-module__edgeW___lHQNo::after {\n  width: 4px;\n  height: 24px;\n}\n\n.styles-module__edgeE___1bGDa {\n  right: -6px;\n}\n\n.styles-module__edgeW___lHQNo {\n  left: -6px;\n  cursor: w-resize;\n}\n\n.styles-module__deleteButton___LkGCb {\n  position: absolute;\n  top: -8px;\n  right: -8px;\n  width: 18px;\n  height: 18px;\n  border-radius: 50%;\n  background: rgba(255, 255, 255, 0.9);\n  backdrop-filter: blur(8px);\n  border: 1px solid rgba(0, 0, 0, 0.08);\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);\n  color: rgba(0, 0, 0, 0.35);\n  cursor: pointer;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-size: 10px;\n  line-height: 1;\n  z-index: 15;\n  pointer-events: none;\n  opacity: 0;\n  transform: scale(0.8);\n  will-change: opacity, transform;\n  transition: opacity 0.2s ease-out, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.12s ease, color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;\n}\n.styles-module__placement___zcxv8:hover .styles-module__deleteButton___LkGCb, .styles-module__selected___6yrp6 .styles-module__deleteButton___LkGCb, .styles-module__sectionOutline___s0hy-:hover .styles-module__deleteButton___LkGCb, .styles-module__sectionOutline___s0hy-.styles-module__selected___6yrp6 .styles-module__deleteButton___LkGCb, .styles-module__ghostOutline___po-kO:hover .styles-module__deleteButton___LkGCb, .styles-module__ghostOutline___po-kO.styles-module__selected___6yrp6 .styles-module__deleteButton___LkGCb {\n  opacity: 1;\n  transform: scale(1);\n  pointer-events: auto;\n}\n.styles-module__deleteButton___LkGCb:hover {\n  background: #ef4444;\n  color: #fff;\n  border-color: #ef4444;\n  box-shadow: 0 1px 4px rgba(239, 68, 68, 0.3);\n  transform: scale(1.1);\n}\n.styles-module__overlay___aWh-q:not(.styles-module__light___ORIft) .styles-module__deleteButton___LkGCb, .styles-module__rearrangeOverlay___-3R3t:not(.styles-module__light___ORIft) .styles-module__deleteButton___LkGCb {\n  background: rgba(40, 40, 40, 0.9);\n  border-color: rgba(255, 255, 255, 0.1);\n  color: rgba(255, 255, 255, 0.5);\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);\n}\n.styles-module__overlay___aWh-q:not(.styles-module__light___ORIft) .styles-module__deleteButton___LkGCb:hover, .styles-module__rearrangeOverlay___-3R3t:not(.styles-module__light___ORIft) .styles-module__deleteButton___LkGCb:hover {\n  background: #ef4444;\n  color: #fff;\n  border-color: #ef4444;\n}\n\n.styles-module__drawBox___BrVAa {\n  position: fixed;\n  pointer-events: none;\n  z-index: 99996;\n  border: 2px solid #3c82f7;\n  border-radius: 6px;\n  background: rgba(59, 130, 246, 0.15);\n}\n\n.styles-module__selectBox___Iu8kB {\n  position: fixed;\n  pointer-events: none;\n  z-index: 99996;\n  border: 1px dashed #3c82f7;\n  background: rgba(59, 130, 246, 0.08);\n  border-radius: 2px;\n}\n\n.styles-module__sizeIndicator___7zJ4y {\n  position: fixed;\n  pointer-events: none;\n  z-index: 100001;\n  font-size: 10px;\n  color: #fff;\n  background: #3c82f7;\n  padding: 2px 6px;\n  border-radius: 4px;\n  white-space: nowrap;\n  font-weight: 500;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);\n}\n\n.styles-module__guideLine___DUQY2 {\n  pointer-events: none;\n  z-index: 100001;\n  background: #f0f;\n  opacity: 0.5;\n}\n\n.styles-module__dragPreview___onPbU {\n  position: fixed;\n  z-index: 100002;\n  pointer-events: none;\n  border: 1.5px dashed #3c82f7;\n  border-radius: 6px;\n  background: rgba(59, 130, 246, 0.1);\n  backdrop-filter: blur(8px);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-size: 9px;\n  font-weight: 600;\n  color: #3c82f7;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  text-transform: uppercase;\n  letter-spacing: 0.04em;\n  box-shadow: 0 4px 16px rgba(59, 130, 246, 0.15);\n  transition: width 0.08s ease, height 0.08s ease, opacity 0.08s ease;\n}\n\n.styles-module__dragPreviewWireframe___jsg0G {\n  border-color: #f97316;\n  background: rgba(249, 115, 22, 0.1);\n  color: #f97316;\n  box-shadow: 0 4px 16px rgba(249, 115, 22, 0.15);\n}\n\n.styles-module__palette___C7iSH {\n  position: absolute;\n  right: 5px;\n  bottom: calc(100% + 0.5rem);\n  width: 256px;\n  overflow: hidden;\n  background: #1c1c1c;\n  border: none;\n  border-radius: 1rem;\n  padding: 13px 0 16px;\n  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.04);\n  z-index: 100001;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  cursor: default;\n  opacity: 0;\n  filter: blur(5px);\n}\n.styles-module__palette___C7iSH .styles-module__paletteItem___6TlnA,\n.styles-module__palette___C7iSH .styles-module__paletteItemLabel___6ncO4,\n.styles-module__palette___C7iSH .styles-module__paletteSectionTitle___PqnjX,\n.styles-module__palette___C7iSH .styles-module__paletteFooter___QYnAG {\n  transition: background 0.25s ease, color 0.25s ease, border-color 0.25s ease;\n}\n.styles-module__palette___C7iSH.styles-module__enter___6LYk5 {\n  opacity: 1;\n  transform: translateY(0);\n  filter: blur(0px);\n  transition: opacity 0.2s ease, transform 0.2s ease, filter 0.2s ease;\n}\n.styles-module__palette___C7iSH.styles-module__exit___iSGRw {\n  opacity: 0;\n  transform: translateY(6px);\n  filter: blur(5px);\n  pointer-events: none;\n  transition: opacity 0.1s ease, transform 0.1s ease, filter 0.1s ease;\n}\n.styles-module__palette___C7iSH.styles-module__light___ORIft {\n  background: #fff;\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);\n}\n\n.styles-module__paletteSection___V8DEA {\n  padding: 0 1rem;\n}\n.styles-module__paletteSection___V8DEA + .styles-module__paletteSection___V8DEA {\n  margin-top: 0.5rem;\n  padding-top: 0.5rem;\n  border-top: 1px solid rgba(255, 255, 255, 0.07);\n}\n.styles-module__light___ORIft .styles-module__paletteSection___V8DEA + .styles-module__paletteSection___V8DEA {\n  border-top-color: rgba(0, 0, 0, 0.07);\n}\n\n.styles-module__paletteSectionTitle___PqnjX {\n  font-size: 0.6875rem;\n  font-weight: 500;\n  color: rgba(255, 255, 255, 0.5);\n  letter-spacing: -0.0094em;\n  padding: 0 0 3px 3px;\n}\n.styles-module__light___ORIft .styles-module__paletteSectionTitle___PqnjX {\n  color: rgba(0, 0, 0, 0.4);\n}\n\n.styles-module__paletteItem___6TlnA {\n  display: flex;\n  align-items: center;\n  gap: 0.375rem;\n  padding: 0.25rem 0.25rem;\n  margin-bottom: 1px;\n  border-radius: 0.375rem;\n  cursor: pointer;\n  transition: background-color 0.15s ease, border-color 0.15s ease;\n  border: 1px solid transparent;\n  user-select: none;\n  min-height: 24px;\n}\n.styles-module__paletteItem___6TlnA:hover {\n  background: rgba(255, 255, 255, 0.1);\n}\n.styles-module__paletteItem___6TlnA.styles-module__active___hosp7 {\n  background: #3c82f7;\n  border-color: transparent;\n}\n.styles-module__paletteItem___6TlnA.styles-module__wireframe___itvQU.styles-module__active___hosp7 {\n  background: #f97316;\n}\n.styles-module__light___ORIft .styles-module__paletteItem___6TlnA:hover {\n  background: rgba(0, 0, 0, 0.05);\n}\n.styles-module__light___ORIft .styles-module__paletteItem___6TlnA.styles-module__active___hosp7 {\n  background: #3c82f7;\n  border-color: transparent;\n}\n.styles-module__light___ORIft .styles-module__paletteItem___6TlnA.styles-module__wireframe___itvQU.styles-module__active___hosp7 {\n  background: #f97316;\n}\n\n.styles-module__paletteItemIcon___0NPQK {\n  width: 20px;\n  height: 16px;\n  border-radius: 2px;\n  border: 1px dashed rgba(255, 255, 255, 0.15);\n  background: rgba(255, 255, 255, 0.04);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  flex-shrink: 0;\n  overflow: hidden;\n  color: rgba(255, 255, 255, 0.45);\n}\n.styles-module__paletteItemIcon___0NPQK svg {\n  display: block;\n  width: 20px;\n  height: 16px;\n}\n.styles-module__active___hosp7 .styles-module__paletteItemIcon___0NPQK {\n  border-color: rgba(255, 255, 255, 0.3);\n  background: rgba(255, 255, 255, 0.15);\n  color: #fff;\n}\n.styles-module__light___ORIft .styles-module__paletteItemIcon___0NPQK {\n  border-color: rgba(0, 0, 0, 0.12);\n  background: rgba(0, 0, 0, 0.02);\n  color: rgba(0, 0, 0, 0.4);\n}\n.styles-module__light___ORIft .styles-module__active___hosp7 .styles-module__paletteItemIcon___0NPQK {\n  border-color: rgba(255, 255, 255, 0.3);\n  background: rgba(255, 255, 255, 0.15);\n  color: #fff;\n}\n\n.styles-module__paletteItemLabel___6ncO4 {\n  font-size: 0.8125rem;\n  font-weight: 500;\n  color: rgba(255, 255, 255, 0.85);\n  letter-spacing: -0.0094em;\n  line-height: 1;\n  min-width: 0;\n}\n.styles-module__active___hosp7 .styles-module__paletteItemLabel___6ncO4 {\n  color: #fff;\n  font-weight: 600;\n}\n.styles-module__light___ORIft .styles-module__paletteItemLabel___6ncO4 {\n  color: rgba(0, 0, 0, 0.7);\n}\n.styles-module__light___ORIft .styles-module__active___hosp7 .styles-module__paletteItemLabel___6ncO4 {\n  color: #fff;\n  font-weight: 600;\n}\n\n.styles-module__placeScroll___7sClM {\n  max-height: 240px;\n  overflow-y: auto;\n  overflow-x: hidden;\n  padding-top: 0.25rem;\n}\n.styles-module__placeScroll___7sClM.styles-module__fadeTop___KT9tF {\n  -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 32px);\n  mask-image: linear-gradient(to bottom, transparent 0, black 32px);\n}\n.styles-module__placeScroll___7sClM.styles-module__fadeBottom___x3ShT {\n  -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 32px), transparent 100%);\n  mask-image: linear-gradient(to bottom, black calc(100% - 32px), transparent 100%);\n}\n.styles-module__placeScroll___7sClM.styles-module__fadeTop___KT9tF.styles-module__fadeBottom___x3ShT {\n  -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 32px, black calc(100% - 32px), transparent 100%);\n  mask-image: linear-gradient(to bottom, transparent 0, black 32px, black calc(100% - 32px), transparent 100%);\n}\n.styles-module__placeScroll___7sClM::-webkit-scrollbar {\n  width: 3px;\n}\n.styles-module__placeScroll___7sClM::-webkit-scrollbar-thumb {\n  background: rgba(255, 255, 255, 0.12);\n  border-radius: 2px;\n}\n.styles-module__light___ORIft .styles-module__placeScroll___7sClM::-webkit-scrollbar-thumb {\n  background: rgba(0, 0, 0, 0.1);\n}\n\n.styles-module__paletteFooterWrap___71-fI {\n  display: grid;\n  grid-template-rows: 1fr;\n  transition: grid-template-rows 0.25s cubic-bezier(0.32, 0.72, 0, 1);\n}\n.styles-module__paletteFooterWrap___71-fI.styles-module__footerHidden___fJUik {\n  grid-template-rows: 0fr;\n}\n\n.styles-module__paletteFooterInnerContent___VC26h {\n  opacity: 1;\n  transform: translateY(0);\n  transition: opacity 0.15s ease, transform 0.15s ease;\n}\n.styles-module__footerHidden___fJUik .styles-module__paletteFooterInnerContent___VC26h {\n  opacity: 0;\n  transform: translateY(4px);\n}\n\n.styles-module__paletteFooterInner___dfylY {\n  overflow: hidden;\n}\n\n.styles-module__paletteFooter___QYnAG {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  min-height: 24px;\n  padding: 0 1rem;\n  margin-top: 0.5rem;\n  padding-top: 0.5rem;\n  border-top: 1px solid rgba(255, 255, 255, 0.07);\n}\n.styles-module__light___ORIft .styles-module__paletteFooter___QYnAG {\n  border-top-color: rgba(0, 0, 0, 0.07);\n}\n\n.styles-module__paletteFooterCount___D3Fia {\n  font-size: 0.8125rem;\n  font-weight: 400;\n  letter-spacing: -0.0094em;\n  color: rgba(255, 255, 255, 0.5);\n}\n.styles-module__light___ORIft .styles-module__paletteFooterCount___D3Fia {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__paletteFooterClear___ybBoa {\n  font-size: 0.8125rem;\n  font-weight: 400;\n  letter-spacing: -0.0094em;\n  color: rgba(255, 255, 255, 0.5);\n  background: none;\n  border: none;\n  cursor: pointer;\n  padding: 0;\n  font-family: inherit;\n  transition: color 0.15s ease;\n}\n.styles-module__paletteFooterClear___ybBoa:hover {\n  color: rgba(255, 255, 255, 0.7);\n}\n.styles-module__light___ORIft .styles-module__paletteFooterClear___ybBoa {\n  color: rgba(0, 0, 0, 0.5);\n}\n.styles-module__light___ORIft .styles-module__paletteFooterClear___ybBoa:hover {\n  color: rgba(0, 0, 0, 0.6);\n}\n\n.styles-module__paletteFooterActions___fLzv8 {\n  display: flex;\n  align-items: center;\n  gap: 0.75rem;\n}\n\n.styles-module__rollingWrap___S75jM {\n  display: inline-block;\n  overflow: hidden;\n  height: 1.15em;\n  position: relative;\n  vertical-align: bottom;\n}\n\n.styles-module__rollingNum___1RKDx {\n  position: absolute;\n  left: 0;\n  top: 0;\n}\n\n.styles-module__exitUp___AFDRW {\n  animation: styles-module__numExitUp___FRQqx 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards;\n}\n\n.styles-module__enterUp___CPlXb {\n  animation: styles-module__numEnterUp___2Yd-w 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards;\n}\n\n.styles-module__exitDown___-1yAy {\n  animation: styles-module__numExitDown___xm5by 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards;\n}\n\n.styles-module__enterDown___DDuFR {\n  animation: styles-module__numEnterDown___hpxBk 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards;\n}\n\n@keyframes styles-module__numExitUp___FRQqx {\n  from {\n    transform: translateY(0);\n    opacity: 1;\n  }\n  to {\n    transform: translateY(-110%);\n    opacity: 0;\n  }\n}\n@keyframes styles-module__numEnterUp___2Yd-w {\n  from {\n    transform: translateY(110%);\n    opacity: 0;\n  }\n  to {\n    transform: translateY(0);\n    opacity: 1;\n  }\n}\n@keyframes styles-module__numExitDown___xm5by {\n  from {\n    transform: translateY(0);\n    opacity: 1;\n  }\n  to {\n    transform: translateY(110%);\n    opacity: 0;\n  }\n}\n@keyframes styles-module__numEnterDown___hpxBk {\n  from {\n    transform: translateY(-110%);\n    opacity: 0;\n  }\n  to {\n    transform: translateY(0);\n    opacity: 1;\n  }\n}\n.styles-module__rearrangeOverlay___-3R3t {\n  position: fixed;\n  inset: 0;\n  z-index: 99995;\n  pointer-events: none;\n  cursor: default;\n  user-select: none;\n  animation: styles-module__overlayFadeIn___aECVy 0.15s ease;\n}\n\n.styles-module__hoverHighlight___8eT-v {\n  position: fixed;\n  pointer-events: none;\n  z-index: 99994;\n  border: 2px dashed rgba(59, 130, 246, 0.5);\n  border-radius: 4px;\n  background: rgba(59, 130, 246, 0.06);\n  animation: styles-module__highlightFadeIn___Lg7KY 0.12s ease;\n}\n\n.styles-module__sectionOutline___s0hy- {\n  position: fixed;\n  border: 2px solid;\n  border-radius: 4px;\n  cursor: grab;\n}\n.styles-module__sectionOutline___s0hy-:active {\n  cursor: grabbing;\n}\n.styles-module__sectionOutline___s0hy- {\n  transition: box-shadow 0.15s, border-color 0.3s, background-color 0.3s, border-style 0s;\n  user-select: none;\n  pointer-events: auto;\n  animation: styles-module__sectionEnter___-8BXT 0.2s ease;\n}\n.styles-module__sectionOutline___s0hy-:hover {\n  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 4px 12px rgba(0, 0, 0, 0.15);\n}\n.styles-module__sectionOutline___s0hy-.styles-module__selected___6yrp6 {\n  border-style: solid;\n  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);\n}\n.styles-module__sectionOutline___s0hy-.styles-module__selected___6yrp6:hover {\n  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);\n}\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6) {\n  border: 1.5px dashed rgba(150, 150, 150, 0.35);\n  background-color: transparent !important;\n  box-shadow: none;\n}\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6):hover {\n  border-color: rgba(150, 150, 150, 0.6);\n  box-shadow: none;\n}\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6) .styles-module__sectionLabel___F80HQ {\n  opacity: 0;\n  transition: opacity 0.15s ease;\n}\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6):hover .styles-module__sectionLabel___F80HQ {\n  opacity: 1;\n}\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6) .styles-module__movedBadge___s8z-q,\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6) .styles-module__sectionDimensions___RcJSL {\n  opacity: 0;\n  transition: opacity 0.15s ease;\n}\n.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6):hover .styles-module__sectionDimensions___RcJSL {\n  opacity: 1;\n}\n.styles-module__sectionOutline___s0hy-.styles-module__exiting___YrM8F {\n  opacity: 0;\n  transform: scale(0.97);\n  pointer-events: none;\n  animation: none;\n  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.32, 0.72, 0, 1);\n}\n\n.styles-module__sectionLabel___F80HQ {\n  position: absolute;\n  top: 4px;\n  left: 4px;\n  font-size: 10px;\n  font-weight: 600;\n  color: #fff;\n  padding: 2px 8px;\n  border-radius: 4px;\n  white-space: nowrap;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);\n  max-width: calc(100% - 8px);\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.styles-module__movedBadge___s8z-q {\n  position: absolute;\n  bottom: 22px;\n  right: 4px;\n  font-size: 9px;\n  font-weight: 700;\n  color: #fff;\n  background: #22c55e;\n  padding: 2px 6px;\n  border-radius: 4px;\n  white-space: nowrap;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  text-transform: uppercase;\n  letter-spacing: 0.04em;\n  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);\n  opacity: 0;\n  transform: scale(0.8);\n  transition: opacity 0.15s ease, transform 0.15s ease;\n}\n.styles-module__movedBadge___s8z-q.styles-module__badgeVisible___npbdS {\n  opacity: 1;\n  transform: scale(1);\n  transition: opacity 0.2s cubic-bezier(0.34, 1.2, 0.64, 1), transform 0.2s cubic-bezier(0.34, 1.2, 0.64, 1);\n}\n\n.styles-module__resizedBadge___u51V8 {\n  background: #3c82f7;\n  bottom: 40px;\n}\n\n.styles-module__sectionDimensions___RcJSL {\n  position: absolute;\n  bottom: 4px;\n  right: 4px;\n  font-size: 9px;\n  font-weight: 500;\n  color: rgba(255, 255, 255, 0.7);\n  background: rgba(0, 0, 0, 0.5);\n  padding: 1px 5px;\n  border-radius: 3px;\n  white-space: nowrap;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n}\n.styles-module__light___ORIft .styles-module__sectionDimensions___RcJSL {\n  color: rgba(0, 0, 0, 0.5);\n  background: rgba(255, 255, 255, 0.7);\n}\n\n.styles-module__wireframeNotice___4GJyB {\n  position: fixed;\n  bottom: 16px;\n  left: 24px;\n  z-index: 99995;\n  font-size: 9.5px;\n  font-weight: 400;\n  color: rgba(0, 0, 0, 0.4);\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  pointer-events: auto;\n  animation: styles-module__overlayFadeIn___aECVy 0.3s ease;\n  line-height: 1.5;\n  max-width: 280px;\n}\n\n.styles-module__wireframeOpacityRow___CJXzi {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  margin-bottom: 8px;\n}\n\n.styles-module__wireframeOpacityLabel___afkfT {\n  font-size: 9px;\n  font-weight: 500;\n  color: rgba(0, 0, 0, 0.32);\n  letter-spacing: 0.02em;\n  white-space: nowrap;\n  user-select: none;\n}\n\n.styles-module__wireframeOpacitySlider___YcoEs {\n  -webkit-appearance: none;\n  appearance: none;\n  width: 56px;\n  height: 4px;\n  background: rgba(0, 0, 0, 0.08);\n  border-radius: 2px;\n  outline: none;\n  cursor: pointer;\n  flex-shrink: 0;\n  transition: background 0.15s ease;\n}\n.styles-module__wireframeOpacitySlider___YcoEs:hover {\n  background: rgba(0, 0, 0, 0.13);\n}\n.styles-module__wireframeOpacitySlider___YcoEs::-webkit-slider-thumb {\n  -webkit-appearance: none;\n  appearance: none;\n  width: 10px;\n  height: 10px;\n  border-radius: 50%;\n  background: #f97316;\n  cursor: pointer;\n  transition: background 0.15s ease;\n}\n.styles-module__wireframeOpacitySlider___YcoEs::-webkit-slider-thumb:hover {\n  background: rgb(224.4209205021, 95.3548117155, 5.7790794979);\n}\n.styles-module__wireframeOpacitySlider___YcoEs::-moz-range-thumb {\n  width: 10px;\n  height: 10px;\n  border-radius: 50%;\n  background: #f97316;\n  border: none;\n  cursor: pointer;\n}\n.styles-module__wireframeOpacitySlider___YcoEs::-moz-range-track {\n  background: rgba(0, 0, 0, 0.08);\n  height: 4px;\n  border-radius: 2px;\n}\n\n.styles-module__wireframeNoticeTitleRow___PJqyG {\n  display: flex;\n  align-items: center;\n  gap: 0;\n  margin-bottom: 2px;\n}\n\n.styles-module__wireframeNoticeTitle___okr08 {\n  font-weight: 600;\n  color: rgba(0, 0, 0, 0.55);\n}\n\n.styles-module__wireframeNoticeDivider___PNKQ6 {\n  width: 1px;\n  height: 8px;\n  background: rgba(0, 0, 0, 0.12);\n  margin: 0 8px;\n  flex-shrink: 0;\n}\n\n.styles-module__wireframeStartOver___YFk-I {\n  font-size: 9.5px;\n  font-weight: 500;\n  color: rgba(0, 0, 0, 0.35);\n  cursor: pointer;\n  background: none;\n  border: none;\n  padding: 0;\n  font-family: inherit;\n  text-decoration: none;\n  transition: color 0.12s ease;\n  white-space: nowrap;\n}\n.styles-module__wireframeStartOver___YFk-I:hover {\n  color: rgba(0, 0, 0, 0.6);\n}\n\n.styles-module__ghostOutline___po-kO {\n  position: fixed;\n  border: 1.5px dashed rgba(59, 130, 246, 0.4);\n  border-radius: 4px;\n  background: rgba(59, 130, 246, 0.04);\n  cursor: grab;\n  opacity: 0.5;\n  user-select: none;\n  pointer-events: auto;\n  animation: styles-module__ghostEnter___EC3Mb 0.25s ease;\n  transition: box-shadow 0.15s, border-color 0.3s, opacity 0.25s;\n}\n.styles-module__ghostOutline___po-kO:active {\n  cursor: grabbing;\n}\n.styles-module__ghostOutline___po-kO:hover {\n  opacity: 0.7;\n  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.1), 0 4px 12px rgba(0, 0, 0, 0.08);\n}\n.styles-module__ghostOutline___po-kO.styles-module__selected___6yrp6 {\n  opacity: 1;\n  border-style: solid;\n  border-width: 2px;\n  border-color: #3c82f7;\n  background: rgba(59, 130, 246, 0.08);\n  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);\n}\n.styles-module__ghostOutline___po-kO.styles-module__exiting___YrM8F {\n  opacity: 0;\n  transform: scale(0.97);\n  pointer-events: none;\n  animation: none;\n  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.32, 0.72, 0, 1);\n}\n\n.styles-module__ghostBadge___tsQUK {\n  position: absolute;\n  bottom: calc(100% + 4px);\n  left: -1px;\n  font-size: 9px;\n  font-weight: 600;\n  color: rgba(59, 130, 246, 0.9);\n  background: rgba(59, 130, 246, 0.08);\n  border: 1px solid rgba(59, 130, 246, 0.2);\n  padding: 1px 5px;\n  border-radius: 3px;\n  white-space: nowrap;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  letter-spacing: 0.02em;\n  line-height: 1.2;\n  animation: styles-module__badgeSlideIn___typJ7 0.2s ease both;\n}\n\n@keyframes styles-module__badgeSlideIn___typJ7 {\n  from {\n    opacity: 0;\n    transform: translateY(4px);\n  }\n  to {\n    opacity: 1;\n    transform: translateY(0);\n  }\n}\n.styles-module__ghostBadgeExtra___6CVoD {\n  display: inline;\n  animation: styles-module__badgeExtraIn___i4W8F 0.2s ease both;\n}\n\n@keyframes styles-module__badgeExtraIn___i4W8F {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}\n.styles-module__originalOutline___Y6DD1 {\n  position: fixed;\n  border: 1.5px dashed rgba(150, 150, 150, 0.3);\n  border-radius: 4px;\n  background: transparent;\n  pointer-events: none;\n  user-select: none;\n  animation: styles-module__sectionEnter___-8BXT 0.2s ease;\n}\n\n.styles-module__originalLabel___HqI9g {\n  position: absolute;\n  top: 4px;\n  left: 4px;\n  font-size: 9px;\n  font-weight: 500;\n  color: rgba(150, 150, 150, 0.5);\n  padding: 1px 6px;\n  border-radius: 3px;\n  white-space: nowrap;\n  pointer-events: none;\n  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  background: rgba(150, 150, 150, 0.08);\n}\n\n.styles-module__connectorSvg___Lovld {\n  position: fixed;\n  inset: 0;\n  width: 100vw;\n  height: 100vh;\n  pointer-events: none;\n  z-index: 99996;\n}\n\n.styles-module__connectorLine___XeWh- {\n  transition: opacity 0.2s ease;\n  animation: styles-module__connectorDraw___8sK5I 0.3s ease both;\n}\n\n.styles-module__connectorDot___yvf7C {\n  transform-box: fill-box;\n  transform-origin: center;\n  animation: styles-module__connectorDotIn___NwTUq 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) 0.15s both;\n}\n\n@keyframes styles-module__connectorDraw___8sK5I {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}\n@keyframes styles-module__connectorDotIn___NwTUq {\n  from {\n    transform: scale(0);\n    opacity: 0;\n  }\n  to {\n    transform: scale(1);\n    opacity: 1;\n  }\n}\n.styles-module__connectorExiting___2lLOs {\n  animation: styles-module__connectorOut___5QoPl 0.2s ease forwards;\n}\n.styles-module__connectorExiting___2lLOs .styles-module__connectorDot___yvf7C {\n  animation: styles-module__connectorDotOut___FEq7e 0.2s ease forwards;\n}\n\n@keyframes styles-module__connectorOut___5QoPl {\n  from {\n    opacity: 1;\n  }\n  to {\n    opacity: 0;\n  }\n}\n@keyframes styles-module__connectorDotOut___FEq7e {\n  from {\n    transform: scale(1);\n    opacity: 1;\n  }\n  to {\n    transform: scale(0);\n    opacity: 0;\n  }\n}\n@keyframes styles-module__placementEnter___TdRhf {\n  from {\n    opacity: 0;\n    transform: scale(0.85);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1);\n  }\n}\n@keyframes styles-module__sectionEnter___-8BXT {\n  from {\n    opacity: 0;\n    transform: scale(0.96);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1);\n  }\n}\n@keyframes styles-module__highlightFadeIn___Lg7KY {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}\n@keyframes styles-module__overlayFadeIn___aECVy {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}\n@keyframes styles-module__ghostEnter___EC3Mb {\n  from {\n    opacity: 0;\n    transform: scale(0.96);\n  }\n  to {\n    opacity: 0.6;\n    transform: scale(1);\n  }\n}';
var classNames4 = { "overlayExiting": "styles-module__overlayExiting___iEmYr", "overlay": "styles-module__overlay___aWh-q", "overlayFadeIn": "styles-module__overlayFadeIn___aECVy", "light": "styles-module__light___ORIft", "wireframe": "styles-module__wireframe___itvQU", "placing": "styles-module__placing___45yD8", "passthrough": "styles-module__passthrough___xaFeE", "blankCanvas": "styles-module__blankCanvas___t2Eue", "visible": "styles-module__visible___OKKqX", "gridActive": "styles-module__gridActive___OZ-cf", "paletteHeader": "styles-module__paletteHeader___-Q5gQ", "paletteHeaderTitle": "styles-module__paletteHeaderTitle___oHqZC", "paletteHeaderDesc": "styles-module__paletteHeaderDesc___6i74T", "wireframePurposeWrap": "styles-module__wireframePurposeWrap___To-tS", "collapsed": "styles-module__collapsed___Ms9vS", "wireframePurposeInner": "styles-module__wireframePurposeInner___Lrahs", "wireframePurposeInput": "styles-module__wireframePurposeInput___7EtBN", "canvasToggle": "styles-module__canvasToggle___-QqSy", "active": "styles-module__active___hosp7", "canvasToggleIcon": "styles-module__canvasToggleIcon___7pJ82", "canvasToggleLabel": "styles-module__canvasToggleLabel___OanpY", "canvasPurposeWrap": "styles-module__canvasPurposeWrap___hj6zk", "canvasPurposeInner": "styles-module__canvasPurposeInner___VWiyu", "canvasPurposeToggle": "styles-module__canvasPurposeToggle___byDH2", "canvasPurposeCheck": "styles-module__canvasPurposeCheck___xqd7l", "checked": "styles-module__checked___-1JGH", "canvasPurposeLabel": "styles-module__canvasPurposeLabel___Zu-tD", "canvasPurposeHelp": "styles-module__canvasPurposeHelp___jijwR", "placement": "styles-module__placement___zcxv8", "placementEnter": "styles-module__placementEnter___TdRhf", "selected": "styles-module__selected___6yrp6", "dragging": "styles-module__dragging___le6KZ", "exiting": "styles-module__exiting___YrM8F", "placementContent": "styles-module__placementContent___f64A4", "placementLabel": "styles-module__placementLabel___0KvWl", "placementAnnotation": "styles-module__placementAnnotation___78pTr", "annotationVisible": "styles-module__annotationVisible___mrUyA", "sectionAnnotation": "styles-module__sectionAnnotation___aUIs0", "handle": "styles-module__handle___Ikbxm", "sectionOutline": "styles-module__sectionOutline___s0hy-", "ghostOutline": "styles-module__ghostOutline___po-kO", "handleNw": "styles-module__handleNw___4TMIj", "handleNe": "styles-module__handleNe___mnsTh", "handleSe": "styles-module__handleSe___oSFnk", "handleSw": "styles-module__handleSw___pi--Z", "handleN": "styles-module__handleN___aBA-Q", "handleE": "styles-module__handleE___0hM5u", "handleS": "styles-module__handleS___JjDRv", "handleW": "styles-module__handleW___ERWGQ", "edgeHandle": "styles-module__edgeHandle___XxXdT", "edgeN": "styles-module__edgeN___-JJDj", "edgeS": "styles-module__edgeS___66lMX", "edgeE": "styles-module__edgeE___1bGDa", "edgeW": "styles-module__edgeW___lHQNo", "deleteButton": "styles-module__deleteButton___LkGCb", "rearrangeOverlay": "styles-module__rearrangeOverlay___-3R3t", "drawBox": "styles-module__drawBox___BrVAa", "selectBox": "styles-module__selectBox___Iu8kB", "sizeIndicator": "styles-module__sizeIndicator___7zJ4y", "guideLine": "styles-module__guideLine___DUQY2", "dragPreview": "styles-module__dragPreview___onPbU", "dragPreviewWireframe": "styles-module__dragPreviewWireframe___jsg0G", "palette": "styles-module__palette___C7iSH", "paletteItem": "styles-module__paletteItem___6TlnA", "paletteItemLabel": "styles-module__paletteItemLabel___6ncO4", "paletteSectionTitle": "styles-module__paletteSectionTitle___PqnjX", "paletteFooter": "styles-module__paletteFooter___QYnAG", "enter": "styles-module__enter___6LYk5", "exit": "styles-module__exit___iSGRw", "paletteSection": "styles-module__paletteSection___V8DEA", "paletteItemIcon": "styles-module__paletteItemIcon___0NPQK", "placeScroll": "styles-module__placeScroll___7sClM", "fadeTop": "styles-module__fadeTop___KT9tF", "fadeBottom": "styles-module__fadeBottom___x3ShT", "paletteFooterWrap": "styles-module__paletteFooterWrap___71-fI", "footerHidden": "styles-module__footerHidden___fJUik", "paletteFooterInnerContent": "styles-module__paletteFooterInnerContent___VC26h", "paletteFooterInner": "styles-module__paletteFooterInner___dfylY", "paletteFooterCount": "styles-module__paletteFooterCount___D3Fia", "paletteFooterClear": "styles-module__paletteFooterClear___ybBoa", "paletteFooterActions": "styles-module__paletteFooterActions___fLzv8", "rollingWrap": "styles-module__rollingWrap___S75jM", "rollingNum": "styles-module__rollingNum___1RKDx", "exitUp": "styles-module__exitUp___AFDRW", "numExitUp": "styles-module__numExitUp___FRQqx", "enterUp": "styles-module__enterUp___CPlXb", "numEnterUp": "styles-module__numEnterUp___2Yd-w", "exitDown": "styles-module__exitDown___-1yAy", "numExitDown": "styles-module__numExitDown___xm5by", "enterDown": "styles-module__enterDown___DDuFR", "numEnterDown": "styles-module__numEnterDown___hpxBk", "hoverHighlight": "styles-module__hoverHighlight___8eT-v", "highlightFadeIn": "styles-module__highlightFadeIn___Lg7KY", "sectionEnter": "styles-module__sectionEnter___-8BXT", "settled": "styles-module__settled___b5U5o", "sectionLabel": "styles-module__sectionLabel___F80HQ", "movedBadge": "styles-module__movedBadge___s8z-q", "sectionDimensions": "styles-module__sectionDimensions___RcJSL", "badgeVisible": "styles-module__badgeVisible___npbdS", "resizedBadge": "styles-module__resizedBadge___u51V8", "wireframeNotice": "styles-module__wireframeNotice___4GJyB", "wireframeOpacityRow": "styles-module__wireframeOpacityRow___CJXzi", "wireframeOpacityLabel": "styles-module__wireframeOpacityLabel___afkfT", "wireframeOpacitySlider": "styles-module__wireframeOpacitySlider___YcoEs", "wireframeNoticeTitleRow": "styles-module__wireframeNoticeTitleRow___PJqyG", "wireframeNoticeTitle": "styles-module__wireframeNoticeTitle___okr08", "wireframeNoticeDivider": "styles-module__wireframeNoticeDivider___PNKQ6", "wireframeStartOver": "styles-module__wireframeStartOver___YFk-I", "ghostEnter": "styles-module__ghostEnter___EC3Mb", "ghostBadge": "styles-module__ghostBadge___tsQUK", "badgeSlideIn": "styles-module__badgeSlideIn___typJ7", "ghostBadgeExtra": "styles-module__ghostBadgeExtra___6CVoD", "badgeExtraIn": "styles-module__badgeExtraIn___i4W8F", "originalOutline": "styles-module__originalOutline___Y6DD1", "originalLabel": "styles-module__originalLabel___HqI9g", "connectorSvg": "styles-module__connectorSvg___Lovld", "connectorLine": "styles-module__connectorLine___XeWh-", "connectorDraw": "styles-module__connectorDraw___8sK5I", "connectorDot": "styles-module__connectorDot___yvf7C", "connectorDotIn": "styles-module__connectorDotIn___NwTUq", "connectorExiting": "styles-module__connectorExiting___2lLOs", "connectorOut": "styles-module__connectorOut___5QoPl", "connectorDotOut": "styles-module__connectorDotOut___FEq7e" };
if (typeof document !== "undefined") {
  let style = document.getElementById("feedback-tool-styles-design-mode-styles");
  if (!style) {
    style = document.createElement("style");
    style.id = "feedback-tool-styles-design-mode-styles";
    document.head.appendChild(style);
  }
  style.textContent = css4;
}
var styles_module_default3 = classNames4;

// src/components/design-mode/index.tsx
import { Fragment as Fragment2, jsx as jsx6, jsxs as jsxs5 } from "react/jsx-runtime";
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
  clearSignal,
  wireframe
}) {
  const [selectedIds, setSelectedIds] = useState3(/* @__PURE__ */ new Set());
  const [drawBox, setDrawBox] = useState3(null);
  const [selectBox, setSelectBox] = useState3(null);
  const [sizeIndicator, setSizeIndicator] = useState3(null);
  const [guides, setGuides] = useState3([]);
  const [editingId, setEditingId] = useState3(null);
  const [editExiting, setEditExiting] = useState3(false);
  const editHadTextRef = useRef3(false);
  const [exitingIds, setExitingIds] = useState3(/* @__PURE__ */ new Set());
  const lastAnnotationTextRef = useRef3(/* @__PURE__ */ new Map());
  const overlayRef = useRef3(null);
  const interactionRef = useRef3(null);
  const placementsRef = useRef3(placements);
  placementsRef.current = placements;
  const onSelectionChangeRef = useRef3(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const onDragMoveRef = useRef3(onDragMove);
  onDragMoveRef.current = onDragMove;
  const onDragEndRef = useRef3(onDragEnd);
  onDragEndRef.current = onDragEnd;
  const deselectRef = useRef3(deselectSignal);
  useEffect3(() => {
    if (deselectSignal !== deselectRef.current) {
      deselectRef.current = deselectSignal;
      setSelectedIds(/* @__PURE__ */ new Set());
    }
  }, [deselectSignal]);
  const clearRef = useRef3(clearSignal);
  useEffect3(() => {
    if (clearSignal !== void 0 && clearSignal !== clearRef.current) {
      clearRef.current = clearSignal;
      const allIds = new Set(placementsRef.current.map((p) => p.id));
      if (allIds.size > 0) {
        setExitingIds(allIds);
        setSelectedIds(/* @__PURE__ */ new Set());
        interactionRef.current = null;
        originalSetTimeout(() => {
          onChange([]);
          setExitingIds(/* @__PURE__ */ new Set());
        }, 180);
      }
    }
  }, [clearSignal, onChange]);
  useEffect3(() => {
    const handleKeyDown = (e) => {
      const target = e.target;
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
  const handleOverlayMouseDown = useCallback2(
    (e) => {
      if (e.button !== 0) return;
      if (passthrough) return;
      const target = e.target;
      if (target.closest(`.${styles_module_default3.placement}`)) return;
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
  const handlePlacementMouseDown = useCallback2(
    (e, id) => {
      if (e.button !== 0) return;
      const target = e.target;
      if (target.closest(`.${styles_module_default3.handle}`) || target.closest(`.${styles_module_default3.deleteButton}`)) return;
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
  const handleResizeMouseDown = useCallback2(
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
  const handleDelete = useCallback2(
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
  const handleDoubleClick = useCallback2((id) => {
    const p = placements.find((pl) => pl.id === id);
    if (!p) return;
    editHadTextRef.current = !!p.text;
    setEditingId(id);
    setEditExiting(false);
  }, [placements]);
  const dismissEdit = useCallback2(() => {
    if (!editingId) return;
    setEditExiting(true);
    originalSetTimeout(() => {
      setEditingId(null);
      setEditExiting(false);
    }, 150);
  }, [editingId]);
  useEffect3(() => {
    if (exiting && editingId) dismissEdit();
  }, [exiting]);
  const submitEdit = useCallback2((text) => {
    if (!editingId) return;
    onChange(placements.map((p) => p.id === editingId ? { ...p, text: text.trim() || void 0 } : p));
    dismissEdit();
  }, [editingId, placements, onChange, dismissEdit]);
  const scrollY = typeof window !== "undefined" ? window.scrollY : 0;
  const cornerHandles = ["nw", "ne", "se", "sw"];
  const arrowColor = wireframe ? "#f97316" : "#3c82f7";
  const edgeHandles = [
    { dir: "n", cls: styles_module_default3.edgeN, arrow: /* @__PURE__ */ jsx6("svg", { width: "8", height: "6", viewBox: "0 0 8 6", fill: "none", children: /* @__PURE__ */ jsx6("path", { d: "M4 0.5L1 4.5h6z", fill: arrowColor }) }) },
    { dir: "e", cls: styles_module_default3.edgeE, arrow: /* @__PURE__ */ jsx6("svg", { width: "6", height: "8", viewBox: "0 0 6 8", fill: "none", children: /* @__PURE__ */ jsx6("path", { d: "M5.5 4L1.5 1v6z", fill: arrowColor }) }) },
    { dir: "s", cls: styles_module_default3.edgeS, arrow: /* @__PURE__ */ jsx6("svg", { width: "8", height: "6", viewBox: "0 0 8 6", fill: "none", children: /* @__PURE__ */ jsx6("path", { d: "M4 5.5L1 1.5h6z", fill: arrowColor }) }) },
    { dir: "w", cls: styles_module_default3.edgeW, arrow: /* @__PURE__ */ jsx6("svg", { width: "6", height: "8", viewBox: "0 0 6 8", fill: "none", children: /* @__PURE__ */ jsx6("path", { d: "M0.5 4L4.5 1v6z", fill: arrowColor }) }) }
  ];
  return /* @__PURE__ */ jsxs5(Fragment2, { children: [
    /* @__PURE__ */ jsx6(
      "div",
      {
        ref: overlayRef,
        className: `${styles_module_default3.overlay} ${!isDarkMode ? styles_module_default3.light : ""} ${activeComponent ? styles_module_default3.placing : ""} ${passthrough ? styles_module_default3.passthrough : ""} ${exiting ? styles_module_default3.overlayExiting : ""} ${wireframe ? styles_module_default3.wireframe : ""}${extraClassName ? ` ${extraClassName}` : ""}`,
        "data-feedback-toolbar": true,
        onMouseDown: handleOverlayMouseDown,
        children: placements.map((p) => {
          const isSelected = selectedIds.has(p.id);
          const label = COMPONENT_MAP[p.type]?.label || p.type;
          const screenY = p.y - scrollY;
          return /* @__PURE__ */ jsxs5(
            "div",
            {
              "data-design-placement": p.id,
              className: `${styles_module_default3.placement} ${isSelected ? styles_module_default3.selected : ""} ${exitingIds.has(p.id) ? styles_module_default3.exiting : ""}`,
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
                /* @__PURE__ */ jsx6("span", { className: styles_module_default3.placementLabel, children: label }),
                /* @__PURE__ */ jsx6("span", { className: `${styles_module_default3.placementAnnotation} ${p.text ? styles_module_default3.annotationVisible : ""}`, children: (() => {
                  if (p.text) lastAnnotationTextRef.current.set(p.id, p.text);
                  return p.text || lastAnnotationTextRef.current.get(p.id) || "";
                })() }),
                /* @__PURE__ */ jsx6("div", { className: styles_module_default3.placementContent, children: /* @__PURE__ */ jsx6(Skeleton, { type: p.type, width: p.width, height: p.height, text: p.text }) }),
                /* @__PURE__ */ jsx6(
                  "div",
                  {
                    className: styles_module_default3.deleteButton,
                    onMouseDown: (e) => e.stopPropagation(),
                    onClick: () => handleDelete(p.id),
                    children: "\u2715"
                  }
                ),
                cornerHandles.map((dir) => /* @__PURE__ */ jsx6(
                  "div",
                  {
                    className: `${styles_module_default3.handle} ${styles_module_default3[`handle${dir.charAt(0).toUpperCase()}${dir.slice(1)}`]}`,
                    onMouseDown: (e) => handleResizeMouseDown(e, p.id, dir)
                  },
                  dir
                )),
                edgeHandles.map(({ dir, cls, arrow }) => /* @__PURE__ */ jsx6(
                  "div",
                  {
                    className: `${styles_module_default3.edgeHandle} ${cls}`,
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
      return /* @__PURE__ */ jsx6(
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
    drawBox && /* @__PURE__ */ jsx6(
      "div",
      {
        className: styles_module_default3.drawBox,
        style: { left: drawBox.x, top: drawBox.y, width: drawBox.w, height: drawBox.h },
        "data-feedback-toolbar": true
      }
    ),
    selectBox && /* @__PURE__ */ jsx6(
      "div",
      {
        className: styles_module_default3.selectBox,
        style: { left: selectBox.x, top: selectBox.y, width: selectBox.w, height: selectBox.h },
        "data-feedback-toolbar": true
      }
    ),
    sizeIndicator && /* @__PURE__ */ jsx6(
      "div",
      {
        className: styles_module_default3.sizeIndicator,
        style: { left: sizeIndicator.x, top: sizeIndicator.y },
        "data-feedback-toolbar": true,
        children: sizeIndicator.text
      }
    ),
    guides.map((g, i) => /* @__PURE__ */ jsx6(
      "div",
      {
        className: styles_module_default3.guideLine,
        style: g.axis === "x" ? { position: "fixed", left: g.pos, top: 0, width: 1, bottom: 0 } : { position: "fixed", left: 0, top: g.pos - scrollY, right: 0, height: 1 },
        "data-feedback-toolbar": true
      },
      `${g.axis}-${g.pos}-${i}`
    ))
  ] });
}

// src/components/design-mode/palette.tsx
import { useEffect as useEffect4, useRef as useRef4, useState as useState4 } from "react";
import { Fragment as Fragment3, jsx as jsx7, jsxs as jsxs6 } from "react/jsx-runtime";
function scrollFadeClass(el) {
  if (!el) return "";
  const top = el.scrollTop > 2;
  const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
  return `${top ? styles_module_default3.fadeTop : ""} ${bottom ? styles_module_default3.fadeBottom : ""}`;
}
var s = "currentColor";
var sw = "0.5";
function PaletteIconSvg({ type }) {
  switch (type) {
    case "navigation":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1", y: "4", width: "18", height: "8", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "2.5", y: "7", width: "3", height: "1.5", rx: ".5", fill: s, opacity: ".4" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "7", width: "2.5", height: "1.5", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "11", y: "7", width: "2.5", height: "1.5", rx: ".5", fill: s, opacity: ".25" })
      ] });
    case "header":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1", y: "2", width: "18", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "5.5", width: "8", height: "2", rx: ".5", fill: s, opacity: ".35" }),
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "9", width: "12", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "hero":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1", y: "1", width: "18", height: "14", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "5", width: "10", height: "1.5", rx: ".5", fill: s, opacity: ".35" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "8", width: "6", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "7.5", y: "10.5", width: "5", height: "2.5", rx: "1", stroke: s, strokeWidth: sw })
      ] });
    case "section":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1", y: "1", width: "18", height: "14", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "4", width: "6", height: "1", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "6.5", width: "14", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "9", width: "10", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "sidebar":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1", y: "1", width: "7", height: "14", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "2.5", y: "4", width: "4", height: "1", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "2.5", y: "6.5", width: "3.5", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "2.5", y: "9", width: "4", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "footer":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1", y: "7", width: "18", height: "8", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "9.5", width: "4", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "9", y: "9.5", width: "4", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "15", y: "9.5", width: "3", height: "1", rx: ".5", fill: s, opacity: ".2" })
      ] });
    case "modal":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "2", width: "14", height: "12", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "4.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "7", width: "10", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "11", y: "11", width: "5", height: "2", rx: ".75", stroke: s, strokeWidth: sw })
      ] });
    case "divider":
      return /* @__PURE__ */ jsx7("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: /* @__PURE__ */ jsx7("line", { x1: "2", y1: "8", x2: "18", y2: "8", stroke: s, strokeWidth: "0.5", opacity: ".3" }) });
    case "card":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "1", width: "16", height: "14", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "1", width: "16", height: "5.5", rx: "1", fill: s, opacity: ".04" }),
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "8.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "11", width: "11", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "text":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "4", width: "14", height: "1.5", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "7", width: "11", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "9.5", width: "13", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "12", width: "8", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "image":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "2", width: "16", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("line", { x1: "2", y1: "2", x2: "18", y2: "14", stroke: s, strokeWidth: ".3", opacity: ".25" }),
        /* @__PURE__ */ jsx7("line", { x1: "18", y1: "2", x2: "2", y2: "14", stroke: s, strokeWidth: ".3", opacity: ".25" })
      ] });
    case "video":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "2", width: "16", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("path", { d: "M8.5 5.5v5l4.5-2.5z", stroke: s, strokeWidth: sw, fill: s, opacity: ".15" })
      ] });
    case "table":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1", y: "2", width: "18", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("line", { x1: "1", y1: "5.5", x2: "19", y2: "5.5", stroke: s, strokeWidth: ".3", opacity: ".25" }),
        /* @__PURE__ */ jsx7("line", { x1: "1", y1: "9", x2: "19", y2: "9", stroke: s, strokeWidth: ".3", opacity: ".25" }),
        /* @__PURE__ */ jsx7("line", { x1: "7", y1: "2", x2: "7", y2: "14", stroke: s, strokeWidth: ".3", opacity: ".25" }),
        /* @__PURE__ */ jsx7("line", { x1: "13", y1: "2", x2: "13", y2: "14", stroke: s, strokeWidth: ".3", opacity: ".25" })
      ] });
    case "grid":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1.5", y: "2", width: "7", height: "5.5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "11.5", y: "2", width: "7", height: "5.5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "1.5", y: "9.5", width: "7", height: "5.5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "11.5", y: "9.5", width: "7", height: "5.5", rx: "1", stroke: s, strokeWidth: sw })
      ] });
    case "list":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("circle", { cx: "3.5", cy: "4.5", r: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "6.5", y: "4", width: "10", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("circle", { cx: "3.5", cy: "8", r: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "6.5", y: "7.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("circle", { cx: "3.5", cy: "11.5", r: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "6.5", y: "11", width: "11", height: "1", rx: ".5", fill: s, opacity: ".2" })
      ] });
    case "chart":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "9", width: "2.5", height: "4", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "6", width: "2.5", height: "7", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "11", y: "3", width: "2.5", height: "10", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "15", y: "5", width: "2.5", height: "8", rx: ".5", fill: s, opacity: ".2" })
      ] });
    case "accordion":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1.5", y: "2", width: "17", height: "4", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "3.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "1.5", y: "7.5", width: "17", height: "3", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "1.5", y: "12", width: "17", height: "3", rx: "1", stroke: s, strokeWidth: sw })
      ] });
    case "carousel":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "2", width: "14", height: "10", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("path", { d: "M1.5 7L3 8.5 1.5 10", stroke: s, strokeWidth: sw, opacity: ".35" }),
        /* @__PURE__ */ jsx7("path", { d: "M18.5 7L17 8.5 18.5 10", stroke: s, strokeWidth: sw, opacity: ".35" }),
        /* @__PURE__ */ jsx7("circle", { cx: "8.5", cy: "14", r: ".6", fill: s, opacity: ".35" }),
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "14", r: ".6", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("circle", { cx: "11.5", cy: "14", r: ".6", fill: s, opacity: ".15" })
      ] });
    case "button":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "5", width: "14", height: "6", rx: "2", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "6.5", y: "7.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".25" })
      ] });
    case "input":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "4", width: "5.5", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "6.5", width: "16", height: "5.5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "3.5", y: "8.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "search":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "4.5", width: "16", height: "7", rx: "3.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("circle", { cx: "6", cy: "8", r: "2", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ jsx7("line", { x1: "7.5", y1: "9.5", x2: "9", y2: "11", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "9.5", y: "7.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "form":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "1.5", width: "5.5", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "3.5", width: "16", height: "3", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "8", width: "7", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "10", width: "16", height: "3", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "12", y: "14", width: "6", height: "2", rx: ".75", stroke: s, strokeWidth: sw })
      ] });
    case "tabs":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1", y: "5", width: "18", height: "10", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "1", y: "2", width: "6", height: "3.5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "2.5", y: "3.25", width: "3", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "2", width: "6", height: "3.5", rx: ".75", stroke: s, strokeWidth: sw })
      ] });
    case "dropdown":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "2", width: "16", height: "4", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "3.5", y: "3.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("path", { d: "M15 3.5l1.5 1.5L18 3.5", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "7", width: "16", height: "7", rx: "1", stroke: s, strokeWidth: sw, strokeDasharray: "2 1", opacity: ".3" })
      ] });
    case "toggle":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "5", width: "12", height: "6", rx: "3", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("circle", { cx: "13", cy: "8", r: "2", fill: s, opacity: ".3" })
      ] });
    case "avatar":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "8", r: "6", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "6.5", r: "2", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("path", { d: "M6.5 13c0-2 1.5-3.5 3.5-3.5s3.5 1.5 3.5 3.5", stroke: s, strokeWidth: sw })
      ] });
    case "badge":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "5", width: "14", height: "6", rx: "3", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "6", y: "7.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".25" })
      ] });
    case "breadcrumb":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1.5", y: "7", width: "3.5", height: "1", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("path", { d: "M6.5 7l1 1-1 1", stroke: s, strokeWidth: sw, opacity: ".2" }),
        /* @__PURE__ */ jsx7("rect", { x: "9", y: "7", width: "3.5", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("path", { d: "M14 7l1 1-1 1", stroke: s, strokeWidth: sw, opacity: ".2" }),
        /* @__PURE__ */ jsx7("rect", { x: "16.5", y: "7", width: "2", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "pagination":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "5.5", width: "3.5", height: "5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "6.5", y: "5.5", width: "3.5", height: "5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "11", y: "5.5", width: "3.5", height: "5", rx: "1", fill: s, opacity: ".15", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "15.5", y: "5.5", width: "3.5", height: "5", rx: "1", stroke: s, strokeWidth: sw })
      ] });
    case "progress":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "7", width: "16", height: "2", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "7", width: "10", height: "2", rx: "1", fill: s, opacity: ".2" })
      ] });
    case "toast":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "4", width: "16", height: "8", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("circle", { cx: "5", cy: "8", r: "1.5", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "8", y: "6.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "8", y: "9", width: "5", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "tooltip":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "3", width: "14", height: "7", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "5.5", y: "5.5", width: "9", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("path", { d: "M9 10l1 2.5 1-2.5", stroke: s, strokeWidth: sw })
      ] });
    case "pricing":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "1", width: "16", height: "14", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "6", y: "3", width: "8", height: "1.5", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "5.5", width: "6", height: "2", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "9", width: "10", height: "1", rx: ".5", fill: s, opacity: ".1" }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "11", width: "10", height: "1", rx: ".5", fill: s, opacity: ".1" }),
        /* @__PURE__ */ jsx7("rect", { x: "6", y: "13", width: "8", height: "1.5", rx: ".5", fill: s, opacity: ".2" })
      ] });
    case "testimonial":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "1", width: "16", height: "14", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("text", { x: "4", y: "5.5", fontSize: "4", fill: s, opacity: ".2", fontFamily: "serif", children: "\u201C" }),
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "7", width: "12", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "9", width: "9", height: "1", rx: ".5", fill: s, opacity: ".12" }),
        /* @__PURE__ */ jsx7("circle", { cx: "5.5", cy: "12.5", r: "1.5", stroke: s, strokeWidth: sw, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "8", y: "12", width: "5", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "cta":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1", y: "2", width: "18", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "4.5", width: "10", height: "1.5", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "6", y: "7.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "10", width: "6", height: "2.5", rx: "1", stroke: s, strokeWidth: sw })
      ] });
    case "alert":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "4", width: "16", height: "8", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("circle", { cx: "6", cy: "8", r: "2", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ jsx7("line", { x1: "6", y1: "7", x2: "6", y2: "8.5", stroke: s, strokeWidth: "0.6", opacity: ".5" }),
        /* @__PURE__ */ jsx7("circle", { cx: "6", cy: "9.3", r: ".3", fill: s, opacity: ".5" }),
        /* @__PURE__ */ jsx7("rect", { x: "9.5", y: "7", width: "6", height: "1", rx: ".5", fill: s, opacity: ".2" })
      ] });
    case "banner":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1", y: "5", width: "18", height: "6", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "7.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "14", y: "7", width: "3.5", height: "2", rx: ".75", stroke: s, strokeWidth: sw })
      ] });
    case "stat":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "2", width: "14", height: "12", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "6", y: "4.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "7", width: "10", height: "2.5", rx: ".5", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "11", width: "6", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "stepper":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("circle", { cx: "4", cy: "8", r: "2", fill: s, opacity: ".2", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("line", { x1: "6", y1: "8", x2: "8", y2: "8", stroke: s, strokeWidth: ".4", opacity: ".3" }),
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "8", r: "2", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("line", { x1: "12", y1: "8", x2: "14", y2: "8", stroke: s, strokeWidth: ".4", opacity: ".3" }),
        /* @__PURE__ */ jsx7("circle", { cx: "16", cy: "8", r: "2", stroke: s, strokeWidth: sw })
      ] });
    case "tag":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "5", width: "14", height: "6", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "5.5", y: "7.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("line", { x1: "14", y1: "6.5", x2: "15.5", y2: "9.5", stroke: s, strokeWidth: sw, opacity: ".2" }),
        /* @__PURE__ */ jsx7("line", { x1: "15.5", y1: "6.5", x2: "14", y2: "9.5", stroke: s, strokeWidth: sw, opacity: ".2" })
      ] });
    case "rating":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("path", { d: "M4 5.5l1 2 2.2.3-1.6 1.5.4 2.2L4 10.3l-2 1.2.4-2.2L.8 7.8 3 7.5z", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("path", { d: "M10 5.5l1 2 2.2.3-1.6 1.5.4 2.2L10 10.3l-2 1.2.4-2.2L6.8 7.8 9 7.5z", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("path", { d: "M16 5.5l1 2 2.2.3-1.6 1.5.4 2.2L16 10.3l-2 1.2.4-2.2-1.6-1.5 2.2-.3z", stroke: s, strokeWidth: sw, opacity: ".25" })
      ] });
    case "map":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "2", width: "16", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("line", { x1: "2", y1: "6", x2: "18", y2: "10", stroke: s, strokeWidth: ".3", opacity: ".15" }),
        /* @__PURE__ */ jsx7("line", { x1: "7", y1: "2", x2: "11", y2: "14", stroke: s, strokeWidth: ".3", opacity: ".15" }),
        /* @__PURE__ */ jsx7("path", { d: "M10 5c-1.7 0-3 1.3-3 3 0 2.5 3 5 3 5s3-2.5 3-5c0-1.7-1.3-3-3-3z", fill: s, opacity: ".15", stroke: s, strokeWidth: sw })
      ] });
    case "timeline":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("line", { x1: "5", y1: "2", x2: "5", y2: "14", stroke: s, strokeWidth: ".4", opacity: ".25" }),
        /* @__PURE__ */ jsx7("circle", { cx: "5", cy: "4", r: "1.5", fill: s, opacity: ".2", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "8", y: "3", width: "8", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("circle", { cx: "5", cy: "8.5", r: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "8", y: "7.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("circle", { cx: "5", cy: "13", r: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "8", y: "12", width: "7", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "fileUpload":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "2", width: "14", height: "12", rx: "1.5", stroke: s, strokeWidth: sw, strokeDasharray: "2 1" }),
        /* @__PURE__ */ jsx7("path", { d: "M10 10V5.5m0 0L7.5 8m2.5-2.5L12.5 8", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "11.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".15" })
      ] });
    case "codeBlock":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "2", width: "16", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("circle", { cx: "4", cy: "4", r: ".6", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("circle", { cx: "5.5", cy: "4", r: ".6", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("circle", { cx: "7", cy: "4", r: ".6", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "7", width: "7", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("rect", { x: "6", y: "9", width: "5", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "11", width: "8", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "calendar":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "3", width: "16", height: "12", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("line", { x1: "2", y1: "6.5", x2: "18", y2: "6.5", stroke: s, strokeWidth: ".4", opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "4", width: "1", height: "1.5", rx: ".3", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("rect", { x: "14", y: "4", width: "1", height: "1.5", rx: ".3", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("circle", { cx: "7", cy: "9", r: ".6", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "9", r: ".6", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("circle", { cx: "13", cy: "9", r: ".6", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("circle", { cx: "7", cy: "12", r: ".6", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "12", r: ".6", fill: s, opacity: ".2" })
      ] });
    case "notification":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "3", width: "16", height: "10", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("circle", { cx: "5.5", cy: "8", r: "2", stroke: s, strokeWidth: sw, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "9", y: "6", width: "6", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "9", y: "8.5", width: "4.5", height: "1", rx: ".5", fill: s, opacity: ".12" }),
        /* @__PURE__ */ jsx7("circle", { cx: "16.5", cy: "4.5", r: "1.5", fill: s, opacity: ".25" })
      ] });
    case "productCard":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "1", width: "14", height: "14", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "1", width: "14", height: "6", rx: "1", fill: s, opacity: ".04" }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "8.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "10.5", width: "4", height: "1.5", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "12", y: "12", width: "4", height: "2", rx: ".75", stroke: s, strokeWidth: sw })
      ] });
    case "profile":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "5", r: "3", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "10", width: "10", height: "1.5", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "12.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "drawer":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "9", y: "1", width: "10", height: "14", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "10.5", y: "4", width: "5", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "10.5", y: "6.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "10.5", y: "9", width: "6", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "1", y: "1", width: "7", height: "14", rx: "1", stroke: s, strokeWidth: sw, opacity: ".15" })
      ] });
    case "popover":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "2", width: "14", height: "9", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "4.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "7", width: "6", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("path", { d: "M9 11l1 2.5 1-2.5", stroke: s, strokeWidth: sw })
      ] });
    case "logo":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "3", width: "10", height: "10", rx: "2", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("path", { d: "M5 9.5l2-4 2 4", stroke: s, strokeWidth: sw, opacity: ".3" }),
        /* @__PURE__ */ jsx7("rect", { x: "14", y: "6", width: "4", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("rect", { x: "14", y: "8.5", width: "3", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "faq":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("text", { x: "2.5", y: "5.5", fontSize: "4", fill: s, opacity: ".3", fontWeight: "bold", children: "?" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "3", width: "10", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "5.5", width: "8", height: "1", rx: ".5", fill: s, opacity: ".12" }),
        /* @__PURE__ */ jsx7("text", { x: "2.5", y: "11.5", fontSize: "4", fill: s, opacity: ".3", fontWeight: "bold", children: "?" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "9", width: "9", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "7", y: "11.5", width: "7", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "gallery":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1.5", y: "1.5", width: "5", height: "5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "7.5", y: "1.5", width: "5", height: "5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "13.5", y: "1.5", width: "5", height: "5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "1.5", y: "9.5", width: "5", height: "5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "7.5", y: "9.5", width: "5", height: "5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "13.5", y: "9.5", width: "5", height: "5", rx: ".75", stroke: s, strokeWidth: sw })
      ] });
    case "checkbox":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "4", width: "8", height: "8", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("path", { d: "M7.5 8l1.5 1.5 3-3", stroke: s, strokeWidth: sw, opacity: ".35" })
      ] });
    case "radio":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "8", r: "4", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "8", r: "2", fill: s, opacity: ".3" })
      ] });
    case "slider":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "7.5", width: "16", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "7.5", width: "10", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("circle", { cx: "12", cy: "8", r: "2.5", stroke: s, strokeWidth: sw })
      ] });
    case "datePicker":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "1", width: "16", height: "5", rx: "1", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "3.5", y: "3", width: "5", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("rect", { x: "14", y: "2.5", width: "2.5", height: "2", rx: ".5", fill: s, opacity: ".12" }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "7", width: "16", height: "8", rx: "1", stroke: s, strokeWidth: sw, strokeDasharray: "2 1", opacity: ".3" }),
        /* @__PURE__ */ jsx7("circle", { cx: "6", cy: "10", r: ".6", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "10", r: ".6", fill: s, opacity: ".3" }),
        /* @__PURE__ */ jsx7("circle", { cx: "14", cy: "10", r: ".6", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("circle", { cx: "6", cy: "13", r: ".6", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "13", r: ".6", fill: s, opacity: ".2" })
      ] });
    case "skeleton":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "2", width: "16", height: "3", rx: "1", fill: s, opacity: ".08" }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "7", width: "10", height: "2", rx: ".75", fill: s, opacity: ".08" }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "11", width: "13", height: "2", rx: ".75", fill: s, opacity: ".08" })
      ] });
    case "chip":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "1.5", y: "5", width: "10", height: "6", rx: "3", fill: s, opacity: ".08", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "7.5", width: "4", height: "1", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("line", { x1: "9.5", y1: "6.5", x2: "10.5", y2: "9.5", stroke: s, strokeWidth: sw, opacity: ".2" }),
        /* @__PURE__ */ jsx7("line", { x1: "10.5", y1: "6.5", x2: "9.5", y2: "9.5", stroke: s, strokeWidth: sw, opacity: ".2" }),
        /* @__PURE__ */ jsx7("rect", { x: "13", y: "5", width: "5.5", height: "6", rx: "3", stroke: s, strokeWidth: sw, opacity: ".25" })
      ] });
    case "icon":
      return /* @__PURE__ */ jsx7("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: /* @__PURE__ */ jsx7("path", { d: "M10 3l1.5 3 3.5.5-2.5 2.5.5 3.5L10 11l-3 1.5.5-3.5L5 6.5l3.5-.5z", stroke: s, strokeWidth: sw, opacity: ".3" }) });
    case "spinner":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "8", r: "5", stroke: s, strokeWidth: sw, opacity: ".12" }),
        /* @__PURE__ */ jsx7("path", { d: "M10 3a5 5 0 0 1 5 5", stroke: s, strokeWidth: sw, opacity: ".35", strokeLinecap: "round" })
      ] });
    case "feature":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "2", width: "5", height: "5", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("path", { d: "M4.5 3.5v3m-1.5-1.5h3", stroke: s, strokeWidth: sw, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "9", y: "2.5", width: "8", height: "1.5", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "9", y: "5.5", width: "6", height: "1", rx: ".5", fill: s, opacity: ".12" }),
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "10", width: "5", height: "5", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "9", y: "10.5", width: "7", height: "1.5", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "9", y: "13.5", width: "5", height: "1", rx: ".5", fill: s, opacity: ".12" })
      ] });
    case "team":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("circle", { cx: "5", cy: "5", r: "2.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "2.5", y: "9", width: "5", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("circle", { cx: "15", cy: "5", r: "2.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "12.5", y: "9", width: "5", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("circle", { cx: "10", cy: "5", r: "2.5", stroke: s, strokeWidth: sw, opacity: ".5" }),
        /* @__PURE__ */ jsx7("rect", { x: "7.5", y: "9", width: "5", height: "1", rx: ".5", fill: s, opacity: ".15" }),
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "12", width: "12", height: "1", rx: ".5", fill: s, opacity: ".1" })
      ] });
    case "login":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "3", y: "1", width: "14", height: "14", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "6", y: "3", width: "8", height: "1.5", rx: ".5", fill: s, opacity: ".25" }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "5.5", width: "10", height: "3", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "5", y: "9.5", width: "10", height: "3", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "6.5", y: "13.5", width: "7", height: "2", rx: ".75", fill: s, opacity: ".2" })
      ] });
    case "contact":
      return /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 20 16", width: "20", height: "16", fill: "none", children: [
        /* @__PURE__ */ jsx7("rect", { x: "2", y: "1", width: "16", height: "14", rx: "1.5", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "3", width: "5", height: "1", rx: ".5", fill: s, opacity: ".2" }),
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "5", width: "12", height: "2.5", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "4", y: "8.5", width: "12", height: "4", rx: ".75", stroke: s, strokeWidth: sw }),
        /* @__PURE__ */ jsx7("rect", { x: "11", y: "13.5", width: "5", height: "1.5", rx: ".5", fill: s, opacity: ".2" })
      ] });
    default:
      return null;
  }
}
function ComponentGrid({ activeType, onSelect, onDragStart, scrollRef, fadeClass, blankCanvas }) {
  return /* @__PURE__ */ jsx7("div", { ref: scrollRef, className: `${styles_module_default3.placeScroll} ${fadeClass || ""}`, children: COMPONENT_REGISTRY.map((section) => /* @__PURE__ */ jsxs6("div", { className: styles_module_default3.paletteSection, children: [
    /* @__PURE__ */ jsx7("div", { className: styles_module_default3.paletteSectionTitle, children: section.section }),
    section.items.map((item) => /* @__PURE__ */ jsxs6(
      "div",
      {
        className: `${styles_module_default3.paletteItem} ${activeType === item.type ? styles_module_default3.active : ""} ${blankCanvas ? styles_module_default3.wireframe : ""}`,
        onClick: () => onSelect(item.type),
        onMouseDown: (e) => {
          if (e.button === 0) onDragStart(item.type, e);
        },
        children: [
          /* @__PURE__ */ jsx7("div", { className: styles_module_default3.paletteItemIcon, children: /* @__PURE__ */ jsx7(PaletteIconSvg, { type: item.type }) }),
          /* @__PURE__ */ jsx7("span", { className: styles_module_default3.paletteItemLabel, children: item.label })
        ]
      },
      item.type
    ))
  ] }, section.section)) });
}
function RollingCount({ value, suffix }) {
  const [prev, setPrev] = useState4(null);
  const [prevSuffix, setPrevSuffix] = useState4(suffix);
  const [dir, setDir] = useState4("up");
  const cur = useRef4(value);
  const curSuffix = useRef4(suffix);
  const timer = useRef4();
  const suffixChanged = prev !== null && prevSuffix !== suffix;
  useEffect4(() => {
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
  if (prev === null) return /* @__PURE__ */ jsxs6(Fragment3, { children: [
    value,
    suffix ? ` ${suffix}` : ""
  ] });
  if (suffixChanged) {
    return /* @__PURE__ */ jsxs6("span", { className: styles_module_default3.rollingWrap, children: [
      /* @__PURE__ */ jsxs6("span", { style: { visibility: "hidden" }, children: [
        value,
        " ",
        suffix
      ] }),
      /* @__PURE__ */ jsxs6("span", { className: `${styles_module_default3.rollingNum} ${dir === "up" ? styles_module_default3.exitUp : styles_module_default3.exitDown}`, children: [
        prev,
        " ",
        prevSuffix
      ] }, `o${prev}-${value}`),
      /* @__PURE__ */ jsxs6("span", { className: `${styles_module_default3.rollingNum} ${dir === "up" ? styles_module_default3.enterUp : styles_module_default3.enterDown}`, children: [
        value,
        " ",
        suffix
      ] }, `n${value}`)
    ] });
  }
  return /* @__PURE__ */ jsxs6(Fragment3, { children: [
    /* @__PURE__ */ jsxs6("span", { className: styles_module_default3.rollingWrap, children: [
      /* @__PURE__ */ jsx7("span", { style: { visibility: "hidden" }, children: value }),
      /* @__PURE__ */ jsx7("span", { className: `${styles_module_default3.rollingNum} ${dir === "up" ? styles_module_default3.exitUp : styles_module_default3.exitDown}`, children: prev }, `o${prev}-${value}`),
      /* @__PURE__ */ jsx7("span", { className: `${styles_module_default3.rollingNum} ${dir === "up" ? styles_module_default3.enterUp : styles_module_default3.enterDown}`, children: value }, `n${value}`)
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
  const [mounted, setMounted] = useState4(false);
  const [animClass, setAnimClass] = useState4("exit");
  const [footerVisible, setFooterVisible] = useState4(false);
  const [footerCollapsed, setFooterCollapsed] = useState4(true);
  const lastFooterCount = useRef4(0);
  const lastFooterSuffix = useRef4("");
  const rafRef = useRef4(0);
  const exitTimerRef = useRef4();
  const placeScrollRef = useRef4(null);
  const [placeFade, setPlaceFade] = useState4("");
  useEffect4(() => {
    if (visible) {
      setMounted(true);
      clearTimeout(exitTimerRef.current);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = originalRequestAnimationFrame(() => {
        rafRef.current = originalRequestAnimationFrame(() => {
          setAnimClass("enter");
        });
      });
    } else {
      cancelAnimationFrame(rafRef.current);
      setAnimClass("exit");
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = originalSetTimeout(() => {
        setMounted(false);
        onExited?.();
      }, 200);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [visible]);
  const hasFooterContent = placementCount > 0 || sectionCount > 0;
  const totalCount = placementCount + sectionCount;
  if (totalCount > 0) {
    lastFooterCount.current = totalCount;
    lastFooterSuffix.current = blankCanvas ? totalCount === 1 ? "Component" : "Components" : totalCount === 1 ? "Change" : "Changes";
  }
  useEffect4(() => {
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
  useEffect4(() => {
    if (!mounted) return;
    const el = placeScrollRef.current;
    if (!el) return;
    const update = () => setPlaceFade(scrollFadeClass(el));
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [mounted]);
  if (!mounted) return null;
  const footerParts = [];
  if (placementCount > 0) footerParts.push("placed");
  if (sectionCount > 0) footerParts.push("captured");
  return /* @__PURE__ */ jsxs6(
    "div",
    {
      className: `${styles_module_default3.palette} ${styles_module_default3[animClass]} ${!isDarkMode ? styles_module_default3.light : ""}`,
      "data-feedback-toolbar": true,
      "data-agentation-palette": true,
      onClick: (e) => e.stopPropagation(),
      onMouseDown: (e) => e.stopPropagation(),
      onTransitionEnd: (e) => {
        if (e.target !== e.currentTarget) return;
        if (!visible) {
          clearTimeout(exitTimerRef.current);
          setMounted(false);
          setAnimClass("exit");
          onExited?.();
        }
      },
      children: [
        /* @__PURE__ */ jsxs6("div", { className: styles_module_default3.paletteHeader, children: [
          /* @__PURE__ */ jsx7("div", { className: styles_module_default3.paletteHeaderTitle, children: "Layout Mode" }),
          /* @__PURE__ */ jsxs6("div", { className: styles_module_default3.paletteHeaderDesc, children: [
            "Rearrange and resize existing elements, add new components, and explore layout ideas. Agent results may vary.",
            " ",
            /* @__PURE__ */ jsx7("a", { href: "https://agentation.dev/features#layout-mode", target: "_blank", rel: "noopener noreferrer", children: "Learn more." })
          ] })
        ] }),
        /* @__PURE__ */ jsxs6(
          "div",
          {
            className: `${styles_module_default3.canvasToggle} ${blankCanvas ? styles_module_default3.active : ""}`,
            onClick: () => onBlankCanvasChange(!blankCanvas),
            children: [
              /* @__PURE__ */ jsx7("span", { className: styles_module_default3.canvasToggleIcon, children: /* @__PURE__ */ jsxs6("svg", { viewBox: "0 0 14 14", width: "14", height: "14", fill: "none", children: [
                /* @__PURE__ */ jsx7("rect", { x: "1", y: "1", width: "12", height: "12", rx: "2", stroke: "currentColor", strokeWidth: "1" }),
                /* @__PURE__ */ jsx7("circle", { cx: "4.5", cy: "4.5", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ jsx7("circle", { cx: "7", cy: "4.5", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ jsx7("circle", { cx: "9.5", cy: "4.5", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ jsx7("circle", { cx: "4.5", cy: "7", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ jsx7("circle", { cx: "7", cy: "7", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ jsx7("circle", { cx: "9.5", cy: "7", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ jsx7("circle", { cx: "4.5", cy: "9.5", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ jsx7("circle", { cx: "7", cy: "9.5", r: "0.8", fill: "currentColor", opacity: ".6" }),
                /* @__PURE__ */ jsx7("circle", { cx: "9.5", cy: "9.5", r: "0.8", fill: "currentColor", opacity: ".6" })
              ] }) }),
              /* @__PURE__ */ jsx7("span", { className: styles_module_default3.canvasToggleLabel, children: "Wireframe New Page" })
            ]
          }
        ),
        /* @__PURE__ */ jsx7("div", { className: `${styles_module_default3.wireframePurposeWrap} ${!blankCanvas ? styles_module_default3.collapsed : ""}`, children: /* @__PURE__ */ jsx7("div", { className: styles_module_default3.wireframePurposeInner, children: /* @__PURE__ */ jsx7(
          "textarea",
          {
            className: styles_module_default3.wireframePurposeInput,
            placeholder: "Describe this page to provide additional context for your agent.",
            value: wireframePurpose,
            onChange: (e) => onWireframePurposeChange(e.target.value),
            rows: 2
          }
        ) }) }),
        /* @__PURE__ */ jsx7(
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
        footerVisible && /* @__PURE__ */ jsx7("div", { className: `${styles_module_default3.paletteFooterWrap} ${footerCollapsed ? styles_module_default3.footerHidden : ""}`, children: /* @__PURE__ */ jsx7("div", { className: styles_module_default3.paletteFooterInner, children: /* @__PURE__ */ jsx7("div", { className: styles_module_default3.paletteFooterInnerContent, children: /* @__PURE__ */ jsxs6("div", { className: styles_module_default3.paletteFooter, children: [
          /* @__PURE__ */ jsx7("span", { className: styles_module_default3.paletteFooterCount, children: /* @__PURE__ */ jsx7(RollingCount, { value: lastFooterCount.current, suffix: lastFooterSuffix.current }) }),
          /* @__PURE__ */ jsx7("button", { className: styles_module_default3.paletteFooterClear, onClick: onClearPlacements, children: "Clear" })
        ] }) }) }) })
      ]
    }
  );
}

// src/components/design-mode/rearrange.tsx
import { useState as useState5, useCallback as useCallback4, useEffect as useEffect5, useRef as useRef5 } from "react";

// src/utils/element-identification.ts
function getParentElement(element) {
  if (element.parentElement) {
    return element.parentElement;
  }
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) {
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
  return element.getRootNode() instanceof ShadowRoot;
}
function getShadowHost(element) {
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) {
    return root.host;
  }
  return null;
}
function getElementPath(target, maxDepth = 4) {
  const parts = [];
  let current = target;
  let depth = 0;
  while (current && depth < maxDepth) {
    const tag = current.tagName.toLowerCase();
    if (tag === "html" || tag === "body") break;
    let identifier = tag;
    if (current.id) {
      identifier = `#${current.id}`;
    } else if (current.className && typeof current.className === "string") {
      const meaningfulClass = current.className.split(/\s+/).find((c) => c.length > 2 && !c.match(/^[a-z]{1,2}$/) && !c.match(/[A-Z0-9]{5,}/));
      if (meaningfulClass) {
        identifier = `.${meaningfulClass.split("_")[0]}`;
      }
    }
    const nextParent = getParentElement(current);
    if (!current.parentElement && nextParent) {
      identifier = `\u27E8shadow\u27E9 ${identifier}`;
    }
    parts.unshift(identifier);
    current = nextParent;
    depth++;
  }
  return parts.join(" > ");
}
function identifyElement(target) {
  const path = getElementPath(target);
  if (target.dataset.element) {
    return { name: target.dataset.element, path };
  }
  const tag = target.tagName.toLowerCase();
  if (["path", "circle", "rect", "line", "g"].includes(tag)) {
    const svg = closestCrossingShadow(target, "svg");
    if (svg) {
      const parent = getParentElement(svg);
      if (parent instanceof HTMLElement) {
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
  const children = elementRoot instanceof ShadowRoot && element.parentElement ? Array.from(element.parentElement.children) : Array.from(parent.children);
  const siblings = children.filter(
    (child) => child !== element && child instanceof HTMLElement
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
  const styles = window.getComputedStyle(target);
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
  const styles = window.getComputedStyle(target);
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
  return parts.join(" > ");
}

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
import { Fragment as Fragment4, jsx as jsx8, jsxs as jsxs7 } from "react/jsx-runtime";
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
function RearrangeOverlay({ rearrangeState, onChange, isDarkMode, exiting, className: extraClassName, blankCanvas, extraSnapRects, onSelectionChange, deselectSignal, onDragMove, onDragEnd, clearSignal }) {
  const { sections } = rearrangeState;
  const rearrangeStateRef = useRef5(rearrangeState);
  rearrangeStateRef.current = rearrangeState;
  const [selectedIds, setSelectedIds] = useState5(/* @__PURE__ */ new Set());
  const [exitingAll, setExitingAll] = useState5(false);
  const clearRef = useRef5(clearSignal);
  useEffect5(() => {
    if (clearSignal !== void 0 && clearSignal !== clearRef.current) {
      clearRef.current = clearSignal;
      if (sections.length > 0) {
        setExitingAll(true);
      }
    }
  }, [clearSignal, sections.length]);
  const deselectRef = useRef5(deselectSignal);
  useEffect5(() => {
    if (deselectSignal !== deselectRef.current) {
      deselectRef.current = deselectSignal;
      setSelectedIds(/* @__PURE__ */ new Set());
    }
  }, [deselectSignal]);
  const [editingId, setEditingId] = useState5(null);
  const [editExiting, setEditExiting] = useState5(false);
  const editHadNoteRef = useRef5(false);
  const handleDoubleClick = useCallback4((id) => {
    const s2 = sections.find((sec) => sec.id === id);
    if (!s2) return;
    editHadNoteRef.current = !!s2.note;
    setEditingId(id);
    setEditExiting(false);
  }, [sections]);
  const dismissEdit = useCallback4(() => {
    if (!editingId) return;
    setEditExiting(true);
    originalSetTimeout(() => {
      setEditingId(null);
      setEditExiting(false);
    }, 150);
  }, [editingId]);
  const submitEdit = useCallback4((text) => {
    if (!editingId) return;
    onChange({
      ...rearrangeState,
      sections: sections.map((s2) => s2.id === editingId ? { ...s2, note: text.trim() || void 0 } : s2)
    });
    dismissEdit();
  }, [editingId, sections, rearrangeState, onChange, dismissEdit]);
  useEffect5(() => {
    if (exiting && editingId) dismissEdit();
  }, [exiting]);
  const [exitingIds, setExitingIds] = useState5(/* @__PURE__ */ new Set());
  const lastNoteTextRef = useRef5(/* @__PURE__ */ new Map());
  const [hoverHighlight, setHoverHighlight] = useState5(null);
  const [sizeIndicator, setSizeIndicator] = useState5(null);
  const [snapGuides, setSnapGuides] = useState5([]);
  const [scrollY, setScrollY] = useState5(0);
  const interactionRef = useRef5(null);
  const seenGhostIdsRef = useRef5(/* @__PURE__ */ new Set());
  const firstActionRef = useRef5(/* @__PURE__ */ new Map());
  const [dragPositions, setDragPositions] = useState5(/* @__PURE__ */ new Map());
  const [exitingConnectors, setExitingConnectors] = useState5(/* @__PURE__ */ new Map());
  const prevChangedIdsRef = useRef5(/* @__PURE__ */ new Set());
  const lastChangedRectsRef = useRef5(/* @__PURE__ */ new Map());
  const onSelectionChangeRef = useRef5(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const onDragMoveRef = useRef5(onDragMove);
  onDragMoveRef.current = onDragMove;
  const onDragEndRef = useRef5(onDragEnd);
  onDragEndRef.current = onDragEnd;
  useEffect5(() => {
    if (blankCanvas) setSelectedIds(/* @__PURE__ */ new Set());
  }, [blankCanvas]);
  const [outlinesReady, setOutlinesReady] = useState5(
    () => !rearrangeState.sections.some((s2) => {
      const o = s2.originalRect, c = s2.currentRect;
      return Math.abs(o.x - c.x) > 1 || Math.abs(o.y - c.y) > 1 || Math.abs(o.width - c.width) > 1 || Math.abs(o.height - c.height) > 1;
    })
  );
  useEffect5(() => {
    if (!outlinesReady) {
      const timer = originalSetTimeout(() => setOutlinesReady(true), 380);
      return () => clearTimeout(timer);
    }
  }, []);
  const capturedSelectors = useRef5(/* @__PURE__ */ new Set());
  useEffect5(() => {
    capturedSelectors.current = new Set(sections.map((s2) => s2.selector));
  }, [sections]);
  useEffect5(() => {
    const onScroll = () => setScrollY(window.scrollY);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  useEffect5(() => {
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
  useEffect5(() => {
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = prev;
    };
  }, []);
  useEffect5(() => {
    const handleMouseDown = (e) => {
      if (interactionRef.current) return;
      if (e.button !== 0) return;
      const el = e.target;
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
          const outlineEl = document.querySelector(`[data-rearrange-section="${section.id}"]`);
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
          const outlineEl = document.querySelector(`[data-rearrange-section="${section.id}"]`);
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
  useEffect5(() => {
    const handleKeyDown = (e) => {
      const t = e.target;
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
  const handleOutlineMouseDown = useCallback4(
    (e, id) => {
      if (e.button !== 0) return;
      const target = e.target;
      if (target.closest(`.${styles_module_default3.handle}`) || target.closest(`.${styles_module_default3.deleteButton}`)) return;
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
          const outlineEl = document.querySelector(`[data-rearrange-section="${s2.id}"]`);
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
  const handleResizeMouseDown = useCallback4(
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
      const resizeOutlineEl = document.querySelector(`[data-rearrange-section="${id}"]`);
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
  const handleDelete = useCallback4(
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
  useEffect5(() => {
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
  return /* @__PURE__ */ jsxs7(Fragment4, { children: [
    /* @__PURE__ */ jsxs7(
      "div",
      {
        className: `${styles_module_default3.rearrangeOverlay} ${!isDarkMode ? styles_module_default3.light : ""} ${exiting ? styles_module_default3.overlayExiting : ""}${extraClassName ? ` ${extraClassName}` : ""}`,
        "data-feedback-toolbar": true,
        children: [
          hoverHighlight && /* @__PURE__ */ jsx8(
            "div",
            {
              className: styles_module_default3.hoverHighlight,
              style: { left: hoverHighlight.x, top: hoverHighlight.y, width: hoverHighlight.w, height: hoverHighlight.h }
            }
          ),
          unchangedSections.map((section) => {
            const rect = section.currentRect;
            const screenY = section.isFixed ? rect.y : rect.y - scrollY;
            const color = SECTION_COLOR;
            const isSelected = selectedIds.has(section.id);
            return /* @__PURE__ */ jsxs7(
              "div",
              {
                "data-rearrange-section": section.id,
                className: `${styles_module_default3.sectionOutline} ${isSelected ? styles_module_default3.selected : ""} ${exitingAll || exiting || exitingIds.has(section.id) ? styles_module_default3.exiting : ""}`,
                style: { left: rect.x, top: screenY, width: rect.width, height: rect.height, borderColor: color.border, backgroundColor: color.bg, ...outlinesReady ? {} : { opacity: 0, animation: "none", transition: "none" } },
                onMouseDown: (e) => handleOutlineMouseDown(e, section.id),
                onDoubleClick: () => handleDoubleClick(section.id),
                children: [
                  /* @__PURE__ */ jsx8("span", { className: styles_module_default3.sectionLabel, style: { backgroundColor: color.pill }, children: section.label }),
                  /* @__PURE__ */ jsx8("span", { className: `${styles_module_default3.sectionAnnotation} ${section.note ? styles_module_default3.annotationVisible : ""}`, children: (() => {
                    if (section.note) lastNoteTextRef.current.set(section.id, section.note);
                    return section.note || lastNoteTextRef.current.get(section.id) || "";
                  })() }),
                  /* @__PURE__ */ jsxs7("span", { className: styles_module_default3.sectionDimensions, children: [
                    Math.round(rect.width),
                    " \xD7 ",
                    Math.round(rect.height)
                  ] }),
                  /* @__PURE__ */ jsx8(
                    "div",
                    {
                      className: styles_module_default3.deleteButton,
                      onMouseDown: (e) => e.stopPropagation(),
                      onClick: () => handleDelete(section.id),
                      children: "\u2715"
                    }
                  ),
                  HANDLES.map((dir) => /* @__PURE__ */ jsx8(
                    "div",
                    {
                      className: `${styles_module_default3.handle} ${styles_module_default3[`handle${dir.charAt(0).toUpperCase()}${dir.slice(1)}`]}`,
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
            return /* @__PURE__ */ jsxs7(
              "div",
              {
                "data-rearrange-section": section.id,
                className: `${styles_module_default3.ghostOutline} ${isSelected ? styles_module_default3.selected : ""} ${exitingAll || exiting || exitingIds.has(section.id) ? styles_module_default3.exiting : ""}`,
                style: { left: rect.x, top: screenY, width: rect.width, height: rect.height, ...outlinesReady ? {} : { opacity: 0, animation: "none", transition: "none" }, ...!isNewGhost ? { animation: "none" } : {} },
                onMouseDown: (e) => handleOutlineMouseDown(e, section.id),
                onDoubleClick: () => handleDoubleClick(section.id),
                children: [
                  /* @__PURE__ */ jsx8("span", { className: styles_module_default3.sectionLabel, style: { backgroundColor: SECTION_COLOR.pill }, children: section.label }),
                  /* @__PURE__ */ jsx8("span", { className: `${styles_module_default3.sectionAnnotation} ${section.note ? styles_module_default3.annotationVisible : ""}`, children: (() => {
                    if (section.note) lastNoteTextRef.current.set(section.id, section.note);
                    return section.note || lastNoteTextRef.current.get(section.id) || "";
                  })() }),
                  /* @__PURE__ */ jsxs7("span", { className: styles_module_default3.sectionDimensions, children: [
                    Math.round(rect.width),
                    " \xD7 ",
                    Math.round(rect.height)
                  ] }),
                  /* @__PURE__ */ jsx8(
                    "div",
                    {
                      className: styles_module_default3.deleteButton,
                      onMouseDown: (e) => e.stopPropagation(),
                      onClick: () => handleDelete(section.id),
                      children: "\u2715"
                    }
                  ),
                  HANDLES.map((dir) => /* @__PURE__ */ jsx8(
                    "div",
                    {
                      className: `${styles_module_default3.handle} ${styles_module_default3[`handle${dir.charAt(0).toUpperCase()}${dir.slice(1)}`]}`,
                      onMouseDown: (e) => handleResizeMouseDown(e, section.id, dir)
                    },
                    dir
                  )),
                  /* @__PURE__ */ jsx8("span", { className: styles_module_default3.ghostBadge, children: (() => {
                    const first = firstActionRef.current.get(section.id);
                    if (moved && resized) {
                      const [a, b] = first === "resize" ? ["Resize", "Move"] : ["Move", "Resize"];
                      return /* @__PURE__ */ jsxs7(Fragment4, { children: [
                        "Suggested ",
                        a,
                        " ",
                        /* @__PURE__ */ jsxs7("span", { className: styles_module_default3.ghostBadgeExtra, children: [
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
      return /* @__PURE__ */ jsxs7("svg", { className: `${styles_module_default3.connectorSvg} ${exitingAll || exiting ? styles_module_default3.connectorExiting : ""}`, children: [
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
          return /* @__PURE__ */ jsxs7("g", { className: isExiting ? styles_module_default3.connectorExiting : "", children: [
            /* @__PURE__ */ jsx8(
              "path",
              {
                className: styles_module_default3.connectorLine,
                d: `M ${ox} ${oy} Q ${cpx} ${cpy} ${cx} ${cy}`,
                fill: "none",
                stroke: "rgba(59, 130, 246, 0.45)",
                strokeWidth: "1.5",
                opacity: baseOpacity * proximityScale
              }
            ),
            /* @__PURE__ */ jsx8("circle", { className: styles_module_default3.connectorDot, cx: ox, cy: oy, r: 4 * proximityScale, fill: "rgba(59, 130, 246, 0.8)", stroke: "#fff", strokeWidth: "1.5", opacity: dotBaseOpacity * proximityScale, filter: "url(#connDotShadow)" }),
            /* @__PURE__ */ jsx8("circle", { className: styles_module_default3.connectorDot, cx, cy, r: 4 * proximityScale, fill: "rgba(59, 130, 246, 0.8)", stroke: "#fff", strokeWidth: "1.5", opacity: dotBaseOpacity * proximityScale, filter: "url(#connDotShadow)" })
          ] }, `conn-${id}`);
        }),
        /* @__PURE__ */ jsx8("defs", { children: /* @__PURE__ */ jsx8("filter", { id: "connDotShadow", x: "-50%", y: "-50%", width: "200%", height: "200%", children: /* @__PURE__ */ jsx8("feDropShadow", { dx: "0", dy: "0.5", stdDeviation: "1", floodOpacity: "0.15" }) }) })
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
      return /* @__PURE__ */ jsx8(
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
    sizeIndicator && /* @__PURE__ */ jsx8("div", { className: styles_module_default3.sizeIndicator, style: { left: sizeIndicator.x, top: sizeIndicator.y }, "data-feedback-toolbar": true, children: sizeIndicator.text }),
    snapGuides.map((g, i) => /* @__PURE__ */ jsx8(
      "div",
      {
        className: styles_module_default3.guideLine,
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
    if (!posMoved && !sizeChanged) {
      if (detailLevel === "forensic") {
        changed.push({ section: s2, posMoved: false, sizeChanged: false });
      }
      continue;
    }
    changed.push({ section: s2, posMoved, sizeChanged });
  }
  if (changed.length === 0) return "";
  if (detailLevel !== "forensic" && changed.every((e) => !e.posMoved && !e.sizeChanged)) return "";
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
      out += `- ${s2.label} \u2014 unchanged at (${Math.round(c.x)}, ${Math.round(c.y)}) ${Math.round(c.width)}\xD7${Math.round(c.height)}px
`;
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
import React from "react";
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
function parseComponentFrame(stack) {
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
        const frame = parseComponentFrame(e.stack);
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

// src/components/page-toolbar-css/styles.module.scss
var css5 = '.styles-module__toolbar___wNsdK svg[fill=none],\n.styles-module__markersLayer___-25j1 svg[fill=none],\n.styles-module__fixedMarkersLayer___ffyX6 svg[fill=none] {\n  fill: none !important;\n}\n.styles-module__toolbar___wNsdK svg[fill=none] :not([fill]),\n.styles-module__markersLayer___-25j1 svg[fill=none] :not([fill]),\n.styles-module__fixedMarkersLayer___ffyX6 svg[fill=none] :not([fill]) {\n  fill: none !important;\n}\n\n.styles-module__controlsContent___9GJWU :where(button, input, select, textarea, label) {\n  background: unset;\n  border: unset;\n  border-radius: unset;\n  padding: unset;\n  margin: unset;\n  color: unset;\n  font-family: unset;\n  font-weight: unset;\n  font-style: unset;\n  line-height: unset;\n  letter-spacing: unset;\n  text-transform: unset;\n  text-decoration: unset;\n  box-shadow: unset;\n  outline: unset;\n}\n\n@keyframes styles-module__toolbarEnter___u8RRu {\n  from {\n    opacity: 0;\n    transform: scale(0.5) rotate(90deg);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1) rotate(0deg);\n  }\n}\n@keyframes styles-module__toolbarHide___y8kaT {\n  from {\n    opacity: 1;\n    transform: scale(1);\n  }\n  to {\n    opacity: 0;\n    transform: scale(0.8);\n  }\n}\n@keyframes styles-module__badgeEnter___mVQLj {\n  from {\n    opacity: 0;\n    transform: scale(0);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1);\n  }\n}\n@keyframes styles-module__scaleIn___c-r1K {\n  from {\n    opacity: 0;\n    transform: scale(0.85);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1);\n  }\n}\n@keyframes styles-module__scaleOut___Wctwz {\n  from {\n    opacity: 1;\n    transform: scale(1);\n  }\n  to {\n    opacity: 0;\n    transform: scale(0.85);\n  }\n}\n@keyframes styles-module__slideUp___kgD36 {\n  from {\n    opacity: 0;\n    transform: scale(0.85) translateY(8px);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1) translateY(0);\n  }\n}\n@keyframes styles-module__slideDown___zcdje {\n  from {\n    opacity: 1;\n    transform: scale(1) translateY(0);\n  }\n  to {\n    opacity: 0;\n    transform: scale(0.85) translateY(8px);\n  }\n}\n@keyframes styles-module__fadeIn___b9qmf {\n  from {\n    opacity: 0;\n  }\n  to {\n    opacity: 1;\n  }\n}\n@keyframes styles-module__fadeOut___6Ut6- {\n  from {\n    opacity: 1;\n  }\n  to {\n    opacity: 0;\n  }\n}\n@keyframes styles-module__hoverHighlightIn___6WYHY {\n  from {\n    opacity: 0;\n    transform: scale(0.98);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1);\n  }\n}\n@keyframes styles-module__hoverTooltipIn___FYGQx {\n  from {\n    opacity: 0;\n    transform: scale(0.95) translateY(4px);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1) translateY(0);\n  }\n}\n.styles-module__disableTransitions___EopxO :is(*, *::before, *::after) {\n  transition: none !important;\n}\n\n.styles-module__toolbar___wNsdK {\n  position: fixed;\n  bottom: 1.25rem;\n  right: 1.25rem;\n  width: 337px;\n  z-index: 100000;\n  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  pointer-events: none;\n  transition: left 0s, top 0s, right 0s, bottom 0s;\n}\n\n:where(.styles-module__toolbar___wNsdK) {\n  bottom: 1.25rem;\n  right: 1.25rem;\n}\n\n.styles-module__toolbarContainer___dIhma {\n  position: relative;\n  user-select: none;\n  margin-left: auto;\n  align-self: flex-end;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: #1a1a1a;\n  color: #fff;\n  border: none;\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2), 0 4px 16px rgba(0, 0, 0, 0.1);\n  pointer-events: auto;\n  transition: width 0.4s cubic-bezier(0.19, 1, 0.22, 1), transform 0.4s cubic-bezier(0.19, 1, 0.22, 1);\n}\n.styles-module__toolbarContainer___dIhma.styles-module__entrance___sgHd8 {\n  animation: styles-module__toolbarEnter___u8RRu 0.5s cubic-bezier(0.34, 1.2, 0.64, 1) forwards;\n}\n.styles-module__toolbarContainer___dIhma.styles-module__hiding___1td44 {\n  animation: styles-module__toolbarHide___y8kaT 0.4s cubic-bezier(0.4, 0, 1, 1) forwards;\n  pointer-events: none;\n}\n.styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn {\n  width: 44px;\n  height: 44px;\n  border-radius: 22px;\n  padding: 0;\n  cursor: pointer;\n}\n.styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn svg {\n  margin-top: -1px;\n}\n.styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn:hover {\n  background: #2a2a2a;\n}\n.styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn:active {\n  transform: scale(0.95);\n}\n.styles-module__toolbarContainer___dIhma.styles-module__expanded___ofKPx {\n  height: 44px;\n  border-radius: 1.5rem;\n  padding: 0.375rem;\n  width: 297px;\n}\n.styles-module__toolbarContainer___dIhma.styles-module__expanded___ofKPx.styles-module__serverConnected___Gfbou {\n  width: 337px;\n}\n\n.styles-module__toggleContent___0yfyP {\n  position: absolute;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  transition: opacity 0.1s cubic-bezier(0.19, 1, 0.22, 1);\n}\n.styles-module__toggleContent___0yfyP.styles-module__visible___KHwEW {\n  opacity: 1;\n  visibility: visible;\n  pointer-events: auto;\n}\n.styles-module__toggleContent___0yfyP.styles-module__hidden___Ae8H4 {\n  opacity: 0;\n  pointer-events: none;\n}\n\n.styles-module__controlsContent___9GJWU {\n  display: flex;\n  align-items: center;\n  gap: 0.375rem;\n  transition: filter 0.8s cubic-bezier(0.19, 1, 0.22, 1), opacity 0.8s cubic-bezier(0.19, 1, 0.22, 1), transform 0.6s cubic-bezier(0.19, 1, 0.22, 1);\n}\n.styles-module__controlsContent___9GJWU.styles-module__visible___KHwEW {\n  opacity: 1;\n  filter: blur(0px);\n  transform: scale(1);\n  visibility: visible;\n  pointer-events: auto;\n}\n.styles-module__controlsContent___9GJWU.styles-module__hidden___Ae8H4 {\n  pointer-events: none;\n  opacity: 0;\n  filter: blur(10px);\n  transform: scale(0.4);\n}\n\n.styles-module__badge___2XsgF {\n  position: absolute;\n  top: -13px;\n  right: -13px;\n  user-select: none;\n  min-width: 18px;\n  height: 18px;\n  padding: 0 5px;\n  border-radius: 9px;\n  background-color: var(--agentation-color-accent);\n  color: white;\n  font-size: 0.625rem;\n  font-weight: 600;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15), inset 0 0 0 1px rgba(255, 255, 255, 0.04);\n  opacity: 1;\n  transition: transform 0.3s ease, opacity 0.2s ease;\n  transform: scale(1);\n}\n.styles-module__badge___2XsgF.styles-module__fadeOut___6Ut6- {\n  opacity: 0;\n  transform: scale(0);\n  pointer-events: none;\n}\n.styles-module__badge___2XsgF.styles-module__entrance___sgHd8 {\n  animation: styles-module__badgeEnter___mVQLj 0.3s cubic-bezier(0.34, 1.2, 0.64, 1) 0.4s both;\n}\n\n.styles-module__controlButton___8Q0jc {\n  position: relative;\n  cursor: pointer;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 34px;\n  height: 34px;\n  border-radius: 50%;\n  border: none;\n  background: transparent;\n  color: rgba(255, 255, 255, 0.85);\n  transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease, opacity 0.2s ease;\n}\n.styles-module__controlButton___8Q0jc:hover:not(:disabled):not([data-active=true]):not([data-failed=true]):not([data-auto-sync=true]):not([data-error=true]):not([data-no-hover=true]) {\n  background: rgba(255, 255, 255, 0.12);\n  color: #fff;\n}\n.styles-module__controlButton___8Q0jc:active:not(:disabled) {\n  transform: scale(0.92);\n}\n.styles-module__controlButton___8Q0jc:disabled {\n  opacity: 0.35;\n  cursor: not-allowed;\n}\n.styles-module__controlButton___8Q0jc[data-active=true] {\n  color: var(--agentation-color-blue);\n  background-color: color-mix(in srgb, var(--agentation-color-blue) 25%, transparent);\n}\n.styles-module__controlButton___8Q0jc[data-error=true] {\n  color: var(--agentation-color-red);\n  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);\n}\n.styles-module__controlButton___8Q0jc[data-danger]:hover:not(:disabled):not([data-active=true]):not([data-failed=true]) {\n  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);\n  color: var(--agentation-color-red);\n}\n.styles-module__controlButton___8Q0jc[data-no-hover=true], .styles-module__controlButton___8Q0jc.styles-module__statusShowing___te6iu {\n  cursor: default;\n  pointer-events: none;\n  background: transparent !important;\n}\n.styles-module__controlButton___8Q0jc[data-auto-sync=true] {\n  color: var(--agentation-color-green);\n  background: transparent;\n  cursor: default;\n}\n.styles-module__controlButton___8Q0jc[data-failed=true] {\n  color: var(--agentation-color-red);\n  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);\n}\n\n.styles-module__buttonBadge___NeFWb {\n  position: absolute;\n  top: 0px;\n  right: 0px;\n  min-width: 16px;\n  height: 16px;\n  padding: 0 4px;\n  border-radius: 8px;\n  background-color: var(--agentation-color-accent);\n  color: white;\n  font-size: 0.625rem;\n  font-weight: 600;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  box-shadow: 0 0 0 2px #1a1a1a, 0 1px 3px rgba(0, 0, 0, 0.2);\n  pointer-events: none;\n}\n[data-agentation-theme=light] .styles-module__buttonBadge___NeFWb {\n  box-shadow: 0 0 0 2px #fff, 0 1px 3px rgba(0, 0, 0, 0.2);\n}\n\n@keyframes styles-module__mcpIndicatorPulseConnected___EDodZ {\n  0%, 100% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 50%, transparent);\n  }\n  50% {\n    box-shadow: 0 0 0 5px color-mix(in srgb, var(--agentation-color-green) 0%, transparent);\n  }\n}\n@keyframes styles-module__mcpIndicatorPulseConnecting___cCYte {\n  0%, 100% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-yellow) 50%, transparent);\n  }\n  50% {\n    box-shadow: 0 0 0 5px color-mix(in srgb, var(--agentation-color-yellow) 0%, transparent);\n  }\n}\n.styles-module__mcpIndicator___zGJeL {\n  position: absolute;\n  top: 3px;\n  right: 3px;\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  pointer-events: none;\n  transition: background-color 0.3s ease, opacity 0.15s ease, transform 0.15s ease;\n  opacity: 1;\n  transform: scale(1);\n}\n.styles-module__mcpIndicator___zGJeL.styles-module__connected___7c28g {\n  background-color: var(--agentation-color-green);\n  animation: styles-module__mcpIndicatorPulseConnected___EDodZ 2.5s ease-in-out infinite;\n}\n.styles-module__mcpIndicator___zGJeL.styles-module__connecting___uo-CW {\n  background-color: var(--agentation-color-yellow);\n  animation: styles-module__mcpIndicatorPulseConnecting___cCYte 1.5s ease-in-out infinite;\n}\n.styles-module__mcpIndicator___zGJeL.styles-module__hidden___Ae8H4 {\n  opacity: 0;\n  transform: scale(0);\n  animation: none;\n}\n\n@keyframes styles-module__connectionPulse___-Zycw {\n  0%, 100% {\n    opacity: 1;\n    transform: scale(1);\n  }\n  50% {\n    opacity: 0.6;\n    transform: scale(0.9);\n  }\n}\n.styles-module__connectionIndicatorWrapper___L-e-3 {\n  width: 8px;\n  height: 34px;\n  margin-left: 6px;\n  margin-right: 6px;\n}\n\n.styles-module__connectionIndicator___afk9p {\n  position: relative;\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  opacity: 0;\n  transition: opacity 0.3s ease, background-color 0.3s ease;\n  cursor: default;\n}\n\n.styles-module__connectionIndicatorVisible___C-i5B {\n  opacity: 1;\n}\n\n.styles-module__connectionIndicatorConnected___IY8pR {\n  background-color: var(--agentation-color-green);\n  animation: styles-module__connectionPulse___-Zycw 2.5s ease-in-out infinite;\n}\n\n.styles-module__connectionIndicatorDisconnected___kmpaZ {\n  background-color: var(--agentation-color-red);\n  animation: none;\n}\n\n.styles-module__connectionIndicatorConnecting___QmSLH {\n  background-color: var(--agentation-color-yellow);\n  animation: styles-module__connectionPulse___-Zycw 1s ease-in-out infinite;\n}\n\n.styles-module__buttonWrapper___rBcdv {\n  position: relative;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n.styles-module__buttonWrapper___rBcdv:hover .styles-module__buttonTooltip___Burd9 {\n  opacity: 1;\n  visibility: visible;\n  transform: translateX(-50%) scale(1);\n  transition-delay: 0.85s;\n}\n.styles-module__buttonWrapper___rBcdv:has(.styles-module__controlButton___8Q0jc:disabled):hover .styles-module__buttonTooltip___Burd9 {\n  opacity: 0;\n  visibility: hidden;\n}\n\n.styles-module__tooltipsInSession___-0lHH .styles-module__buttonWrapper___rBcdv:hover .styles-module__buttonTooltip___Burd9 {\n  transition-delay: 0s;\n}\n\n.styles-module__sendButtonWrapper___UUxG6 {\n  width: 0;\n  opacity: 0;\n  overflow: hidden;\n  pointer-events: none;\n  margin-left: -0.375rem;\n  transition: width 0.4s cubic-bezier(0.19, 1, 0.22, 1), opacity 0.3s cubic-bezier(0.19, 1, 0.22, 1), margin 0.4s cubic-bezier(0.19, 1, 0.22, 1);\n}\n.styles-module__sendButtonWrapper___UUxG6 .styles-module__controlButton___8Q0jc {\n  transform: scale(0.8);\n  transition: transform 0.4s cubic-bezier(0.19, 1, 0.22, 1);\n}\n.styles-module__sendButtonWrapper___UUxG6.styles-module__sendButtonVisible___WPSQU {\n  width: 34px;\n  opacity: 1;\n  overflow: visible;\n  pointer-events: auto;\n  margin-left: 0;\n}\n.styles-module__sendButtonWrapper___UUxG6.styles-module__sendButtonVisible___WPSQU .styles-module__controlButton___8Q0jc {\n  transform: scale(1);\n}\n\n.styles-module__buttonTooltip___Burd9 {\n  position: absolute;\n  bottom: calc(100% + 14px);\n  left: 50%;\n  transform: translateX(-50%) scale(0.95);\n  padding: 6px 10px;\n  background: #1a1a1a;\n  color: rgba(255, 255, 255, 0.9);\n  font-size: 12px;\n  font-weight: 500;\n  border-radius: 8px;\n  white-space: nowrap;\n  opacity: 0;\n  visibility: hidden;\n  pointer-events: none;\n  z-index: 100001;\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);\n  transition: opacity 0.135s ease, transform 0.135s ease, visibility 0.135s ease;\n}\n.styles-module__buttonTooltip___Burd9::after {\n  content: "";\n  position: absolute;\n  top: calc(100% - 4px);\n  left: 50%;\n  transform: translateX(-50%) rotate(45deg);\n  width: 8px;\n  height: 8px;\n  background: #1a1a1a;\n  border-radius: 0 0 2px 0;\n}\n\n.styles-module__shortcut___lEAQk {\n  margin-left: 4px;\n  opacity: 0.5;\n}\n\n.styles-module__tooltipBelow___m6ats .styles-module__buttonTooltip___Burd9 {\n  bottom: auto;\n  top: calc(100% + 14px);\n  transform: translateX(-50%) scale(0.95);\n}\n.styles-module__tooltipBelow___m6ats .styles-module__buttonTooltip___Burd9::after {\n  top: -4px;\n  bottom: auto;\n  border-radius: 2px 0 0 0;\n}\n\n.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapper___rBcdv:hover .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(-50%) scale(1);\n}\n\n.styles-module__tooltipsHidden___VtLJG .styles-module__buttonTooltip___Burd9 {\n  opacity: 0 !important;\n  visibility: hidden !important;\n  transition: none !important;\n}\n\n.styles-module__tooltipVisible___0jcCv,\n.styles-module__tooltipsHidden___VtLJG .styles-module__tooltipVisible___0jcCv {\n  opacity: 1 !important;\n  visibility: visible !important;\n  transform: translateX(-50%) scale(1) !important;\n  transition-delay: 0s !important;\n}\n\n.styles-module__buttonWrapperAlignLeft___myzIp .styles-module__buttonTooltip___Burd9 {\n  left: 50%;\n  transform: translateX(-12px) scale(0.95);\n}\n.styles-module__buttonWrapperAlignLeft___myzIp .styles-module__buttonTooltip___Burd9::after {\n  left: 16px;\n}\n.styles-module__buttonWrapperAlignLeft___myzIp:hover .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(-12px) scale(1);\n}\n\n.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapperAlignLeft___myzIp .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(-12px) scale(0.95);\n}\n.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapperAlignLeft___myzIp:hover .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(-12px) scale(1);\n}\n\n.styles-module__buttonWrapperAlignRight___HCQFR .styles-module__buttonTooltip___Burd9 {\n  left: 50%;\n  transform: translateX(calc(-100% + 12px)) scale(0.95);\n}\n.styles-module__buttonWrapperAlignRight___HCQFR .styles-module__buttonTooltip___Burd9::after {\n  left: auto;\n  right: 8px;\n}\n.styles-module__buttonWrapperAlignRight___HCQFR:hover .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(calc(-100% + 12px)) scale(1);\n}\n\n.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapperAlignRight___HCQFR .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(calc(-100% + 12px)) scale(0.95);\n}\n.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapperAlignRight___HCQFR:hover .styles-module__buttonTooltip___Burd9 {\n  transform: translateX(calc(-100% + 12px)) scale(1);\n}\n\n.styles-module__divider___c--s1 {\n  width: 1px;\n  height: 12px;\n  background: rgba(255, 255, 255, 0.15);\n  margin: 0 0.125rem;\n}\n\n.styles-module__overlay___Q1O9y {\n  position: fixed;\n  inset: 0;\n  z-index: 99997;\n  pointer-events: none;\n}\n.styles-module__overlay___Q1O9y > * {\n  pointer-events: auto;\n}\n\n.styles-module__hoverHighlight___ogakW {\n  position: fixed;\n  border: 2px solid color-mix(in srgb, var(--agentation-color-accent) 50%, transparent);\n  border-radius: 4px;\n  background-color: color-mix(in srgb, var(--agentation-color-accent) 4%, transparent);\n  pointer-events: none !important;\n  box-sizing: border-box;\n  will-change: opacity;\n  contain: layout style;\n}\n.styles-module__hoverHighlight___ogakW.styles-module__enter___WFIki {\n  animation: styles-module__hoverHighlightIn___6WYHY 0.12s ease-out forwards;\n}\n\n.styles-module__multiSelectOutline___cSJ-m {\n  position: fixed;\n  border: 2px dashed color-mix(in srgb, var(--agentation-color-green) 60%, transparent);\n  border-radius: 4px;\n  pointer-events: none !important;\n  background-color: color-mix(in srgb, var(--agentation-color-green) 5%, transparent);\n  box-sizing: border-box;\n  will-change: opacity;\n}\n.styles-module__multiSelectOutline___cSJ-m.styles-module__enter___WFIki {\n  animation: styles-module__fadeIn___b9qmf 0.15s ease-out forwards;\n}\n.styles-module__multiSelectOutline___cSJ-m.styles-module__exit___fyOJ0 {\n  animation: styles-module__fadeOut___6Ut6- 0.15s ease-out forwards;\n}\n\n.styles-module__singleSelectOutline___QhX-O {\n  position: fixed;\n  border: 2px solid color-mix(in srgb, var(--agentation-color-blue) 60%, transparent);\n  border-radius: 4px;\n  pointer-events: none !important;\n  background-color: color-mix(in srgb, var(--agentation-color-blue) 5%, transparent);\n  box-sizing: border-box;\n  will-change: opacity;\n}\n.styles-module__singleSelectOutline___QhX-O.styles-module__enter___WFIki {\n  animation: styles-module__fadeIn___b9qmf 0.15s ease-out forwards;\n}\n.styles-module__singleSelectOutline___QhX-O.styles-module__exit___fyOJ0 {\n  animation: styles-module__fadeOut___6Ut6- 0.15s ease-out forwards;\n}\n\n.styles-module__hoverTooltip___bvLk7 {\n  position: fixed;\n  font-size: 0.6875rem;\n  font-weight: 500;\n  color: #fff;\n  background: rgba(0, 0, 0, 0.85);\n  padding: 0.35rem 0.6rem;\n  border-radius: 0.375rem;\n  pointer-events: none !important;\n  white-space: nowrap;\n  max-width: 280px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.styles-module__hoverTooltip___bvLk7.styles-module__enter___WFIki {\n  animation: styles-module__hoverTooltipIn___FYGQx 0.1s ease-out forwards;\n}\n\n.styles-module__hoverReactPath___gx1IJ {\n  font-size: 0.625rem;\n  color: rgba(255, 255, 255, 0.6);\n  margin-bottom: 0.15rem;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.styles-module__hoverElementName___QMLMl {\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.styles-module__markersLayer___-25j1 {\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;\n  height: 0;\n  z-index: 99998;\n  pointer-events: none;\n}\n.styles-module__markersLayer___-25j1 > * {\n  pointer-events: auto;\n}\n\n.styles-module__fixedMarkersLayer___ffyX6 {\n  position: fixed;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  z-index: 99998;\n  pointer-events: none;\n}\n.styles-module__fixedMarkersLayer___ffyX6 > * {\n  pointer-events: auto;\n}\n\n.styles-module__marker___6sQrs {\n  position: absolute;\n  width: 22px;\n  height: 22px;\n  background: var(--agentation-color-blue);\n  color: white;\n  border-radius: 50%;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-size: 0.6875rem;\n  font-weight: 600;\n  transform: translate(-50%, -50%) scale(1);\n  opacity: 1;\n  cursor: pointer;\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2), inset 0 0 0 1px rgba(0, 0, 0, 0.04);\n  user-select: none;\n  will-change: transform, opacity;\n  contain: layout style;\n  z-index: 1;\n}\n.styles-module__marker___6sQrs:hover {\n  z-index: 2;\n}\n.styles-module__marker___6sQrs:not(.styles-module__enter___WFIki):not(.styles-module__exit___fyOJ0):not(.styles-module__clearing___FQ--7) {\n  transition: background-color 0.15s ease, transform 0.1s ease;\n}\n.styles-module__marker___6sQrs.styles-module__enter___WFIki {\n  animation: styles-module__markerIn___5FaAP 0.25s cubic-bezier(0.22, 1, 0.36, 1) both;\n}\n.styles-module__marker___6sQrs.styles-module__exit___fyOJ0 {\n  animation: styles-module__markerOut___GU5jX 0.2s ease-out both;\n  pointer-events: none;\n}\n.styles-module__marker___6sQrs.styles-module__clearing___FQ--7 {\n  animation: styles-module__markerOut___GU5jX 0.15s ease-out both;\n  pointer-events: none;\n}\n.styles-module__marker___6sQrs:not(.styles-module__enter___WFIki):not(.styles-module__exit___fyOJ0):not(.styles-module__clearing___FQ--7):hover {\n  transform: translate(-50%, -50%) scale(1.1);\n}\n.styles-module__marker___6sQrs.styles-module__pending___2IHLC {\n  position: fixed;\n  background-color: var(--agentation-color-blue);\n  cursor: default;\n}\n.styles-module__marker___6sQrs.styles-module__fixed___dBMHC {\n  position: fixed;\n}\n.styles-module__marker___6sQrs.styles-module__multiSelect___YWiuz {\n  background-color: var(--agentation-color-green);\n  width: 26px;\n  height: 26px;\n  border-radius: 6px;\n  font-size: 0.75rem;\n}\n.styles-module__marker___6sQrs.styles-module__multiSelect___YWiuz.styles-module__pending___2IHLC {\n  background-color: var(--agentation-color-green);\n}\n.styles-module__marker___6sQrs.styles-module__hovered___ZgXIy {\n  background-color: var(--agentation-color-red);\n}\n\n.styles-module__renumber___nCTxD {\n  display: block;\n  animation: styles-module__renumberRoll___Wgbq3 0.2s ease-out;\n}\n\n@keyframes styles-module__renumberRoll___Wgbq3 {\n  0% {\n    transform: translateX(-40%);\n    opacity: 0;\n  }\n  100% {\n    transform: translateX(0);\n    opacity: 1;\n  }\n}\n.styles-module__markerTooltip___aLJID {\n  position: absolute;\n  top: calc(100% + 10px);\n  left: 50%;\n  transform: translateX(-50%) scale(0.909);\n  z-index: 100002;\n  background: #1a1a1a;\n  padding: 8px 0.75rem;\n  border-radius: 0.75rem;\n  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  font-weight: 400;\n  color: #fff;\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);\n  min-width: 120px;\n  max-width: 200px;\n  pointer-events: none;\n  cursor: default;\n}\n.styles-module__markerTooltip___aLJID.styles-module__enter___WFIki {\n  animation: styles-module__tooltipIn___0N31w 0.1s ease-out forwards;\n}\n\n.styles-module__markerQuote___FHmrz {\n  display: block;\n  font-size: 12px;\n  font-style: italic;\n  color: rgba(255, 255, 255, 0.6);\n  margin-bottom: 0.3125rem;\n  line-height: 1.4;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.styles-module__markerNote___QkrrS {\n  display: block;\n  font-size: 13px;\n  font-weight: 400;\n  line-height: 1.4;\n  color: #fff;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  padding-bottom: 2px;\n}\n\n.styles-module__markerHint___2iF-6 {\n  display: block;\n  font-size: 0.625rem;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.6);\n  margin-top: 0.375rem;\n  white-space: nowrap;\n}\n\n.styles-module__settingsPanel___OxX3Y {\n  position: absolute;\n  right: 5px;\n  bottom: calc(100% + 0.5rem);\n  z-index: 1;\n  overflow: hidden;\n  background: #1c1c1c;\n  border-radius: 1rem;\n  padding: 13px 0 16px;\n  min-width: 205px;\n  cursor: default;\n  opacity: 1;\n  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.04);\n  transition: background-color 0.25s ease, box-shadow 0.25s ease;\n}\n.styles-module__settingsPanel___OxX3Y::before, .styles-module__settingsPanel___OxX3Y::after {\n  content: "";\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  width: 16px;\n  z-index: 2;\n  pointer-events: none;\n}\n.styles-module__settingsPanel___OxX3Y::before {\n  left: 0;\n  background: linear-gradient(to right, #1c1c1c 0%, transparent 100%);\n}\n.styles-module__settingsPanel___OxX3Y::after {\n  right: 0;\n  background: linear-gradient(to left, #1c1c1c 0%, transparent 100%);\n}\n.styles-module__settingsPanel___OxX3Y .styles-module__settingsHeader___pwDY9,\n.styles-module__settingsPanel___OxX3Y .styles-module__settingsBrand___0gJeM,\n.styles-module__settingsPanel___OxX3Y .styles-module__settingsBrandSlash___uTG18,\n.styles-module__settingsPanel___OxX3Y .styles-module__settingsVersion___TUcFq,\n.styles-module__settingsPanel___OxX3Y .styles-module__settingsSection___m-YM2,\n.styles-module__settingsPanel___OxX3Y .styles-module__settingsLabel___8UjfX,\n.styles-module__settingsPanel___OxX3Y .styles-module__cycleButton___FMKfw,\n.styles-module__settingsPanel___OxX3Y .styles-module__cycleDot___nPgLY,\n.styles-module__settingsPanel___OxX3Y .styles-module__dropdownButton___16NPz,\n.styles-module__settingsPanel___OxX3Y .styles-module__toggleLabel___Xm8Aa,\n.styles-module__settingsPanel___OxX3Y .styles-module__customCheckbox___U39ax,\n.styles-module__settingsPanel___OxX3Y .styles-module__sliderLabel___U8sPr,\n.styles-module__settingsPanel___OxX3Y .styles-module__slider___GLdxp,\n.styles-module__settingsPanel___OxX3Y .styles-module__themeToggle___2rUjA {\n  transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease;\n}\n.styles-module__settingsPanel___OxX3Y.styles-module__enter___WFIki {\n  opacity: 1;\n  transform: translateY(0) scale(1);\n  filter: blur(0px);\n  transition: opacity 0.2s ease, transform 0.2s ease, filter 0.2s ease;\n}\n.styles-module__settingsPanel___OxX3Y.styles-module__exit___fyOJ0 {\n  opacity: 0;\n  transform: translateY(8px) scale(0.95);\n  filter: blur(5px);\n  pointer-events: none;\n  transition: opacity 0.1s ease, transform 0.1s ease, filter 0.1s ease;\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y {\n  background: #1a1a1a;\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__settingsLabel___8UjfX {\n  color: rgba(255, 255, 255, 0.6);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__settingsOption___UNa12 {\n  color: rgba(255, 255, 255, 0.85);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__settingsOption___UNa12:hover {\n  background: rgba(255, 255, 255, 0.1);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__settingsOption___UNa12.styles-module__selected___OwRqP {\n  background: rgba(255, 255, 255, 0.15);\n  color: #fff;\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__toggleLabel___Xm8Aa {\n  color: rgba(255, 255, 255, 0.85);\n}\n\n.styles-module__settingsPanelContainer___Xksv8 {\n  overflow: visible;\n  position: relative;\n  display: flex;\n  padding: 0 1rem;\n}\n\n.styles-module__settingsPage___6YfHH {\n  min-width: 100%;\n  flex-shrink: 0;\n  transition: transform 0.2s ease, opacity 0.2s ease;\n  transition-delay: 0s;\n  opacity: 1;\n}\n\n.styles-module__settingsPage___6YfHH.styles-module__slideLeft___Ps01J {\n  transform: translateX(-24px);\n  opacity: 0;\n  pointer-events: none;\n}\n\n.styles-module__automationsPage___uvCq6 {\n  position: absolute;\n  top: 0;\n  left: 24px;\n  width: 100%;\n  height: 100%;\n  padding: 3px 1rem 0;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  transition: transform 0.2s ease, opacity 0.2s ease;\n  opacity: 0;\n  pointer-events: none;\n}\n\n.styles-module__automationsPage___uvCq6.styles-module__slideIn___4-qXe {\n  transform: translateX(-24px);\n  opacity: 1;\n  pointer-events: auto;\n}\n\n.styles-module__settingsNavLink___wCzJt {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  width: 100%;\n  padding: 0;\n  border: none;\n  background: transparent;\n  font-family: inherit;\n  font-size: 0.8125rem;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.5);\n  cursor: pointer;\n  transition: color 0.15s ease;\n}\n.styles-module__settingsNavLink___wCzJt:hover {\n  color: rgba(255, 255, 255, 0.9);\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___wCzJt {\n  color: rgba(0, 0, 0, 0.5);\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___wCzJt:hover {\n  color: rgba(0, 0, 0, 0.8);\n}\n.styles-module__settingsNavLink___wCzJt svg {\n  color: rgba(255, 255, 255, 0.4);\n  transition: color 0.15s ease;\n}\n.styles-module__settingsNavLink___wCzJt:hover svg {\n  color: #fff;\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___wCzJt svg {\n  color: rgba(0, 0, 0, 0.25);\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___wCzJt:hover svg {\n  color: rgba(0, 0, 0, 0.8);\n}\n\n.styles-module__settingsNavLinkRight___ZWwhj {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.styles-module__mcpNavIndicator___cl9pO {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  flex-shrink: 0;\n}\n.styles-module__mcpNavIndicator___cl9pO.styles-module__connected___7c28g {\n  background-color: var(--agentation-color-green);\n  animation: styles-module__mcpPulse___uNggr 2.5s ease-in-out infinite;\n}\n.styles-module__mcpNavIndicator___cl9pO.styles-module__connecting___uo-CW {\n  background-color: var(--agentation-color-yellow);\n  animation: styles-module__mcpPulse___uNggr 1.5s ease-in-out infinite;\n}\n\n.styles-module__settingsBackButton___bIe2j {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  padding: 6px 0 12px 0;\n  margin: -6px 0 0.5rem 0;\n  border: none;\n  border-bottom: 1px solid rgba(255, 255, 255, 0.07);\n  border-radius: 0;\n  background: transparent;\n  font-family: inherit;\n  font-size: 0.8125rem;\n  font-weight: 500;\n  letter-spacing: -0.15px;\n  color: #fff;\n  cursor: pointer;\n  transition: transform 0.12s cubic-bezier(0.32, 0.72, 0, 1);\n}\n.styles-module__settingsBackButton___bIe2j svg {\n  opacity: 0.4;\n  flex-shrink: 0;\n  transition: opacity 0.15s ease, transform 0.18s cubic-bezier(0.32, 0.72, 0, 1);\n}\n.styles-module__settingsBackButton___bIe2j:hover {\n  border-bottom-color: rgba(255, 255, 255, 0.07);\n}\n.styles-module__settingsBackButton___bIe2j:hover svg {\n  opacity: 1;\n}\n[data-agentation-theme=light] .styles-module__settingsBackButton___bIe2j {\n  color: rgba(0, 0, 0, 0.85);\n  border-bottom-color: rgba(0, 0, 0, 0.08);\n}\n[data-agentation-theme=light] .styles-module__settingsBackButton___bIe2j:hover {\n  border-bottom-color: rgba(0, 0, 0, 0.08);\n}\n\n.styles-module__automationHeader___InP0r {\n  display: flex;\n  align-items: center;\n  gap: 0.125rem;\n  font-size: 0.8125rem;\n  font-weight: 400;\n  color: #fff;\n}\n[data-agentation-theme=light] .styles-module__automationHeader___InP0r {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n.styles-module__automationDescription___NKlmo {\n  font-size: 0.6875rem;\n  font-weight: 300;\n  color: rgba(255, 255, 255, 0.5);\n  margin-top: 2px;\n  line-height: 14px;\n}\n[data-agentation-theme=light] .styles-module__automationDescription___NKlmo {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__learnMoreLink___8xv-x {\n  color: rgba(255, 255, 255, 0.8);\n  text-decoration: underline dotted;\n  text-decoration-color: rgba(255, 255, 255, 0.2);\n  text-underline-offset: 2px;\n  transition: color 0.15s ease;\n}\n.styles-module__learnMoreLink___8xv-x:hover {\n  color: #fff;\n}\n[data-agentation-theme=light] .styles-module__learnMoreLink___8xv-x {\n  color: rgba(0, 0, 0, 0.6);\n  text-decoration-color: rgba(0, 0, 0, 0.2);\n}\n[data-agentation-theme=light] .styles-module__learnMoreLink___8xv-x:hover {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n.styles-module__autoSendRow___UblX5 {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n\n.styles-module__autoSendLabel___icDc2 {\n  font-size: 0.6875rem;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.4);\n  transition: color 0.15s ease;\n}\n.styles-module__autoSendLabel___icDc2.styles-module__active___-zoN6 {\n  color: #66b8ff;\n  color: color(display-p3 0.4 0.72 1);\n}\n[data-agentation-theme=light] .styles-module__autoSendLabel___icDc2 {\n  color: rgba(0, 0, 0, 0.4);\n}\n[data-agentation-theme=light] .styles-module__autoSendLabel___icDc2.styles-module__active___-zoN6 {\n  color: var(--agentation-color-blue);\n}\n\n.styles-module__webhookUrlInput___2375C {\n  display: block;\n  width: 100%;\n  flex: 1;\n  min-height: 60px;\n  box-sizing: border-box;\n  margin-top: 11px;\n  padding: 8px 10px;\n  border: 1px solid rgba(255, 255, 255, 0.1);\n  border-radius: 6px;\n  background: rgba(255, 255, 255, 0.03);\n  font-family: inherit;\n  font-size: 0.75rem;\n  font-weight: 400;\n  color: #fff;\n  outline: none;\n  resize: none;\n  user-select: text;\n  transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;\n}\n.styles-module__webhookUrlInput___2375C::placeholder {\n  color: rgba(255, 255, 255, 0.3);\n}\n.styles-module__webhookUrlInput___2375C:focus {\n  border-color: rgba(255, 255, 255, 0.3);\n  background: rgba(255, 255, 255, 0.08);\n}\n[data-agentation-theme=light] .styles-module__webhookUrlInput___2375C {\n  border-color: rgba(0, 0, 0, 0.1);\n  background: rgba(0, 0, 0, 0.03);\n  color: rgba(0, 0, 0, 0.85);\n}\n[data-agentation-theme=light] .styles-module__webhookUrlInput___2375C::placeholder {\n  color: rgba(0, 0, 0, 0.3);\n}\n[data-agentation-theme=light] .styles-module__webhookUrlInput___2375C:focus {\n  border-color: rgba(0, 0, 0, 0.25);\n  background: rgba(0, 0, 0, 0.05);\n}\n\n.styles-module__settingsHeader___pwDY9 {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  min-height: 24px;\n  margin-bottom: 0.5rem;\n  padding-bottom: 9px;\n  border-bottom: 1px solid rgba(255, 255, 255, 0.07);\n}\n\n.styles-module__settingsBrand___0gJeM {\n  font-size: 0.8125rem;\n  font-weight: 600;\n  letter-spacing: -0.0094em;\n  color: #fff;\n  text-decoration: none;\n}\n\n.styles-module__settingsBrandSlash___uTG18 {\n  color: var(--agentation-color-accent);\n  transition: color 0.2s ease;\n}\n\n.styles-module__settingsVersion___TUcFq {\n  font-size: 11px;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.4);\n  margin-left: auto;\n  letter-spacing: -0.0094em;\n}\n\n.styles-module__settingsSection___m-YM2 + .styles-module__settingsSection___m-YM2 {\n  margin-top: 0.5rem;\n  padding-top: 0.5rem;\n  border-top: 1px solid rgba(255, 255, 255, 0.07);\n}\n.styles-module__settingsSection___m-YM2.styles-module__settingsSectionExtraPadding___jdhFV {\n  padding-top: calc(0.5rem + 4px);\n}\n\n.styles-module__settingsSectionGrow___h-5HZ {\n  flex: 1;\n  display: flex;\n  flex-direction: column;\n}\n\n.styles-module__settingsRow___3sdhc {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  min-height: 24px;\n}\n.styles-module__settingsRow___3sdhc.styles-module__settingsRowMarginTop___zA0Sp {\n  margin-top: 8px;\n}\n\n.styles-module__dropdownContainer___BVnxe {\n  position: relative;\n}\n\n.styles-module__dropdownButton___16NPz {\n  display: flex;\n  align-items: center;\n  gap: 0.5rem;\n  padding: 0.25rem 0.5rem;\n  border: none;\n  border-radius: 0.375rem;\n  background: transparent;\n  font-size: 0.8125rem;\n  font-weight: 600;\n  color: #fff;\n  cursor: pointer;\n  transition: background-color 0.15s ease, color 0.15s ease;\n  letter-spacing: -0.0094em;\n}\n.styles-module__dropdownButton___16NPz:hover {\n  background: rgba(255, 255, 255, 0.08);\n}\n.styles-module__dropdownButton___16NPz svg {\n  opacity: 0.6;\n}\n\n.styles-module__cycleButton___FMKfw {\n  display: flex;\n  align-items: center;\n  gap: 0.5rem;\n  padding: 0;\n  border: none;\n  background: transparent;\n  font-size: 0.8125rem;\n  font-weight: 500;\n  color: #fff;\n  cursor: pointer;\n  letter-spacing: -0.0094em;\n}\n[data-agentation-theme=light] .styles-module__cycleButton___FMKfw {\n  color: rgba(0, 0, 0, 0.85);\n}\n.styles-module__cycleButton___FMKfw:disabled {\n  opacity: 0.35;\n  cursor: not-allowed;\n}\n\n.styles-module__settingsRowDisabled___EgS0V .styles-module__settingsLabel___8UjfX {\n  color: rgba(255, 255, 255, 0.2);\n}\n[data-agentation-theme=light] .styles-module__settingsRowDisabled___EgS0V .styles-module__settingsLabel___8UjfX {\n  color: rgba(0, 0, 0, 0.2);\n}\n.styles-module__settingsRowDisabled___EgS0V .styles-module__toggleSwitch___l4Ygm {\n  opacity: 0.4;\n  cursor: not-allowed;\n}\n\n@keyframes styles-module__cycleTextIn___Q6zJf {\n  0% {\n    opacity: 0;\n    transform: translateY(-6px);\n  }\n  100% {\n    opacity: 1;\n    transform: translateY(0);\n  }\n}\n.styles-module__cycleButtonText___fD1LR {\n  display: inline-block;\n  animation: styles-module__cycleTextIn___Q6zJf 0.2s ease-out;\n}\n\n.styles-module__cycleDots___LWuoQ {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.styles-module__cycleDot___nPgLY {\n  width: 3px;\n  height: 3px;\n  border-radius: 50%;\n  background: rgba(255, 255, 255, 0.3);\n  transform: scale(0.667);\n  transition: background-color 0.25s ease-out, transform 0.25s ease-out;\n}\n.styles-module__cycleDot___nPgLY.styles-module__active___-zoN6 {\n  background: #fff;\n  transform: scale(1);\n}\n[data-agentation-theme=light] .styles-module__cycleDot___nPgLY {\n  background: rgba(0, 0, 0, 0.2);\n}\n[data-agentation-theme=light] .styles-module__cycleDot___nPgLY.styles-module__active___-zoN6 {\n  background: rgba(0, 0, 0, 0.7);\n}\n\n.styles-module__dropdownMenu___k73ER {\n  position: absolute;\n  right: 0;\n  top: calc(100% + 0.25rem);\n  background: #1a1a1a;\n  border-radius: 0.5rem;\n  padding: 0.25rem;\n  min-width: 120px;\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1);\n  z-index: 10;\n  animation: styles-module__scaleIn___c-r1K 0.15s ease-out;\n}\n\n.styles-module__dropdownItem___ylsLj {\n  width: 100%;\n  display: flex;\n  align-items: center;\n  padding: 0.5rem 0.625rem;\n  border: none;\n  border-radius: 0.375rem;\n  background: transparent;\n  font-size: 0.8125rem;\n  font-weight: 500;\n  color: rgba(255, 255, 255, 0.85);\n  cursor: pointer;\n  text-align: left;\n  transition: background-color 0.15s ease, color 0.15s ease;\n  letter-spacing: -0.0094em;\n}\n.styles-module__dropdownItem___ylsLj:hover {\n  background: rgba(255, 255, 255, 0.08);\n}\n.styles-module__dropdownItem___ylsLj.styles-module__selected___OwRqP {\n  background: rgba(255, 255, 255, 0.12);\n  color: #fff;\n  font-weight: 600;\n}\n\n.styles-module__settingsLabel___8UjfX {\n  font-size: 0.8125rem;\n  font-weight: 400;\n  letter-spacing: -0.0094em;\n  color: rgba(255, 255, 255, 0.5);\n  display: flex;\n  align-items: center;\n  gap: 0.125rem;\n}\n[data-agentation-theme=light] .styles-module__settingsLabel___8UjfX {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__settingsLabelMarker___ewdtV {\n  padding-top: 3px;\n  margin-bottom: 10px;\n}\n\n.styles-module__settingsOptions___LyrBA {\n  display: flex;\n  gap: 0.25rem;\n}\n\n.styles-module__settingsOption___UNa12 {\n  flex: 1;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: 0.25rem;\n  padding: 0.375rem 0.5rem;\n  border: none;\n  border-radius: 0.375rem;\n  background: transparent;\n  font-size: 0.6875rem;\n  font-weight: 500;\n  color: rgba(0, 0, 0, 0.7);\n  cursor: pointer;\n  transition: background-color 0.15s ease, color 0.15s ease;\n}\n.styles-module__settingsOption___UNa12:hover {\n  background: rgba(0, 0, 0, 0.05);\n}\n.styles-module__settingsOption___UNa12.styles-module__selected___OwRqP {\n  background: color-mix(in srgb, var(--agentation-color-blue) 15%, transparent);\n  color: var(--agentation-color-blue);\n}\n\n.styles-module__sliderContainer___ducXj {\n  display: flex;\n  flex-direction: column;\n  gap: 0.5rem;\n}\n\n.styles-module__slider___GLdxp {\n  -webkit-appearance: none;\n  appearance: none;\n  width: 100%;\n  height: 4px;\n  background: rgba(255, 255, 255, 0.15);\n  border-radius: 2px;\n  outline: none;\n  cursor: pointer;\n}\n.styles-module__slider___GLdxp::-webkit-slider-thumb {\n  -webkit-appearance: none;\n  appearance: none;\n  width: 14px;\n  height: 14px;\n  background: white;\n  border-radius: 50%;\n  cursor: pointer;\n  transition: transform 0.15s ease, box-shadow 0.15s ease;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);\n}\n.styles-module__slider___GLdxp::-moz-range-thumb {\n  width: 14px;\n  height: 14px;\n  background: white;\n  border: none;\n  border-radius: 50%;\n  cursor: pointer;\n  transition: transform 0.15s ease, box-shadow 0.15s ease;\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);\n}\n.styles-module__slider___GLdxp:hover::-webkit-slider-thumb {\n  transform: scale(1.15);\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);\n}\n.styles-module__slider___GLdxp:hover::-moz-range-thumb {\n  transform: scale(1.15);\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);\n}\n\n.styles-module__sliderLabels___FhLDB {\n  display: flex;\n  justify-content: space-between;\n}\n\n.styles-module__sliderLabel___U8sPr {\n  font-size: 0.625rem;\n  font-weight: 500;\n  color: rgba(255, 255, 255, 0.4);\n  cursor: pointer;\n  transition: color 0.15s ease;\n}\n.styles-module__sliderLabel___U8sPr:hover {\n  color: rgba(255, 255, 255, 0.7);\n}\n.styles-module__sliderLabel___U8sPr.styles-module__active___-zoN6 {\n  color: rgba(255, 255, 255, 0.9);\n}\n\n.styles-module__colorOptions___iHCNX {\n  display: flex;\n  gap: 0.5rem;\n  margin-top: 0.375rem;\n  margin-bottom: 1px;\n}\n\n.styles-module__colorOption___IodiY {\n  display: block;\n  width: 20px;\n  height: 20px;\n  border-radius: 50%;\n  border: 2px solid transparent;\n  background-color: var(--swatch);\n  cursor: pointer;\n  transition: transform 0.2s cubic-bezier(0.25, 1, 0.5, 1);\n}\n@supports (color: color(display-p3 0 0 0)) {\n  .styles-module__colorOption___IodiY {\n    background-color: var(--swatch-p3);\n  }\n}\n.styles-module__colorOption___IodiY:hover {\n  transform: scale(1.15);\n}\n.styles-module__colorOption___IodiY.styles-module__selected___OwRqP {\n  transform: scale(0.83);\n}\n\n.styles-module__colorOptionRing___U2xpo {\n  display: flex;\n  width: 24px;\n  height: 24px;\n  border: 2px solid transparent;\n  border-radius: 50%;\n  transition: border-color 0.3s ease;\n}\n.styles-module__colorOptionRing___U2xpo.styles-module__selected___OwRqP {\n  border-color: var(--swatch);\n}\n@supports (color: color(display-p3 0 0 0)) {\n  .styles-module__colorOptionRing___U2xpo.styles-module__selected___OwRqP {\n    border-color: var(--swatch-p3);\n  }\n}\n\n.styles-module__settingsToggle___fBrFn {\n  display: flex;\n  align-items: center;\n  gap: 0.5rem;\n  cursor: pointer;\n}\n.styles-module__settingsToggle___fBrFn + .styles-module__settingsToggle___fBrFn {\n  margin-top: calc(0.5rem + 6px);\n}\n.styles-module__settingsToggle___fBrFn input[type=checkbox] {\n  position: absolute;\n  opacity: 0;\n  width: 0;\n  height: 0;\n}\n.styles-module__settingsToggle___fBrFn.styles-module__settingsToggleMarginBottom___MZUyF {\n  margin-bottom: calc(0.5rem + 6px);\n}\n\n.styles-module__customCheckbox___U39ax {\n  position: relative;\n  width: 14px;\n  height: 14px;\n  border: 1px solid rgba(255, 255, 255, 0.2);\n  border-radius: 4px;\n  background: rgba(255, 255, 255, 0.05);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  flex-shrink: 0;\n  transition: background-color 0.25s ease, border-color 0.25s ease;\n}\n.styles-module__customCheckbox___U39ax svg {\n  color: #1a1a1a;\n  opacity: 1;\n  transition: opacity 0.15s ease;\n}\ninput[type=checkbox]:checked + .styles-module__customCheckbox___U39ax {\n  border-color: rgba(255, 255, 255, 0.3);\n  background: rgb(255, 255, 255);\n}\n[data-agentation-theme=light] .styles-module__customCheckbox___U39ax {\n  border: 1px solid rgba(0, 0, 0, 0.15);\n  background: #fff;\n}\n[data-agentation-theme=light] .styles-module__customCheckbox___U39ax.styles-module__checked___mnZLo {\n  border-color: #1a1a1a;\n  background: #1a1a1a;\n}\n[data-agentation-theme=light] .styles-module__customCheckbox___U39ax.styles-module__checked___mnZLo svg {\n  color: #fff;\n}\n\n.styles-module__toggleLabel___Xm8Aa {\n  font-size: 0.8125rem;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.5);\n  letter-spacing: -0.0094em;\n  display: flex;\n  align-items: center;\n  gap: 0.25rem;\n}\n[data-agentation-theme=light] .styles-module__toggleLabel___Xm8Aa {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__toggleSwitch___l4Ygm {\n  position: relative;\n  display: inline-block;\n  width: 24px;\n  height: 16px;\n  flex-shrink: 0;\n  cursor: pointer;\n  transition: background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);\n}\n.styles-module__toggleSwitch___l4Ygm input {\n  opacity: 0;\n  width: 0;\n  height: 0;\n}\n.styles-module__toggleSwitch___l4Ygm input:checked + .styles-module__toggleSlider___wprIn {\n  background-color: var(--agentation-color-blue);\n}\n.styles-module__toggleSwitch___l4Ygm input:checked + .styles-module__toggleSlider___wprIn::before {\n  transform: translateX(8px);\n}\n.styles-module__toggleSwitch___l4Ygm.styles-module__disabled___332Jw {\n  opacity: 0.4;\n}\n.styles-module__toggleSwitch___l4Ygm.styles-module__disabled___332Jw .styles-module__toggleSlider___wprIn {\n  cursor: not-allowed;\n}\n\n.styles-module__toggleSlider___wprIn {\n  position: absolute;\n  cursor: pointer;\n  inset: 0;\n  border-radius: 16px;\n  background: #484848;\n}\n[data-agentation-theme=light] .styles-module__toggleSlider___wprIn {\n  background: #dddddd;\n}\n.styles-module__toggleSlider___wprIn::before {\n  content: "";\n  position: absolute;\n  height: 12px;\n  width: 12px;\n  left: 2px;\n  bottom: 2px;\n  background: white;\n  border-radius: 50%;\n  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);\n}\n\n@keyframes styles-module__mcpPulse___uNggr {\n  0% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 50%, transparent);\n  }\n  70% {\n    box-shadow: 0 0 0 6px color-mix(in srgb, var(--agentation-color-green) 0%, transparent);\n  }\n  100% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 0%, transparent);\n  }\n}\n@keyframes styles-module__mcpPulseError___fov9B {\n  0% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-red) 50%, transparent);\n  }\n  70% {\n    box-shadow: 0 0 0 6px color-mix(in srgb, var(--agentation-color-red) 0%, transparent);\n  }\n  100% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-red) 0%, transparent);\n  }\n}\n.styles-module__mcpStatusDot___ibgkc {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  flex-shrink: 0;\n}\n.styles-module__mcpStatusDot___ibgkc.styles-module__connecting___uo-CW {\n  background-color: var(--agentation-color-yellow);\n  animation: styles-module__mcpPulse___uNggr 1.5s infinite;\n}\n.styles-module__mcpStatusDot___ibgkc.styles-module__connected___7c28g {\n  background-color: var(--agentation-color-green);\n  animation: styles-module__mcpPulse___uNggr 2.5s ease-in-out infinite;\n}\n.styles-module__mcpStatusDot___ibgkc.styles-module__disconnected___cHPxR {\n  background-color: var(--agentation-color-red);\n  animation: styles-module__mcpPulseError___fov9B 2s infinite;\n}\n\n.styles-module__drawCanvas___7cG9U {\n  position: fixed;\n  inset: 0;\n  z-index: 99996;\n  pointer-events: none !important;\n}\n.styles-module__drawCanvas___7cG9U.styles-module__active___-zoN6 {\n  pointer-events: auto !important;\n  cursor: crosshair !important;\n}\n.styles-module__drawCanvas___7cG9U.styles-module__active___-zoN6[data-stroke-hover] {\n  cursor: pointer !important;\n}\n\n.styles-module__dragSelection___kZLq2 {\n  position: fixed;\n  top: 0;\n  left: 0;\n  border: 2px solid color-mix(in srgb, var(--agentation-color-green) 60%, transparent);\n  border-radius: 4px;\n  background-color: color-mix(in srgb, var(--agentation-color-green) 8%, transparent);\n  pointer-events: none;\n  z-index: 99997;\n  will-change: transform, width, height;\n  contain: layout style;\n}\n\n.styles-module__dragCount___KM90j {\n  position: absolute;\n  top: 50%;\n  left: 50%;\n  transform: translate(-50%, -50%);\n  background-color: var(--agentation-color-green);\n  color: white;\n  font-size: 0.875rem;\n  font-weight: 600;\n  padding: 0.25rem 0.5rem;\n  border-radius: 1rem;\n  min-width: 1.5rem;\n  text-align: center;\n}\n\n.styles-module__highlightsContainer___-0xzG {\n  position: fixed;\n  top: 0;\n  left: 0;\n  pointer-events: none;\n  z-index: 99996;\n}\n\n.styles-module__selectedElementHighlight___fyVlI {\n  position: fixed;\n  top: 0;\n  left: 0;\n  border: 2px solid color-mix(in srgb, var(--agentation-color-green) 50%, transparent);\n  border-radius: 4px;\n  background: color-mix(in srgb, var(--agentation-color-green) 6%, transparent);\n  pointer-events: none;\n  will-change: transform, width, height;\n  contain: layout style;\n}\n\n[data-agentation-theme=light] .styles-module__toolbarContainer___dIhma {\n  background: #fff;\n  color: rgba(0, 0, 0, 0.85);\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);\n}\n[data-agentation-theme=light] .styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn:hover {\n  background: #f5f5f5;\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc {\n  color: rgba(0, 0, 0, 0.5);\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc:hover:not(:disabled):not([data-active=true]):not([data-failed=true]):not([data-auto-sync=true]):not([data-error=true]):not([data-no-hover=true]) {\n  background: rgba(0, 0, 0, 0.06);\n  color: rgba(0, 0, 0, 0.85);\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-active=true] {\n  color: var(--agentation-color-blue);\n  background: color-mix(in srgb, var(--agentation-color-blue) 15%, transparent);\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-error=true] {\n  color: var(--agentation-color-red);\n  background: color-mix(in srgb, var(--agentation-color-red) 15%, transparent);\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-danger]:hover:not(:disabled):not([data-active=true]):not([data-failed=true]) {\n  color: var(--agentation-color-red);\n  background: color-mix(in srgb, var(--agentation-color-red) 15%, transparent);\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-auto-sync=true] {\n  color: var(--agentation-color-green);\n  background: transparent;\n}\n[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-failed=true] {\n  color: var(--agentation-color-red);\n  background: color-mix(in srgb, var(--agentation-color-red) 15%, transparent);\n}\n[data-agentation-theme=light] .styles-module__buttonTooltip___Burd9 {\n  background: #fff;\n  color: rgba(0, 0, 0, 0.85);\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);\n}\n[data-agentation-theme=light] .styles-module__buttonTooltip___Burd9::after {\n  background: #fff;\n}\n[data-agentation-theme=light] .styles-module__divider___c--s1 {\n  background: rgba(0, 0, 0, 0.1);\n}';
var classNames5 = { "toolbar": "styles-module__toolbar___wNsdK", "markersLayer": "styles-module__markersLayer___-25j1", "fixedMarkersLayer": "styles-module__fixedMarkersLayer___ffyX6", "controlsContent": "styles-module__controlsContent___9GJWU", "disableTransitions": "styles-module__disableTransitions___EopxO", "toolbarContainer": "styles-module__toolbarContainer___dIhma", "entrance": "styles-module__entrance___sgHd8", "toolbarEnter": "styles-module__toolbarEnter___u8RRu", "hiding": "styles-module__hiding___1td44", "toolbarHide": "styles-module__toolbarHide___y8kaT", "collapsed": "styles-module__collapsed___Rydsn", "expanded": "styles-module__expanded___ofKPx", "serverConnected": "styles-module__serverConnected___Gfbou", "toggleContent": "styles-module__toggleContent___0yfyP", "visible": "styles-module__visible___KHwEW", "hidden": "styles-module__hidden___Ae8H4", "badge": "styles-module__badge___2XsgF", "fadeOut": "styles-module__fadeOut___6Ut6-", "badgeEnter": "styles-module__badgeEnter___mVQLj", "controlButton": "styles-module__controlButton___8Q0jc", "statusShowing": "styles-module__statusShowing___te6iu", "buttonBadge": "styles-module__buttonBadge___NeFWb", "mcpIndicator": "styles-module__mcpIndicator___zGJeL", "connected": "styles-module__connected___7c28g", "mcpIndicatorPulseConnected": "styles-module__mcpIndicatorPulseConnected___EDodZ", "connecting": "styles-module__connecting___uo-CW", "mcpIndicatorPulseConnecting": "styles-module__mcpIndicatorPulseConnecting___cCYte", "connectionIndicatorWrapper": "styles-module__connectionIndicatorWrapper___L-e-3", "connectionIndicator": "styles-module__connectionIndicator___afk9p", "connectionIndicatorVisible": "styles-module__connectionIndicatorVisible___C-i5B", "connectionIndicatorConnected": "styles-module__connectionIndicatorConnected___IY8pR", "connectionPulse": "styles-module__connectionPulse___-Zycw", "connectionIndicatorDisconnected": "styles-module__connectionIndicatorDisconnected___kmpaZ", "connectionIndicatorConnecting": "styles-module__connectionIndicatorConnecting___QmSLH", "buttonWrapper": "styles-module__buttonWrapper___rBcdv", "buttonTooltip": "styles-module__buttonTooltip___Burd9", "tooltipsInSession": "styles-module__tooltipsInSession___-0lHH", "sendButtonWrapper": "styles-module__sendButtonWrapper___UUxG6", "sendButtonVisible": "styles-module__sendButtonVisible___WPSQU", "shortcut": "styles-module__shortcut___lEAQk", "tooltipBelow": "styles-module__tooltipBelow___m6ats", "tooltipsHidden": "styles-module__tooltipsHidden___VtLJG", "tooltipVisible": "styles-module__tooltipVisible___0jcCv", "buttonWrapperAlignLeft": "styles-module__buttonWrapperAlignLeft___myzIp", "buttonWrapperAlignRight": "styles-module__buttonWrapperAlignRight___HCQFR", "divider": "styles-module__divider___c--s1", "overlay": "styles-module__overlay___Q1O9y", "hoverHighlight": "styles-module__hoverHighlight___ogakW", "enter": "styles-module__enter___WFIki", "hoverHighlightIn": "styles-module__hoverHighlightIn___6WYHY", "multiSelectOutline": "styles-module__multiSelectOutline___cSJ-m", "fadeIn": "styles-module__fadeIn___b9qmf", "exit": "styles-module__exit___fyOJ0", "singleSelectOutline": "styles-module__singleSelectOutline___QhX-O", "hoverTooltip": "styles-module__hoverTooltip___bvLk7", "hoverTooltipIn": "styles-module__hoverTooltipIn___FYGQx", "hoverReactPath": "styles-module__hoverReactPath___gx1IJ", "hoverElementName": "styles-module__hoverElementName___QMLMl", "marker": "styles-module__marker___6sQrs", "clearing": "styles-module__clearing___FQ--7", "markerIn": "styles-module__markerIn___5FaAP", "markerOut": "styles-module__markerOut___GU5jX", "pending": "styles-module__pending___2IHLC", "fixed": "styles-module__fixed___dBMHC", "multiSelect": "styles-module__multiSelect___YWiuz", "hovered": "styles-module__hovered___ZgXIy", "renumber": "styles-module__renumber___nCTxD", "renumberRoll": "styles-module__renumberRoll___Wgbq3", "markerTooltip": "styles-module__markerTooltip___aLJID", "tooltipIn": "styles-module__tooltipIn___0N31w", "markerQuote": "styles-module__markerQuote___FHmrz", "markerNote": "styles-module__markerNote___QkrrS", "markerHint": "styles-module__markerHint___2iF-6", "settingsPanel": "styles-module__settingsPanel___OxX3Y", "settingsHeader": "styles-module__settingsHeader___pwDY9", "settingsBrand": "styles-module__settingsBrand___0gJeM", "settingsBrandSlash": "styles-module__settingsBrandSlash___uTG18", "settingsVersion": "styles-module__settingsVersion___TUcFq", "settingsSection": "styles-module__settingsSection___m-YM2", "settingsLabel": "styles-module__settingsLabel___8UjfX", "cycleButton": "styles-module__cycleButton___FMKfw", "cycleDot": "styles-module__cycleDot___nPgLY", "dropdownButton": "styles-module__dropdownButton___16NPz", "toggleLabel": "styles-module__toggleLabel___Xm8Aa", "customCheckbox": "styles-module__customCheckbox___U39ax", "sliderLabel": "styles-module__sliderLabel___U8sPr", "slider": "styles-module__slider___GLdxp", "themeToggle": "styles-module__themeToggle___2rUjA", "settingsOption": "styles-module__settingsOption___UNa12", "selected": "styles-module__selected___OwRqP", "settingsPanelContainer": "styles-module__settingsPanelContainer___Xksv8", "settingsPage": "styles-module__settingsPage___6YfHH", "slideLeft": "styles-module__slideLeft___Ps01J", "automationsPage": "styles-module__automationsPage___uvCq6", "slideIn": "styles-module__slideIn___4-qXe", "settingsNavLink": "styles-module__settingsNavLink___wCzJt", "settingsNavLinkRight": "styles-module__settingsNavLinkRight___ZWwhj", "mcpNavIndicator": "styles-module__mcpNavIndicator___cl9pO", "mcpPulse": "styles-module__mcpPulse___uNggr", "settingsBackButton": "styles-module__settingsBackButton___bIe2j", "automationHeader": "styles-module__automationHeader___InP0r", "automationDescription": "styles-module__automationDescription___NKlmo", "learnMoreLink": "styles-module__learnMoreLink___8xv-x", "autoSendRow": "styles-module__autoSendRow___UblX5", "autoSendLabel": "styles-module__autoSendLabel___icDc2", "active": "styles-module__active___-zoN6", "webhookUrlInput": "styles-module__webhookUrlInput___2375C", "settingsSectionExtraPadding": "styles-module__settingsSectionExtraPadding___jdhFV", "settingsSectionGrow": "styles-module__settingsSectionGrow___h-5HZ", "settingsRow": "styles-module__settingsRow___3sdhc", "settingsRowMarginTop": "styles-module__settingsRowMarginTop___zA0Sp", "dropdownContainer": "styles-module__dropdownContainer___BVnxe", "settingsRowDisabled": "styles-module__settingsRowDisabled___EgS0V", "toggleSwitch": "styles-module__toggleSwitch___l4Ygm", "cycleButtonText": "styles-module__cycleButtonText___fD1LR", "cycleTextIn": "styles-module__cycleTextIn___Q6zJf", "cycleDots": "styles-module__cycleDots___LWuoQ", "dropdownMenu": "styles-module__dropdownMenu___k73ER", "scaleIn": "styles-module__scaleIn___c-r1K", "dropdownItem": "styles-module__dropdownItem___ylsLj", "settingsLabelMarker": "styles-module__settingsLabelMarker___ewdtV", "settingsOptions": "styles-module__settingsOptions___LyrBA", "sliderContainer": "styles-module__sliderContainer___ducXj", "sliderLabels": "styles-module__sliderLabels___FhLDB", "colorOptions": "styles-module__colorOptions___iHCNX", "colorOption": "styles-module__colorOption___IodiY", "colorOptionRing": "styles-module__colorOptionRing___U2xpo", "settingsToggle": "styles-module__settingsToggle___fBrFn", "settingsToggleMarginBottom": "styles-module__settingsToggleMarginBottom___MZUyF", "checked": "styles-module__checked___mnZLo", "toggleSlider": "styles-module__toggleSlider___wprIn", "disabled": "styles-module__disabled___332Jw", "mcpStatusDot": "styles-module__mcpStatusDot___ibgkc", "disconnected": "styles-module__disconnected___cHPxR", "mcpPulseError": "styles-module__mcpPulseError___fov9B", "drawCanvas": "styles-module__drawCanvas___7cG9U", "dragSelection": "styles-module__dragSelection___kZLq2", "dragCount": "styles-module__dragCount___KM90j", "highlightsContainer": "styles-module__highlightsContainer___-0xzG", "selectedElementHighlight": "styles-module__selectedElementHighlight___fyVlI", "scaleOut": "styles-module__scaleOut___Wctwz", "slideUp": "styles-module__slideUp___kgD36", "slideDown": "styles-module__slideDown___zcdje" };
if (typeof document !== "undefined") {
  let style = document.getElementById("feedback-tool-styles-page-toolbar-css-styles");
  if (!style) {
    style = document.createElement("style");
    style.id = "feedback-tool-styles-page-toolbar-css-styles";
    document.head.appendChild(style);
  }
  style.textContent = css5;
}
var styles_module_default4 = classNames5;

// src/utils/generate-output.ts
var OUTPUT_DETAIL_OPTIONS = [
  { value: "compact", label: "Compact" },
  { value: "standard", label: "Standard" },
  { value: "detailed", label: "Detailed" },
  { value: "forensic", label: "Forensic" }
];
function generateOutput(annotations, pathname, detailLevel = "standard") {
  if (annotations.length === 0) return "";
  const viewport = typeof window !== "undefined" ? `${window.innerWidth}\xD7${window.innerHeight}` : "unknown";
  let output = `## Page Feedback: ${pathname}
`;
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

// src/components/page-toolbar-css/annotation-marker/styles.module.scss
var css6 = '@keyframes styles-module__markerIn___x4G8D {\n  0% {\n    opacity: 0;\n    transform: translate(-50%, -50%) scale(0.3);\n  }\n  100% {\n    opacity: 1;\n    transform: translate(-50%, -50%) scale(1);\n  }\n}\n@keyframes styles-module__markerOut___6VhQN {\n  0% {\n    opacity: 1;\n    transform: translate(-50%, -50%) scale(1);\n  }\n  100% {\n    opacity: 0;\n    transform: translate(-50%, -50%) scale(0.3);\n  }\n}\n@keyframes styles-module__tooltipIn___aJslQ {\n  from {\n    opacity: 0;\n    transform: translateX(-50%) translateY(2px) scale(0.891);\n  }\n  to {\n    opacity: 1;\n    transform: translateX(-50%) translateY(0) scale(0.909);\n  }\n}\n@keyframes styles-module__renumberRoll___akV9B {\n  0% {\n    transform: translateX(-40%);\n    opacity: 0;\n  }\n  100% {\n    transform: translateX(0);\n    opacity: 1;\n  }\n}\n.styles-module__marker___9CKF7 {\n  position: absolute;\n  width: 22px;\n  height: 22px;\n  background: var(--agentation-color-blue);\n  color: white;\n  border-radius: 50%;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  font-size: 0.6875rem;\n  font-weight: 600;\n  transform: translate(-50%, -50%) scale(1);\n  opacity: 1;\n  cursor: pointer;\n  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2), inset 0 0 0 1px rgba(0, 0, 0, 0.04);\n  user-select: none;\n  will-change: transform, opacity;\n  contain: layout style;\n  z-index: 1;\n}\n.styles-module__marker___9CKF7:hover {\n  z-index: 2;\n}\n.styles-module__marker___9CKF7:not(.styles-module__enter___8kI3q):not(.styles-module__exit___KBdR3):not(.styles-module__clearing___8rM7K) {\n  transition: background-color 0.15s ease, transform 0.1s ease;\n}\n.styles-module__marker___9CKF7.styles-module__enter___8kI3q {\n  animation: styles-module__markerIn___x4G8D 0.25s cubic-bezier(0.22, 1, 0.36, 1) both;\n}\n.styles-module__marker___9CKF7.styles-module__exit___KBdR3 {\n  animation: styles-module__markerOut___6VhQN 0.2s ease-out both;\n  pointer-events: none;\n}\n.styles-module__marker___9CKF7.styles-module__clearing___8rM7K {\n  animation: styles-module__markerOut___6VhQN 0.15s ease-out both;\n  pointer-events: none;\n}\n.styles-module__marker___9CKF7:not(.styles-module__enter___8kI3q):not(.styles-module__exit___KBdR3):not(.styles-module__clearing___8rM7K):hover {\n  transform: translate(-50%, -50%) scale(1.1);\n}\n.styles-module__marker___9CKF7.styles-module__pending___BiY-U {\n  position: fixed;\n  background-color: var(--agentation-color-blue);\n  cursor: default;\n}\n.styles-module__marker___9CKF7.styles-module__fixed___aKrQO {\n  position: fixed;\n}\n.styles-module__marker___9CKF7.styles-module__multiSelect___CPfTC {\n  background-color: var(--agentation-color-green);\n  width: 26px;\n  height: 26px;\n  border-radius: 6px;\n  font-size: 0.75rem;\n}\n.styles-module__marker___9CKF7.styles-module__multiSelect___CPfTC.styles-module__pending___BiY-U {\n  background-color: var(--agentation-color-green);\n}\n.styles-module__marker___9CKF7.styles-module__hovered___-mg2N {\n  background-color: var(--agentation-color-red);\n}\n\n.styles-module__renumber___16lvD {\n  display: block;\n  animation: styles-module__renumberRoll___akV9B 0.2s ease-out;\n}\n\n.styles-module__markerTooltip___-VUm- {\n  position: absolute;\n  top: calc(100% + 10px);\n  left: 50%;\n  transform: translateX(-50%) scale(0.909);\n  z-index: 100002;\n  background: #1a1a1a;\n  padding: 8px 0.75rem;\n  border-radius: 0.75rem;\n  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n  font-weight: 400;\n  color: #fff;\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);\n  min-width: 120px;\n  max-width: 200px;\n  pointer-events: none;\n  cursor: default;\n}\n.styles-module__markerTooltip___-VUm-.styles-module__enter___8kI3q {\n  animation: styles-module__tooltipIn___aJslQ 0.1s ease-out forwards;\n}\n\n.styles-module__markerQuote___tQake {\n  display: block;\n  font-size: 12px;\n  font-style: italic;\n  color: rgba(255, 255, 255, 0.6);\n  margin-bottom: 0.3125rem;\n  line-height: 1.4;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.styles-module__markerNote___Rh4eI {\n  display: block;\n  font-size: 13px;\n  font-weight: 400;\n  line-height: 1.4;\n  color: #fff;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  padding-bottom: 2px;\n}\n\n[data-agentation-theme=light] .styles-module__markerTooltip___-VUm- {\n  background: #fff;\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.06);\n}\n[data-agentation-theme=light] .styles-module__markerTooltip___-VUm- .styles-module__markerQuote___tQake {\n  color: rgba(0, 0, 0, 0.5);\n}\n[data-agentation-theme=light] .styles-module__markerTooltip___-VUm- .styles-module__markerNote___Rh4eI {\n  color: rgba(0, 0, 0, 0.85);\n}';
var classNames6 = { "marker": "styles-module__marker___9CKF7", "enter": "styles-module__enter___8kI3q", "exit": "styles-module__exit___KBdR3", "clearing": "styles-module__clearing___8rM7K", "markerIn": "styles-module__markerIn___x4G8D", "markerOut": "styles-module__markerOut___6VhQN", "pending": "styles-module__pending___BiY-U", "fixed": "styles-module__fixed___aKrQO", "multiSelect": "styles-module__multiSelect___CPfTC", "hovered": "styles-module__hovered___-mg2N", "renumber": "styles-module__renumber___16lvD", "renumberRoll": "styles-module__renumberRoll___akV9B", "markerTooltip": "styles-module__markerTooltip___-VUm-", "tooltipIn": "styles-module__tooltipIn___aJslQ", "markerQuote": "styles-module__markerQuote___tQake", "markerNote": "styles-module__markerNote___Rh4eI" };
if (typeof document !== "undefined") {
  let style = document.getElementById("feedback-tool-styles-annotation-marker-styles");
  if (!style) {
    style = document.createElement("style");
    style.id = "feedback-tool-styles-annotation-marker-styles";
    document.head.appendChild(style);
  }
  style.textContent = css6;
}
var styles_module_default5 = classNames6;

// src/components/page-toolbar-css/annotation-marker/index.tsx
import { jsx as jsx9, jsxs as jsxs8 } from "react/jsx-runtime";
function AnnotationMarker({
  annotation,
  globalIndex,
  layerIndex,
  layerSize,
  isExiting,
  isClearing,
  isAnimated,
  isHovered,
  isDeleting,
  isEditingAny,
  renumberFrom,
  markerClickBehavior,
  tooltipStyle,
  onHoverEnter,
  onHoverLeave,
  onClick,
  onContextMenu
}) {
  const showDeleteState = (isHovered || isDeleting) && !isEditingAny;
  const showDeleteHover = showDeleteState && markerClickBehavior === "delete";
  const isMulti = annotation.isMultiSelect;
  const markerColor = isMulti ? "var(--agentation-color-green)" : "var(--agentation-color-accent)";
  const animClass = isExiting ? styles_module_default5.exit : isClearing ? styles_module_default5.clearing : !isAnimated ? styles_module_default5.enter : "";
  const animationDelay = isExiting ? `${(layerSize - 1 - layerIndex) * 20}ms` : `${layerIndex * 20}ms`;
  return /* @__PURE__ */ jsxs8(
    "div",
    {
      className: `${styles_module_default5.marker} ${isMulti ? styles_module_default5.multiSelect : ""} ${animClass} ${showDeleteHover ? styles_module_default5.hovered : ""}`,
      "data-annotation-marker": true,
      style: {
        left: `${annotation.x}%`,
        top: annotation.y,
        backgroundColor: showDeleteHover ? void 0 : markerColor,
        animationDelay
      },
      onMouseEnter: () => onHoverEnter(annotation),
      onMouseLeave: onHoverLeave,
      onClick: (e) => {
        e.stopPropagation();
        if (!isExiting) onClick(annotation);
      },
      onContextMenu: onContextMenu ? (e) => {
        if (markerClickBehavior === "delete") {
          e.preventDefault();
          e.stopPropagation();
          if (!isExiting) onContextMenu(annotation);
        }
      } : void 0,
      children: [
        showDeleteState ? showDeleteHover ? /* @__PURE__ */ jsx9(IconXmark, { size: isMulti ? 18 : 16 }) : /* @__PURE__ */ jsx9(IconEdit, { size: 16 }) : /* @__PURE__ */ jsx9(
          "span",
          {
            className: renumberFrom !== null && globalIndex >= renumberFrom ? styles_module_default5.renumber : void 0,
            children: globalIndex + 1
          }
        ),
        isHovered && !isEditingAny && /* @__PURE__ */ jsxs8(
          "div",
          {
            className: `${styles_module_default5.markerTooltip} ${styles_module_default5.enter}`,
            style: tooltipStyle,
            children: [
              /* @__PURE__ */ jsxs8("span", { className: styles_module_default5.markerQuote, children: [
                annotation.element,
                annotation.selectedText && ` "${annotation.selectedText.slice(0, 30)}${annotation.selectedText.length > 30 ? "..." : ""}"`
              ] }),
              /* @__PURE__ */ jsx9("span", { className: styles_module_default5.markerNote, children: annotation.comment })
            ]
          }
        )
      ]
    }
  );
}
function PendingMarker({
  x,
  y,
  isMultiSelect,
  isExiting
}) {
  return /* @__PURE__ */ jsx9(
    "div",
    {
      className: `${styles_module_default5.marker} ${styles_module_default5.pending} ${isMultiSelect ? styles_module_default5.multiSelect : ""} ${isExiting ? styles_module_default5.exit : styles_module_default5.enter}`,
      style: {
        left: `${x}%`,
        top: y,
        backgroundColor: isMultiSelect ? "var(--agentation-color-green)" : "var(--agentation-color-accent)"
      },
      children: /* @__PURE__ */ jsx9(IconPlus, { size: 12 })
    }
  );
}
function ExitingMarker({ annotation, fixed }) {
  const isMulti = annotation.isMultiSelect;
  return /* @__PURE__ */ jsx9(
    "div",
    {
      className: `${styles_module_default5.marker} ${fixed ? styles_module_default5.fixed : ""} ${styles_module_default5.hovered} ${isMulti ? styles_module_default5.multiSelect : ""} ${styles_module_default5.exit}`,
      "data-annotation-marker": true,
      style: {
        left: `${annotation.x}%`,
        top: annotation.y
      },
      children: /* @__PURE__ */ jsx9(IconXmark, { size: isMulti ? 12 : 10 })
    }
  );
}

// src/components/switch/styles.module.scss
var css7 = ".styles-module__switchContainer___Ka-AB {\n  display: flex;\n  align-items: center;\n  position: relative;\n  padding: 2px;\n  width: 24px;\n  height: 16px;\n  border-radius: 8px;\n  background-color: #cdcdcd;\n  transition: background-color 0.15s, opacity 0.15s;\n}\n[data-agentation-theme=dark] .styles-module__switchContainer___Ka-AB {\n  background-color: #484848;\n}\n.styles-module__switchContainer___Ka-AB:has(.styles-module__switchInput___kYDSD:checked) {\n  background-color: var(--agentation-color-blue);\n}\n.styles-module__switchContainer___Ka-AB:has(.styles-module__switchInput___kYDSD:disabled) {\n  opacity: 0.3;\n}\n\n.styles-module__switchInput___kYDSD {\n  position: absolute;\n  z-index: 1;\n  inset: 0;\n  border-radius: inherit;\n  opacity: 0;\n  cursor: pointer;\n}\n.styles-module__switchInput___kYDSD:disabled {\n  cursor: not-allowed;\n}\n\n.styles-module__switchThumb___4sCPH {\n  border-radius: 50%;\n  width: 12px;\n  height: 12px;\n  background-color: #fff;\n  transition: transform 0.15s;\n}\n.styles-module__switchContainer___Ka-AB:has(.styles-module__switchInput___kYDSD:checked) .styles-module__switchThumb___4sCPH {\n  transform: translateX(8px);\n}";
var classNames7 = { "switchContainer": "styles-module__switchContainer___Ka-AB", "switchInput": "styles-module__switchInput___kYDSD", "switchThumb": "styles-module__switchThumb___4sCPH" };
if (typeof document !== "undefined") {
  let style = document.getElementById("feedback-tool-styles-switch-styles");
  if (!style) {
    style = document.createElement("style");
    style.id = "feedback-tool-styles-switch-styles";
    document.head.appendChild(style);
  }
  style.textContent = css7;
}
var styles_module_default6 = classNames7;

// src/components/switch/index.tsx
import { jsx as jsx10, jsxs as jsxs9 } from "react/jsx-runtime";
var Switch = ({ className = "", ...props }) => {
  return /* @__PURE__ */ jsxs9("div", { className: `${styles_module_default6.switchContainer} ${className}`, children: [
    /* @__PURE__ */ jsx10("input", { className: styles_module_default6.switchInput, type: "checkbox", ...props }),
    /* @__PURE__ */ jsx10("div", { className: styles_module_default6.switchThumb })
  ] });
};

// src/components/page-toolbar-css/settings-panel/checkbox-field/index.tsx
import { useId } from "react";

// src/components/checkbox/styles.module.scss
var css8 = ".styles-module__checkboxContainer___joqZk {\n  display: flex;\n  justify-content: center;\n  align-items: center;\n  position: relative;\n  border: 1px solid rgba(26, 26, 26, 0.2);\n  border-radius: 4px;\n  width: 14px;\n  height: 14px;\n  background-color: #fff;\n  transition: background-color 0.2s ease;\n}\n[data-agentation-theme=dark] .styles-module__checkboxContainer___joqZk {\n  border-color: rgba(255, 255, 255, 0.2);\n  background-color: #252525;\n}\n.styles-module__checkboxContainer___joqZk:has(.styles-module__checkboxInput___ECzzO:checked) {\n  background-color: #1a1a1a;\n}\n[data-agentation-theme=dark] .styles-module__checkboxContainer___joqZk:has(.styles-module__checkboxInput___ECzzO:checked) {\n  background-color: #fff;\n}\n\n.styles-module__checkboxInput___ECzzO {\n  position: absolute;\n  z-index: 1;\n  inset: -1px;\n  border-radius: inherit;\n  opacity: 0;\n  cursor: pointer;\n}\n\n.styles-module__checkboxCheck___fUXpr {\n  color: #fafafa;\n}\n[data-agentation-theme=dark] .styles-module__checkboxCheck___fUXpr {\n  color: #1a1a1a;\n}\n\n.styles-module__checkboxCheckPath___cDyh8 {\n  stroke-dasharray: 9.29px;\n  stroke-dashoffset: 9.29px;\n  color: #fafafa;\n  transition: stroke-dashoffset 0.1s ease;\n}\n[data-agentation-theme=dark] .styles-module__checkboxCheckPath___cDyh8 {\n  color: #1a1a1a;\n}\n.styles-module__checkboxContainer___joqZk:has(.styles-module__checkboxInput___ECzzO:checked) .styles-module__checkboxCheckPath___cDyh8 {\n  transition-duration: 0.2s;\n  stroke-dashoffset: 0;\n}";
var classNames8 = { "checkboxContainer": "styles-module__checkboxContainer___joqZk", "checkboxInput": "styles-module__checkboxInput___ECzzO", "checkboxCheck": "styles-module__checkboxCheck___fUXpr", "checkboxCheckPath": "styles-module__checkboxCheckPath___cDyh8" };
if (typeof document !== "undefined") {
  let style = document.getElementById("feedback-tool-styles-checkbox-styles");
  if (!style) {
    style = document.createElement("style");
    style.id = "feedback-tool-styles-checkbox-styles";
    document.head.appendChild(style);
  }
  style.textContent = css8;
}
var styles_module_default7 = classNames8;

// src/components/checkbox/index.tsx
import { jsx as jsx11, jsxs as jsxs10 } from "react/jsx-runtime";
var Checkbox = ({ className = "", ...props }) => {
  return /* @__PURE__ */ jsxs10("div", { className: `${styles_module_default7.checkboxContainer} ${className}`, children: [
    /* @__PURE__ */ jsx11("input", { className: styles_module_default7.checkboxInput, type: "checkbox", ...props }),
    /* @__PURE__ */ jsx11(
      "svg",
      {
        className: styles_module_default7.checkboxCheck,
        width: "14",
        height: "14",
        viewBox: "0 0 14 14",
        fill: "none",
        children: /* @__PURE__ */ jsx11(
          "path",
          {
            className: styles_module_default7.checkboxCheckPath,
            d: "M3.94 7L6.13 9.19L10.5 4.81",
            stroke: "currentColor",
            strokeWidth: "1.5",
            strokeLinecap: "round",
            strokeLinejoin: "round"
          }
        )
      }
    )
  ] });
};

// src/components/page-toolbar-css/settings-panel/checkbox-field/styles.module.scss
var css9 = ".styles-module__container___w8eAF {\n  display: flex;\n  align-items: center;\n  height: 24px;\n}\n\n.styles-module__label___J5mxE {\n  padding-inline: 8px 2px;\n  line-height: 20px;\n  font-size: 13px;\n  letter-spacing: -0.15px;\n  color: rgba(26, 26, 26, 0.5);\n  cursor: pointer;\n}\n[data-agentation-theme=dark] .styles-module__label___J5mxE {\n  color: rgba(255, 255, 255, 0.5);\n}";
var classNames9 = { "container": "styles-module__container___w8eAF", "label": "styles-module__label___J5mxE" };
if (typeof document !== "undefined") {
  let style = document.getElementById("feedback-tool-styles-checkbox-field-styles");
  if (!style) {
    style = document.createElement("style");
    style.id = "feedback-tool-styles-checkbox-field-styles";
    document.head.appendChild(style);
  }
  style.textContent = css9;
}
var styles_module_default8 = classNames9;

// src/components/page-toolbar-css/settings-panel/checkbox-field/index.tsx
import { jsx as jsx12, jsxs as jsxs11 } from "react/jsx-runtime";
var CheckboxField = ({
  className = "",
  label,
  tooltip,
  checked,
  onChange,
  ...props
}) => {
  const id = useId();
  return /* @__PURE__ */ jsxs11("div", { className: `${styles_module_default8.container} ${className}`, ...props, children: [
    /* @__PURE__ */ jsx12(Checkbox, { id, onChange, checked }),
    /* @__PURE__ */ jsx12("label", { className: styles_module_default8.label, htmlFor: id, children: label }),
    tooltip && /* @__PURE__ */ jsx12(HelpTooltip, { content: tooltip })
  ] });
};

// src/components/page-toolbar-css/settings-panel/styles.module.scss
var css10 = '@keyframes styles-module__cycleTextIn___VBNTi {\n  0% {\n    opacity: 0;\n    transform: translateY(-6px);\n  }\n  100% {\n    opacity: 1;\n    transform: translateY(0);\n  }\n}\n@keyframes styles-module__scaleIn___QpQ8E {\n  from {\n    opacity: 0;\n    transform: scale(0.85);\n  }\n  to {\n    opacity: 1;\n    transform: scale(1);\n  }\n}\n@keyframes styles-module__mcpPulse___5Q3Jj {\n  0% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 50%, transparent);\n  }\n  70% {\n    box-shadow: 0 0 0 6px color-mix(in srgb, var(--agentation-color-green) 0%, transparent);\n  }\n  100% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 0%, transparent);\n  }\n}\n@keyframes styles-module__mcpPulseError___VHxhx {\n  0% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-red) 50%, transparent);\n  }\n  70% {\n    box-shadow: 0 0 0 6px color-mix(in srgb, var(--agentation-color-red) 0%, transparent);\n  }\n  100% {\n    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-red) 0%, transparent);\n  }\n}\n@keyframes styles-module__themeIconIn___qUWMV {\n  0% {\n    opacity: 0;\n    transform: scale(0.8) rotate(-30deg);\n  }\n  100% {\n    opacity: 1;\n    transform: scale(1) rotate(0deg);\n  }\n}\n.styles-module__settingsPanel___qNkn- {\n  position: absolute;\n  right: 5px;\n  bottom: calc(100% + 0.5rem);\n  z-index: 1;\n  overflow: hidden;\n  background: #1c1c1c;\n  border-radius: 16px;\n  padding: 12px 0;\n  width: 100%;\n  max-width: 253px;\n  min-width: 205px;\n  cursor: default;\n  opacity: 1;\n  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.04);\n  transition: background-color 0.25s ease, box-shadow 0.25s ease;\n}\n.styles-module__settingsPanel___qNkn-::before, .styles-module__settingsPanel___qNkn-::after {\n  content: "";\n  position: absolute;\n  top: 0;\n  bottom: 0;\n  width: 16px;\n  z-index: 2;\n  pointer-events: none;\n}\n.styles-module__settingsPanel___qNkn-::before {\n  left: 0;\n  background: linear-gradient(to right, #1c1c1c 0%, transparent 100%);\n}\n.styles-module__settingsPanel___qNkn-::after {\n  right: 0;\n  background: linear-gradient(to left, #1c1c1c 0%, transparent 100%);\n}\n.styles-module__settingsPanel___qNkn- .styles-module__settingsHeader___Fn1DP,\n.styles-module__settingsPanel___qNkn- .styles-module__settingsBrand___OoKlM,\n.styles-module__settingsPanel___qNkn- .styles-module__settingsBrandSlash___Q-AU9,\n.styles-module__settingsPanel___qNkn- .styles-module__settingsVersion___rXmL9,\n.styles-module__settingsPanel___qNkn- .styles-module__settingsSection___n5V-4,\n.styles-module__settingsPanel___qNkn- .styles-module__settingsLabel___VCVOQ,\n.styles-module__settingsPanel___qNkn- .styles-module__cycleButton___XMBx3,\n.styles-module__settingsPanel___qNkn- .styles-module__cycleDot___zgSXY,\n.styles-module__settingsPanel___qNkn- .styles-module__dropdownButton___mKHe8,\n.styles-module__settingsPanel___qNkn- .styles-module__sliderLabel___6K5v1,\n.styles-module__settingsPanel___qNkn- .styles-module__slider___v5z-c,\n.styles-module__settingsPanel___qNkn- .styles-module__themeToggle___3imlT {\n  transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease;\n}\n.styles-module__settingsPanel___qNkn-.styles-module__enter___wginS {\n  opacity: 1;\n  transform: translateY(0) scale(1);\n  filter: blur(0px);\n  transition: opacity 0.2s ease, transform 0.2s ease, filter 0.2s ease;\n}\n.styles-module__settingsPanel___qNkn-.styles-module__exit___A4iJc {\n  opacity: 0;\n  transform: translateY(8px) scale(0.95);\n  filter: blur(5px);\n  pointer-events: none;\n  transition: opacity 0.1s ease, transform 0.1s ease, filter 0.1s ease;\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- {\n  background: #1a1a1a;\n  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- .styles-module__settingsLabel___VCVOQ {\n  color: rgba(255, 255, 255, 0.6);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- .styles-module__settingsOption___JoyH- {\n  color: rgba(255, 255, 255, 0.85);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- .styles-module__settingsOption___JoyH-:hover {\n  background: rgba(255, 255, 255, 0.1);\n}\n[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- .styles-module__settingsOption___JoyH-.styles-module__selected___k1-Vq {\n  background: rgba(255, 255, 255, 0.15);\n  color: #fff;\n}\n\n.styles-module__settingsPanelContainer___5it-H {\n  overflow: visible;\n  position: relative;\n  display: flex;\n  padding: 0 16px;\n}\n\n.styles-module__settingsPage___BMn-3 {\n  min-width: 100%;\n  flex-basis: 0;\n  flex-shrink: 0;\n  transition: transform 0.2s ease, opacity 0.2s ease;\n  transition-delay: 0s;\n  opacity: 1;\n}\n\n.styles-module__settingsPage___BMn-3.styles-module__slideLeft___qUvW4 {\n  transform: translateX(-24px);\n  opacity: 0;\n  pointer-events: none;\n}\n\n.styles-module__automationsPage___N7By0 {\n  position: absolute;\n  top: 0;\n  left: 24px;\n  width: 100%;\n  height: 100%;\n  padding: 0 16px 4px;\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  transition: transform 0.2s ease, opacity 0.2s ease;\n  opacity: 0;\n  pointer-events: none;\n}\n\n.styles-module__automationsPage___N7By0.styles-module__slideIn___uXDSu {\n  transform: translateX(-24px);\n  opacity: 1;\n  pointer-events: auto;\n}\n\n.styles-module__settingsHeader___Fn1DP {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  height: 24px;\n}\n\n.styles-module__settingsBrand___OoKlM {\n  font-size: 0.8125rem;\n  font-weight: 600;\n  letter-spacing: -0.0094em;\n  color: #fff;\n  text-decoration: none;\n}\n\n.styles-module__settingsBrandSlash___Q-AU9 {\n  color: var(--agentation-color-accent);\n  transition: color 0.2s ease;\n}\n\n.styles-module__settingsVersion___rXmL9 {\n  font-size: 11px;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.4);\n  margin-left: auto;\n  letter-spacing: -0.0094em;\n}\n\n.styles-module__themeToggle___3imlT {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  width: 22px;\n  height: 22px;\n  margin-left: 8px;\n  border: none;\n  border-radius: 6px;\n  background: transparent;\n  color: rgba(255, 255, 255, 0.4);\n  transition: background-color 0.15s ease, color 0.15s ease;\n  cursor: pointer;\n}\n.styles-module__themeToggle___3imlT:hover {\n  background: rgba(255, 255, 255, 0.1);\n  color: rgba(255, 255, 255, 0.8);\n}\n[data-agentation-theme=light] .styles-module__themeToggle___3imlT {\n  color: rgba(0, 0, 0, 0.4);\n}\n[data-agentation-theme=light] .styles-module__themeToggle___3imlT:hover {\n  background: rgba(0, 0, 0, 0.06);\n  color: rgba(0, 0, 0, 0.7);\n}\n\n.styles-module__themeIconWrapper___pyaYa {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  position: relative;\n  width: 20px;\n  height: 20px;\n}\n\n.styles-module__themeIcon___w7lAm {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  animation: styles-module__themeIconIn___qUWMV 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;\n}\n\n.styles-module__settingsSectionGrow___eZTRw {\n  flex: 1;\n  display: flex;\n  flex-direction: column;\n}\n\n.styles-module__settingsRow___y-tDE {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  min-height: 24px;\n}\n.styles-module__settingsRow___y-tDE.styles-module__settingsRowMarginTop___uLpGb {\n  margin-top: 8px;\n}\n\n.styles-module__settingsRowDisabled___ydl3Q .styles-module__settingsLabel___VCVOQ {\n  color: rgba(255, 255, 255, 0.2);\n}\n[data-agentation-theme=light] .styles-module__settingsRowDisabled___ydl3Q .styles-module__settingsLabel___VCVOQ {\n  color: rgba(0, 0, 0, 0.2);\n}\n\n.styles-module__settingsLabel___VCVOQ {\n  display: flex;\n  align-items: center;\n  column-gap: 2px;\n  line-height: 20px;\n  font-size: 13px;\n  font-weight: 400;\n  letter-spacing: -0.15px;\n  color: rgba(255, 255, 255, 0.5);\n}\n[data-agentation-theme=light] .styles-module__settingsLabel___VCVOQ {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__cycleButton___XMBx3 {\n  display: flex;\n  align-items: center;\n  gap: 0.5rem;\n  padding: 0;\n  border: none;\n  background: transparent;\n  font-size: 0.8125rem;\n  font-weight: 500;\n  color: #fff;\n  cursor: pointer;\n  letter-spacing: -0.0094em;\n}\n[data-agentation-theme=light] .styles-module__cycleButton___XMBx3 {\n  color: rgba(0, 0, 0, 0.85);\n}\n.styles-module__cycleButton___XMBx3:disabled {\n  opacity: 0.35;\n  cursor: not-allowed;\n}\n\n.styles-module__cycleButtonText___mbbnD {\n  display: inline-block;\n  animation: styles-module__cycleTextIn___VBNTi 0.2s ease-out;\n}\n\n.styles-module__cycleDots___ehp6i {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n}\n\n.styles-module__cycleDot___zgSXY {\n  width: 3px;\n  height: 3px;\n  border-radius: 50%;\n  background: rgba(255, 255, 255, 0.3);\n  transform: scale(0.667);\n  transition: background-color 0.25s ease-out, transform 0.25s ease-out;\n}\n.styles-module__cycleDot___zgSXY.styles-module__active___dpAhM {\n  background: #fff;\n  transform: scale(1);\n}\n[data-agentation-theme=light] .styles-module__cycleDot___zgSXY {\n  background: rgba(0, 0, 0, 0.2);\n}\n[data-agentation-theme=light] .styles-module__cycleDot___zgSXY.styles-module__active___dpAhM {\n  background: rgba(0, 0, 0, 0.7);\n}\n\n.styles-module__colorOptions___pbxZx {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n  margin-top: 6px;\n  height: 26px;\n}\n\n.styles-module__colorOption___Co955 {\n  padding: 0;\n  position: relative;\n  border-radius: 50%;\n  width: 20px;\n  height: 20px;\n  background-color: #fff;\n  cursor: pointer;\n}\n[data-agentation-theme=dark] .styles-module__colorOption___Co955 {\n  background-color: #1a1a1a;\n}\n.styles-module__colorOption___Co955::before, .styles-module__colorOption___Co955::after {\n  content: "";\n  position: absolute;\n  inset: 0;\n  border-radius: 50%;\n  background-color: var(--swatch);\n  transition: opacity 0.2s, transform 0.2s;\n}\n@supports (color: color(display-p3 0 0 0)) {\n  .styles-module__colorOption___Co955::before, .styles-module__colorOption___Co955::after {\n    --color: var(--swatch-p3);\n  }\n}\n.styles-module__colorOption___Co955::after {\n  z-index: -1;\n  transform: scale(1.2);\n  opacity: 0;\n}\n.styles-module__colorOption___Co955.styles-module__selected___k1-Vq::before {\n  transform: scale(0.8);\n}\n.styles-module__colorOption___Co955.styles-module__selected___k1-Vq::after {\n  opacity: 1;\n}\n\n.styles-module__settingsNavLink___uYIwM {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  width: 100%;\n  height: 24px;\n  padding: 0;\n  border: none;\n  background: transparent;\n  font-family: inherit;\n  line-height: 20px;\n  font-size: 13px;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.5);\n  transition: color 0.15s ease;\n  cursor: pointer;\n}\n.styles-module__settingsNavLink___uYIwM:hover {\n  color: rgba(255, 255, 255, 0.9);\n}\n.styles-module__settingsNavLink___uYIwM svg {\n  color: rgba(255, 255, 255, 0.4);\n  transition: color 0.15s ease;\n}\n.styles-module__settingsNavLink___uYIwM:hover svg {\n  color: #fff;\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___uYIwM {\n  color: rgba(0, 0, 0, 0.5);\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___uYIwM:hover {\n  color: rgba(0, 0, 0, 0.8);\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___uYIwM svg {\n  color: rgba(0, 0, 0, 0.25);\n}\n[data-agentation-theme=light] .styles-module__settingsNavLink___uYIwM:hover svg {\n  color: rgba(0, 0, 0, 0.8);\n}\n\n.styles-module__settingsNavLinkRight___XBUzC {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.styles-module__settingsBackButton___fflll {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  height: 24px;\n  background: transparent;\n  font-family: inherit;\n  line-height: 20px;\n  font-size: 13px;\n  font-weight: 500;\n  letter-spacing: -0.15px;\n  color: #fff;\n  cursor: pointer;\n  transition: transform 0.12s cubic-bezier(0.32, 0.72, 0, 1);\n}\n.styles-module__settingsBackButton___fflll svg {\n  opacity: 0.4;\n  flex-shrink: 0;\n  transition: opacity 0.15s ease, transform 0.18s cubic-bezier(0.32, 0.72, 0, 1);\n}\n.styles-module__settingsBackButton___fflll:hover svg {\n  opacity: 1;\n}\n[data-agentation-theme=light] .styles-module__settingsBackButton___fflll {\n  color: rgba(0, 0, 0, 0.85);\n  border-bottom-color: rgba(0, 0, 0, 0.08);\n}\n\n.styles-module__automationHeader___Avra9 {\n  display: flex;\n  align-items: center;\n  gap: 0.125rem;\n  font-size: 0.8125rem;\n  font-weight: 400;\n  color: #fff;\n}\n[data-agentation-theme=light] .styles-module__automationHeader___Avra9 {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n.styles-module__automationDescription___vFTmJ {\n  font-size: 0.6875rem;\n  font-weight: 300;\n  color: rgba(255, 255, 255, 0.5);\n  margin-top: 2px;\n  line-height: 14px;\n}\n[data-agentation-theme=light] .styles-module__automationDescription___vFTmJ {\n  color: rgba(0, 0, 0, 0.5);\n}\n\n.styles-module__learnMoreLink___cG7OI {\n  color: rgba(255, 255, 255, 0.8);\n  text-decoration-line: underline;\n  text-decoration-style: dotted;\n  text-decoration-color: rgba(255, 255, 255, 0.2);\n  text-underline-offset: 2px;\n  transition: color 0.15s ease;\n}\n.styles-module__learnMoreLink___cG7OI:hover {\n  color: #fff;\n}\n[data-agentation-theme=light] .styles-module__learnMoreLink___cG7OI {\n  color: rgba(0, 0, 0, 0.6);\n  text-decoration-color: rgba(0, 0, 0, 0.2);\n}\n[data-agentation-theme=light] .styles-module__learnMoreLink___cG7OI:hover {\n  color: rgba(0, 0, 0, 0.85);\n}\n\n.styles-module__autoSendContainer___VpkXk {\n  display: flex;\n  align-items: center;\n}\n\n.styles-module__autoSendLabel___ngNdC {\n  padding-inline-end: 8px;\n  font-size: 11px;\n  font-weight: 400;\n  color: rgba(255, 255, 255, 0.4);\n  transition: color 0.15s, opacity 0.15s;\n  cursor: pointer;\n}\n.styles-module__autoSendLabel___ngNdC.styles-module__active___dpAhM {\n  color: #66b8ff;\n  color: color(display-p3 0.4 0.72 1);\n}\n[data-agentation-theme=light] .styles-module__autoSendLabel___ngNdC {\n  color: rgba(0, 0, 0, 0.4);\n}\n[data-agentation-theme=light] .styles-module__autoSendLabel___ngNdC.styles-module__active___dpAhM {\n  color: var(--agentation-color-blue);\n}\n.styles-module__autoSendLabel___ngNdC.styles-module__disabled___9AZYS {\n  opacity: 0.3;\n  cursor: not-allowed;\n}\n\n.styles-module__mcpStatusDot___8AMxP {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  flex-shrink: 0;\n}\n.styles-module__mcpStatusDot___8AMxP.styles-module__connecting___QEO1r {\n  background-color: var(--agentation-color-yellow);\n  animation: styles-module__mcpPulse___5Q3Jj 1.5s infinite;\n}\n.styles-module__mcpStatusDot___8AMxP.styles-module__connected___WyFkx {\n  background-color: var(--agentation-color-green);\n  animation: styles-module__mcpPulse___5Q3Jj 2.5s ease-in-out infinite;\n}\n.styles-module__mcpStatusDot___8AMxP.styles-module__disconnected___mvmvQ {\n  background-color: var(--agentation-color-red);\n  animation: styles-module__mcpPulseError___VHxhx 2s infinite;\n}\n\n.styles-module__mcpNavIndicator___auBHI {\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  flex-shrink: 0;\n}\n.styles-module__mcpNavIndicator___auBHI.styles-module__connected___WyFkx {\n  background-color: var(--agentation-color-green);\n  animation: styles-module__mcpPulse___5Q3Jj 2.5s ease-in-out infinite;\n}\n.styles-module__mcpNavIndicator___auBHI.styles-module__connecting___QEO1r {\n  background-color: var(--agentation-color-yellow);\n  animation: styles-module__mcpPulse___5Q3Jj 1.5s ease-in-out infinite;\n}\n\n.styles-module__webhookUrlInput___WDDDC {\n  display: block;\n  width: 100%;\n  flex: 1;\n  min-height: 60px;\n  box-sizing: border-box;\n  margin-top: 11px;\n  padding: 8px 10px;\n  border: 1px solid rgba(255, 255, 255, 0.1);\n  border-radius: 6px;\n  background: rgba(255, 255, 255, 0.03);\n  font-family: inherit;\n  font-size: 0.75rem;\n  font-weight: 400;\n  color: #fff;\n  outline: none;\n  resize: none;\n  user-select: text;\n  transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;\n}\n.styles-module__webhookUrlInput___WDDDC::placeholder {\n  color: rgba(255, 255, 255, 0.3);\n}\n.styles-module__webhookUrlInput___WDDDC:focus {\n  border-color: rgba(255, 255, 255, 0.3);\n  background: rgba(255, 255, 255, 0.08);\n}\n[data-agentation-theme=light] .styles-module__webhookUrlInput___WDDDC {\n  border-color: rgba(0, 0, 0, 0.1);\n  background: rgba(0, 0, 0, 0.03);\n  color: rgba(0, 0, 0, 0.85);\n}\n[data-agentation-theme=light] .styles-module__webhookUrlInput___WDDDC::placeholder {\n  color: rgba(0, 0, 0, 0.3);\n}\n[data-agentation-theme=light] .styles-module__webhookUrlInput___WDDDC:focus {\n  border-color: rgba(0, 0, 0, 0.25);\n  background: rgba(0, 0, 0, 0.05);\n}\n\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- {\n  background: #fff;\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn-::before {\n  background: linear-gradient(to right, #fff 0%, transparent 100%);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn-::after {\n  background: linear-gradient(to left, #fff 0%, transparent 100%);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsHeader___Fn1DP {\n  border-bottom-color: rgba(0, 0, 0, 0.08);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsBrand___OoKlM {\n  color: #E5484D;\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsVersion___rXmL9 {\n  color: rgba(0, 0, 0, 0.4);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsSection___n5V-4 {\n  border-top-color: rgba(0, 0, 0, 0.08);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsLabel___VCVOQ {\n  color: rgba(0, 0, 0, 0.5);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__cycleButton___XMBx3 {\n  color: rgba(0, 0, 0, 0.85);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__cycleDot___zgSXY {\n  background: rgba(0, 0, 0, 0.2);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__cycleDot___zgSXY.styles-module__active___dpAhM {\n  background: rgba(0, 0, 0, 0.7);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__dropdownButton___mKHe8 {\n  color: rgba(0, 0, 0, 0.85);\n}\n[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__dropdownButton___mKHe8:hover {\n  background: rgba(0, 0, 0, 0.05);\n}\n\n.styles-module__checkboxField___ZrSqv:not(:first-child) {\n  margin-top: 8px;\n}\n\n.styles-module__divider___h6Yux {\n  margin-block: 8px;\n  width: 100%;\n  height: 1px;\n  background-color: rgba(26, 26, 26, 0.07);\n}\n[data-agentation-theme=dark] .styles-module__divider___h6Yux {\n  background-color: rgba(255, 255, 255, 0.07);\n}';
var classNames10 = { "settingsPanel": "styles-module__settingsPanel___qNkn-", "settingsHeader": "styles-module__settingsHeader___Fn1DP", "settingsBrand": "styles-module__settingsBrand___OoKlM", "settingsBrandSlash": "styles-module__settingsBrandSlash___Q-AU9", "settingsVersion": "styles-module__settingsVersion___rXmL9", "settingsSection": "styles-module__settingsSection___n5V-4", "settingsLabel": "styles-module__settingsLabel___VCVOQ", "cycleButton": "styles-module__cycleButton___XMBx3", "cycleDot": "styles-module__cycleDot___zgSXY", "dropdownButton": "styles-module__dropdownButton___mKHe8", "sliderLabel": "styles-module__sliderLabel___6K5v1", "slider": "styles-module__slider___v5z-c", "themeToggle": "styles-module__themeToggle___3imlT", "enter": "styles-module__enter___wginS", "exit": "styles-module__exit___A4iJc", "settingsOption": "styles-module__settingsOption___JoyH-", "selected": "styles-module__selected___k1-Vq", "settingsPanelContainer": "styles-module__settingsPanelContainer___5it-H", "settingsPage": "styles-module__settingsPage___BMn-3", "slideLeft": "styles-module__slideLeft___qUvW4", "automationsPage": "styles-module__automationsPage___N7By0", "slideIn": "styles-module__slideIn___uXDSu", "themeIconWrapper": "styles-module__themeIconWrapper___pyaYa", "themeIcon": "styles-module__themeIcon___w7lAm", "themeIconIn": "styles-module__themeIconIn___qUWMV", "settingsSectionGrow": "styles-module__settingsSectionGrow___eZTRw", "settingsRow": "styles-module__settingsRow___y-tDE", "settingsRowMarginTop": "styles-module__settingsRowMarginTop___uLpGb", "settingsRowDisabled": "styles-module__settingsRowDisabled___ydl3Q", "cycleButtonText": "styles-module__cycleButtonText___mbbnD", "cycleTextIn": "styles-module__cycleTextIn___VBNTi", "cycleDots": "styles-module__cycleDots___ehp6i", "active": "styles-module__active___dpAhM", "colorOptions": "styles-module__colorOptions___pbxZx", "colorOption": "styles-module__colorOption___Co955", "settingsNavLink": "styles-module__settingsNavLink___uYIwM", "settingsNavLinkRight": "styles-module__settingsNavLinkRight___XBUzC", "settingsBackButton": "styles-module__settingsBackButton___fflll", "automationHeader": "styles-module__automationHeader___Avra9", "automationDescription": "styles-module__automationDescription___vFTmJ", "learnMoreLink": "styles-module__learnMoreLink___cG7OI", "autoSendContainer": "styles-module__autoSendContainer___VpkXk", "autoSendLabel": "styles-module__autoSendLabel___ngNdC", "disabled": "styles-module__disabled___9AZYS", "mcpStatusDot": "styles-module__mcpStatusDot___8AMxP", "connecting": "styles-module__connecting___QEO1r", "mcpPulse": "styles-module__mcpPulse___5Q3Jj", "connected": "styles-module__connected___WyFkx", "disconnected": "styles-module__disconnected___mvmvQ", "mcpPulseError": "styles-module__mcpPulseError___VHxhx", "mcpNavIndicator": "styles-module__mcpNavIndicator___auBHI", "webhookUrlInput": "styles-module__webhookUrlInput___WDDDC", "checkboxField": "styles-module__checkboxField___ZrSqv", "divider": "styles-module__divider___h6Yux", "scaleIn": "styles-module__scaleIn___QpQ8E" };
if (typeof document !== "undefined") {
  let style = document.getElementById("feedback-tool-styles-settings-panel-styles");
  if (!style) {
    style = document.createElement("style");
    style.id = "feedback-tool-styles-settings-panel-styles";
    document.head.appendChild(style);
  }
  style.textContent = css10;
}
var styles_module_default9 = classNames10;

// src/components/page-toolbar-css/settings-panel/index.tsx
import { jsx as jsx13, jsxs as jsxs12 } from "react/jsx-runtime";
function SettingsPanel({
  settings,
  onSettingsChange,
  isDarkMode,
  onToggleTheme,
  isDevMode,
  connectionStatus,
  endpoint,
  isVisible,
  toolbarNearBottom,
  settingsPage,
  onSettingsPageChange,
  onHideToolbar
}) {
  return /* @__PURE__ */ jsx13(
    "div",
    {
      className: `${styles_module_default9.settingsPanel} ${isVisible ? styles_module_default9.enter : styles_module_default9.exit}`,
      style: toolbarNearBottom ? { bottom: "auto", top: "calc(100% + 0.5rem)" } : void 0,
      "data-agentation-settings-panel": true,
      children: /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.settingsPanelContainer, children: [
        /* @__PURE__ */ jsxs12(
          "div",
          {
            className: `${styles_module_default9.settingsPage} ${settingsPage === "automations" ? styles_module_default9.slideLeft : ""}`,
            children: [
              /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.settingsHeader, children: [
                /* @__PURE__ */ jsx13("a", { className: styles_module_default9.settingsBrand, href: "https://agentation.com", target: "_blank", rel: "noopener noreferrer", children: /* @__PURE__ */ jsx13("svg", { width: "72", height: "16", viewBox: "0 0 676 151", fill: "none", xmlns: "http://www.w3.org/2000/svg", children: /* @__PURE__ */ jsx13("path", { d: "M79.6666 100.561L104.863 15.5213C107.828 4.03448 99.1201 -3.00582 88.7449 1.25541L3.52015 39.6065C1.48217 40.5329 0 42.7562 0 45.1647C0 48.6848 2.77907 51.4639 6.29922 51.4639C7.22558 51.4639 8.15193 51.2786 9.07829 50.9081L93.7472 12.7422C97.2674 11.0748 93.7472 8.29572 92.6356 12.1864L67.624 97.2259C66.5123 100.931 69.4767 105.193 73.7379 105.193C76.517 105.193 79.1108 103.155 79.6666 100.561ZM663.641 100.005C665.679 107.231 677.537 104.081 675.499 96.8553L666.05 66.2856C663.456 57.7631 655.489 55.7251 648.82 61.098L618.991 86.6654C617.324 87.9623 621.029 89.815 621.214 88.1476L625.846 61.6538C626.958 55.3546 624.179 50.5375 615.841 50.5375L579.158 51.0934C576.008 51.0934 578.417 53.8724 578.417 57.022C578.417 60.1716 580.825 61.6538 583.975 61.6538L616.212 60.9127C616.397 60.9127 614.544 59.6158 614.544 59.8011L609.727 88.7034C607.875 99.6344 617.694 102.784 626.031 95.7437L655.86 70.1763L654.192 69.6205L663.641 100.005ZM571.191 89.0739C555.443 88.7034 562.298 61.4685 578.787 61.8391C594.72 62.0243 587.124 89.2592 571.191 89.0739ZM571.006 100.375C601.575 100.931 611.024 51.6492 579.158 51.0934C547.847 50.5375 540.065 99.8197 571.006 100.375ZM521.909 46.4616C525.985 46.4616 529.505 42.9414 529.505 38.6802C529.505 34.4189 525.985 31.0841 521.909 31.0841C517.833 31.0841 514.127 34.6042 514.127 38.6802C514.127 42.7562 517.648 46.4616 521.909 46.4616ZM472.256 103.525C493.192 103.71 515.98 73.3259 519.13 62.3949L509.866 60.9127C505.234 73.3259 497.638 101.672 519.871 102.043C536.545 102.228 552.479 85.3685 563.595 70.1763C564.151 69.2499 564.706 68.1383 564.706 66.8414C564.706 63.6918 563.965 61.098 560.816 61.098C558.963 61.098 557.296 62.0243 556.184 63.5065C546.365 77.0313 530.802 90.9266 522.094 90.7414C511.904 90.5561 517.462 71.4732 519.871 64.9887C523.391 55.7251 512.831 53.5019 509.681 60.9127C506.531 68.6941 488.19 92.4088 475.035 92.2235C467.439 92.0383 464.29 83.8863 472.441 59.9864L486.707 17.7445C487.634 14.4097 485.41 10.519 481.334 10.519C478.741 10.519 476.517 12.1864 475.962 14.4097L461.696 56.4662C451.506 86.4801 455.211 103.155 472.256 103.525ZM447.43 42.5709L496.527 41.4593C499.306 41.4593 501.529 39.0507 501.529 36.2717C501.529 33.3073 499.306 31.0841 496.341 31.0841L447.245 32.1957C444.466 32.1957 442.242 34.4189 442.242 37.3833C442.242 40.1624 444.466 42.5709 447.43 42.5709ZM422.974 106.304C435.387 106.489 457.249 94.8173 472.441 53.8724C473.553 50.7228 472.071 48.3143 468.365 48.3143C466.142 48.3143 464.29 49.6112 463.548 51.6492C450.394 87.2212 431.682 96.1142 424.456 95.929C419.454 95.929 417.972 93.3352 418.713 85.5538C419.454 78.1429 410.376 74.9933 406.114 81.1073C401.297 87.777 394.442 94.2615 385.549 94.0763C370.172 93.891 376.471 67.0267 399.815 67.3972C408.338 67.5825 414.452 71.4732 417.045 76.6608C417.786 78.3282 419.454 79.6251 421.492 79.6251C424.271 79.6251 426.679 77.2166 426.679 74.4375C426.679 73.6964 426.494 72.9553 426.124 72.2143C421.862 63.6918 412.414 57.3926 400 57.2073C363.502 56.6515 353.497 104.451 383.326 104.822C397.036 105.193 410.005 94.0763 413.34 85.9243C412.599 86.8507 408.338 86.6654 408.523 84.4422C407.411 97.4111 410.931 106.119 422.974 106.304ZM335.897 104.266C335.897 115.012 347.569 117.606 347.569 103.34C347.569 89.0739 358.5 54.4282 361.464 45.1647L396.666 43.6825C405.929 43.1267 404.262 33.1221 397.036 33.3073L364.984 34.4189L368.875 22.7469C369.801 20.1531 370.542 17.9298 370.542 16.2624C370.542 13.4833 368.504 11.8159 365.911 11.8159C362.946 11.8159 360.352 12.7422 357.573 21.0794L352.942 35.16L330.153 36.0864C326.263 36.4569 323.483 38.1244 323.483 41.6445C323.483 45.5352 326.448 47.0174 330.709 46.8321L349.421 45.9058C345.901 56.6515 335.897 90.7414 335.897 104.266ZM186.939 78.6988C193.979 56.4662 212.877 54.984 212.877 62.9507C212.877 68.3236 203.984 77.0313 186.939 78.6988ZM113.942 150.955C142.844 152.437 159.704 111.492 160.63 80.5515C161.556 73.3259 153.96 70.3616 148.773 75.7344C141.918 83.1453 129.505 93.1499 119.685 93.1499C103.011 93.1499 116.165 59.8011 143.956 59.8011C149.514 59.8011 153.59 61.6538 156.184 64.0623C160.815 68.3236 170.82 62.0243 165.818 56.0957C161.927 51.4639 155.072 48.129 144.882 48.129C102.455 48.129 83.7426 105.007 116.721 105.007C134.692 105.007 151.367 88.3329 155.257 82.7747C154.516 83.5158 149.329 81.2925 149.699 79.4398L149.143 83.5158C148.958 107.045 134.322 141.506 116.536 139.838C113.386 139.468 112.089 137.43 112.089 134.836C112.089 128.907 122.094 119.273 145.067 113.53C159.518 109.824 152.293 101.487 143.4 104.081C111.163 113.53 99.6759 127.425 99.6759 137.8C99.6759 145.026 105.605 150.584 113.942 150.955ZM194.72 109.454C214.359 109.454 239 95.3732 251.228 77.9577C250.301 82.96 246.596 96.8553 246.596 101.487C246.596 110.01 254.748 109.454 261.232 102.784L288.097 75.5491L290.32 85.7391C293.284 99.4491 299.213 104.822 308.847 104.822C326.263 104.822 342.196 85.7391 349.421 74.8081L344.049 63.6918C339.787 74.8081 321.631 92.5941 311.626 92.5941C306.994 92.5941 304.771 89.815 303.289 83.7011L300.325 71.2879C297.916 60.7275 289.023 58.3189 279.018 68.1383L261.788 84.8127L264.382 69.991C266.235 59.2453 255.674 58.1337 250.116 65.915C241.779 77.0313 216.767 97.7817 196.387 97.7817C187.865 97.7817 185.456 93.7057 185.456 88.3329C230.848 84.998 239.185 47.2027 208.986 47.2027C172.858 47.2027 157.11 109.454 194.72 109.454Z", fill: "currentColor" }) }) }),
                /* @__PURE__ */ jsxs12("p", { className: styles_module_default9.settingsVersion, children: [
                  "v",
                  "3.0.2"
                ] }),
                /* @__PURE__ */ jsx13(
                  "button",
                  {
                    className: styles_module_default9.themeToggle,
                    onClick: onToggleTheme,
                    title: isDarkMode ? "Switch to light mode" : "Switch to dark mode",
                    children: /* @__PURE__ */ jsx13("span", { className: styles_module_default9.themeIconWrapper, children: /* @__PURE__ */ jsx13(
                      "span",
                      {
                        className: styles_module_default9.themeIcon,
                        children: isDarkMode ? /* @__PURE__ */ jsx13(IconSun, { size: 20 }) : /* @__PURE__ */ jsx13(IconMoon, { size: 20 })
                      },
                      isDarkMode ? "sun" : "moon"
                    ) })
                  }
                )
              ] }),
              /* @__PURE__ */ jsx13("div", { className: styles_module_default9.divider }),
              /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.settingsSection, children: [
                /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.settingsRow, children: [
                  /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.settingsLabel, children: [
                    "Output Detail",
                    /* @__PURE__ */ jsx13(HelpTooltip, { content: "Controls how much detail is included in the copied output" })
                  ] }),
                  /* @__PURE__ */ jsxs12(
                    "button",
                    {
                      className: styles_module_default9.cycleButton,
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
                        /* @__PURE__ */ jsx13(
                          "span",
                          {
                            className: styles_module_default9.cycleButtonText,
                            children: OUTPUT_DETAIL_OPTIONS.find(
                              (opt) => opt.value === settings.outputDetail
                            )?.label
                          },
                          settings.outputDetail
                        ),
                        /* @__PURE__ */ jsx13("span", { className: styles_module_default9.cycleDots, children: OUTPUT_DETAIL_OPTIONS.map((option) => /* @__PURE__ */ jsx13(
                          "span",
                          {
                            className: `${styles_module_default9.cycleDot} ${settings.outputDetail === option.value ? styles_module_default9.active : ""}`
                          },
                          option.value
                        )) })
                      ]
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs12(
                  "div",
                  {
                    className: `${styles_module_default9.settingsRow} ${styles_module_default9.settingsRowMarginTop} ${!isDevMode ? styles_module_default9.settingsRowDisabled : ""}`,
                    children: [
                      /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.settingsLabel, children: [
                        "React Components",
                        /* @__PURE__ */ jsx13(
                          HelpTooltip,
                          {
                            content: !isDevMode ? "Disabled \u2014 production builds minify component names, making detection unreliable. Use in development mode." : "Include React component names in annotations"
                          }
                        )
                      ] }),
                      /* @__PURE__ */ jsx13(
                        Switch,
                        {
                          checked: isDevMode && settings.reactEnabled,
                          onChange: (e) => onSettingsChange({ reactEnabled: e.target.checked }),
                          disabled: !isDevMode
                        }
                      )
                    ]
                  }
                ),
                /* @__PURE__ */ jsxs12(
                  "div",
                  {
                    className: `${styles_module_default9.settingsRow} ${styles_module_default9.settingsRowMarginTop}`,
                    children: [
                      /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.settingsLabel, children: [
                        "Hide Until Restart",
                        /* @__PURE__ */ jsx13(HelpTooltip, { content: "Hides the toolbar until you open a new tab" })
                      ] }),
                      /* @__PURE__ */ jsx13(
                        Switch,
                        {
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
              /* @__PURE__ */ jsx13("div", { className: styles_module_default9.divider }),
              /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.settingsSection, children: [
                /* @__PURE__ */ jsx13(
                  "div",
                  {
                    className: `${styles_module_default9.settingsLabel} ${styles_module_default9.settingsLabelMarker}`,
                    children: "Marker Color"
                  }
                ),
                /* @__PURE__ */ jsx13("div", { className: styles_module_default9.colorOptions, children: COLOR_OPTIONS.map((color) => /* @__PURE__ */ jsx13(
                  "button",
                  {
                    className: `${styles_module_default9.colorOption} ${settings.annotationColorId === color.id ? styles_module_default9.selected : ""}`,
                    style: {
                      "--swatch": color.srgb,
                      "--swatch-p3": color.p3
                    },
                    onClick: () => onSettingsChange({ annotationColorId: color.id }),
                    title: color.label,
                    type: "button"
                  },
                  color.id
                )) })
              ] }),
              /* @__PURE__ */ jsx13("div", { className: styles_module_default9.divider }),
              /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.settingsSection, children: [
                /* @__PURE__ */ jsx13(
                  CheckboxField,
                  {
                    className: "checkbox-field",
                    label: "Clear on copy/send",
                    checked: settings.autoClearAfterCopy,
                    onChange: (e) => onSettingsChange({ autoClearAfterCopy: e.target.checked }),
                    tooltip: "Automatically clear annotations after copying"
                  }
                ),
                /* @__PURE__ */ jsx13(
                  CheckboxField,
                  {
                    className: styles_module_default9.checkboxField,
                    label: "Block page interactions",
                    checked: settings.blockInteractions,
                    onChange: (e) => onSettingsChange({ blockInteractions: e.target.checked })
                  }
                )
              ] }),
              /* @__PURE__ */ jsx13("div", { className: styles_module_default9.divider }),
              /* @__PURE__ */ jsxs12(
                "button",
                {
                  className: styles_module_default9.settingsNavLink,
                  onClick: () => onSettingsPageChange("automations"),
                  children: [
                    /* @__PURE__ */ jsx13("span", { children: "Manage MCP & Webhooks" }),
                    /* @__PURE__ */ jsxs12("span", { className: styles_module_default9.settingsNavLinkRight, children: [
                      endpoint && connectionStatus !== "disconnected" && /* @__PURE__ */ jsx13(
                        "span",
                        {
                          className: `${styles_module_default9.mcpNavIndicator} ${styles_module_default9[connectionStatus]}`
                        }
                      ),
                      /* @__PURE__ */ jsx13(
                        "svg",
                        {
                          width: "16",
                          height: "16",
                          viewBox: "0 0 16 16",
                          fill: "none",
                          xmlns: "http://www.w3.org/2000/svg",
                          children: /* @__PURE__ */ jsx13(
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
        /* @__PURE__ */ jsxs12(
          "div",
          {
            className: `${styles_module_default9.settingsPage} ${styles_module_default9.automationsPage} ${settingsPage === "automations" ? styles_module_default9.slideIn : ""}`,
            children: [
              /* @__PURE__ */ jsxs12(
                "button",
                {
                  className: styles_module_default9.settingsBackButton,
                  onClick: () => onSettingsPageChange("main"),
                  children: [
                    /* @__PURE__ */ jsx13(IconChevronLeft, { size: 16 }),
                    /* @__PURE__ */ jsx13("span", { children: "Manage MCP & Webhooks" })
                  ]
                }
              ),
              /* @__PURE__ */ jsx13("div", { className: styles_module_default9.divider }),
              /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.settingsSection, children: [
                /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.settingsRow, children: [
                  /* @__PURE__ */ jsxs12("span", { className: styles_module_default9.automationHeader, children: [
                    "MCP Connection",
                    /* @__PURE__ */ jsx13(HelpTooltip, { content: "Connect via Model Context Protocol to let AI agents like Claude Code receive annotations in real-time." })
                  ] }),
                  endpoint && /* @__PURE__ */ jsx13(
                    "div",
                    {
                      className: `${styles_module_default9.mcpStatusDot} ${styles_module_default9[connectionStatus]}`,
                      title: connectionStatus === "connected" ? "Connected" : connectionStatus === "connecting" ? "Connecting..." : "Disconnected"
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs12(
                  "p",
                  {
                    className: styles_module_default9.automationDescription,
                    style: { paddingBottom: 6 },
                    children: [
                      "MCP connection allows agents to receive and act on annotations.",
                      " ",
                      /* @__PURE__ */ jsx13(
                        "a",
                        {
                          href: "https://agentation.dev/mcp",
                          target: "_blank",
                          rel: "noopener noreferrer",
                          className: styles_module_default9.learnMoreLink,
                          children: "Learn more"
                        }
                      )
                    ]
                  }
                )
              ] }),
              /* @__PURE__ */ jsx13("div", { className: styles_module_default9.divider }),
              /* @__PURE__ */ jsxs12(
                "div",
                {
                  className: `${styles_module_default9.settingsSection} ${styles_module_default9.settingsSectionGrow}`,
                  children: [
                    /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.settingsRow, children: [
                      /* @__PURE__ */ jsxs12("span", { className: styles_module_default9.automationHeader, children: [
                        "Webhooks",
                        /* @__PURE__ */ jsx13(HelpTooltip, { content: "Send annotation data to any URL endpoint when annotations change. Useful for custom integrations." })
                      ] }),
                      /* @__PURE__ */ jsxs12("div", { className: styles_module_default9.autoSendContainer, children: [
                        /* @__PURE__ */ jsx13(
                          "label",
                          {
                            htmlFor: "agentation-auto-send",
                            className: `${styles_module_default9.autoSendLabel} ${settings.webhooksEnabled ? styles_module_default9.active : ""} ${!settings.webhookUrl ? styles_module_default9.disabled : ""}`,
                            children: "Auto-Send"
                          }
                        ),
                        /* @__PURE__ */ jsx13(
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
                    /* @__PURE__ */ jsx13("p", { className: styles_module_default9.automationDescription, children: "The webhook URL will receive live annotation changes and annotation data." }),
                    /* @__PURE__ */ jsx13(
                      "textarea",
                      {
                        className: styles_module_default9.webhookUrlInput,
                        placeholder: "Webhook URL",
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
}

// src/components/page-toolbar-css/index.tsx
import { Fragment as Fragment5, jsx as jsx14, jsxs as jsxs13 } from "react/jsx-runtime";
function identifyElementWithReact(element, reactMode = "filtered") {
  const { name: elementName, path } = identifyElement(element);
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
var COLOR_OPTIONS = [
  { id: "indigo", label: "Indigo", srgb: "#6155F5", p3: "color(display-p3 0.38 0.33 0.96)" },
  { id: "blue", label: "Blue", srgb: "#0088FF", p3: "color(display-p3 0.00 0.53 1.00)" },
  { id: "cyan", label: "Cyan", srgb: "#00C3D0", p3: "color(display-p3 0.00 0.76 0.82)" },
  { id: "green", label: "Green", srgb: "#34C759", p3: "color(display-p3 0.20 0.78 0.35)" },
  { id: "yellow", label: "Yellow", srgb: "#FFCC00", p3: "color(display-p3 1.00 0.80 0.00)" },
  { id: "orange", label: "Orange", srgb: "#FF8D28", p3: "color(display-p3 1.00 0.55 0.16)" },
  { id: "red", label: "Red", srgb: "#FF383C", p3: "color(display-p3 1.00 0.22 0.24)" }
];
var injectAgentationColorTokens = () => {
  if (typeof document === "undefined") return;
  if (document.getElementById("agentation-color-tokens")) return;
  const style = document.createElement("style");
  style.id = "agentation-color-tokens";
  style.textContent = [
    ...COLOR_OPTIONS.map((c) => `
      [data-agentation-accent="${c.id}"] {
        --agentation-color-accent: ${c.srgb};
      }

      @supports (color: color(display-p3 0 0 0)) {
        [data-agentation-accent="${c.id}"] {
          --agentation-color-accent: ${c.p3};
        }
      }
    `),
    `:root {
      ${COLOR_OPTIONS.map((c) => `--agentation-color-${c.id}: ${c.srgb};`).join("\n")}
    }`,
    `@supports (color: color(display-p3 0 0 0)) {
      :root {
        ${COLOR_OPTIONS.map((c) => `--agentation-color-${c.id}: ${c.p3};`).join("\n")}
      }
    }`
  ].join("");
  document.head.appendChild(style);
};
injectAgentationColorTokens();
function deepElementFromPoint(x, y) {
  let element = document.elementFromPoint(x, y);
  if (!element) return null;
  while (element?.shadowRoot) {
    const deeper = element.shadowRoot.elementFromPoint(x, y);
    if (!deeper || deeper === element) break;
    element = deeper;
  }
  return element;
}
function isElementFixed(element) {
  let current = element;
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
  return annotation.status !== "resolved" && annotation.status !== "dismissed";
}
function detectSourceFile(element) {
  const result = getSourceLocation(element);
  const loc = result.found ? result : findNearestComponentSource(element);
  if (loc.found && loc.source) {
    return formatSourceLocation(loc.source, "path");
  }
  return void 0;
}
function PageFeedbackToolbarCSS({
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
} = {}) {
  const [isActive, setIsActive] = useState6(false);
  const [annotations, setAnnotations] = useState6([]);
  const [showMarkers, setShowMarkers] = useState6(true);
  const [isToolbarHidden, setIsToolbarHidden] = useState6(() => loadToolbarHidden());
  const [isToolbarHiding, setIsToolbarHiding] = useState6(false);
  const portalWrapperRef = useRef6(null);
  useEffect6(() => {
    const stop = (e) => {
      const wrapper = portalWrapperRef.current;
      if (wrapper && wrapper.contains(e.target)) {
        e.stopPropagation();
      }
    };
    const events = ["mousedown", "click", "pointerdown"];
    events.forEach((evt) => document.body.addEventListener(evt, stop));
    return () => {
      events.forEach((evt) => document.body.removeEventListener(evt, stop));
    };
  }, []);
  const [markersVisible, setMarkersVisible] = useState6(false);
  const [markersExiting, setMarkersExiting] = useState6(false);
  const [hoverInfo, setHoverInfo] = useState6(null);
  const [hoverPosition, setHoverPosition] = useState6({ x: 0, y: 0 });
  const [pendingAnnotation, setPendingAnnotation] = useState6(null);
  const [copied, setCopied] = useState6(false);
  const [sendState, setSendState] = useState6("idle");
  const [cleared, setCleared] = useState6(false);
  const [isClearing, setIsClearing] = useState6(false);
  const [hoveredMarkerId, setHoveredMarkerId] = useState6(null);
  const [hoveredTargetElement, setHoveredTargetElement] = useState6(null);
  const [hoveredTargetElements, setHoveredTargetElements] = useState6([]);
  const [deletingMarkerId, setDeletingMarkerId] = useState6(null);
  const [renumberFrom, setRenumberFrom] = useState6(null);
  const [editingAnnotation, setEditingAnnotation] = useState6(
    null
  );
  const [editingTargetElement, setEditingTargetElement] = useState6(null);
  const [editingTargetElements, setEditingTargetElements] = useState6([]);
  const [scrollY, setScrollY] = useState6(0);
  const [isScrolling, setIsScrolling] = useState6(false);
  const [mounted, setMounted] = useState6(false);
  const [isFrozen, setIsFrozen] = useState6(false);
  const [showSettings, setShowSettings] = useState6(false);
  const [showSettingsVisible, setShowSettingsVisible] = useState6(false);
  const [settingsPage, setSettingsPage] = useState6(
    "main"
  );
  const [tooltipsHidden, setTooltipsHidden] = useState6(false);
  const [isDesignMode, setIsDesignMode] = useState6(false);
  const [designOverlayExiting, setDesignOverlayExiting] = useState6(false);
  const [designPlacements, setDesignPlacements] = useState6([]);
  const [activeDesignComponent, setActiveDesignComponent] = useState6(null);
  const designPlacementsLoaded = useRef6(false);
  const [blankCanvas, setBlankCanvas] = useState6(false);
  const [canvasReady, setCanvasReady] = useState6(false);
  const [canvasOpacity, setCanvasOpacity] = useState6(1);
  const [canvasPurpose, setCanvasPurpose] = useState6("new-page");
  const [wireframePurpose, setWireframePurpose] = useState6("");
  const [designInteracting, setDesignInteracting] = useState6(false);
  const [rearrangeState, setRearrangeState] = useState6(null);
  const rearrangeLoaded = useRef6(false);
  const exploreStashRef = useRef6({ rearrange: null, placements: [] });
  const wireframeStashRef = useRef6({ rearrange: null, placements: [] });
  const [designDeselectSignal, setDesignDeselectSignal] = useState6(0);
  const [rearrangeDeselectSignal, setRearrangeDeselectSignal] = useState6(0);
  const [designClearSignal, setDesignClearSignal] = useState6(0);
  const [rearrangeClearSignal, setRearrangeClearSignal] = useState6(0);
  const designSelectedIdsRef = useRef6(/* @__PURE__ */ new Set());
  const rearrangeSelectedIdsRef = useRef6(/* @__PURE__ */ new Set());
  const crossDragStartRef = useRef6(null);
  const designExitTimer = useRef6();
  const canvasShouldBeVisible = isDesignMode && isActive && !designOverlayExiting && blankCanvas;
  useEffect6(() => {
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
  const placementAnnotationMap = useRef6(/* @__PURE__ */ new Map());
  const rearrangeAnnotationMap = useRef6(/* @__PURE__ */ new Map());
  const rearrangeDebounceTimer = useRef6();
  const [isDrawMode, setIsDrawMode] = useState6(false);
  const [drawStrokes, setDrawStrokes] = useState6([]);
  const drawStrokesRef = useRef6(drawStrokes);
  drawStrokesRef.current = drawStrokes;
  const [hoveredDrawingIdx, setHoveredDrawingIdx] = useState6(null);
  const drawCanvasRef = useRef6(null);
  const isDrawingRef = useRef6(false);
  const currentStrokeRef = useRef6([]);
  const dimAmountRef = useRef6(0);
  const visualHighlightRef = useRef6(null);
  const exitingStrokeIdRef = useRef6(null);
  const exitingAlphaRef = useRef6(1);
  const [tooltipSessionActive, setTooltipSessionActive] = useState6(false);
  const tooltipSessionTimerRef = useRef6(
    null
  );
  const [pendingMultiSelectElements, setPendingMultiSelectElements] = useState6([]);
  const modifiersHeldRef = useRef6({ cmd: false, shift: false });
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
  useEffect6(() => {
    return () => {
      if (tooltipSessionTimerRef.current)
        clearTimeout(tooltipSessionTimerRef.current);
    };
  }, []);
  const [settings, setSettings] = useState6(() => {
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
  const [isDarkMode, setIsDarkMode] = useState6(true);
  const [showEntranceAnimation, setShowEntranceAnimation] = useState6(false);
  const toggleTheme = () => {
    portalWrapperRef.current?.classList.add(styles_module_default4.disableTransitions);
    setIsDarkMode((previous) => !previous);
    originalRequestAnimationFrame(() => {
      portalWrapperRef.current?.classList.remove(styles_module_default4.disableTransitions);
    });
  };
  const isDevMode = process.env.NODE_ENV === "development" || isReactPage();
  const effectiveReactMode = isDevMode && settings.reactEnabled ? OUTPUT_TO_REACT_MODE[settings.outputDetail] : "off";
  const [currentSessionId, setCurrentSessionId] = useState6(
    initialSessionId ?? null
  );
  const sessionInitializedRef = useRef6(false);
  const [connectionStatus, setConnectionStatus] = useState6(endpoint ? "connecting" : "disconnected");
  const [toolbarPosition, setToolbarPosition] = useState6(null);
  const [isDraggingToolbar, setIsDraggingToolbar] = useState6(false);
  const [dragStartPos, setDragStartPos] = useState6(null);
  const justFinishedToolbarDragRef = useRef6(false);
  const [animatedMarkers, setAnimatedMarkers] = useState6(
    /* @__PURE__ */ new Set()
  );
  const [exitingMarkers, setExitingMarkers] = useState6(/* @__PURE__ */ new Set());
  const [pendingExiting, setPendingExiting] = useState6(false);
  const [editExiting, setEditExiting] = useState6(false);
  const [isDragging, setIsDragging] = useState6(false);
  const mouseDownPosRef = useRef6(null);
  const dragStartRef = useRef6(null);
  const dragRectRef = useRef6(null);
  const highlightsContainerRef = useRef6(null);
  const justFinishedDragRef = useRef6(false);
  const lastElementUpdateRef = useRef6(0);
  const recentlyAddedIdRef = useRef6(null);
  const prevConnectionStatusRef = useRef6(null);
  const DRAG_THRESHOLD = 8;
  const ELEMENT_UPDATE_THROTTLE = 50;
  const popupRef = useRef6(null);
  const editPopupRef = useRef6(null);
  const scrollTimeoutRef = useRef6(null);
  const pathname = typeof window !== "undefined" ? window.location.pathname : "/";
  useEffect6(() => {
    if (showSettings) {
      setShowSettingsVisible(true);
    } else {
      setTooltipsHidden(false);
      setSettingsPage("main");
      const timer = originalSetTimeout(() => setShowSettingsVisible(false), 0);
      return () => clearTimeout(timer);
    }
  }, [showSettings]);
  const shouldShowMarkers = isActive && showMarkers && !isDesignMode;
  useEffect6(() => {
    if (shouldShowMarkers) {
      setMarkersExiting(false);
      setMarkersVisible(true);
      setAnimatedMarkers(/* @__PURE__ */ new Set());
      const timer = originalSetTimeout(() => {
        setAnimatedMarkers((prev) => {
          const newSet = new Set(prev);
          annotations.forEach((a) => newSet.add(a.id));
          return newSet;
        });
      }, 350);
      return () => clearTimeout(timer);
    } else if (markersVisible) {
      setMarkersExiting(true);
      const timer = originalSetTimeout(() => {
        setMarkersVisible(false);
        setMarkersExiting(false);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [shouldShowMarkers]);
  useEffect6(() => {
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
  useEffect6(() => {
    if (mounted) {
      localStorage.setItem(
        "feedback-toolbar-settings",
        JSON.stringify(settings)
      );
    }
  }, [settings, mounted]);
  useEffect6(() => {
    if (mounted) {
      localStorage.setItem(
        "feedback-toolbar-theme",
        isDarkMode ? "dark" : "light"
      );
    }
  }, [isDarkMode, mounted]);
  const prevDraggingRef = useRef6(false);
  useEffect6(() => {
    const wasDragging = prevDraggingRef.current;
    prevDraggingRef.current = isDraggingToolbar;
    if (wasDragging && !isDraggingToolbar && toolbarPosition && mounted) {
      localStorage.setItem(
        "feedback-toolbar-position",
        JSON.stringify(toolbarPosition)
      );
    }
  }, [isDraggingToolbar, toolbarPosition, mounted]);
  useEffect6(() => {
    if (!endpoint || !mounted || sessionInitializedRef.current) return;
    sessionInitializedRef.current = true;
    setConnectionStatus("connecting");
    const initSession = async () => {
      try {
        const storedSessionId = loadSessionId(pathname);
        const sessionIdToJoin = initialSessionId || storedSessionId;
        let sessionEstablished = false;
        if (sessionIdToJoin) {
          try {
            const session = await getSession(endpoint, sessionIdToJoin);
            setCurrentSessionId(session.id);
            setConnectionStatus("connected");
            saveSessionId(pathname, session.id);
            sessionEstablished = true;
            const allLocalAnnotations = loadAnnotations(pathname);
            const serverIds = new Set(session.annotations.map((a) => a.id));
            const localToMerge = allLocalAnnotations.filter((a) => {
              if (serverIds.has(a.id)) return false;
              return true;
            });
            if (localToMerge.length > 0) {
              const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
              const pageUrl = `${baseUrl}${pathname}`;
              const results = await Promise.allSettled(
                localToMerge.map(
                  (annotation) => syncAnnotation(endpoint, session.id, {
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
              setAnnotations(allAnnotations.filter(isRenderableAnnotation));
              saveAnnotationsWithSyncMarker(
                pathname,
                allAnnotations.filter(isRenderableAnnotation),
                session.id
              );
            } else {
              setAnnotations(
                session.annotations.filter(isRenderableAnnotation)
              );
              saveAnnotationsWithSyncMarker(
                pathname,
                session.annotations.filter(isRenderableAnnotation),
                session.id
              );
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
          const currentUrl = typeof window !== "undefined" ? window.location.href : "/";
          const session = await createSession(endpoint, currentUrl);
          setCurrentSessionId(session.id);
          setConnectionStatus("connected");
          saveSessionId(pathname, session.id);
          onSessionCreated?.(session.id);
          const allAnnotations = loadAllAnnotations();
          const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
          const syncPromises = [];
          for (const [pagePath, annotations2] of allAnnotations) {
            const unsyncedAnnotations = annotations2.filter(
              (a) => !a._syncedTo
            );
            if (unsyncedAnnotations.length === 0) continue;
            const pageUrl = `${baseUrl}${pagePath}`;
            const isCurrentPage = pagePath === pathname;
            syncPromises.push(
              (async () => {
                try {
                  const targetSession = isCurrentPage ? session : await createSession(endpoint, pageUrl);
                  const results = await Promise.allSettled(
                    unsyncedAnnotations.map(
                      (annotation) => syncAnnotation(endpoint, targetSession.id, {
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
                  const renderableSyncedAnnotations = syncedAnnotations.filter(
                    isRenderableAnnotation
                  );
                  saveAnnotationsWithSyncMarker(
                    pagePath,
                    renderableSyncedAnnotations,
                    targetSession.id
                  );
                  if (isCurrentPage) {
                    const originalIds = new Set(
                      unsyncedAnnotations.map((a) => a.id)
                    );
                    setAnnotations((prev) => {
                      const newDuringSync = prev.filter(
                        (a) => !originalIds.has(a.id)
                      );
                      return [...renderableSyncedAnnotations, ...newDuringSync];
                    });
                  }
                } catch (err) {
                  console.warn(
                    `[Agentation] Failed to sync annotations for ${pagePath}:`,
                    err
                  );
                }
              })()
            );
          }
          await Promise.allSettled(syncPromises);
        }
      } catch (error) {
        setConnectionStatus("disconnected");
        console.warn(
          "[Agentation] Failed to initialize session, using local storage:",
          error
        );
      }
    };
    initSession();
  }, [endpoint, initialSessionId, mounted, onSessionCreated, pathname]);
  useEffect6(() => {
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
  useEffect6(() => {
    if (!endpoint || !mounted || !currentSessionId) return;
    const eventSource = new EventSource(
      `${endpoint}/sessions/${currentSessionId}/events`
    );
    const removedStatuses = ["resolved", "dismissed"];
    const handler = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (removedStatuses.includes(event.payload?.status)) {
          const id = event.payload.id;
          const kind = event.payload.kind;
          if (kind === "placement") {
            for (const [placementId, annotationId] of placementAnnotationMap.current) {
              if (annotationId === id) {
                placementAnnotationMap.current.delete(placementId);
                setDesignPlacements((prev) => prev.filter((p) => p.id !== placementId));
                break;
              }
            }
          } else if (kind === "rearrange") {
            for (const [sectionId, annotationId] of rearrangeAnnotationMap.current) {
              if (annotationId === id) {
                rearrangeAnnotationMap.current.delete(sectionId);
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
            setExitingMarkers((prev) => new Set(prev).add(id));
            originalSetTimeout(() => {
              setAnnotations((prev) => prev.filter((a) => a.id !== id));
              setExitingMarkers((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
            }, 150);
          }
        }
      } catch {
      }
    };
    eventSource.addEventListener("annotation.updated", handler);
    return () => {
      eventSource.removeEventListener("annotation.updated", handler);
      eventSource.close();
    };
  }, [endpoint, mounted, currentSessionId]);
  useEffect6(() => {
    if (!endpoint || !mounted) return;
    const wasDisconnected = prevConnectionStatusRef.current === "disconnected";
    const isNowConnected = connectionStatus === "connected";
    prevConnectionStatusRef.current = connectionStatus;
    if (wasDisconnected && isNowConnected) {
      const syncLocalAnnotations = async () => {
        try {
          const localAnnotations = loadAnnotations(pathname);
          if (localAnnotations.length === 0) return;
          const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
          const pageUrl = `${baseUrl}${pathname}`;
          let sessionId = currentSessionId;
          let serverAnnotations = [];
          if (sessionId) {
            try {
              const session = await getSession(endpoint, sessionId);
              serverAnnotations = session.annotations;
            } catch {
              sessionId = null;
            }
          }
          if (!sessionId) {
            const newSession = await createSession(endpoint, pageUrl);
            sessionId = newSession.id;
            setCurrentSessionId(sessionId);
            saveSessionId(pathname, sessionId);
          }
          const serverIds = new Set(serverAnnotations.map((a) => a.id));
          const unsyncedLocal = localAnnotations.filter((a) => !serverIds.has(a.id));
          if (unsyncedLocal.length > 0) {
            const results = await Promise.allSettled(
              unsyncedLocal.map(
                (annotation) => syncAnnotation(endpoint, sessionId, {
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
            const renderableAnnotations = allAnnotations.filter(
              isRenderableAnnotation
            );
            setAnnotations(renderableAnnotations);
            saveAnnotationsWithSyncMarker(
              pathname,
              renderableAnnotations,
              sessionId
            );
          }
        } catch (err) {
          console.warn("[Agentation] Failed to sync on reconnect:", err);
        }
      };
      syncLocalAnnotations();
    }
  }, [connectionStatus, endpoint, mounted, currentSessionId, pathname]);
  const hideToolbarTemporarily = useCallback5(() => {
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
  useEffect6(() => {
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
          const rect = element.getBoundingClientRect();
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
  useEffect6(() => {
    const handleScroll = () => {
      setScrollY(window.scrollY);
      setIsScrolling(true);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      scrollTimeoutRef.current = originalSetTimeout(() => {
        setIsScrolling(false);
      }, 150);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);
  useEffect6(() => {
    if (mounted && annotations.length > 0) {
      if (currentSessionId) {
        saveAnnotationsWithSyncMarker(pathname, annotations, currentSessionId);
      } else {
        saveAnnotations(pathname, annotations);
      }
    } else if (mounted && annotations.length === 0) {
      localStorage.removeItem(getStorageKey(pathname));
    }
  }, [annotations, pathname, mounted, currentSessionId]);
  useEffect6(() => {
    if (mounted && !designPlacementsLoaded.current) {
      designPlacementsLoaded.current = true;
      const stored = loadDesignPlacements(pathname);
      if (stored.length > 0) setDesignPlacements(stored);
    }
  }, [mounted, pathname]);
  useEffect6(() => {
    if (mounted && designPlacementsLoaded.current && !blankCanvas) {
      if (designPlacements.length > 0) {
        saveDesignPlacements(pathname, designPlacements);
      } else {
        clearDesignPlacements(pathname);
      }
    }
  }, [designPlacements, pathname, mounted, blankCanvas]);
  useEffect6(() => {
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
  useEffect6(() => {
    if (mounted && rearrangeLoaded.current && !blankCanvas) {
      if (rearrangeState) {
        saveRearrangeState(pathname, rearrangeState);
      } else {
        clearRearrangeState(pathname);
      }
    }
  }, [rearrangeState, pathname, mounted, blankCanvas]);
  const wireframeLoaded = useRef6(false);
  useEffect6(() => {
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
  useEffect6(() => {
    if (!mounted || !wireframeLoaded.current) return;
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
  }, [rearrangeState, designPlacements, wireframePurpose, blankCanvas, pathname, mounted]);
  useEffect6(() => {
    if (isDesignMode && !rearrangeState) {
      setRearrangeState({
        sections: [],
        originalOrder: [],
        detectedAt: Date.now()
      });
    }
  }, [isDesignMode, rearrangeState]);
  useEffect6(() => {
    if (!endpoint || !currentSessionId) return;
    const currentMap = placementAnnotationMap.current;
    const currentIds = new Set(designPlacements.map((p) => p.id));
    for (const p of designPlacements) {
      if (currentMap.has(p.id)) continue;
      currentMap.set(p.id, "");
      const pageUrl = typeof window !== "undefined" ? window.location.pathname + window.location.search + window.location.hash : pathname;
      syncAnnotation(endpoint, currentSessionId, {
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
        placement: {
          componentType: p.type,
          width: p.width,
          height: p.height,
          scrollY: p.scrollY,
          text: p.text
        }
      }).then((serverAnnotation) => {
        if (currentMap.has(p.id)) {
          currentMap.set(p.id, serverAnnotation.id);
        }
      }).catch((err) => {
        console.warn("[Agentation] Failed to sync placement annotation:", err);
        currentMap.delete(p.id);
      });
    }
    for (const [placementId, annotationId] of currentMap) {
      if (!currentIds.has(placementId)) {
        currentMap.delete(placementId);
        if (annotationId) {
          deleteAnnotation(endpoint, annotationId).catch(() => {
          });
        }
      }
    }
  }, [designPlacements, endpoint, currentSessionId, pathname]);
  useEffect6(() => {
    if (!endpoint || !currentSessionId) return;
    if (rearrangeDebounceTimer.current) {
      clearTimeout(rearrangeDebounceTimer.current);
    }
    rearrangeDebounceTimer.current = originalSetTimeout(() => {
      const currentMap = rearrangeAnnotationMap.current;
      if (!rearrangeState || rearrangeState.sections.length === 0) {
        for (const [, annotationId] of currentMap) {
          if (annotationId) {
            deleteAnnotation(endpoint, annotationId).catch(() => {
            });
          }
        }
        currentMap.clear();
        return;
      }
      const currentIds = new Set(rearrangeState.sections.map((s2) => s2.id));
      const pageUrl = typeof window !== "undefined" ? window.location.pathname + window.location.search + window.location.hash : pathname;
      for (const section of rearrangeState.sections) {
        const orig = section.originalRect;
        const curr = section.currentRect;
        const hasMoved = Math.abs(orig.x - curr.x) > 1 || Math.abs(orig.y - curr.y) > 1 || Math.abs(orig.width - curr.width) > 1 || Math.abs(orig.height - curr.height) > 1;
        if (!hasMoved) {
          const existingId = currentMap.get(section.id);
          if (existingId) {
            currentMap.delete(section.id);
            deleteAnnotation(endpoint, existingId).catch(() => {
            });
          }
          continue;
        }
        const existingAnnotationId = currentMap.get(section.id);
        if (existingAnnotationId) {
          updateAnnotation(endpoint, existingAnnotationId, {
            comment: `Move ${section.label} section (${section.tagName}) \u2014 from (${Math.round(orig.x)},${Math.round(orig.y)}) ${Math.round(orig.width)}\xD7${Math.round(orig.height)} to (${Math.round(curr.x)},${Math.round(curr.y)}) ${Math.round(curr.width)}\xD7${Math.round(curr.height)}`
          }).catch((err) => {
            console.warn("[Agentation] Failed to update rearrange annotation:", err);
          });
        } else {
          currentMap.set(section.id, "");
          syncAnnotation(endpoint, currentSessionId, {
            id: section.id,
            x: curr.x / window.innerWidth * 100,
            y: curr.y,
            comment: `Move ${section.label} section (${section.tagName}) \u2014 from (${Math.round(orig.x)},${Math.round(orig.y)}) ${Math.round(orig.width)}\xD7${Math.round(orig.height)} to (${Math.round(curr.x)},${Math.round(curr.y)}) ${Math.round(curr.width)}\xD7${Math.round(curr.height)}`,
            element: section.selector,
            elementPath: "[rearrange]",
            timestamp: Date.now(),
            url: pageUrl,
            intent: "change",
            severity: "important",
            kind: "rearrange",
            rearrange: {
              selector: section.selector,
              label: section.label,
              tagName: section.tagName,
              originalRect: orig,
              currentRect: curr
            }
          }).then((serverAnnotation) => {
            if (currentMap.has(section.id)) {
              currentMap.set(section.id, serverAnnotation.id);
            }
          }).catch((err) => {
            console.warn("[Agentation] Failed to sync rearrange annotation:", err);
            currentMap.delete(section.id);
          });
        }
      }
      for (const [sectionId, annotationId] of currentMap) {
        if (!currentIds.has(sectionId)) {
          currentMap.delete(sectionId);
          if (annotationId) {
            deleteAnnotation(endpoint, annotationId).catch(() => {
            });
          }
        }
      }
    }, 300);
    return () => {
      if (rearrangeDebounceTimer.current) {
        clearTimeout(rearrangeDebounceTimer.current);
      }
    };
  }, [rearrangeState, endpoint, currentSessionId, pathname]);
  const rearrangeMovedEls = useRef6(/* @__PURE__ */ new Map());
  useLayoutEffect(() => {
    const sections = rearrangeState?.sections ?? [];
    const active = /* @__PURE__ */ new Set();
    if ((isDesignMode || designOverlayExiting) && isActive) {
      for (const s2 of sections) {
        active.add(s2.id);
        try {
          const el = document.querySelector(s2.selector);
          if (!el) continue;
          if (!rearrangeMovedEls.current.has(s2.id)) {
            const origStyles = {
              transform: el.style.transform,
              transformOrigin: el.style.transformOrigin,
              opacity: el.style.opacity,
              position: el.style.position,
              zIndex: el.style.zIndex,
              display: el.style.display
            };
            const ancestors = [];
            let parent = el.parentElement;
            while (parent && parent !== document.body) {
              const cs = getComputedStyle(parent);
              if (cs.overflow !== "visible" || cs.overflowX !== "visible" || cs.overflowY !== "visible") {
                ancestors.push({ el: parent, overflow: parent.style.overflow });
                parent.style.overflow = "visible";
              }
              parent = parent.parentElement;
            }
            const computed = getComputedStyle(el);
            if (computed.display === "inline") {
              el.style.display = "inline-block";
            }
            rearrangeMovedEls.current.set(s2.id, { el, origStyles, ancestors });
            el.style.transformOrigin = "top left";
            el.style.zIndex = "9999";
          }
        } catch {
        }
      }
    }
    for (const [id, entry] of rearrangeMovedEls.current) {
      if (!active.has(id)) {
        const { el, origStyles, ancestors } = entry;
        el.style.transition = "transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s cubic-bezier(0.22, 1, 0.36, 1)";
        el.style.transform = origStyles.transform;
        el.style.transformOrigin = origStyles.transformOrigin;
        el.style.opacity = origStyles.opacity;
        el.style.position = origStyles.position;
        el.style.zIndex = origStyles.zIndex;
        rearrangeMovedEls.current.delete(id);
        originalSetTimeout(() => {
          el.style.transition = "";
          el.style.display = origStyles.display;
          for (const a of ancestors) {
            a.el.style.overflow = a.overflow;
          }
        }, 450);
      }
    }
  }, [rearrangeState, isDesignMode, designOverlayExiting, isActive]);
  useEffect6(() => {
    return () => {
      for (const [, entry] of rearrangeMovedEls.current) {
        const { el, origStyles, ancestors } = entry;
        el.style.transition = "transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s cubic-bezier(0.22, 1, 0.36, 1)";
        el.style.transform = origStyles.transform;
        el.style.transformOrigin = origStyles.transformOrigin;
        el.style.opacity = origStyles.opacity;
        el.style.position = origStyles.position;
        el.style.zIndex = origStyles.zIndex;
        originalSetTimeout(() => {
          el.style.transition = "";
          el.style.display = origStyles.display;
          for (const a of ancestors) {
            a.el.style.overflow = a.overflow;
          }
        }, 450);
      }
      rearrangeMovedEls.current.clear();
    };
  }, []);
  const closeDesignMode = useCallback5(() => {
    setDesignOverlayExiting(true);
    setIsDesignMode(false);
    setActiveDesignComponent(null);
    clearTimeout(designExitTimer.current);
    designExitTimer.current = originalSetTimeout(() => {
      setDesignOverlayExiting(false);
    }, 300);
  }, []);
  const deactivate = useCallback5(() => {
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
  const freezeAnimations = useCallback5(() => {
    if (isFrozen) return;
    freeze();
    setIsFrozen(true);
  }, [isFrozen]);
  const unfreezeAnimations = useCallback5(() => {
    if (!isFrozen) return;
    unfreeze();
    setIsFrozen(false);
  }, [isFrozen]);
  const toggleFreeze = useCallback5(() => {
    if (isFrozen) {
      unfreezeAnimations();
    } else {
      freezeAnimations();
    }
  }, [isFrozen, freezeAnimations, unfreezeAnimations]);
  const createMultiSelectPendingAnnotation = useCallback5(() => {
    if (pendingMultiSelectElements.length === 0) return;
    const firstItem = pendingMultiSelectElements[0];
    const firstEl = firstItem.element;
    const isMulti = pendingMultiSelectElements.length > 1;
    const freshRects = pendingMultiSelectElements.map(
      (item) => item.element.getBoundingClientRect()
    );
    if (!isMulti) {
      const rect = freshRects[0];
      const isFixed = isElementFixed(firstEl);
      setPendingAnnotation({
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
        sourceFile: detectSourceFile(firstEl)
      });
    } else {
      const bounds = {
        left: Math.min(...freshRects.map((r) => r.left)),
        top: Math.min(...freshRects.map((r) => r.top)),
        right: Math.max(...freshRects.map((r) => r.right)),
        bottom: Math.max(...freshRects.map((r) => r.bottom))
      };
      const names = pendingMultiSelectElements.slice(0, 5).map((item) => item.name).join(", ");
      const suffix = pendingMultiSelectElements.length > 5 ? ` +${pendingMultiSelectElements.length - 5} more` : "";
      const elementBoundingBoxes = freshRects.map((rect) => ({
        x: rect.left,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height
      }));
      const lastItem = pendingMultiSelectElements[pendingMultiSelectElements.length - 1];
      const lastEl = lastItem.element;
      const lastRect = freshRects[freshRects.length - 1];
      const lastCenterX = lastRect.left + lastRect.width / 2;
      const lastCenterY = lastRect.top + lastRect.height / 2;
      const lastIsFixed = isElementFixed(lastEl);
      setPendingAnnotation({
        x: lastCenterX / window.innerWidth * 100,
        y: lastIsFixed ? lastCenterY : lastCenterY + window.scrollY,
        clientY: lastCenterY,
        element: `${pendingMultiSelectElements.length} elements: ${names}${suffix}`,
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
        multiSelectElements: pendingMultiSelectElements.map((item) => item.element),
        targetElement: lastEl,
        // Anchor marker/popup to last clicked element
        fullPath: getFullElementPath(firstEl),
        accessibility: getAccessibilityInfo(firstEl),
        computedStyles: getForensicComputedStyles(firstEl),
        computedStylesObj: getDetailedComputedStyles(firstEl),
        nearbyElements: getNearbyElements(firstEl),
        cssClasses: getElementClasses(firstEl),
        nearbyText: getNearbyText(firstEl),
        sourceFile: detectSourceFile(firstEl)
      });
    }
    setPendingMultiSelectElements([]);
    setHoverInfo(null);
  }, [pendingMultiSelectElements]);
  useEffect6(() => {
    if (!isActive) {
      setPendingAnnotation(null);
      setEditingAnnotation(null);
      setEditingTargetElement(null);
      setEditingTargetElements([]);
      setHoverInfo(null);
      setShowSettings(false);
      setPendingMultiSelectElements([]);
      modifiersHeldRef.current = { cmd: false, shift: false };
      if (isFrozen) {
        unfreezeAnimations();
      }
    }
  }, [isActive, isFrozen, unfreezeAnimations]);
  useEffect6(() => {
    return () => {
      unfreeze();
    };
  }, []);
  useEffect6(() => {
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
    const notAgentationSelector = `:not([data-agentation-root]):not([data-agentation-root] *)`;
    const style = document.createElement("style");
    style.id = "feedback-cursor-styles";
    style.textContent = `
      body ${notAgentationSelector} {
        cursor: crosshair !important;
      }

      body :is(${textElementsSelector})${notAgentationSelector} {
        cursor: text !important;
      }
    `;
    document.head.appendChild(style);
    return () => {
      const existingStyle = document.getElementById("feedback-cursor-styles");
      if (existingStyle) existingStyle.remove();
    };
  }, [isActive]);
  useEffect6(() => {
    if (hoveredDrawingIdx !== null && isActive) {
      document.documentElement.setAttribute("data-drawing-hover", "");
      return () => document.documentElement.removeAttribute("data-drawing-hover");
    }
  }, [hoveredDrawingIdx, isActive]);
  useEffect6(() => {
    if (!isActive || pendingAnnotation || isDrawMode || isDesignMode) return;
    const handleMouseMove = (e) => {
      const target = e.composedPath()[0] || e.target;
      if (closestCrossingShadow(target, "[data-feedback-toolbar]")) {
        setHoverInfo(null);
        return;
      }
      const elementUnder = deepElementFromPoint(e.clientX, e.clientY);
      if (!elementUnder || closestCrossingShadow(elementUnder, "[data-feedback-toolbar]")) {
        setHoverInfo(null);
        return;
      }
      const { name, elementName, path, reactComponents } = identifyElementWithReact(elementUnder, effectiveReactMode);
      const rect = elementUnder.getBoundingClientRect();
      setHoverInfo({
        element: name,
        elementName,
        elementPath: path,
        rect,
        reactComponents
      });
      setHoverPosition({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener("mousemove", handleMouseMove);
    return () => document.removeEventListener("mousemove", handleMouseMove);
  }, [isActive, pendingAnnotation, isDrawMode, isDesignMode, effectiveReactMode, drawStrokes]);
  const startEditAnnotation = useCallback5((annotation) => {
    setEditingAnnotation(annotation);
    setHoveredMarkerId(null);
    setHoveredTargetElement(null);
    setHoveredTargetElements([]);
    if (annotation.elementBoundingBoxes?.length) {
      const elements = [];
      for (const bb of annotation.elementBoundingBoxes) {
        const centerX = bb.x + bb.width / 2;
        const centerY = bb.y + bb.height / 2 - window.scrollY;
        const el = deepElementFromPoint(centerX, centerY);
        if (el) elements.push(el);
      }
      setEditingTargetElements(elements);
      setEditingTargetElement(null);
    } else if (annotation.boundingBox) {
      const bb = annotation.boundingBox;
      const centerX = bb.x + bb.width / 2;
      const centerY = annotation.isFixed ? bb.y + bb.height / 2 : bb.y + bb.height / 2 - window.scrollY;
      const el = deepElementFromPoint(centerX, centerY);
      if (el) {
        const elRect = el.getBoundingClientRect();
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
  }, []);
  useEffect6(() => {
    if (!isActive || isDrawMode || isDesignMode) return;
    const handleClick = (e) => {
      if (justFinishedDragRef.current) {
        justFinishedDragRef.current = false;
        return;
      }
      const target = e.composedPath()[0] || e.target;
      if (closestCrossingShadow(target, "[data-feedback-toolbar]")) return;
      if (closestCrossingShadow(target, "[data-annotation-popup]")) return;
      if (closestCrossingShadow(target, "[data-annotation-marker]")) return;
      if (e.metaKey && e.shiftKey && !pendingAnnotation && !editingAnnotation) {
        e.preventDefault();
        e.stopPropagation();
        const elementUnder2 = deepElementFromPoint(e.clientX, e.clientY);
        if (!elementUnder2) return;
        const rect2 = elementUnder2.getBoundingClientRect();
        const { name: name2, path: path2, reactComponents: reactComponents2 } = identifyElementWithReact(
          elementUnder2,
          effectiveReactMode
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
      if (settings.blockInteractions && isInteractive) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (pendingAnnotation) {
        if (isInteractive && !settings.blockInteractions) {
          return;
        }
        e.preventDefault();
        popupRef.current?.shake();
        return;
      }
      if (editingAnnotation) {
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
        effectiveReactMode
      );
      const rect = elementUnder.getBoundingClientRect();
      const x = e.clientX / window.innerWidth * 100;
      const isFixed = isElementFixed(elementUnder);
      const y = isFixed ? e.clientY : e.clientY + window.scrollY;
      const selection = window.getSelection();
      let selectedText;
      if (selection && selection.toString().trim().length > 0) {
        selectedText = selection.toString().trim().slice(0, 500);
      }
      const computedStylesObj = getDetailedComputedStyles(elementUnder);
      const computedStylesStr = getForensicComputedStyles(elementUnder);
      setPendingAnnotation({
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
        targetElement: elementUnder
        // Store for live position queries
      });
      setHoverInfo(null);
    };
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [
    isActive,
    isDrawMode,
    isDesignMode,
    pendingAnnotation,
    editingAnnotation,
    settings.blockInteractions,
    effectiveReactMode,
    pendingMultiSelectElements
  ]);
  useEffect6(() => {
    if (!isActive) return;
    const handleKeyDown = (e) => {
      if (e.key === "Meta") modifiersHeldRef.current.cmd = true;
      if (e.key === "Shift") modifiersHeldRef.current.shift = true;
    };
    const handleKeyUp = (e) => {
      const wasHoldingBoth = modifiersHeldRef.current.cmd && modifiersHeldRef.current.shift;
      if (e.key === "Meta") modifiersHeldRef.current.cmd = false;
      if (e.key === "Shift") modifiersHeldRef.current.shift = false;
      const nowHoldingBoth = modifiersHeldRef.current.cmd && modifiersHeldRef.current.shift;
      if (wasHoldingBoth && !nowHoldingBoth && pendingMultiSelectElements.length > 0) {
        createMultiSelectPendingAnnotation();
      }
    };
    const handleBlur = () => {
      modifiersHeldRef.current = { cmd: false, shift: false };
      setPendingMultiSelectElements([]);
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [isActive, pendingMultiSelectElements, createMultiSelectPendingAnnotation]);
  useEffect6(() => {
    if (!isActive || pendingAnnotation || isDrawMode || isDesignMode) return;
    const handleMouseDown = (e) => {
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
      if (textTags.has(target.tagName) || target.isContentEditable) {
        return;
      }
      e.preventDefault();
      mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isActive, pendingAnnotation, isDrawMode, isDesignMode]);
  useEffect6(() => {
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
        const nearbyElements = document.querySelectorAll(
          "button, a, input, img, p, h1, h2, h3, h4, h5, h6, li, label, td, th, div, span, section, article, aside, nav"
        );
        for (const el of nearbyElements) {
          if (el instanceof HTMLElement) {
            const rect = el.getBoundingClientRect();
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
          const rect = el.getBoundingClientRect();
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
              div.className = styles_module_default4.selectedElementHighlight;
              container.appendChild(div);
            }
            div.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
            div.style.width = `${rect.width}px`;
            div.style.height = `${rect.height}px`;
          });
        }
      }
    };
    document.addEventListener("mousemove", handleMouseMove, { passive: true });
    return () => document.removeEventListener("mousemove", handleMouseMove);
  }, [isActive, pendingAnnotation, isDragging, DRAG_THRESHOLD]);
  useEffect6(() => {
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
        document.querySelectorAll(selector).forEach((el) => {
          if (!(el instanceof HTMLElement)) return;
          if (closestCrossingShadow(el, "[data-feedback-toolbar]") || closestCrossingShadow(el, "[data-annotation-marker]"))
            return;
          const rect = el.getBoundingClientRect();
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
        if (finalElements.length > 0) {
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
            sourceFile: detectSourceFile(firstElement)
          });
        } else {
          const width = Math.abs(right - left);
          const height = Math.abs(bottom - top);
          if (width > 20 && height > 20) {
            setPendingAnnotation({
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
    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, [isActive, isDragging]);
  const fireWebhook = useCallback5(
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
  const addAnnotation = useCallback5(
    (comment) => {
      if (!pendingAnnotation) return;
      const newAnnotation = {
        id: Date.now().toString(),
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
        elementBoundingBoxes: pendingAnnotation.elementBoundingBoxes,
        // Protocol fields for server sync
        ...endpoint && currentSessionId ? {
          sessionId: currentSessionId,
          url: typeof window !== "undefined" ? window.location.href : void 0,
          status: "pending"
        } : {}
      };
      setAnnotations((prev) => [...prev, newAnnotation]);
      recentlyAddedIdRef.current = newAnnotation.id;
      originalSetTimeout(() => {
        recentlyAddedIdRef.current = null;
      }, 300);
      originalSetTimeout(() => {
        setAnimatedMarkers((prev) => new Set(prev).add(newAnnotation.id));
      }, 250);
      onAnnotationAdd?.(newAnnotation);
      fireWebhook("annotation.add", { annotation: newAnnotation });
      setPendingExiting(true);
      originalSetTimeout(() => {
        setPendingAnnotation(null);
        setPendingExiting(false);
      }, 150);
      window.getSelection()?.removeAllRanges();
      if (endpoint && currentSessionId) {
        syncAnnotation(endpoint, currentSessionId, newAnnotation).then((serverAnnotation) => {
          if (serverAnnotation.id !== newAnnotation.id) {
            setAnnotations(
              (prev) => prev.map(
                (a) => a.id === newAnnotation.id ? { ...a, id: serverAnnotation.id } : a
              )
            );
            setAnimatedMarkers((prev) => {
              const next = new Set(prev);
              next.delete(newAnnotation.id);
              next.add(serverAnnotation.id);
              return next;
            });
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
      currentSessionId
    ]
  );
  const cancelAnnotation = useCallback5(() => {
    setPendingExiting(true);
    originalSetTimeout(() => {
      setPendingAnnotation(null);
      setPendingExiting(false);
    }, 150);
  }, []);
  const deleteAnnotation2 = useCallback5(
    (id) => {
      const deletedIndex = annotations.findIndex((a) => a.id === id);
      const deletedAnnotation = annotations[deletedIndex];
      if (editingAnnotation?.id === id) {
        setEditExiting(true);
        originalSetTimeout(() => {
          setEditingAnnotation(null);
          setEditingTargetElement(null);
          setEditingTargetElements([]);
          setEditExiting(false);
        }, 150);
      }
      setDeletingMarkerId(id);
      setExitingMarkers((prev) => new Set(prev).add(id));
      if (deletedAnnotation) {
        onAnnotationDelete?.(deletedAnnotation);
        fireWebhook("annotation.delete", { annotation: deletedAnnotation });
      }
      if (endpoint) {
        deleteAnnotation(endpoint, id).catch((error) => {
          console.warn(
            "[Agentation] Failed to delete annotation from server:",
            error
          );
        });
      }
      originalSetTimeout(() => {
        setAnnotations((prev) => prev.filter((a) => a.id !== id));
        setExitingMarkers((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setDeletingMarkerId(null);
        if (deletedIndex < annotations.length - 1) {
          setRenumberFrom(deletedIndex);
          originalSetTimeout(() => setRenumberFrom(null), 200);
        }
      }, 150);
    },
    [annotations, editingAnnotation, onAnnotationDelete, fireWebhook, endpoint]
  );
  const handleMarkerHover = useCallback5(
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
          const allEls = document.elementsFromPoint(centerX, centerY);
          const el = allEls.find(
            (e) => !e.closest("[data-annotation-marker]") && !e.closest("[data-agentation-root]")
          );
          if (el) elements.push(el);
        }
        setHoveredTargetElements(elements);
        setHoveredTargetElement(null);
      } else if (annotation.boundingBox) {
        const bb = annotation.boundingBox;
        const centerX = bb.x + bb.width / 2;
        const centerY = annotation.isFixed ? bb.y + bb.height / 2 : bb.y + bb.height / 2 - window.scrollY;
        const el = deepElementFromPoint(centerX, centerY);
        if (el) {
          const elRect = el.getBoundingClientRect();
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
  const updateAnnotation2 = useCallback5(
    (newComment) => {
      if (!editingAnnotation) return;
      const updatedAnnotation = { ...editingAnnotation, comment: newComment };
      setAnnotations(
        (prev) => prev.map(
          (a) => a.id === editingAnnotation.id ? updatedAnnotation : a
        )
      );
      onAnnotationUpdate?.(updatedAnnotation);
      fireWebhook("annotation.update", { annotation: updatedAnnotation });
      if (endpoint) {
        updateAnnotation(endpoint, editingAnnotation.id, {
          comment: newComment
        }).catch((error) => {
          console.warn(
            "[Agentation] Failed to update annotation on server:",
            error
          );
        });
      }
      setEditExiting(true);
      originalSetTimeout(() => {
        setEditingAnnotation(null);
        setEditingTargetElement(null);
        setEditingTargetElements([]);
        setEditExiting(false);
      }, 150);
    },
    [editingAnnotation, onAnnotationUpdate, fireWebhook, endpoint]
  );
  const cancelEditAnnotation = useCallback5(() => {
    setEditExiting(true);
    originalSetTimeout(() => {
      setEditingAnnotation(null);
      setEditingTargetElement(null);
      setEditingTargetElements([]);
      setEditExiting(false);
    }, 150);
  }, []);
  const clearAll = useCallback5(() => {
    const count = annotations.length;
    const hasDesign = designPlacements.length > 0 || !!rearrangeState;
    if (count === 0 && drawStrokes.length === 0 && !hasDesign) return;
    onAnnotationsClear?.(annotations);
    fireWebhook("annotations.clear", { annotations });
    if (endpoint) {
      Promise.all(
        annotations.map(
          (a) => deleteAnnotation(endpoint, a.id).catch((error) => {
            console.warn(
              "[Agentation] Failed to delete annotation from server:",
              error
            );
          })
        )
      );
      for (const [, annotationId] of placementAnnotationMap.current) {
        if (annotationId) {
          deleteAnnotation(endpoint, annotationId).catch(() => {
          });
        }
      }
      placementAnnotationMap.current.clear();
      for (const [, annotationId] of rearrangeAnnotationMap.current) {
        if (annotationId) {
          deleteAnnotation(endpoint, annotationId).catch(() => {
          });
        }
      }
      rearrangeAnnotationMap.current.clear();
    }
    setIsClearing(true);
    setCleared(true);
    setDrawStrokes([]);
    const canvas = drawCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    if (designPlacements.length > 0 || rearrangeState) {
      setDesignClearSignal((n) => n + 1);
      setRearrangeClearSignal((n) => n + 1);
      originalSetTimeout(() => {
        setDesignPlacements([]);
        setRearrangeState(null);
      }, 200);
    }
    if (blankCanvas) setBlankCanvas(false);
    if (wireframePurpose) setWireframePurpose("");
    wireframeStashRef.current = { rearrange: null, placements: [] };
    clearWireframeState(pathname);
    const totalAnimationTime = count * 30 + 200;
    originalSetTimeout(() => {
      setAnnotations([]);
      setAnimatedMarkers(/* @__PURE__ */ new Set());
      localStorage.removeItem(getStorageKey(pathname));
      setIsClearing(false);
    }, totalAnimationTime);
    originalSetTimeout(() => setCleared(false), 1500);
  }, [pathname, annotations, drawStrokes, designPlacements, rearrangeState, blankCanvas, wireframePurpose, onAnnotationsClear, fireWebhook, endpoint]);
  const copyOutput = useCallback5(async () => {
    const displayUrl = typeof window !== "undefined" ? window.location.pathname + window.location.search + window.location.hash : pathname;
    const wireframeOnly = isDesignMode && blankCanvas;
    let output;
    if (wireframeOnly) {
      if (designPlacements.length === 0 && !rearrangeState && !wireframePurpose) return;
      output = "";
    } else {
      output = generateOutput(
        annotations,
        displayUrl,
        settings.outputDetail
      );
      if (!output && drawStrokes.length === 0 && designPlacements.length === 0 && !rearrangeState) return;
      if (!output) output = `## Page Feedback: ${displayUrl}
`;
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
    if (copyToClipboard) {
      try {
        await navigator.clipboard.writeText(output);
      } catch {
      }
    }
    onCopy?.(output);
    setCopied(true);
    originalSetTimeout(() => setCopied(false), 2e3);
    if (settings.autoClearAfterCopy) {
      originalSetTimeout(() => clearAll(), 500);
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
    settings.autoClearAfterCopy,
    clearAll,
    copyToClipboard,
    onCopy
  ]);
  const sendToWebhook = useCallback5(async () => {
    const displayUrl = typeof window !== "undefined" ? window.location.pathname + window.location.search + window.location.hash : pathname;
    let output = generateOutput(
      annotations,
      displayUrl,
      settings.outputDetail
    );
    if (!output && designPlacements.length === 0 && !rearrangeState) return;
    if (!output) output = `## Page Feedback: ${displayUrl}
`;
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
    if (onSubmit) {
      onSubmit(output, annotations);
    }
    setSendState("sending");
    await new Promise((resolve) => originalSetTimeout(resolve, 150));
    const success = await fireWebhook("submit", { output, annotations }, true);
    setSendState(success ? "sent" : "failed");
    originalSetTimeout(() => setSendState("idle"), 2500);
    if (success && settings.autoClearAfterCopy) {
      originalSetTimeout(() => clearAll(), 500);
    }
  }, [
    onSubmit,
    fireWebhook,
    annotations,
    designPlacements,
    rearrangeState,
    blankCanvas,
    canvasPurpose,
    pathname,
    settings.outputDetail,
    effectiveReactMode,
    settings.autoClearAfterCopy,
    clearAll
  ]);
  useEffect6(() => {
    if (!dragStartPos) return;
    const DRAG_THRESHOLD2 = 10;
    const handleMouseMove = (e) => {
      const deltaX = e.clientX - dragStartPos.x;
      const deltaY = e.clientY - dragStartPos.y;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      if (!isDraggingToolbar && distance > DRAG_THRESHOLD2) {
        setIsDraggingToolbar(true);
      }
      if (isDraggingToolbar || distance > DRAG_THRESHOLD2) {
        let newX = dragStartPos.toolbarX + deltaX;
        let newY = dragStartPos.toolbarY + deltaY;
        const padding = 20;
        const wrapperWidth = 337;
        const toolbarHeight = 44;
        const contentWidth = isActive ? connectionStatus === "connected" ? 297 : 257 : 44;
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
    const handleMouseUp = () => {
      if (isDraggingToolbar) {
        justFinishedToolbarDragRef.current = true;
      }
      setIsDraggingToolbar(false);
      setDragStartPos(null);
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragStartPos, isDraggingToolbar, isActive, connectionStatus]);
  const handleToolbarMouseDown = useCallback5(
    (e) => {
      if (e.target.closest("button") || e.target.closest("[data-agentation-settings-panel]")) {
        return;
      }
      const toolbarParent = e.currentTarget.parentElement;
      if (!toolbarParent) return;
      const rect = toolbarParent.getBoundingClientRect();
      const currentX = toolbarPosition?.x ?? rect.left;
      const currentY = toolbarPosition?.y ?? rect.top;
      setDragStartPos({
        x: e.clientX,
        y: e.clientY,
        toolbarX: currentX,
        toolbarY: currentY
      });
    },
    [toolbarPosition]
  );
  useEffect6(() => {
    if (!toolbarPosition) return;
    const constrainPosition = () => {
      const padding = 20;
      const wrapperWidth = 337;
      const toolbarHeight = 44;
      let newX = toolbarPosition.x;
      let newY = toolbarPosition.y;
      const contentWidth = isActive ? connectionStatus === "connected" ? 297 : 257 : 44;
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
  }, [toolbarPosition, isActive, connectionStatus]);
  useEffect6(() => {
    const handleKeyDown = (e) => {
      const target = e.target;
      const isTyping = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if (e.key === "Escape") {
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
        if (pendingAnnotation) {
        } else if (isActive) {
          hideTooltipsUntilMouseLeave();
          setIsActive(false);
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        hideTooltipsUntilMouseLeave();
        if (isActive) {
          deactivate();
        } else {
          setIsActive(true);
        }
        return;
      }
      if (isTyping || e.metaKey || e.ctrlKey) return;
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
          setIsDesignMode(true);
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
        const hasValidWebhook = isValidUrl(settings.webhookUrl) || isValidUrl(webhookUrl || "");
        if (annotations.length > 0 && hasValidWebhook && sendState === "idle") {
          e.preventDefault();
          hideTooltipsUntilMouseLeave();
          sendToWebhook();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    isActive,
    isDrawMode,
    isDesignMode,
    activeDesignComponent,
    designPlacements,
    rearrangeState,
    pendingAnnotation,
    annotations.length,
    settings.webhookUrl,
    webhookUrl,
    sendState,
    sendToWebhook,
    toggleFreeze,
    copyOutput,
    clearAll,
    pendingMultiSelectElements
  ]);
  if (!mounted) return null;
  if (isToolbarHidden) return null;
  const hasAnnotations = annotations.length > 0;
  const visibleAnnotations = annotations.filter(
    (a) => !exitingMarkers.has(a.id) && a.kind !== "placement" && a.kind !== "rearrange"
  );
  const hasVisibleAnnotations = visibleAnnotations.length > 0;
  const exitingAnnotationsList = annotations.filter(
    (a) => exitingMarkers.has(a.id)
  );
  const getTooltipPosition = (annotation) => {
    const tooltipMaxWidth = 200;
    const tooltipEstimatedHeight = 80;
    const markerSize = 22;
    const gap = 10;
    const markerX = annotation.x / 100 * window.innerWidth;
    const markerY = typeof annotation.y === "string" ? parseFloat(annotation.y) : annotation.y;
    const styles = {};
    const spaceBelow = window.innerHeight - markerY - markerSize - gap;
    if (spaceBelow < tooltipEstimatedHeight) {
      styles.top = "auto";
      styles.bottom = `calc(100% + ${gap}px)`;
    }
    const centerX = markerX - tooltipMaxWidth / 2;
    const edgePadding = 10;
    if (centerX < edgePadding) {
      const offset = edgePadding - centerX;
      styles.left = `calc(50% + ${offset}px)`;
    } else if (centerX + tooltipMaxWidth > window.innerWidth - edgePadding) {
      const overflow = centerX + tooltipMaxWidth - (window.innerWidth - edgePadding);
      styles.left = `calc(50% - ${overflow}px)`;
    }
    return styles;
  };
  return createPortal2(
    /* @__PURE__ */ jsxs13("div", { ref: portalWrapperRef, style: { display: "contents" }, "data-agentation-theme": isDarkMode ? "dark" : "light", "data-agentation-accent": settings.annotationColorId, "data-agentation-root": "", children: [
      /* @__PURE__ */ jsx14(
        "div",
        {
          className: `${styles_module_default4.toolbar}${userClassName ? ` ${userClassName}` : ""}`,
          "data-feedback-toolbar": true,
          "data-agentation-toolbar": true,
          style: toolbarPosition ? {
            left: toolbarPosition.x,
            top: toolbarPosition.y,
            right: "auto",
            bottom: "auto"
          } : void 0,
          children: /* @__PURE__ */ jsxs13(
            "div",
            {
              className: `${styles_module_default4.toolbarContainer} ${isActive ? styles_module_default4.expanded : styles_module_default4.collapsed} ${showEntranceAnimation ? styles_module_default4.entrance : ""} ${isToolbarHiding ? styles_module_default4.hiding : ""} ${!settings.webhooksEnabled && (isValidUrl(settings.webhookUrl) || isValidUrl(webhookUrl || "")) ? styles_module_default4.serverConnected : ""}`,
              onClick: !isActive ? (e) => {
                if (justFinishedToolbarDragRef.current) {
                  justFinishedToolbarDragRef.current = false;
                  e.preventDefault();
                  return;
                }
                setIsActive(true);
              } : void 0,
              onMouseDown: handleToolbarMouseDown,
              role: !isActive ? "button" : void 0,
              tabIndex: !isActive ? 0 : -1,
              title: !isActive ? "Start feedback mode" : void 0,
              children: [
                /* @__PURE__ */ jsxs13(
                  "div",
                  {
                    className: `${styles_module_default4.toggleContent} ${!isActive ? styles_module_default4.visible : styles_module_default4.hidden}`,
                    children: [
                      /* @__PURE__ */ jsx14(IconListSparkle, { size: 24 }),
                      hasVisibleAnnotations && /* @__PURE__ */ jsx14(
                        "span",
                        {
                          className: `${styles_module_default4.badge} ${isActive ? styles_module_default4.fadeOut : ""} ${showEntranceAnimation ? styles_module_default4.entrance : ""}`,
                          children: visibleAnnotations.length
                        }
                      )
                    ]
                  }
                ),
                /* @__PURE__ */ jsxs13(
                  "div",
                  {
                    className: `${styles_module_default4.controlsContent} ${isActive ? styles_module_default4.visible : styles_module_default4.hidden} ${toolbarPosition && toolbarPosition.y < 100 ? styles_module_default4.tooltipBelow : ""} ${tooltipsHidden || showSettings ? styles_module_default4.tooltipsHidden : ""} ${tooltipSessionActive ? styles_module_default4.tooltipsInSession : ""}`,
                    onMouseEnter: handleControlsMouseEnter,
                    onMouseLeave: handleControlsMouseLeave,
                    children: [
                      /* @__PURE__ */ jsxs13(
                        "div",
                        {
                          className: `${styles_module_default4.buttonWrapper} ${toolbarPosition && toolbarPosition.x < 120 ? styles_module_default4.buttonWrapperAlignLeft : ""}`,
                          children: [
                            /* @__PURE__ */ jsx14(
                              "button",
                              {
                                className: styles_module_default4.controlButton,
                                onClick: (e) => {
                                  e.stopPropagation();
                                  hideTooltipsUntilMouseLeave();
                                  toggleFreeze();
                                },
                                "data-active": isFrozen,
                                children: /* @__PURE__ */ jsx14(IconPausePlayAnimated, { size: 24, isPaused: isFrozen })
                              }
                            ),
                            /* @__PURE__ */ jsxs13("span", { className: styles_module_default4.buttonTooltip, children: [
                              isFrozen ? "Resume animations" : "Pause animations",
                              /* @__PURE__ */ jsx14("span", { className: styles_module_default4.shortcut, children: "P" })
                            ] })
                          ]
                        }
                      ),
                      /* @__PURE__ */ jsxs13("div", { className: styles_module_default4.buttonWrapper, children: [
                        /* @__PURE__ */ jsx14(
                          "button",
                          {
                            className: `${styles_module_default4.controlButton} ${!isDarkMode ? styles_module_default4.light : ""}`,
                            onClick: (e) => {
                              e.stopPropagation();
                              hideTooltipsUntilMouseLeave();
                              if (isDrawMode) setIsDrawMode(false);
                              if (showSettings) setShowSettings(false);
                              if (pendingAnnotation) cancelAnnotation();
                              if (isDesignMode) {
                                closeDesignMode();
                              } else {
                                setIsDesignMode(true);
                              }
                            },
                            "data-active": isDesignMode,
                            style: isDesignMode && blankCanvas ? { color: "#f97316", background: "rgba(249, 115, 22, 0.25)" } : void 0,
                            children: /* @__PURE__ */ jsx14(IconLayout, { size: 21 })
                          }
                        ),
                        /* @__PURE__ */ jsxs13("span", { className: styles_module_default4.buttonTooltip, children: [
                          isDesignMode ? "Exit layout mode" : "Layout mode",
                          /* @__PURE__ */ jsx14("span", { className: styles_module_default4.shortcut, children: "L" })
                        ] })
                      ] }),
                      /* @__PURE__ */ jsxs13("div", { className: styles_module_default4.buttonWrapper, children: [
                        /* @__PURE__ */ jsx14(
                          "button",
                          {
                            className: styles_module_default4.controlButton,
                            onClick: (e) => {
                              e.stopPropagation();
                              hideTooltipsUntilMouseLeave();
                              setShowMarkers(!showMarkers);
                            },
                            disabled: !hasAnnotations || isDesignMode,
                            children: /* @__PURE__ */ jsx14(IconEyeAnimated, { size: 24, isOpen: showMarkers })
                          }
                        ),
                        /* @__PURE__ */ jsxs13("span", { className: styles_module_default4.buttonTooltip, children: [
                          showMarkers ? "Hide markers" : "Show markers",
                          /* @__PURE__ */ jsx14("span", { className: styles_module_default4.shortcut, children: "H" })
                        ] })
                      ] }),
                      /* @__PURE__ */ jsxs13("div", { className: styles_module_default4.buttonWrapper, children: [
                        /* @__PURE__ */ jsx14(
                          "button",
                          {
                            className: `${styles_module_default4.controlButton} ${copied ? styles_module_default4.statusShowing : ""}`,
                            onClick: (e) => {
                              e.stopPropagation();
                              hideTooltipsUntilMouseLeave();
                              copyOutput();
                            },
                            disabled: isDesignMode && blankCanvas ? designPlacements.length === 0 && !rearrangeState?.sections?.length : !hasAnnotations && drawStrokes.length === 0 && designPlacements.length === 0 && !rearrangeState?.sections?.length,
                            "data-active": copied,
                            children: /* @__PURE__ */ jsx14(IconCopyAnimated, { size: 24, copied, tint: isDesignMode && blankCanvas && (designPlacements.length > 0 || !!rearrangeState?.sections?.length) ? "#f97316" : void 0 })
                          }
                        ),
                        /* @__PURE__ */ jsxs13("span", { className: styles_module_default4.buttonTooltip, children: [
                          isDesignMode && blankCanvas ? "Copy layout" : "Copy feedback",
                          /* @__PURE__ */ jsx14("span", { className: styles_module_default4.shortcut, children: "C" })
                        ] })
                      ] }),
                      /* @__PURE__ */ jsxs13(
                        "div",
                        {
                          className: `${styles_module_default4.buttonWrapper} ${styles_module_default4.sendButtonWrapper} ${isActive && !settings.webhooksEnabled && (isValidUrl(settings.webhookUrl) || isValidUrl(webhookUrl || "")) ? styles_module_default4.sendButtonVisible : ""}`,
                          children: [
                            /* @__PURE__ */ jsxs13(
                              "button",
                              {
                                className: `${styles_module_default4.controlButton} ${sendState === "sent" || sendState === "failed" ? styles_module_default4.statusShowing : ""}`,
                                onClick: (e) => {
                                  e.stopPropagation();
                                  hideTooltipsUntilMouseLeave();
                                  sendToWebhook();
                                },
                                disabled: !hasAnnotations || !isValidUrl(settings.webhookUrl) && !isValidUrl(webhookUrl || "") || sendState === "sending",
                                "data-no-hover": sendState === "sent" || sendState === "failed",
                                tabIndex: isValidUrl(settings.webhookUrl) || isValidUrl(webhookUrl || "") ? 0 : -1,
                                children: [
                                  /* @__PURE__ */ jsx14(IconSendArrow, { size: 24, state: sendState }),
                                  hasAnnotations && sendState === "idle" && /* @__PURE__ */ jsx14(
                                    "span",
                                    {
                                      className: styles_module_default4.buttonBadge,
                                      children: annotations.length
                                    }
                                  )
                                ]
                              }
                            ),
                            /* @__PURE__ */ jsxs13("span", { className: styles_module_default4.buttonTooltip, children: [
                              "Send Annotations",
                              /* @__PURE__ */ jsx14("span", { className: styles_module_default4.shortcut, children: "S" })
                            ] })
                          ]
                        }
                      ),
                      /* @__PURE__ */ jsxs13("div", { className: styles_module_default4.buttonWrapper, children: [
                        /* @__PURE__ */ jsx14(
                          "button",
                          {
                            className: styles_module_default4.controlButton,
                            onClick: (e) => {
                              e.stopPropagation();
                              hideTooltipsUntilMouseLeave();
                              clearAll();
                            },
                            disabled: !hasAnnotations && drawStrokes.length === 0 && designPlacements.length === 0 && !rearrangeState?.sections?.length,
                            "data-danger": true,
                            children: /* @__PURE__ */ jsx14(IconTrashAlt, { size: 24 })
                          }
                        ),
                        /* @__PURE__ */ jsxs13("span", { className: styles_module_default4.buttonTooltip, children: [
                          "Clear all",
                          /* @__PURE__ */ jsx14("span", { className: styles_module_default4.shortcut, children: "X" })
                        ] })
                      ] }),
                      /* @__PURE__ */ jsxs13("div", { className: styles_module_default4.buttonWrapper, children: [
                        /* @__PURE__ */ jsx14(
                          "button",
                          {
                            className: styles_module_default4.controlButton,
                            onClick: (e) => {
                              e.stopPropagation();
                              hideTooltipsUntilMouseLeave();
                              if (isDesignMode) closeDesignMode();
                              setShowSettings(!showSettings);
                            },
                            children: /* @__PURE__ */ jsx14(IconGear, { size: 24 })
                          }
                        ),
                        endpoint && connectionStatus !== "disconnected" && /* @__PURE__ */ jsx14(
                          "span",
                          {
                            className: `${styles_module_default4.mcpIndicator} ${styles_module_default4[connectionStatus]} ${showSettings ? styles_module_default4.hidden : ""}`,
                            title: connectionStatus === "connected" ? "MCP Connected" : "MCP Connecting..."
                          }
                        ),
                        /* @__PURE__ */ jsx14("span", { className: styles_module_default4.buttonTooltip, children: "Settings" })
                      ] }),
                      /* @__PURE__ */ jsx14(
                        "div",
                        {
                          className: styles_module_default4.divider
                        }
                      ),
                      /* @__PURE__ */ jsxs13(
                        "div",
                        {
                          className: `${styles_module_default4.buttonWrapper} ${toolbarPosition && typeof window !== "undefined" && toolbarPosition.x > window.innerWidth - 120 ? styles_module_default4.buttonWrapperAlignRight : ""}`,
                          children: [
                            /* @__PURE__ */ jsx14(
                              "button",
                              {
                                className: styles_module_default4.controlButton,
                                onClick: (e) => {
                                  e.stopPropagation();
                                  hideTooltipsUntilMouseLeave();
                                  deactivate();
                                },
                                children: /* @__PURE__ */ jsx14(IconXmarkLarge, { size: 24 })
                              }
                            ),
                            /* @__PURE__ */ jsxs13("span", { className: styles_module_default4.buttonTooltip, children: [
                              "Exit",
                              /* @__PURE__ */ jsx14("span", { className: styles_module_default4.shortcut, children: "Esc" })
                            ] })
                          ]
                        }
                      )
                    ]
                  }
                ),
                /* @__PURE__ */ jsx14(
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
                      setDesignClearSignal((n) => n + 1);
                      setRearrangeClearSignal((n) => n + 1);
                      originalSetTimeout(() => {
                        setRearrangeState({
                          sections: [],
                          originalOrder: [],
                          detectedAt: Date.now()
                        });
                      }, 200);
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
                          preview.className = `${styles_module_default3.dragPreview}${blankCanvas ? ` ${styles_module_default3.dragPreviewWireframe}` : ""}`;
                          document.body.appendChild(preview);
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
                        if (preview) document.body.removeChild(preview);
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
                /* @__PURE__ */ jsx14(
                  SettingsPanel,
                  {
                    settings,
                    onSettingsChange: (patch) => setSettings((s2) => ({ ...s2, ...patch })),
                    isDarkMode,
                    onToggleTheme: toggleTheme,
                    isDevMode,
                    connectionStatus,
                    endpoint,
                    isVisible: showSettingsVisible,
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
      (isDesignMode || designOverlayExiting) && /* @__PURE__ */ jsx14(
        "div",
        {
          className: `${styles_module_default3.blankCanvas} ${canvasReady ? styles_module_default3.visible : ""} ${designInteracting ? styles_module_default3.gridActive : ""}`,
          style: { "--canvas-opacity": canvasOpacity },
          "data-feedback-toolbar": true
        }
      ),
      isDesignMode && blankCanvas && canvasReady && /* @__PURE__ */ jsxs13("div", { className: styles_module_default3.wireframeNotice, "data-feedback-toolbar": true, children: [
        /* @__PURE__ */ jsxs13("div", { className: styles_module_default3.wireframeOpacityRow, children: [
          /* @__PURE__ */ jsx14("span", { className: styles_module_default3.wireframeOpacityLabel, children: "Toggle Opacity" }),
          /* @__PURE__ */ jsx14(
            "input",
            {
              type: "range",
              className: styles_module_default3.wireframeOpacitySlider,
              min: 0,
              max: 1,
              step: 0.01,
              value: canvasOpacity,
              onChange: (e) => setCanvasOpacity(Number(e.target.value))
            }
          )
        ] }),
        /* @__PURE__ */ jsxs13("div", { className: styles_module_default3.wireframeNoticeTitleRow, children: [
          /* @__PURE__ */ jsx14("span", { className: styles_module_default3.wireframeNoticeTitle, children: "Wireframe Mode" }),
          /* @__PURE__ */ jsx14("span", { className: styles_module_default3.wireframeNoticeDivider }),
          /* @__PURE__ */ jsx14(
            "button",
            {
              className: styles_module_default3.wireframeStartOver,
              onClick: () => {
                setDesignClearSignal((n) => n + 1);
                setRearrangeState({ sections: [], originalOrder: [], detectedAt: Date.now() });
                wireframeStashRef.current = { rearrange: null, placements: [] };
                setWireframePurpose("");
                clearWireframeState(pathname);
              },
              children: "Start Over"
            }
          )
        ] }),
        "Drag components onto the canvas.",
        /* @__PURE__ */ jsx14("br", {}),
        "Copied output will only include the wireframed layout."
      ] }),
      (isDesignMode || designOverlayExiting) && /* @__PURE__ */ jsx14(
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
          clearSignal: designClearSignal,
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
              const outlineEl = document.querySelector(`[data-rearrange-section="${s2.id}"]`);
              if (outlineEl) outlineEl.style.transform = `translate(${dx}px, ${dy}px)`;
            }
          },
          onDragEnd: (dx, dy, committed) => {
            const selIds = rearrangeSelectedIdsRef.current;
            const starts = crossDragStartRef.current;
            crossDragStartRef.current = null;
            if (!selIds.size || !rearrangeState || !starts) return;
            for (const id of selIds) {
              const el = document.querySelector(`[data-rearrange-section="${id}"]`);
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
      (isDesignMode || designOverlayExiting) && rearrangeState && /* @__PURE__ */ jsx14(
        RearrangeOverlay,
        {
          rearrangeState,
          onChange: setRearrangeState,
          isDarkMode,
          exiting: designOverlayExiting,
          blankCanvas,
          extraSnapRects: designPlacements.map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height })),
          clearSignal: rearrangeClearSignal,
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
              const el = document.querySelector(`[data-design-placement="${id}"]`);
              if (el) el.style.transform = `translate(${dx}px, ${dy}px)`;
            }
          },
          onDragEnd: (dx, dy, committed) => {
            const selIds = designSelectedIdsRef.current;
            const starts = crossDragStartRef.current;
            crossDragStartRef.current = null;
            if (!selIds.size || !starts) return;
            for (const id of selIds) {
              const el = document.querySelector(`[data-design-placement="${id}"]`);
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
      /* @__PURE__ */ jsx14(
        "canvas",
        {
          ref: drawCanvasRef,
          className: `${styles_module_default4.drawCanvas} ${isDrawMode ? styles_module_default4.active : ""}`,
          style: { opacity: shouldShowMarkers ? 1 : 0, transition: "opacity 0.15s ease" },
          "data-feedback-toolbar": true
        }
      ),
      /* @__PURE__ */ jsxs13("div", { className: styles_module_default4.markersLayer, "data-feedback-toolbar": true, children: [
        markersVisible && visibleAnnotations.filter((a) => !a.isFixed).map((annotation, layerIndex, arr) => /* @__PURE__ */ jsx14(
          AnnotationMarker,
          {
            annotation,
            globalIndex: visibleAnnotations.findIndex((a) => a.id === annotation.id),
            layerIndex,
            layerSize: arr.length,
            isExiting: markersExiting,
            isClearing,
            isAnimated: animatedMarkers.has(annotation.id),
            isHovered: !markersExiting && hoveredMarkerId === annotation.id,
            isDeleting: deletingMarkerId === annotation.id,
            isEditingAny: !!editingAnnotation,
            renumberFrom,
            markerClickBehavior: settings.markerClickBehavior,
            tooltipStyle: getTooltipPosition(annotation),
            onHoverEnter: (a) => !markersExiting && a.id !== recentlyAddedIdRef.current && handleMarkerHover(a),
            onHoverLeave: () => handleMarkerHover(null),
            onClick: (a) => settings.markerClickBehavior === "delete" ? deleteAnnotation2(a.id) : startEditAnnotation(a),
            onContextMenu: startEditAnnotation
          },
          annotation.id
        )),
        markersVisible && !markersExiting && exitingAnnotationsList.filter((a) => !a.isFixed).map((a) => /* @__PURE__ */ jsx14(ExitingMarker, { annotation: a }, a.id))
      ] }),
      /* @__PURE__ */ jsxs13("div", { className: styles_module_default4.fixedMarkersLayer, "data-feedback-toolbar": true, children: [
        markersVisible && visibleAnnotations.filter((a) => a.isFixed).map((annotation, layerIndex, arr) => /* @__PURE__ */ jsx14(
          AnnotationMarker,
          {
            annotation,
            globalIndex: visibleAnnotations.findIndex((a) => a.id === annotation.id),
            layerIndex,
            layerSize: arr.length,
            isExiting: markersExiting,
            isClearing,
            isAnimated: animatedMarkers.has(annotation.id),
            isHovered: !markersExiting && hoveredMarkerId === annotation.id,
            isDeleting: deletingMarkerId === annotation.id,
            isEditingAny: !!editingAnnotation,
            renumberFrom,
            markerClickBehavior: settings.markerClickBehavior,
            tooltipStyle: getTooltipPosition(annotation),
            onHoverEnter: (a) => !markersExiting && a.id !== recentlyAddedIdRef.current && handleMarkerHover(a),
            onHoverLeave: () => handleMarkerHover(null),
            onClick: (a) => settings.markerClickBehavior === "delete" ? deleteAnnotation2(a.id) : startEditAnnotation(a),
            onContextMenu: startEditAnnotation
          },
          annotation.id
        )),
        markersVisible && !markersExiting && exitingAnnotationsList.filter((a) => a.isFixed).map((a) => /* @__PURE__ */ jsx14(ExitingMarker, { annotation: a, fixed: true }, a.id))
      ] }),
      isActive && /* @__PURE__ */ jsxs13(
        "div",
        {
          className: styles_module_default4.overlay,
          "data-feedback-toolbar": true,
          style: pendingAnnotation || editingAnnotation ? { zIndex: 99999 } : void 0,
          children: [
            hoverInfo?.rect && !pendingAnnotation && !isScrolling && !isDragging && /* @__PURE__ */ jsx14(
              "div",
              {
                className: `${styles_module_default4.hoverHighlight} ${styles_module_default4.enter}`,
                style: {
                  left: hoverInfo.rect.left,
                  top: hoverInfo.rect.top,
                  width: hoverInfo.rect.width,
                  height: hoverInfo.rect.height,
                  borderColor: "color-mix(in srgb, var(--agentation-color-accent) 50%, transparent)",
                  backgroundColor: "color-mix(in srgb, var(--agentation-color-accent) 4%, transparent)"
                }
              }
            ),
            pendingMultiSelectElements.filter((item) => document.contains(item.element)).map((item, index) => {
              const rect = item.element.getBoundingClientRect();
              const isMulti = pendingMultiSelectElements.length > 1;
              return /* @__PURE__ */ jsx14(
                "div",
                {
                  className: isMulti ? styles_module_default4.multiSelectOutline : styles_module_default4.singleSelectOutline,
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
                  return hoveredTargetElements.filter((el) => document.contains(el)).map((el, index) => {
                    const rect2 = el.getBoundingClientRect();
                    return /* @__PURE__ */ jsx14(
                      "div",
                      {
                        className: `${styles_module_default4.multiSelectOutline} ${styles_module_default4.enter}`,
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
                  (bb2, index) => /* @__PURE__ */ jsx14(
                    "div",
                    {
                      className: `${styles_module_default4.multiSelectOutline} ${styles_module_default4.enter}`,
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
              const rect = hoveredTargetElement && document.contains(hoveredTargetElement) ? hoveredTargetElement.getBoundingClientRect() : null;
              const bb = rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : {
                x: hoveredAnnotation.boundingBox.x,
                y: hoveredAnnotation.isFixed ? hoveredAnnotation.boundingBox.y : hoveredAnnotation.boundingBox.y - scrollY,
                width: hoveredAnnotation.boundingBox.width,
                height: hoveredAnnotation.boundingBox.height
              };
              const isMulti = hoveredAnnotation.isMultiSelect;
              return /* @__PURE__ */ jsx14(
                "div",
                {
                  className: `${isMulti ? styles_module_default4.multiSelectOutline : styles_module_default4.singleSelectOutline} ${styles_module_default4.enter}`,
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
            hoverInfo && !pendingAnnotation && !isScrolling && !isDragging && /* @__PURE__ */ jsxs13(
              "div",
              {
                className: `${styles_module_default4.hoverTooltip} ${styles_module_default4.enter}`,
                style: {
                  left: Math.max(
                    8,
                    Math.min(hoverPosition.x, window.innerWidth - 100)
                  ),
                  top: Math.max(
                    hoverPosition.y - (hoverInfo.reactComponents ? 48 : 32),
                    8
                  )
                },
                children: [
                  hoverInfo.reactComponents && /* @__PURE__ */ jsx14("div", { className: styles_module_default4.hoverReactPath, children: hoverInfo.reactComponents }),
                  /* @__PURE__ */ jsx14("div", { className: styles_module_default4.hoverElementName, children: hoverInfo.elementName })
                ]
              }
            ),
            pendingAnnotation && /* @__PURE__ */ jsxs13(Fragment5, { children: [
              pendingAnnotation.multiSelectElements?.length ? (
                // Cmd+shift+click multi-select: show individual boxes with live positions
                pendingAnnotation.multiSelectElements.filter((el) => document.contains(el)).map((el, index) => {
                  const rect = el.getBoundingClientRect();
                  return /* @__PURE__ */ jsx14(
                    "div",
                    {
                      className: `${styles_module_default4.multiSelectOutline} ${pendingExiting ? styles_module_default4.exit : styles_module_default4.enter}`,
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
                pendingAnnotation.targetElement && document.contains(pendingAnnotation.targetElement) ? (
                  // Single-click: use live getBoundingClientRect for consistent positioning
                  (() => {
                    const rect = pendingAnnotation.targetElement.getBoundingClientRect();
                    return /* @__PURE__ */ jsx14(
                      "div",
                      {
                        className: `${styles_module_default4.singleSelectOutline} ${pendingExiting ? styles_module_default4.exit : styles_module_default4.enter}`,
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
                  pendingAnnotation.boundingBox && /* @__PURE__ */ jsx14(
                    "div",
                    {
                      className: `${pendingAnnotation.isMultiSelect ? styles_module_default4.multiSelectOutline : styles_module_default4.singleSelectOutline} ${pendingExiting ? styles_module_default4.exit : styles_module_default4.enter}`,
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
                const markerX = pendingAnnotation.x;
                const markerY = pendingAnnotation.isFixed ? pendingAnnotation.y : pendingAnnotation.y - scrollY;
                return /* @__PURE__ */ jsxs13(Fragment5, { children: [
                  /* @__PURE__ */ jsx14(
                    PendingMarker,
                    {
                      x: markerX,
                      y: markerY,
                      isMultiSelect: pendingAnnotation.isMultiSelect,
                      isExiting: pendingExiting
                    }
                  ),
                  /* @__PURE__ */ jsx14(
                    AnnotationPopupCSS,
                    {
                      ref: popupRef,
                      element: pendingAnnotation.element,
                      selectedText: pendingAnnotation.selectedText,
                      computedStyles: pendingAnnotation.computedStylesObj,
                      placeholder: pendingAnnotation.element === "Area selection" ? "What should change in this area?" : pendingAnnotation.isMultiSelect ? "Feedback for this group of elements..." : "What should change?",
                      onSubmit: addAnnotation,
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
                    }
                  )
                ] });
              })()
            ] }),
            editingAnnotation && /* @__PURE__ */ jsxs13(Fragment5, { children: [
              editingAnnotation.elementBoundingBoxes?.length ? (
                // Cmd+shift+click: show individual element boxes (use live rects when available)
                (() => {
                  if (editingTargetElements.length > 0) {
                    return editingTargetElements.filter((el) => document.contains(el)).map((el, index) => {
                      const rect = el.getBoundingClientRect();
                      return /* @__PURE__ */ jsx14(
                        "div",
                        {
                          className: `${styles_module_default4.multiSelectOutline} ${styles_module_default4.enter}`,
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
                    (bb, index) => /* @__PURE__ */ jsx14(
                      "div",
                      {
                        className: `${styles_module_default4.multiSelectOutline} ${styles_module_default4.enter}`,
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
                  const rect = editingTargetElement && document.contains(editingTargetElement) ? editingTargetElement.getBoundingClientRect() : null;
                  const bb = rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : editingAnnotation.boundingBox ? {
                    x: editingAnnotation.boundingBox.x,
                    y: editingAnnotation.isFixed ? editingAnnotation.boundingBox.y : editingAnnotation.boundingBox.y - scrollY,
                    width: editingAnnotation.boundingBox.width,
                    height: editingAnnotation.boundingBox.height
                  } : null;
                  if (!bb) return null;
                  return /* @__PURE__ */ jsx14(
                    "div",
                    {
                      className: `${editingAnnotation.isMultiSelect ? styles_module_default4.multiSelectOutline : styles_module_default4.singleSelectOutline} ${styles_module_default4.enter}`,
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
              ),
              /* @__PURE__ */ jsx14(
                AnnotationPopupCSS,
                {
                  ref: editPopupRef,
                  element: editingAnnotation.element,
                  selectedText: editingAnnotation.selectedText,
                  computedStyles: parseComputedStylesString(
                    editingAnnotation.computedStyles
                  ),
                  placeholder: "Edit your feedback...",
                  initialValue: editingAnnotation.comment,
                  submitLabel: "Save",
                  onSubmit: updateAnnotation2,
                  onCancel: cancelEditAnnotation,
                  onDelete: () => deleteAnnotation2(editingAnnotation.id),
                  isExiting: editExiting,
                  lightMode: !isDarkMode,
                  accentColor: editingAnnotation.isMultiSelect ? "var(--agentation-color-green)" : "var(--agentation-color-accent)",
                  style: (() => {
                    const markerY = editingAnnotation.isFixed ? editingAnnotation.y : editingAnnotation.y - scrollY;
                    return {
                      // Popup is 280px wide, centered with translateX(-50%), so 140px each side
                      // Clamp so popup stays 20px from viewport edges
                      left: Math.max(
                        160,
                        Math.min(
                          window.innerWidth - 160,
                          editingAnnotation.x / 100 * window.innerWidth
                        )
                      ),
                      // Position popup above or below marker to keep marker visible
                      ...markerY > window.innerHeight - 290 ? { bottom: window.innerHeight - markerY + 20 } : { top: markerY + 20 }
                    };
                  })()
                }
              )
            ] }),
            isDragging && /* @__PURE__ */ jsxs13(Fragment5, { children: [
              /* @__PURE__ */ jsx14("div", { ref: dragRectRef, className: styles_module_default4.dragSelection }),
              /* @__PURE__ */ jsx14(
                "div",
                {
                  ref: highlightsContainerRef,
                  className: styles_module_default4.highlightsContainer
                }
              )
            ] })
          ]
        }
      )
    ] }),
    document.body
  );
}
export {
  PageFeedbackToolbarCSS as Agentation,
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
};
//# sourceMappingURL=index.mjs.map