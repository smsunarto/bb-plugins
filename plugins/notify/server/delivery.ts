import { execFile } from "node:child_process";
import type { Context } from "@bb-kit/core/plugin";
import { BODY_MAX_CHARS, notificationLines, oneLine } from "./format.ts";
import { pluginSettings } from "./settings.ts";
import { resolveSound } from "./sound.ts";

const OSASCRIPT = "/usr/bin/osascript";
const DISPLAY_NOTIFICATION_SCRIPT = `on run argv
  set titleText to item 1 of argv
  set bodyText to item 2 of argv
  set soundName to item 3 of argv
  if soundName is "" then
    display notification bodyText with title titleText
  else
    display notification bodyText with title titleText sound name soundName
  end if
end run`;

export type NativeNotification = {
  title: string;
  body: string;
  soundName: string | null;
};

export type NotificationSender = (notification: NativeNotification) => Promise<void>;

export type PostInput = {
  project: string | null;
  heading: string;
  message: string;
};

/** Keep notification text in argv. No user text is interpolated into code. */
export function macOsNotificationArguments(notification: NativeNotification): string[] {
  return [
    "-e",
    DISPLAY_NOTIFICATION_SCRIPT,
    notification.title,
    notification.body,
    notification.soundName ?? "",
  ];
}

const senderOverrides = new WeakMap<object, NotificationSender>();

/** Bind a deterministic sender for an isolated host. */
export function bindNotificationSender(bb: object, send: NotificationSender): void {
  senderOverrides.set(bb, send);
}

/** Post through macOS Notification Center without needing a BB window. */
export const sendMacOsNotification: NotificationSender = async (notification) => {
  if (process.platform !== "darwin") {
    throw new Error("native notification delivery requires macOS");
  }
  await new Promise<void>((resolve, reject) => {
    execFile(OSASCRIPT, macOsNotificationArguments(notification), { timeout: 10_000 }, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
};

/** Format and post one native notification. */
export async function deliver(
  bb: Context["bb"],
  input: PostInput,
  send: NotificationSender = senderOverrides.get(bb) ?? sendMacOsNotification,
): Promise<boolean> {
  const { title, body } = notificationLines(
    input.project,
    oneLine(input.heading, 90),
    input.message,
  );
  const notification = {
    title: oneLine(title, 90),
    body: oneLine(body, BODY_MAX_CHARS),
    soundName: resolveSound(pluginSettings(bb).sound),
  };
  try {
    await send(notification);
    bb.log.debug("dispatched through macOS Notification Center");
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    bb.log.warn(`notification delivery failed: ${detail}`);
    return false;
  }
}
