import { describe, it, expect, vi } from "vitest";
import * as BashCommand from "./bashCommand.ts";
import type { Shell, ShellResult, OutputLine } from "../capabilities/shell.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";

function createMockShell(result: ShellResult): Shell {
  return {
    execute: (
      _command: string,
      opts: {
        toolRequestId: string;
        onOutput?: (line: OutputLine) => void;
        onStart?: () => void;
      },
    ) => {
      opts.onStart?.();
      for (const line of result.output) {
        opts.onOutput?.(line);
      }
      return Promise.resolve(result);
    },
    terminate: vi.fn(),
  };
}

function makeOutputLines(
  lines: string[],
  stream: "stdout" | "stderr" = "stdout",
): OutputLine[] {
  return lines.map((text) => ({ stream, text }));
}

function createTool(command: string, shellResult: ShellResult) {
  const shell = createMockShell(shellResult);
  const requestRender = vi.fn();

  const invocation = BashCommand.execute(
    {
      id: "tool_1" as ToolRequestId,
      toolName: "bash_command" as const,
      input: { command },
    },
    { shell, requestRender },
  );

  return { invocation, requestRender };
}

async function getResultText(invocation: {
  promise: Promise<ProviderToolResult>;
}): Promise<string> {
  const result = await invocation.promise;
  if (result.result.status === "ok") {
    return (result.result.value[0] as { type: "text"; text: string }).text;
  }
  return result.result.error;
}

describe("bashCommand unit tests", () => {
  it("returns formatted output for simple successful command", async () => {
    const { invocation } = createTool("echo hello", {
      exitCode: 0,
      signal: undefined,
      output: makeOutputLines(["hello"]),
      logFilePath: "/tmp/test.log",
      durationMs: 42,
    });

    const text = await getResultText(invocation);
    expect(text).toContain("stdout:");
    expect(text).toContain("hello");
    expect(text).toContain("exit code 0 (42ms)");
    expect(text).toContain("Full output (1 lines): /tmp/test.log");
  });

  it("includes duration in result for failed commands", async () => {
    const { invocation } = createTool("exit 1", {
      exitCode: 1,
      signal: undefined,
      output: [],
      logFilePath: "/tmp/test.log",
      durationMs: 100,
    });

    const text = await getResultText(invocation);
    expect(text).toContain("exit code 1 (100ms)");
  });

  it("reports signal when process is terminated", async () => {
    const { invocation } = createTool("sleep 60", {
      exitCode: 0,
      signal: "SIGTERM",
      output: [],
      logFilePath: undefined,
      durationMs: 500,
    });

    const text = await getResultText(invocation);
    expect(text).toContain("terminated by signal SIGTERM (500ms)");
  });

  it("includes full output when within token budget", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `LINE${i + 1}: content`);
    const { invocation } = createTool("test", {
      exitCode: 0,
      signal: undefined,
      output: makeOutputLines(lines),
      logFilePath: "/tmp/test.log",
      durationMs: 50,
    });

    const text = await getResultText(invocation);
    for (let i = 1; i <= 30; i++) {
      expect(text).toContain(`LINE${i}:`);
    }
    expect(text).not.toContain("lines omitted");
    expect(text).toContain("Full output");
  });

  it("abbreviates output when it exceeds token budget", async () => {
    const lineContent = "X".repeat(500);
    const lines = Array.from(
      { length: 100 },
      (_, i) => `LINE${i + 1}:${lineContent}`,
    );
    const { invocation } = createTool("test", {
      exitCode: 0,
      signal: undefined,
      output: makeOutputLines(lines),
      logFilePath: "/tmp/test.log",
      durationMs: 50,
    });

    const text = await getResultText(invocation);
    // Should be within budget (8000 chars for 2000 tokens)
    expect(text.length).toBeLessThan(9000);
    expect(text).toContain("exit code 0");
    expect(text).toContain("lines omitted");
    expect(text).toContain("LINE1:");
    expect(text).toContain("LINE100:");
    expect(text).toContain("Full output (100 lines):");
    expect(text).toContain("/tmp/test.log");
  });

  it("abbreviates long lines", async () => {
    const longLine = "A".repeat(5000);
    // Need multiple long lines so total exceeds budget and triggers abbreviation path
    const lines = Array.from({ length: 20 }, () => longLine);
    const { invocation } = createTool("test", {
      exitCode: 0,
      signal: undefined,
      output: makeOutputLines(lines),
      logFilePath: "/tmp/test.log",
      durationMs: 10,
    });

    const text = await getResultText(invocation);
    // The full 5000-char string should NOT be present
    expect(text).not.toContain(longLine);
    // But abbreviated lines should contain the "..." marker
    expect(text).toContain("AAA...AAA");
  });

  it("separates stdout and stderr streams", async () => {
    const output: OutputLine[] = [
      { stream: "stdout", text: "normal output" },
      { stream: "stderr", text: "error output" },
      { stream: "stdout", text: "more output" },
    ];
    const { invocation } = createTool("test", {
      exitCode: 0,
      signal: undefined,
      output,
      logFilePath: undefined,
      durationMs: 10,
    });

    const text = await getResultText(invocation);
    expect(text).toContain("stdout:");
    expect(text).toContain("normal output");
    expect(text).toContain("stderr:");
    expect(text).toContain("error output");
  });

  it("calls requestRender on output and start", async () => {
    const { invocation, requestRender } = createTool("echo hello", {
      exitCode: 0,
      signal: undefined,
      output: makeOutputLines(["line1", "line2"]),
      logFilePath: undefined,
      durationMs: 10,
    });

    await invocation.promise;
    // onOutput is called for each line, onStart is called once
    expect(requestRender).toHaveBeenCalled();
  });

  it("abort returns error result", async () => {
    let resolveShell: (result: ShellResult) => void;
    const shell: Shell = {
      execute: async (_command, opts) => {
        opts.onStart?.();
        return new Promise<ShellResult>((resolve) => {
          resolveShell = resolve;
        });
      },
      terminate: vi.fn(),
    };

    const requestRender = vi.fn();
    const invocation = BashCommand.execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "bash_command" as const,
        input: { command: "sleep 60" },
      },
      { shell, requestRender },
    );

    invocation.abort();
    // Resolve the shell after abort
    resolveShell!({
      exitCode: 0,
      signal: "SIGTERM",
      output: [],
      logFilePath: undefined,
      durationMs: 100,
    });

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("aborted by the user");
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(shell.terminate).toHaveBeenCalled();
  });

  it("validateInput rejects non-string command", () => {
    const result = BashCommand.validateInput({ command: 123 });
    expect(result.status).toBe("error");
  });

  it("validateInput accepts valid command", () => {
    const result = BashCommand.validateInput({ command: "echo hello" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.command).toBe("echo hello");
    }
  });
});
