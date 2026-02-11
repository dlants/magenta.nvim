import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BashCommandTool,
  abbreviateLine,
  formatOutputForToolResult,
  MAX_CHARS_PER_LINE,
  MAX_OUTPUT_TOKENS_FOR_AGENT,
  CHARACTERS_PER_TOKEN,
  type Msg,
  type OutputLine,
} from "./bash-command-tool.ts";
import type { CommandExec, CommandResult, SpawnOptions } from "./environment.ts";
import type { Logger } from "../logger.ts";
import type { AbsFilePath, Cwd, HomeDir } from "../utils/files.ts";
import type { ToolRequestId, ToolName, ToolMsg } from "./types.ts";
import type { ToolRequest } from "./specs/bash-command.ts";
import { validateInput } from "./specs/bash-command.ts";
import type { Result } from "../utils/result.ts";
import { createTool, type CreateToolContext } from "./create-tool.ts";
import { TOOL_SPEC_MAP } from "./toolManager.ts";

function mockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

type MockCommandExecHandler = (
  command: string,
  options: SpawnOptions,
) => Promise<Result<CommandResult>>;

function mockCommandExec(
  handler?: MockCommandExecHandler,
): CommandExec & { calls: { command: string; options: SpawnOptions }[] } {
  const calls: { command: string; options: SpawnOptions }[] = [];
  const defaultHandler: MockCommandExecHandler = async () => ({
    status: "ok",
    value: {
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: undefined,
      logFile: undefined,
    },
  });

  return {
    calls,
    async spawn(command: string, options: SpawnOptions) {
      calls.push({ command, options });
      return (handler ?? defaultHandler)(command, options);
    },
  };
}

const TEST_CWD = "/test/project" as Cwd;
const TEST_HOME = "/home/user" as HomeDir;

function makeRequest(command: string): ToolRequest {
  return {
    id: "test-tool-1" as ToolRequestId,
    toolName: "bash_command" as unknown as ToolName,
    input: { command },
  };
}

function waitForDone(tool: BashCommandTool): Promise<void> {
  return vi.waitFor(() => {
    expect(tool.isDone()).toBe(true);
  });
}

