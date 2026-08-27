import type { Context } from "@bb-kit/core/plugin";

import { BODY_MAX_CHARS, notificationLines, oneLine } from "./format.ts";
import {
  type NotificationOffer,
  type OfferResult,
  rendererMailbox,
} from "./renderer-mailbox.ts";
import { pluginSettings } from "./settings.ts";
import { resolveSound } from "./sound.ts";

export type NotificationOfferer = (notification: NotificationOffer) => Promise<OfferResult>;

export type PostInput = Readonly<{
  project: string | null;
  heading: string;
  message: string;
  threadId: string | null;
}>;

const offerOverrides = new WeakMap<object, NotificationOfferer>();

export function bindNotificationOfferer(bb: object, offer: NotificationOfferer): void {
  offerOverrides.set(bb, offer);
}

export async function deliver(
  bb: Context["bb"],
  input: PostInput,
  offer: NotificationOfferer = offerOverrides.get(bb) ?? rendererMailbox(bb).offer,
): Promise<boolean> {
  const { title, body } = notificationLines(
    input.project,
    oneLine(input.heading, 90),
    input.message,
  );
  const sound = resolveSound(pluginSettings(bb).sound);
  try {
    const result = await offer({
      title: oneLine(title, 90),
      body: oneLine(body, BODY_MAX_CHARS),
      threadId: input.threadId,
      silent: sound.silent,
      play: sound.play,
    });
    if (result === "shown") {
      bb.log.debug("notification acknowledged by the BB renderer");
      return true;
    }
    if (result === "failed") bb.log.warn("the BB renderer could not show the notification");
    return false;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    bb.log.warn(`notification delivery failed: ${detail}`);
    return false;
  }
}
