import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SandboxViolation,
  SandboxViolationHandler,
} from "./sandbox-violation-handler.ts";
import type { ShellResult } from "./shell.ts";

function makeShellResult(overrides?: Partial<ShellResult>): ShellResult {
  return {
    exitCode: 0,
    signal: undefined,
    output: [{ stream: "stdout", text: "ok" }],
    logFilePath: undefined,
    durationMs: 100,
    ...overrides,
  };
}

function makeViolation(command = "cat ~/.ssh/id_rsa"): SandboxViolation {
  return {
    command,
    violations: [
      {
        line: "sandbox deny file-read-data /Users/me/.ssh/id_rsa",
        command,
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    ],
    stderr:
      "Operation not permitted: read access denied for /Users/me/.ssh/id_rsa",
    result: makeShellResult({
      exitCode: 1,
      output: [
        {
          stream: "stderr",
          text: "Operation not permitted: read access denied for /Users/me/.ssh/id_rsa",
        },
      ],
    }),
  };
}

describe("SandboxViolationHandler", () => {
  let handler: SandboxViolationHandler;
  let onPendingChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onPendingChange = vi.fn();
    handler = new SandboxViolationHandler(onPendingChange);
  });

  describe("addViolation", () => {
    it("creates pending entry", () => {
      const retryFn = vi.fn().mockResolvedValue(makeShellResult());
      void handler.addViolation(makeViolation(), retryFn);

      expect(handler.getPendingViolations().size).toBe(1);
      expect(onPendingChange).toHaveBeenCalledOnce();
    });

    it("returns a pending promise", async () => {
      const retryFn = vi.fn().mockResolvedValue(makeShellResult());
      let resolved = false;
      void handler.addViolation(makeViolation(), retryFn).then(() => {
        resolved = true;
      });

      await vi.waitFor(() => {
        expect(handler.getPendingViolations().size).toBe(1);
      });
      expect(resolved).toBe(false);
    });
  });

  describe("reject", () => {
    it("resolves with original result plus rejection note for violations", async () => {
      const retryFn = vi.fn().mockResolvedValue(makeShellResult());
      const violation = makeViolation();
      const promise = handler.addViolation(violation, retryFn);

      const [[id]] = [...handler.getPendingViolations().entries()];
      handler.reject(id);

      const result = await promise;
      expect(result.exitCode).toBe(1);
      expect(result.output.at(-1)).toEqual({
        stream: "stderr",
        text: "The user rejected re-running this command outside the sandbox.",
      });
      expect(handler.getPendingViolations().size).toBe(0);
      expect(onPendingChange).toHaveBeenCalledTimes(2);
    });

    it("preserves original stdout and stderr in resolved result", async () => {
      const retryFn = vi.fn().mockResolvedValue(makeShellResult());
      const violation = makeViolation();
      const promise = handler.addViolation(violation, retryFn);

      const [[id]] = [...handler.getPendingViolations().entries()];
      handler.reject(id);

      const result = await promise;
      // Original stderr from the sandboxed command is preserved
      expect(result.output[0]).toEqual({
        stream: "stderr",
        text: "Operation not permitted: read access denied for /Users/me/.ssh/id_rsa",
      });
      // Rejection note is appended after original output
      expect(result.output).toHaveLength(2);
      expect(result.output[1].stream).toBe("stderr");
      expect(result.output[1].text).toContain("rejected");
    });

    it("does not call retry function when rejected", async () => {
      const retryFn = vi.fn().mockResolvedValue(makeShellResult());
      const promise = handler.addViolation(makeViolation(), retryFn);

      const [[id]] = [...handler.getPendingViolations().entries()];
      handler.reject(id);

      await promise;
      expect(retryFn).not.toHaveBeenCalled();
    });
  });

  describe("approve", () => {
    it("calls retry and resolves promise with result", async () => {
      const result = makeShellResult();
      const retryFn = vi.fn().mockResolvedValue(result);
      const promise = handler.addViolation(makeViolation(), retryFn);

      const [[id]] = [...handler.getPendingViolations().entries()];
      handler.approve(id);

      const resolved = await promise;
      expect(resolved).toBe(result);
      expect(retryFn).toHaveBeenCalledOnce();
      expect(handler.getPendingViolations().size).toBe(0);
    });

    it("propagates retry errors", async () => {
      const retryFn = vi.fn().mockRejectedValue(new Error("spawn failed"));
      const promise = handler.addViolation(makeViolation(), retryFn);

      const [[id]] = [...handler.getPendingViolations().entries()];
      handler.approve(id);

      await expect(promise).rejects.toThrow("spawn failed");
    });
  });

  describe("approveAll", () => {
    it("approves all pending items", async () => {
      const result1 = makeShellResult({ durationMs: 1 });
      const result2 = makeShellResult({ durationMs: 2 });
      const retry1 = vi.fn().mockResolvedValue(result1);
      const retry2 = vi.fn().mockResolvedValue(result2);

      const promise1 = handler.addViolation(makeViolation("cmd1"), retry1);
      const promise2 = handler.addViolation(makeViolation("cmd2"), retry2);

      handler.approveAll();

      const [r1, r2] = await Promise.all([promise1, promise2]);
      expect(r1).toBe(result1);
      expect(r2).toBe(result2);
      expect(retry1).toHaveBeenCalledOnce();
      expect(retry2).toHaveBeenCalledOnce();
      expect(handler.getPendingViolations().size).toBe(0);
    });
  });

  describe("rejectAll", () => {
    it("rejects all pending items", async () => {
      const retry1 = vi.fn().mockResolvedValue(makeShellResult());
      const retry2 = vi.fn().mockResolvedValue(makeShellResult());

      const promise1 = handler.addViolation(makeViolation("cmd1"), retry1);
      const promise2 = handler.addViolation(makeViolation("cmd2"), retry2);

      handler.rejectAll();

      const [r1, r2] = await Promise.all([promise1, promise2]);
      expect(r1.output.at(-1)?.text).toContain("rejected");
      expect(r2.output.at(-1)?.text).toContain("rejected");
      expect(handler.getPendingViolations().size).toBe(0);
    });
  });

  describe("promptForNetworkAccess", () => {
    it("resolves true on approve", async () => {
      const promise = handler.promptForNetworkAccess({
        host: "example.com",
        port: 443,
      });

      expect(handler.getPendingViolations().size).toBe(1);
      expect(onPendingChange).toHaveBeenCalledOnce();

      const [[id]] = [...handler.getPendingViolations().entries()];
      handler.approve(id);

      await expect(promise).resolves.toBe(true);
      expect(handler.getPendingViolations().size).toBe(0);
      expect(onPendingChange).toHaveBeenCalledTimes(2);
    });

    it("resolves false on reject", async () => {
      const promise = handler.promptForNetworkAccess({
        host: "example.com",
        port: undefined,
      });

      const [[id]] = [...handler.getPendingViolations().entries()];
      handler.reject(id);

      await expect(promise).resolves.toBe(false);
      expect(handler.getPendingViolations().size).toBe(0);
    });

    it("renders host:port prompt", () => {
      void handler.promptForNetworkAccess({ host: "example.com", port: 443 });

      const text = serializeVDOM(handler.view());
      expect(text).toContain("Allow network access");
      expect(text).toContain("example.com:443");
      expect(text).toContain("APPROVE");
      expect(text).toContain("REJECT");
    });

    it("approveAll resolves true", async () => {
      const promise = handler.promptForNetworkAccess({
        host: "a.com",
        port: 80,
      });
      handler.approveAll();
      await expect(promise).resolves.toBe(true);
    });

    it("rejectAll resolves false", async () => {
      const promise = handler.promptForNetworkAccess({
        host: "a.com",
        port: 80,
      });
      handler.rejectAll();
      await expect(promise).resolves.toBe(false);
    });
  });

  describe("operations on non-existent IDs", () => {
    it("approve is a no-op for non-existent ID", () => {
      handler.approve("non-existent");
      expect(handler.getPendingViolations().size).toBe(0);
    });

    it("reject is a no-op for non-existent ID", () => {
      handler.reject("non-existent");
      expect(handler.getPendingViolations().size).toBe(0);
    });
  });

  describe("view", () => {
    it("returns empty node when no violations", () => {
      const node = handler.view();
      expect(node.type).toBe("node");
      if (node.type === "node") {
        const hasContent = node.children.some(
          (c) => c.type === "string" && c.content.trim().length > 0,
        );
        expect(hasContent).toBe(false);
      }
    });

    it("renders violation with APPROVE/REJECT buttons", () => {
      const retryFn = vi.fn().mockResolvedValue(makeShellResult());
      void handler.addViolation(makeViolation("cat ~/.ssh/id_rsa"), retryFn);

      const node = handler.view();
      const text = serializeVDOM(node);

      expect(text).toContain("Sandbox blocked");
      expect(text).toContain("cat ~/.ssh/id_rsa");
      expect(text).toContain("APPROVE");
      expect(text).toContain("REJECT");
    });

    it("renders APPROVE ALL / REJECT ALL for multiple items", () => {
      const retryFn = vi.fn().mockResolvedValue(makeShellResult());
      void handler.addViolation(makeViolation("cmd1"), retryFn);
      void handler.addViolation(makeViolation("cmd2"), retryFn);

      const node = handler.view();
      const text = serializeVDOM(node);

      expect(text).toContain("APPROVE ALL");
      expect(text).toContain("REJECT ALL");
    });

    it("does not render ALL buttons for single item", () => {
      const retryFn = vi.fn().mockResolvedValue(makeShellResult());
      void handler.addViolation(makeViolation("cmd1"), retryFn);

      const node = handler.view();
      const text = serializeVDOM(node);

      expect(text).not.toContain("APPROVE ALL");
      expect(text).not.toContain("REJECT ALL");
    });
  });

  describe("promptForApproval", () => {
    it("shows command prompt", () => {
      const executeFn = vi.fn().mockResolvedValue(makeShellResult());
      void handler.promptForApproval("npm install", executeFn);

      expect(handler.getPendingViolations().size).toBe(1);
      expect(onPendingChange).toHaveBeenCalledOnce();

      const node = handler.view();
      const text = serializeVDOM(node);

      expect(text).toContain("May I run command");
      expect(text).toContain("npm install");
      expect(text).toContain("YES");
      expect(text).toContain("NO");
    });

    it("approve calls execute and resolves with result", async () => {
      const result = makeShellResult();
      const executeFn = vi.fn().mockResolvedValue(result);
      const promise = handler.promptForApproval("npm install", executeFn);

      const [[id]] = [...handler.getPendingViolations().entries()];
      handler.approve(id);

      const resolved = await promise;
      expect(resolved).toBe(result);
      expect(executeFn).toHaveBeenCalledOnce();
    });

    it("reject rejects without calling execute", async () => {
      const executeFn = vi.fn().mockResolvedValue(makeShellResult());
      const promise = handler.promptForApproval("npm install", executeFn);

      const [[id]] = [...handler.getPendingViolations().entries()];
      handler.reject(id);

      await expect(promise).rejects.toThrow(
        "The user did not allow running this command.",
      );
      expect(executeFn).not.toHaveBeenCalled();
    });
  });
});

/** Recursively extract text content from a VDOMNode for assertion purposes. */
function serializeVDOM(node: { type: string; [key: string]: unknown }): string {
  if (node.type === "string") {
    return (node as { type: "string"; content: string }).content;
  }
  if (node.type === "node" || node.type === "array") {
    const children = (
      node as unknown as {
        children: Array<{ type: string; [key: string]: unknown }>;
      }
    ).children;
    return children.map(serializeVDOM).join("");
  }
  return "";
}