describe("BashCommandTool", () => {
  let dispatched: Msg[];
  let logger: Logger;

  beforeEach(() => {
    dispatched = [];
    logger = mockLogger();
  });

  function createBashTool(
    command: string,
    handler?: MockCommandExecHandler,
  ) {
    const request = makeRequest(command);
    const commandExec = mockCommandExec(handler);
    let tool: BashCommandTool;
    tool = new BashCommandTool(request, {
      commandExec,
      logger,
      cwd: TEST_CWD,
      myDispatch: (msg: Msg) => {
        dispatched.push(msg);
        tool.update(msg as unknown as ToolMsg);
      },
    });
    return { tool, commandExec };
  }

  it("executes a successful command", async () => {
    const { tool, commandExec } = createBashTool(
      "echo hello",
      async (_cmd, options) => {
        options.onOutput?.({ stream: "stdout", text: "hello" });
        return {
          status: "ok",
          value: {
            stdout: "hello",
            stderr: "",
            exitCode: 0,
            signal: undefined,
            logFile: undefined,
          },
        };
      },
    );

    expect(tool.state.state).toBe("processing");
    expect(tool.isDone()).toBe(false);
    expect(tool.isPendingUserAction()).toBe(false);

    await waitForDone(tool);

    expect(dispatched.length).toBe(1);
    expect(dispatched[0].type).toBe("finish");
    expect(dispatched[0].result.status).toBe("ok");

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      expect(result.result.value[0].type).toBe("text");
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("hello");
      expect(text).toContain("exit code 0");
    }

    expect(commandExec.calls.length).toBe(1);
    expect(commandExec.calls[0].command).toBe("echo hello");
  });

  it("handles command failure (error result from environment)", async () => {
    const { tool } = createBashTool("bad-command", async () => ({
      status: "error",
      error: "Command not found: bad-command",
    }));

    await waitForDone(tool);

    expect(dispatched.length).toBe(1);
    expect(dispatched[0].result.status).toBe("error");

    const result = tool.getToolResult();
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("bad-command");
    }
  });

  it("handles non-zero exit code", async () => {
    const { tool } = createBashTool("exit 1", async (_cmd, options) => {
      options.onOutput?.({ stream: "stderr", text: "error occurred" });
      return {
        status: "ok",
        value: {
          stdout: "",
          stderr: "error occurred",
          exitCode: 1,
          signal: undefined,
          logFile: undefined,
        },
      };
    });

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("exit code 1");
      expect(text).toContain("error occurred");
    }
  });

  it("handles command terminated by signal", async () => {
    const { tool } = createBashTool("sleep 100", async () => ({
      status: "ok",
      value: {
        stdout: "",
        stderr: "",
        exitCode: undefined,
        signal: "SIGTERM",
        logFile: undefined,
      },
    }));

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("terminated by signal SIGTERM");
    }
  });

  it("includes log file reference when present", async () => {
    const logPath = "/tmp/log-123.log" as AbsFilePath;
    const { tool } = createBashTool("ls", async (_cmd, options) => {
      options.onOutput?.({ stream: "stdout", text: "file1.ts" });
      options.onOutput?.({ stream: "stdout", text: "file2.ts" });
      return {
        status: "ok",
        value: {
          stdout: "file1.ts\nfile2.ts",
          stderr: "",
          exitCode: 0,
          signal: undefined,
          logFile: logPath,
        },
      };
    });

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain(logPath);
      expect(text).toContain("2 lines");
    }
  });

  it("streams output to state.output during execution", async () => {
    const { tool } = createBashTool("stream-test", async (_cmd, options) => {
      options.onOutput?.({ stream: "stdout", text: "line 1" });
      options.onOutput?.({ stream: "stdout", text: "line 2" });
      options.onOutput?.({ stream: "stderr", text: "warning" });

      // Verify output is accumulated during execution
      expect(tool.state.state).toBe("processing");
      if (tool.state.state === "processing") {
        expect(tool.state.output).toHaveLength(3);
        expect(tool.state.output[0]).toEqual({
          stream: "stdout",
          text: "line 1",
        });
        expect(tool.state.output[2]).toEqual({
          stream: "stderr",
          text: "warning",
        });
      }

      return {
        status: "ok",
        value: {
          stdout: "line 1\nline 2",
          stderr: "warning",
          exitCode: 0,
          signal: undefined,
          logFile: undefined,
        },
      };
    });

    await waitForDone(tool);
  });

  it("can be aborted before completion", async () => {
    let resolveSpawn: (() => void) | undefined;
    const { tool, commandExec } = createBashTool(
      "long-running",
      async (_cmd, _options) => {
        await new Promise<void>((resolve) => {
          resolveSpawn = resolve;
        });
        return {
          status: "ok",
          value: {
            stdout: "",
            stderr: "",
            exitCode: 0,
            signal: undefined,
            logFile: undefined,
          },
        };
      },
    );

    // Wait for spawn to be called
    await vi.waitFor(() => {
      expect(commandExec.calls.length).toBe(1);
    });

    const result = tool.abort();
    expect(tool.isDone()).toBe(true);
    expect(tool.aborted).toBe(true);
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("aborted");
    }

    // The abort signal should have been set
    expect(commandExec.calls[0].options.abortSignal?.aborted).toBe(true);

    // Resolve the pending promise so the test doesn't leak
    resolveSpawn?.();
  });

  it("abort returns existing result if already done", async () => {
    const { tool } = createBashTool("echo done", async (_cmd, options) => {
      options.onOutput?.({ stream: "stdout", text: "done" });
      return {
        status: "ok",
        value: {
          stdout: "done",
          stderr: "",
          exitCode: 0,
          signal: undefined,
          logFile: undefined,
        },
      };
    });

    await waitForDone(tool);

    const result = tool.abort();
    expect(result.result.status).toBe("ok");
  });

  it("returns processing result before done", () => {
    const { tool } = createBashTool("echo hello");
    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      expect(result.result.value[0].type).toBe("text");
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("being processed");
    }
  });

  it("passes correct spawn options", async () => {
    const { tool, commandExec } = createBashTool("test-cmd");

    await waitForDone(tool);

    expect(commandExec.calls[0].options.cwd).toBe(TEST_CWD);
    expect(commandExec.calls[0].options.timeout).toBe(300_000);
    expect(commandExec.calls[0].options.abortSignal).toBeDefined();
    expect(commandExec.calls[0].options.onOutput).toBeDefined();
  });
});

describe("abbreviateLine", () => {
  it("returns short lines unchanged", () => {
    expect(abbreviateLine("short line")).toBe("short line");
  });

  it("abbreviates lines exceeding MAX_CHARS_PER_LINE", () => {
    const longLine = "x".repeat(MAX_CHARS_PER_LINE + 100);
    const result = abbreviateLine(longLine);
    expect(result.length).toBeLessThan(longLine.length);
    expect(result).toContain("...");
    expect(result.startsWith("x")).toBe(true);
    expect(result.endsWith("x")).toBe(true);
  });

  it("does not abbreviate lines at exactly MAX_CHARS_PER_LINE", () => {
    const exactLine = "a".repeat(MAX_CHARS_PER_LINE);
    expect(abbreviateLine(exactLine)).toBe(exactLine);
  });
});

