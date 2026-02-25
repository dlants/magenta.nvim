import { attach, type LogLevel, type Nvim } from "../nvim/nvim-node/index.ts";
import { access, rm, cp, mkdir, realpath } from "node:fs/promises";
import { spawn } from "child_process";
import { type MountedVDOM } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import * as path from "node:path";
import { pollUntil } from "../utils/async.ts";
import { Magenta } from "../magenta.ts";
import { withMockClient } from "../providers/mock.ts";
import { NvimDriver } from "./driver.ts";
import { type MagentaOptions } from "../options.ts";
import {
  type MockMCPServer,
  mockServers,
  type ServerName,
} from "@magenta/core";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import type { ToolRequestId } from "@magenta/core";

type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;

/**
 * Helper functions for asserting properties of tool result arrays.
 * These work with Anthropic's ToolResultBlockParam format.
 */
export function assertToolResultContainsText(
  toolResult: ToolResultBlockParam,
  expectedText: string,
): void {
  const content = toolResult.content;
  if (toolResult.is_error) {
    throw new Error(
      `Expected tool result to have ok status, but got error: ${JSON.stringify(content)}`,
    );
  }
  if (typeof content === "string") {
    if (!content.includes(expectedText)) {
      throw new Error(
        `Expected tool result to contain text "${expectedText}" but it didn't. Result: ${content}`,
      );
    }
    return;
  }
  if (Array.isArray(content)) {
    const hasText = content.some((item) => {
      if (item.type === "text") {
        return item.text.includes(expectedText);
      }
      return false;
    });
    if (!hasText) {
      throw new Error(
        `Expected tool result to contain text "${expectedText}" but it didn't. Result: ${JSON.stringify(content)}`,
      );
    }
    return;
  }
  throw new Error(
    `Expected tool result to have content, but got: ${JSON.stringify(toolResult)}`,
  );
}

export function assertToolResultHasType(
  toolResult: ToolResultBlockParam,
  expectedType: "text" | "image" | "document",
): void {
  const content = toolResult.content;
  if (toolResult.is_error) {
    throw new Error(
      `Expected tool result to have ok status, but got error: ${JSON.stringify(content)}`,
    );
  }
  if (typeof content === "string") {
    if (expectedType !== "text") {
      throw new Error(
        `Expected tool result to contain item with type "${expectedType}" but got string content`,
      );
    }
    return;
  }
  if (Array.isArray(content)) {
    const hasType = content.some((item) => item.type === expectedType);
    if (!hasType) {
      throw new Error(
        `Expected tool result to contain item with type "${expectedType}" but it didn't. Result: ${JSON.stringify(content)}`,
      );
    }
    return;
  }
  throw new Error(
    `Expected tool result to have content, but got: ${JSON.stringify(toolResult)}`,
  );
}

export function assertToolResultHasImageSource(
  toolResult: ToolResultBlockParam,
  expectedMediaType: string,
): void {
  const content = toolResult.content;
  if (toolResult.is_error) {
    throw new Error(
      `Expected tool result to have ok status, but got error: ${JSON.stringify(content)}`,
    );
  }
  if (typeof content === "string") {
    throw new Error(
      `Expected tool result to contain image item but got string content`,
    );
  }
  if (!Array.isArray(content)) {
    throw new Error(
      `Expected tool result to have array content, but got: ${JSON.stringify(toolResult)}`,
    );
  }
  const imageItem = content.find((item) => item.type === "image");
  if (!imageItem) {
    throw new Error(
      `Expected tool result to contain image item but it didn't. Result: ${JSON.stringify(content)}`,
    );
  }
  if (
    !imageItem.source ||
    imageItem.source.type !== "base64" ||
    imageItem.source.media_type !== expectedMediaType ||
    typeof imageItem.source.data !== "string" ||
    imageItem.source.data.length === 0
  ) {
    throw new Error(
      `Expected image item to have valid source with media_type "${expectedMediaType}" but got: ${JSON.stringify(imageItem.source)}`,
    );
  }
}

