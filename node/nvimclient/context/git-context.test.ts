import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";

const execFile = promisify(execFileCb);

type ContentBlockParam = Anthropic.Messages.ContentBlockParam;

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile(
    "git",
    ["-c", "user.email=test@test.com", "-c", "user.name=test", ...args],
    { cwd },
  );
}

async function initRepo(tmpDir: string): Promise<void> {
  await git(tmpDir, ["init", "-q"]);
  await git(tmpDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(tmpDir, ["add", "poem.txt"]);
  await git(tmpDir, ["commit", "-q", "-m", "initial commit"]);
}

function findUserText(
  messages: Anthropic.MessageParam[],
  needle: string,
): string | undefined {
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as ContentBlockParam[]) {
      if (block.type === "text" && block.text.includes(needle)) {
        return block.text;
      }
    }
  }
  return undefined;
}

it("renders the git context update when the branch changes", async () => {
  await withDriver(
    { setupFiles: async (tmpDir) => initRepo(tmpDir) },
    async (driver, dirs) => {
      await driver.showSidebar();
      await driver.inputMagentaText("first");
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingStream();
      request1.respond({
        stopReason: "end_turn",
        text: "ok",
        toolRequests: [],
      });

      // Change the coarse git state out from under the thread.
      await git(dirs.tmpDir, ["checkout", "-q", "-b", "feature"]);

      await driver.inputMagentaText("second");
      await driver.send();

      const request2 = await driver.mockAnthropic.awaitPendingStream();
      const gitText = findUserText(request2.messages, "# Git status update");
      expect(gitText).toBeDefined();
      expect(gitText).toContain("Branch: feature");

      await driver.assertDisplayBufferContains("git: feature");

      request2.respond({
        stopReason: "end_turn",
        text: "done",
        toolRequests: [],
      });
    },
  );
});
