import { toCssTiming, transition } from "@animate-ui/react/utils/motion";

/** Scoped to the sidebar that owns the event's panel. */
export const DISCLOSURE_START_EVENT = "gtd-disclosure-start";
export const DISCLOSURE_TIMING = toCssTiming(transition.disclosure);
/** An opening fold's fade: quick, so its rows read soon after the click. */
export const OPEN_FADE_TIMING = toCssTiming(transition.fade);