export function assertToolResultHasDocumentSource(
  toolResult: ToolResultBlockParam,
  expectedMediaType: string,
): void {
  const content = toolResult.content;
  if (toolResult.is_error) {
    throw new Error(
      `Expected tool result to have ok status, but got error: ${JSON.stringify(content)}`,
    );
  }
  if (typeof content === "string") {
    throw new Error(
      `Expected tool result to contain document item but got string content`,
    );
  }
  if (!Array.isArray(content)) {
    throw new Error(
      `Expected tool result to have array content, but got: ${JSON.stringify(toolResult)}`,
    );
  }
  const documentItem = content.find((item) => item.type === "document");
  if (!documentItem) {
    throw new Error(
      `Expected tool result to contain document item but it didn't. Result: ${JSON.stringify(content)}`,
    );
  }
  if (
    !documentItem.source ||
    documentItem.source.type !== "base64" ||
    documentItem.source.media_type !== expectedMediaType ||
    typeof documentItem.source.data !== "string" ||
    documentItem.source.data.length === 0
  ) {
    throw new Error(
      `Expected document item to have valid source with media_type "${expectedMediaType}" but got: ${JSON.stringify(documentItem.source)}`,
    );
  }
}

export async function assertHasMcpServer(
  serverName: ServerName,
): Promise<MockMCPServer> {
  return await pollUntil(
    () => {
      if (mockServers[serverName]) {
        return mockServers[serverName];
      }
      throw new Error(`Mock server with name ${serverName} was not found.`);
    },
    { timeout: 1000 },
  );
}

/** Poll until a tool result appears in the thread messages for the given toolRequestId */
export async function pollForToolResult(
  driver: NvimDriver,
  toolRequestId: ToolRequestId,
): Promise<ProviderToolResult> {
  return pollUntil(
    () => {
      const thread = driver.magenta.chat.getActiveThread();
      if (!thread) {
        throw new Error("No active thread");
      }

      const messages = thread.getProviderMessages();
      for (const message of messages) {
        if (message.role !== "user") continue;
        for (const content of message.content) {
          if (content.type === "tool_result" && content.id === toolRequestId) {
            return content;
          }
        }
      }

      throw new Error(`Tool result for ${toolRequestId} not found yet`);
    },
    { timeout: 5000 },
  );
}

export type NvimProcessOptions = {
  setupFiles?: ((tmpDir: string) => Promise<void>) | undefined;
  setupHome?: ((homeDir: string) => Promise<void>) | undefined;
  setupExtraDirs?: ((baseDir: string) => Promise<void>) | undefined;
};

export async function withNvimProcess(
  fn: (
    sock: string,
    dirs: { tmpDir: string; homeDir: string; baseDir: string },
  ) => Promise<void>,
  options: NvimProcessOptions = {},
) {
  // Generate unique ID for this test run
  const testId = Math.random().toString(36).substring(2, 15);

  // Set up test directory paths
  const testDir = path.dirname(__filename);
  const fixturesDir = path.join(testDir, "fixtures");
  // On macOS, /tmp is a symlink to /private/tmp. Resolve the symlink so paths
  // are consistent for permission checking logic.
  const resolvedTmp = await realpath("/tmp");
  const baseDir = path.join(resolvedTmp, "magenta-test", testId);
  const tmpDir = path.join(baseDir, "cwd");
  const homeDir = path.join(baseDir, "home");
  const sock = path.join(baseDir, "magenta-test.sock");

  // Clean up and recreate base directory
  try {
    await rm(baseDir, { recursive: true, force: true });
  } catch (e) {
    if ((e as { code: string }).code !== "ENOENT") {
      console.error(e);
    }
  }

  // Create directories and copy fixtures
  try {
    await mkdir(tmpDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await cp(fixturesDir, tmpDir, { recursive: true });

    // Set up additional files in cwd if provided
    if (options.setupFiles) {
      await options.setupFiles(tmpDir);
    }

    // Set up home directory if provided
    if (options.setupHome) {
      await options.setupHome(homeDir);
    }

    // Set up extra directories outside cwd if provided
    if (options.setupExtraDirs) {
      await options.setupExtraDirs(baseDir);
    }
  } catch (e) {
    console.error("Failed to set up test directory:", e);
    throw e;
  }

  const nvimProcess = spawn(
    "nvim",
    [
      "--headless",
      "--cmd",
      "set columns=200",
      "--cmd",
      "set lines=60",
      "-n",
      "--clean",
      "--listen",
      sock,
      "-u",
      path.resolve(testDir, "../../minimal-init.lua"),
    ],
    {
      cwd: tmpDir,
      env: {
        ...process.env,
        HOME: homeDir,
      },
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
      // Only throw error for unexpected exits (not normal cleanup)
      if (code !== null && code !== 0 && code !== 1) {
        throw new Error(
          `Nvim process exited unexpectedly with code ${code} and signal ${signal}`,
        );
      }
    });

    await pollUntil(
      async () => {
        try {
          await access(sock);
          return true;
        } catch (e) {
          throw new Error(`socket ${sock} not ready: ${(e as Error).message}`);
        }
      },
      { timeout: 500 },
    );

    await fn(sock, { tmpDir, homeDir, baseDir });
  } finally {
    nvimProcess.kill();
    // Clean up base directory (includes cwd and home)
    try {
      await rm(baseDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors to avoid masking test failures
      console.warn(`Failed to cleanup test directory ${baseDir}:`, e);
    }
  }
}

export async function withNvimClient(
  fn: (nvim: Nvim) => Promise<void>,
  options: {
    logFile?: string;
    logLevel?: LogLevel;
    overrideLogger?: boolean;
    setupFiles?: (tmpDir: string) => Promise<void>;
    setupHome?: (homeDir: string) => Promise<void>;
    setupExtraDirs?: (baseDir: string) => Promise<void>;
  } = {
    overrideLogger: true,
  },
) {
  return await withNvimProcess(
    async (sock) => {
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
              nvim.logger.error(msg);
              break;
            case 2: // WARN
              nvim.logger.warn(msg);
              break;
            case 3: // INFO
              nvim.logger.info(msg);
              break;
            default: // DEBUG and others
              nvim.logger.debug(msg);
          }
        } catch (err) {
          nvim.logger.error(err as Error);
        }
      });

      try {
        await fn(nvim);
      } finally {
        nvim.detach();
      }
    },
    {
      setupFiles: options.setupFiles,
      setupHome: options.setupHome,
      setupExtraDirs: options.setupExtraDirs,
    },
  );
}

