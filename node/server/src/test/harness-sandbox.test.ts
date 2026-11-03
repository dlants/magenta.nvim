import { expect, it } from "vitest";
import type { ThreadId } from "../chat-types.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { pollUntil } from "../utils/async.ts";
import { type Harness, submissionResolve, withHarness } from "./harness.ts";

const sandbox = { config: { requireApprovalPatterns: ["^rm "] } };

async function runBash(h: Harness, command: string) {
  const { id, thread } = await h.createRoot();
  const done = h.send(thread, "run it");
  const stream = await h.nextStream();
  stream.streamToolUse("bash-1" as ToolRequestId, "bash_command" as ToolName, {
    description: "test",
    command,
  });
  stream.finishResponse("tool_use");
  return { id, thread, done };
}

function pendingApproval(h: Harness, id: ThreadId) {
  return pollUntil(() => {
    const [entry] = h.session.getPendingApprovals(id).keys();
    if (!entry) throw new Error("no pending approval");
    return entry;
  });
}

async function finish(h: Harness, done: Promise<unknown>) {
  const next = await h.nextStream();
  const request = JSON.stringify(next.messages);
  next.finishResponse("end_turn");
  await done;
  return request;
}

it("runs an approved command", () =>
  withHarness(
    { sandbox, shell: { "rm x": { stdout: "removed" } } },
    async (h) => {
      const { id, done } = await runBash(h, "rm x");
      const approvalId = await pendingApproval(h, id);
      expect(h.shell.calls).toEqual([]);
      h.session.approve(id, approvalId);
      expect(await finish(h, done)).toContain("removed");
      expect(h.shell.calls).toEqual(["rm x"]);
      expect(h.session.getPendingApprovals(id).size).toBe(0);
    },
  ));

it("a rejected command reports the user did not allow it", () =>
  withHarness({ sandbox }, async (h) => {
    const { id, done } = await runBash(h, "rm x");
    h.session.reject(id, await pendingApproval(h, id));
    expect(await finish(h, done)).toContain(
      "The user did not allow running this command.",
    );
    expect(h.shell.calls).toEqual([]);
  }));

it("toggling the sandbox bypass approves pending approvals", () =>
  withHarness(
    { sandbox, shell: { "rm x": { stdout: "removed" } } },
    async (h) => {
      const { id, done } = await runBash(h, "rm x");
      await pendingApproval(h, id);
      h.session.toggleSandboxBypass(id);
      expect(await finish(h, done)).toContain("removed");
      expect(h.session.getPendingApprovals(id).size).toBe(0);
    },
  ));

it("blocked writes wait for approval before reaching the fileIO", () =>
  withHarness({ sandbox }, async (h) => {
    h.sandbox.blockWritesTo("/project/secret.txt");
    const { id, thread } = await h.createRoot();
    const done = h.send(thread, "write it");
    const stream = await h.nextStream();
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: 'newfile `/project/secret.txt`\ninsert_after "hi"',
    });
    stream.finishResponse("tool_use");
    const approvalId = await pendingApproval(h, id);
    expect(await h.fileIO.fileExists("/project/secret.txt")).toBe(false);
    h.session.approve(id, approvalId);
    await finish(h, done);
    expect(await h.fileIO.readFile("/project/secret.txt")).toBe("hi");
  }));

it("per-test custom commands expand through submissionResolve", () =>
  withHarness(
    {
      resolve: submissionResolve,
      options: { customCommands: [{ name: "@hi", text: "custom text" }] },
    },
    async (h) => {
      const { thread } = await h.createRoot();
      const done = h.send(thread, "say @hi");
      const stream = await h.nextStream();
      expect(JSON.stringify(stream.messages)).toContain("custom text");
      stream.finishResponse("end_turn");
      await done;
    },
  ));
