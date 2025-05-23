import { attach, type LogLevel, type Nvim } from "../nvim/nvim-node";
import { unlink, access, rm, cp, mkdir } from "node:fs/promises";
import { spawn } from "child_process";
import { type MountedVDOM } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import path from "node:path";
import { pollUntil } from "../utils/async.ts";
import { Magenta } from "../magenta.ts";
import { withMockClient } from "../providers/mock.ts";
import { NvimDriver } from "./driver.ts";
import { type MagentaOptions } from "../options.ts";

const SOCK = `/tmp/magenta-test.sock`;
export const TMP_DIR = "node/test/tmp";
export async function withNvimProcess(fn: (sock: string) => Promise<void>) {
  try {
    await unlink(SOCK);
  } catch (e) {
    if ((e as { code: string }).code !== "ENOENT") {
      console.error(e);
    }
  }

  // Set up test directory paths
  const testDir = path.dirname(__filename);
  const rootDir = path.resolve(testDir, "../../");
  const tmpDir = path.join(rootDir, TMP_DIR);
  const fixturesDir = path.join(rootDir, "node/test/fixtures");

  // Clean up and recreate tmp directory
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch (e) {
    if ((e as { code: string }).code !== "ENOENT") {
      console.error(e);
    }
  }

  // Create tmp directory and copy fixtures
  try {
    await mkdir(tmpDir, { recursive: true });
    await cp(fixturesDir, tmpDir, { recursive: true });
  } catch (e) {
    console.error("Failed to set up test directory:", e);
    throw e;
  }

  const nvimProcess = spawn(
    "nvim",
    ["--headless", "-n", "--clean", "--listen", SOCK, "-u", "minimal-init.lua"],
    {
      cwd: rootDir,
    },
  );

  if (!nvimProcess.pid) {
    throw new Error("Failed to start nvim process");
  }

  try {
    nvimProcess.on("error", (err) => {
      throw err;
    });

    nvimProcess.on("exit", (code, signal) => {
      if (code !== 1) {
        throw new Error(
          `Nvim process exited with code ${code} and signal ${signal}`,
        );
      }
    });

    await pollUntil(
      async () => {
        try {
          await access(SOCK);
          return true;
        } catch (e) {
          throw new Error(`socket ${SOCK} not ready: ${(e as Error).message}`);
        }
      },
      { timeout: 500 },
    );

    await fn(SOCK);
  } finally {
    nvimProcess.kill();
  }
}

export async function withNvimClient(
  fn: (nvim: Nvim) => Promise<void>,
  options: {
    logFile?: string;
    logLevel?: LogLevel;
    overrideLogger?: boolean;
  } = {
    overrideLogger: true,
  },
) {
  return await withNvimProcess(async (sock) => {
    const nvim = await attach({
      socket: sock,
      client: { name: "test" },
      logging: { level: options.logLevel ?? "debug", file: options.logFile },
    });

    await nvim.call("nvim_exec_lua", [
      `\
        require('magenta').bridge(${nvim.channelId})

        -- Set up message interception
        local notify = vim.notify
        vim.notify = function(msg, level, opts)
          local channelId = ${nvim.channelId}
          if channelId then
            vim.rpcnotify(channelId, 'testMessage', {msg = msg, level = level})
          end
          notify(msg, level, opts)
        end
      `,
      [],
    ]);

    if (options.overrideLogger) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      nvim.logger = {
        error: (msg: string) => console.error(msg),
        warn: (msg: string) => console.warn(msg),
        info: (msg: string) => console.info(msg),
        debug: (msg: string) => console.debug(msg),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    }

    nvim.onNotification("testMessage", (args) => {
      try {
        const { msg, level } = args[0] as { msg: string; level: number };
        switch (level) {
          case 0: // ERROR
            nvim.logger?.error(msg);
            break;
          case 2: // WARN
            nvim.logger?.warn(msg);
            break;
          case 3: // INFO
            nvim.logger?.info(msg);
            break;
          default: // DEBUG and others
            nvim.logger?.debug(msg);
        }
      } catch (err) {
        nvim.logger?.error(err as Error);
      }
    });

    try {
      await fn(nvim);
    } finally {
      nvim.detach();
    }
  });
}

export type TestOptions = Partial<MagentaOptions>;

export async function withDriver(
  driverOptions: {
    options?: TestOptions;
    doNotOverrideLogger?: boolean;
  },
  fn: (driver: NvimDriver) => Promise<void>,
) {
  return await withNvimProcess(async (sock) => {
    const nvim = await attach({
      socket: sock,
      client: { name: "test" },
      logging: { level: "debug" },
    });

    // Set test options before Magenta starts
    if (driverOptions.options) {
      // Send JSON string to Lua and let it parse the string into a table
      // Make sure we use the long string syntax [=[ ]=] to avoid escaping issues
      const testOptionsJson = JSON.stringify(driverOptions.options);
      await nvim.call("nvim_exec_lua", [
        `setup_test_options([=[${testOptionsJson}]=])`,
        [],
      ]);
    }

    await withMockClient(async (mockAnthropic) => {
      const magenta = await Magenta.start(nvim);
      await nvim.call("nvim_exec_lua", [
        `\
-- Set up message interception
local notify = vim.notify
vim.notify = function(msg, level, opts)
  local channelId = ${nvim.channelId}
  if channelId then
    vim.rpcnotify(channelId, 'testMessage', {msg = msg, level = level})
  end
  notify(msg, level, opts)
end

`,
        [],
      ]);
      if (!driverOptions.doNotOverrideLogger) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        magenta.nvim.logger = {
          error: (msg: string) => console.error(msg),
          warn: (msg: string) => console.warn(msg),
          info: (msg: string) => console.info(msg),
          debug: (msg: string) =>
            process.env.LOG_LEVEL == "debug" && console.debug(msg),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      }

      try {
        await fn(new NvimDriver(nvim, magenta, mockAnthropic));
      } finally {
        magenta.destroy();
        nvim.detach();
      }
    });
  });
}

export function extractMountTree(mounted: MountedVDOM): unknown {
  switch (mounted.type) {
    case "string":
      return {
        type: "string",
        startPos: mounted.startPos,
        endPos: mounted.endPos,
        content: mounted.content,
      };
    case "node":
      return {
        type: "node",
        children: mounted.children.map(extractMountTree),
        startPos: mounted.startPos,
        endPos: mounted.endPos,
      };

    case "array":
      return {
        type: "array",
        children: mounted.children.map(extractMountTree),
        startPos: mounted.startPos,
        endPos: mounted.endPos,
      };

    default:
      assertUnreachable(mounted);
  }
}

process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});