export type TestOptions = Partial<MagentaOptions> & {
  changeDebounceMs?: number;
};

export type TestDirs = {
  tmpDir: string;
  homeDir: string;
  baseDir: string;
};

export async function withDriver(
  driverOptions: {
    options?: TestOptions;
    doNotOverrideLogger?: boolean;
    setupFiles?: (tmpDir: string) => Promise<void>;
    setupHome?: (homeDir: string) => Promise<void>;
    setupExtraDirs?: (baseDir: string) => Promise<void>;
  },
  fn: (driver: NvimDriver, dirs: TestDirs) => Promise<void>,
) {
  return await withNvimProcess(
    async (sock, dirs) => {
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
        const magenta = await Magenta.start(
          nvim,
          dirs.homeDir as import("../utils/files.ts").HomeDir,
        );
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
            info: (msg: string) => console.log(msg),
            debug: (msg: string) =>
              process.env.LOG_LEVEL == "debug" && console.debug(msg),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any;
        }

        try {
          await fn(new NvimDriver(nvim, magenta, mockAnthropic), dirs);
        } finally {
          magenta.destroy();
          nvim.detach();
          for (const serverName in mockServers) {
            await mockServers[serverName as ServerName].stop();
            delete mockServers[serverName as ServerName];
          }
        }
      });
    },
    {
      setupFiles: driverOptions.setupFiles,
      setupHome: driverOptions.setupHome,
      setupExtraDirs: driverOptions.setupExtraDirs,
    },
  );
}

/**
 * Normalizes paths in test data by replacing the tmpDir prefix with a placeholder.
 * This allows tests to match results that contain absolute paths.
 */
export function normalizePaths<T>(data: T, tmpDir: string): T {
  const normalizedTmpDir = tmpDir.replace(/\/+$/, ""); // remove trailing slashes
  // On macOS, /tmp is a symlink to /private/tmp, so we need to handle both
  const privateTmpDir = `/private${normalizedTmpDir}`;

  const replacePath = (str: string): string => {
    // Replace both variations of the tmpDir path with a placeholder
    return str
      .replaceAll(privateTmpDir, "<tmpDir>")
      .replaceAll(normalizedTmpDir, "<tmpDir>");
  };

  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") {
      return replacePath(value);
    }
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = normalize(val);
      }
      return result;
    }
    return value;
  };

  return normalize(data) as T;
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
