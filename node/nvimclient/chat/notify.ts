import { join } from "node:path";
import player from "play-sound";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { type MagentaOptions, PLUGIN_ROOT } from "../options.ts";

export type NotifyContext = {
  nvim: Nvim;
  options: MagentaOptions;
};

export type NotifyReason =
  | "thread-attention"
  | "thread-turn-end"
  | "script-finished";

/** Test-observable record of every notification raised via notifyUser. */
export const notificationLog: { reason: NotifyReason }[] = [];

export function resetNotificationLog(): void {
  notificationLog.length = 0;
}

/**
 * Notify the user that something needs their attention: play the chime sound
 * (respecting `chimeVolume`) and ring the bell (respecting `bellOnNotify`).
 *
 * The bell is sent to the host terminal (channel 2). We deliberately avoid
 * feeding <Esc> to the editor itself to produce a beep, since that yanks the
 * user out of insert mode while they're composing.
 */
export function notifyUser(context: NotifyContext, reason: NotifyReason): void {
  notificationLog.push({ reason });
  playChimeSound(context);
  sendBell(context);
}

function sendBell(context: NotifyContext): void {
  if (context.options.bellOnNotify === false) {
    return;
  }

  context.nvim.call("nvim_chan_send", [2, "\x07"]).catch((err) => {
    context.nvim.logger.error(
      `Failed to send terminal bell: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

function playChimeSound(context: NotifyContext): void {
  const actualVolume = context.options.chimeVolume;

  if (!actualVolume) {
    return;
  }

  try {
    const play = player();
    const chimeFile = join(PLUGIN_ROOT, "chime.wav");

    const playOptions = {
      afplay: ["-v", actualVolume.toString()],
      aplay: ["-v", `${Math.round(actualVolume * 100).toString()}%`],
      mpg123: ["-f", Math.round(actualVolume * 32768).toString()],
    };

    play.play(chimeFile, playOptions, (err: Error | null) => {
      if (err) {
        context.nvim.logger.error(`Failed to play chime sound: ${err.message}`);
      }
    });
  } catch (error) {
    context.nvim.logger.error(
      `Error setting up chime sound: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
