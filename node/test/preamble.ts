import { attach, type LogLevel, type Nvim } from "../nvim/nvim-node/index.ts";
import { access, rm, cp, mkdir } from "node:fs/promises";
import { spawn } from "child_process";
import { type MountedVDOM } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import * as path from "node:path";
import { pollUntil } from "../utils/async.ts";
import { Magenta } from "../magenta.ts";
import { withMockClient } from "../providers/mock.ts";
import { NvimDriver } from "./driver.ts";
import { type MagentaOptions } from "../options.ts";
import type { Chat } from "../chat/chat.ts";
import type { Thread } from "../chat/thread.ts";
import type { Message } from "../chat/message.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import { type MockMCPServer, mockServers } from "../tools/mcp/mock-server.ts";
import type { ServerName } from "../tools/mcp/types.ts";

/**
 * Helper functions for asserting properties of tool result arrays
 */
export function assertToolResultContainsText(
  toolResult: ProviderToolResult,
  expectedText: string,
): void {
  const result = toolResult.result;
  if (result.status === "ok") {
    const hasText = result.value.some((item) => {
      if (typeof item === "object" && item.type === "text") {
        return item.text.includes(expectedText);
      }
      return false;
    });
    if (!hasText) {
      throw new Error(
        `Expected tool result to contain text "${expectedText}" but it didn't. Result: ${JSON.stringify(result.value)}`,
      );
    }
  } else {
    throw new Error(
      `Expected tool result to have ok status with array value, but got: ${JSON.stringify(result)}`,
    );
  }
}

export function assertToolResultHasType(
  toolResult: ProviderToolResult,
  expectedType: "text" | "image" | "document",
): void {
  const result = toolResult.result;
  if (result.status === "ok") {
    const hasType = result.value.some((item) => {
      return item && typeof item === "object" && item.type === expectedType;
    });
    if (!hasType) {
      throw new Error(
        `Expected tool result to contain item with type "${expectedType}" but it didn't. Result: ${JSON.stringify(result.value)}`,
      );
    }
  } else {
    throw new Error(
      `Expected tool result to have ok status with array value, but got: ${JSON.stringify(result)}`,
    );
  }
}

export function assertToolResultHasImageSource(
  toolResult: ProviderToolResult,
  expectedMediaType: string,
): void {
  const result = toolResult.result;
  if (result.status === "ok") {
    const imageItem = result.value.find((item) => {
      return item && typeof item === "object" && item.type === "image";
    });
    if (!imageItem) {
      throw new Error(
        `Expected tool result to contain image item but it didn't. Result: ${JSON.stringify(result.value)}`,
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
  } else {
    throw new Error(
      `Expected tool result to have ok status with array value, but got: ${JSON.stringify(result)}`,
    );
  }
}

export function assertToolResultHasDocumentSource(
  toolResult: ProviderToolResult,
  expectedMediaType: string,
): void {
  const result = toolResult.result;
  if (result.status === "ok") {
    const documentItem = result.value.find((item) => {
      return item && typeof item === "object" && item.type === "document";
    });
    if (!documentItem) {
      throw new Error(
        `Expected tool result to contain document item but it didn't. Result: ${JSON.stringify(result.value)}`,
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
  } else {
    throw new Error(
      `Expected tool result to have ok status with array value, but got: ${JSON.stringify(result)}`,
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

export async function withNvimProcess(
  fn: (sock: string) => Promise<void>,
  options: {
    setupFiles?: ((tmpDir: string) => Promise<void>) | undefined;
  } = {},
) {
  // Generate unique ID for this test run
  const testId = Math.random().toString(36).substring(2, 15);

  // Set up test directory paths
  const testDir = path.dirname(__filename);
  const fixturesDir = path.join(testDir, "fixtures");
  const tmpDir = path.join("/tmp/magenta-test", testId);
  const sock = path.join(tmpDir, "magenta-test.sock");

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

    // Set up additional files if provided
    if (options.setupFiles) {
      await options.setupFiles(tmpDir);
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

    await fn(sock);
  } finally {
    nvimProcess.kill();
    // Clean up temporary directory
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors to avoid masking test failures
      console.warn(`Failed to cleanup test directory ${tmpDir}:`, e);
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
    { setupFiles: options.setupFiles },
  );
}

export type TestOptions = Partial<MagentaOptions> & {
  changeDebounceMs?: number;
};

export async function withDriver(
  driverOptions: {
    options?: TestOptions;
    doNotOverrideLogger?: boolean;
    setupFiles?: (tmpDir: string) => Promise<void>;
  },
  fn: (driver: NvimDriver) => Promise<void>,
) {
  return await withNvimProcess(
    async (sock) => {
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
            info: (msg: string) => console.log(msg),
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
          for (const serverName in mockServers) {
            await mockServers[serverName as ServerName].stop();
            delete mockServers[serverName as ServerName];
          }
        }
      });
    },
    { setupFiles: driverOptions.setupFiles },
  );
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

export function renderMessage(message: Message) {
  return `message ${message.state.id}

content:
${message.state.content.map((c) => JSON.stringify(c)).join("\n")}
`;
}

export function renderThread(thread: Thread) {
  return `Thread ${thread.id}

messages: ${thread.state.messages.map((m) => renderMessage(m)).join("\n")}
`;
}

export function renderChat(chat: Chat) {
  const out = [];
  for (const [threadId, threadState] of Object.entries(chat.threadWrappers)) {
    out.push(
      `${threadId} - ${threadState.state == "initialized" && renderThread(threadState.thread)}`,
    );
  }

  return out.join("\n");
}
