import { describe, expect, it } from "vitest";
import type { LspClient } from "./capabilities/lsp-client.ts";
import type { LuaExecutor } from "./capabilities/lua-executor.ts";
import { SandboxViolationHandler } from "./capabilities/sandbox-violation-handler.ts";
import type { ThreadId } from "./chat-types.ts";
import {
  createLocalEnvironment,
  environmentCapabilities,
} from "./environment.ts";
import { MockSandboxManager } from "./test/mock-sandbox-manager.ts";
import { noopLogger } from "./test-helpers.ts";
import type { HomeDir, ProjectDir } from "./utils/files.ts";

function build(extra: { lspClient?: LspClient; luaExecutor?: LuaExecutor }) {
  return createLocalEnvironment({
    logger: noopLogger,
    projectDir: "/tmp" as ProjectDir,
    homeDir: "/tmp" as HomeDir,
    getSandboxConfig: () => {
      throw new Error("unused");
    },
    threadId: "t" as ThreadId,
    sandbox: new MockSandboxManager(),
    approvals: new SandboxViolationHandler(() => {}),
    isBypassed: () => false,
    ...extra,
  });
}

describe("environmentCapabilities", () => {
  it("omits lsp and nvim without editor collaborators", () => {
    const caps = environmentCapabilities(build({}));
    expect([...caps].sort()).toEqual([
      "file-io",
      "scripts",
      "shell",
      "threads",
    ]);
  });

  it("offers lsp and nvim when their collaborators are supplied", () => {
    const caps = environmentCapabilities(
      build({
        lspClient: {} as LspClient,
        luaExecutor: {} as LuaExecutor,
      }),
    );
    expect(caps.has("lsp")).toBe(true);
    expect(caps.has("nvim")).toBe(true);
  });
});
