// The repo resolves jsdom 25, which has no PointerEvent (bb's own tests run
// on jsdom 29, which does). Radix menus open on a pointerdown whose `button`
// is 0, so without the class a fired pointerdown never opens one.
if (typeof window !== "undefined" && !("PointerEvent" in window)) {
  class PointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(window, "PointerEvent", { value: PointerEvent, configurable: true });
}
