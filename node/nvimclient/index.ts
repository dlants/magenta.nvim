import { Magenta } from "./magenta.ts";
import { notifyErr } from "./nvim/nvim.ts";
import { attach, type LogLevel } from "./nvim/nvim-node/index.ts";
import {
  addEntry as addTimingEntry,
  getEntries as getTimingEntries,
  record as recordTiming,
  isEnabled as timingsEnabled,
} from "./timings.ts";

declare global {
  // Set by node/nvimclient/boot.mjs via `node --import ./node/nvimclient/boot.mjs` before index.ts
  // imports are loaded and TS-transformed.
  var __MAGENTA_BOOT_MS__: number | undefined;
}

// If boot.mjs captured a pre-import timestamp, synthesize a timing entry for
// it so we can separate "node startup" from "TS transform + import side effects".
if (typeof globalThis.__MAGENTA_BOOT_MS__ === "number") {
  addTimingEntry({
    label: "node: boot.mjs loaded (pre-import)",
    time_ms: globalThis.__MAGENTA_BOOT_MS__,
  });
}
recordTiming("node: index.ts body executing (post-import)");

// These values are set by neovim when starting the node process
const ENV = {
  NVIM: process.env.NVIM,
  LOG_LEVEL: process.env.LOG_LEVEL as LogLevel | undefined,
  DEV: Boolean(process.env.IS_DEV),
};

if (!ENV.NVIM) throw Error("socket missing");
const nvim = await attach({
  socket: ENV.NVIM,
  client: { name: "magenta" },
  logging: { level: ENV.LOG_LEVEL },
});

if (nvim.logger.error) {
  const original = nvim.logger.error.bind(nvim.logger);
  nvim.logger.error = ((error: Error | string, ...rest: unknown[]) => {
    original(
      error instanceof Error
        ? `Error: ${error.message}\n${error.stack}`
        : error,
      ...rest,
    );
    notifyErr(nvim, error, ...rest).catch((err) =>
      original(
        err instanceof Error
          ? `notifyErr failed: ${err.message}\n${err.stack}`
          : err,
      ),
    );
  }) as typeof original;
}

// Exit promptly on SIGTERM/SIGINT (e.g. nvim shutdown sends SIGTERM via
// jobstop). Without an explicit handler, libuv handles or background work
// (MCP stdio child processes, keep-alive HTTP sockets, polling timers)
// can delay exit, causing nvim to wait up to its SIGTERM->SIGKILL timeout
// (~2s) before quitting.
const exitOnSignal = (signal: NodeJS.Signals) => {
  process.on(signal, () => {
    process.exit(0);
  });
};
exitOnSignal("SIGTERM");
exitOnSignal("SIGINT");

process.on("uncaughtException", (error) => {
  nvim.logger.error(error);
  setTimeout(() => {
    // wait for logger to finish writing
    process.exit(1);
  }, 100);
});

// Node 24's default behavior is to terminate on unhandled promise rejections,
// but without going through `uncaughtException` reliably and without our
// logger.error wrapper (which writes to /tmp/magenta.log AND surfaces the
// error in nvim via notifyErr). Hook it explicitly so the crash is visible
// in both places, then exit to match the default termination behavior.
process.on("unhandledRejection", (reason) => {
  const err =
    reason instanceof Error
      ? reason
      : new Error(`Unhandled promise rejection: ${String(reason)}`);
  nvim.logger.error(err);
  setTimeout(() => {
    process.exit(1);
  }, 100);
});

recordTiming("node: attached to nvim");
await Magenta.start(nvim);
recordTiming("node: Magenta.start() complete");

if (timingsEnabled()) {
  try {
    await nvim.call("nvim_exec_lua", [
      `require('magenta').report_timings(...)`,
      [getTimingEntries()],
    ]);
  } catch (err) {
    nvim.logger.error(err instanceof Error ? err : new Error(String(err)));
  }
}