describe("formatOutputForToolResult", () => {
  function makeResult(
    overrides: Partial<CommandResult> = {},
  ): CommandResult {
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: undefined,
      logFile: undefined,
      ...overrides,
    };
  }

  it("formats small output without truncation", () => {
    const output: OutputLine[] = [
      { stream: "stdout", text: "hello" },
      { stream: "stdout", text: "world" },
    ];
    const result = formatOutputForToolResult(makeResult(), output);
    expect(result).toHaveLength(1);
    const text = (result[0] as { type: "text"; text: string }).text;
    expect(text).toContain("stdout:");
    expect(text).toContain("hello");
    expect(text).toContain("world");
    expect(text).toContain("exit code 0");
    expect(text).not.toContain("omitted");
  });

  it("truncates large output with head/tail split", () => {
    const totalBudget = MAX_OUTPUT_TOKENS_FOR_AGENT * CHARACTERS_PER_TOKEN;
    const lineLength = 80;
    const numLines = Math.ceil((totalBudget * 2) / lineLength);
    const output: OutputLine[] = [];
    for (let i = 0; i < numLines; i++) {
      output.push({
        stream: "stdout",
        text: `line ${String(i).padStart(4, "0")} ${"x".repeat(lineLength - 15)}`,
      });
    }

    const result = formatOutputForToolResult(makeResult(), output);
    const text = (result[0] as { type: "text"; text: string }).text;
    expect(text).toContain("omitted");
    expect(text).toContain("line 0000");
    expect(text).toContain(
      `line ${String(numLines - 1).padStart(4, "0")}`,
    );
  });

  it("separates stdout and stderr sections", () => {
    const output: OutputLine[] = [
      { stream: "stdout", text: "out1" },
      { stream: "stderr", text: "err1" },
      { stream: "stdout", text: "out2" },
    ];
    const result = formatOutputForToolResult(makeResult(), output);
    const text = (result[0] as { type: "text"; text: string }).text;
    expect(text).toContain("stdout:");
    expect(text).toContain("stderr:");
    // stdout: should appear twice since it switches back
    const stdoutMatches = text.match(/stdout:/g);
    expect(stdoutMatches?.length).toBe(2);
  });

  it("shows signal instead of exit code", () => {
    const result = formatOutputForToolResult(
      makeResult({ signal: "SIGKILL" }),
      [],
    );
    const text = (result[0] as { type: "text"; text: string }).text;
    expect(text).toContain("terminated by signal SIGKILL");
    expect(text).not.toContain("exit code");
  });

  it("includes log file with line count", () => {
    const output: OutputLine[] = [
      { stream: "stdout", text: "a" },
      { stream: "stdout", text: "b" },
      { stream: "stdout", text: "c" },
    ];
    const result = formatOutputForToolResult(
      makeResult({ logFile: "/tmp/log.log" as AbsFilePath }),
      output,
    );
    const text = (result[0] as { type: "text"; text: string }).text;
    expect(text).toContain("/tmp/log.log");
    expect(text).toContain("3 lines");
  });

  it("abbreviates long lines in truncated output", () => {
    const totalBudget = MAX_OUTPUT_TOKENS_FOR_AGENT * CHARACTERS_PER_TOKEN;
    const longLine = "x".repeat(MAX_CHARS_PER_LINE + 200);
    const numLines = Math.ceil((totalBudget * 2) / MAX_CHARS_PER_LINE);
    const output: OutputLine[] = [];
    for (let i = 0; i < numLines; i++) {
      output.push({ stream: "stdout", text: longLine });
    }

    const result = formatOutputForToolResult(makeResult(), output);
    const text = (result[0] as { type: "text"; text: string }).text;
    expect(text).toContain("...");
    expect(text).toContain("omitted");
  });
});

describe("validateInput", () => {
  it("accepts valid command string", () => {
    const result = validateInput({ command: "echo hello" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.command).toBe("echo hello");
    }
  });

  it("rejects missing command", () => {
    const result = validateInput({});
    expect(result.status).toBe("error");
  });

  it("rejects non-string command", () => {
    const result = validateInput({ command: 123 });
    expect(result.status).toBe("error");
  });
});

describe("toolManager integration", () => {
  it("has bash_command spec registered", () => {
    expect(TOOL_SPEC_MAP["bash_command"]).toBeDefined();
    expect(TOOL_SPEC_MAP["bash_command"].name).toBe("bash_command");
  });
});

describe("createTool integration", () => {
  function makeContext(
    handler?: MockCommandExecHandler,
  ): CreateToolContext {
    return {
      fileIO: {
        async readFile() {
          return { status: "error", error: "not implemented" };
        },
        async writeFile() {
          return { status: "ok", value: undefined };
        },
        async fileExists() {
          return { status: "ok", value: false };
        },
        async mkdir() {
          return { status: "ok", value: undefined };
        },
        async readDir() {
          return { status: "ok", value: [] };
        },
      },
      logger: mockLogger(),
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      myDispatch: vi.fn(),
      edlRegisters: { registers: new Map(), nextSavedId: 0 },
      commandExec: mockCommandExec(handler),
    };
  }

  it("creates BashCommandTool for bash_command requests", () => {
    const result = createTool(
      {
        id: "req-1" as ToolRequestId,
        toolName: "bash_command" as unknown as ToolName,
        input: { command: "echo test" },
      },
      makeContext(),
    );

    expect("status" in result).toBe(false);
    expect((result as BashCommandTool).toolName).toBe("bash_command");
  });

  it("returns error for invalid bash_command input", () => {
    const result = createTool(
      {
        id: "req-1" as ToolRequestId,
        toolName: "bash_command" as unknown as ToolName,
        input: { notCommand: 123 },
      },
      makeContext(),
    );

    expect("status" in result && result.status === "error").toBe(true);
  });
});