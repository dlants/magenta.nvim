import os from "node:os";
import { MockSandboxManager } from "@magenta/server/src/test/mock-sandbox-manager.ts";
import { noopLogger } from "@magenta/server/src/test-helpers.ts";
import type { HomeDir, ProjectDir } from "@magenta/server/src/utils/files.ts";
import { expect, it, vi } from "vitest";
import { startInProcessServer } from "./in-process-server.ts";
import type { MagentaOptions } from "./options.ts";

function start() {
  return startInProcessServer({
    logger: noopLogger,
    cwd: os.tmpdir() as ProjectDir,
    homeDir: os.homedir() as HomeDir,
    sandbox: new MockSandboxManager(),
    // Only read for MCP servers here: no thread is created.
    getBaseOptions: () => ({ mcpServers: {} }) as MagentaOptions,
    getScriptsPaths: () => [],
  });
}

it("dispose disposes the session even if script teardown fails", async () => {
  const { server, internals } = start();
  vi.spyOn(internals.scripts, "dispose").mockRejectedValue(
    new Error("scripts failed"),
  );
  const sessionDispose = vi.spyOn(internals.session, "dispose");
  await expect(server.dispose()).rejects.toThrow("scripts failed");
  expect(sessionDispose).toHaveBeenCalledOnce();
});
