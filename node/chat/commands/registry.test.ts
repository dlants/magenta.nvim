import { describe, it, expect, vi } from "vitest";
import { CommandRegistry } from "./registry.ts";
import type { MessageContext } from "./types.ts";
import type { Nvim } from "../../nvim/nvim-node/index.ts";
import type { NvimCwd, HomeDir } from "../../utils/files.ts";
import type { ContextManager } from "../../context/context-manager.ts";
import type { MagentaOptions } from "../../options.ts";
import os from "os";

// Mock the dependencies used by commands
vi.mock("../../utils/diagnostics.ts", () => ({
  getDiagnostics: vi.fn().mockResolvedValue("Mock diagnostics content"),
}));

vi.mock("../../nvim/nvim.ts", () => ({
  getQuickfixList: vi.fn().mockResolvedValue([]),
  quickfixListToString: vi.fn().mockResolvedValue("Mock quickfix content"),
}));

vi.mock("../../utils/listBuffers.ts", () => ({
  getBuffersList: vi.fn().mockResolvedValue("Mock buffers list"),
}));

vi.mock("../../utils/files.ts", () => ({
  resolveFilePath: vi
    .fn()
    .mockImplementation((_cwd, path) => `/resolved/${path}`),
  relativePath: vi
    .fn()
    .mockImplementation((_cwd, path: string) => path.replace("/resolved/", "")),
  detectFileType: vi.fn().mockResolvedValue({ type: "file" }),
}));

vi.mock("zx", () => ({
  $: vi.fn(),
  within: vi.fn().mockImplementation((_fn) => {
    return {
      stdout: "Mock diff content",
      stderr: "",
    };
  }),
}));

const createMockContext = (): MessageContext => {
  const updateFn = vi.fn();
  return {
    nvim: {
      logger: {
        error: vi.fn(),
      },
    } as unknown as Nvim,
    cwd: "/test" as NvimCwd,
    homeDir: os.homedir() as HomeDir,
    contextManager: {
      update: updateFn,
    } as unknown as ContextManager,
    options: {
      customCommands: [],
    } as unknown as MagentaOptions,
  };
};

describe("CommandRegistry", () => {
  it("should register and process built-in commands", async () => {
    const registry = new CommandRegistry();
    const context = createMockContext();

    const result = await registry.processMessage("@diag some text", context);

    // Commands should NOT be removed from text (preserves original behavior)
    expect(result.processedText).toBe("@diag some text");
    // Should have added diagnostic content
    expect(result.additionalContent.length).toBeGreaterThan(0);
  });

  it("should handle multiple commands in one message", async () => {
    const registry = new CommandRegistry();
    const context = createMockContext();

    const result = await registry.processMessage(
      "@diag @qf some text",
      context,
    );

    // Commands should NOT be removed from text
    expect(result.processedText).toBe("@diag @qf some text");
    // Should have content from both commands
    expect(result.additionalContent.length).toBeGreaterThan(1);
  });

  it("should register and process custom commands", async () => {
    const registry = new CommandRegistry();
    registry.registerCustomCommand({
      name: "@custom",
      text: "Custom command text",
      description: "Test custom command",
    });

    const context = createMockContext();
    const result = await registry.processMessage("@custom some text", context);

    // Commands should NOT be removed from text
    expect(result.processedText).toBe("@custom some text");
    // Should have custom command content
    expect(result.additionalContent).toEqual([
      {
        type: "text",
        text: "Custom command text",
      },
    ]);
  });

  it("should handle parameterized commands like @file:", async () => {
    const registry = new CommandRegistry();
    const context = createMockContext();

    const result = await registry.processMessage(
      "@file:test.ts more text",
      context,
    );

    // Commands should NOT be removed from text
    expect(result.processedText).toBe("@file:test.ts more text");
    // Context manager should have been called
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(context.contextManager.update).toHaveBeenCalled();
  });

  it("should handle @async by stripping it", async () => {
    const registry = new CommandRegistry();
    const context = createMockContext();

    const result = await registry.processMessage(
      "@async do something",
      context,
    );

    // @async should be stripped from the beginning
    expect(result.processedText).toBe("do something");
    expect(result.additionalContent).toEqual([]);
  });

  it("should handle overlapping commands correctly", async () => {
    const registry = new CommandRegistry();
    const context = createMockContext();

    // Register a custom command that could overlap
    registry.registerCustomCommand({
      name: "@di",
      text: "Short command",
    });

    const result = await registry.processMessage("@diag test", context);

    // Should match @diag, not @di (commands not removed)
    expect(result.processedText).toBe("@diag test");
    // Should have diagnostic content, not custom command content
    expect(result.additionalContent.length).toBeGreaterThan(0);
    expect(result.additionalContent[0].type).toBe("text");
    const textContent = result.additionalContent[0] as {
      type: string;
      text: string;
    };
    expect(textContent.text).toContain("diagnostics");
  });

  it("should escape special regex characters in custom command names", async () => {
    const registry = new CommandRegistry();
    registry.registerCustomCommand({
      name: "@test[1]",
      text: "Special characters",
    });

    const context = createMockContext();
    const result = await registry.processMessage("@test[1] text", context);

    expect(result.processedText).toBe("@test[1] text");
    expect(result.additionalContent).toEqual([
      {
        type: "text",
        text: "Special characters",
      },
    ]);
  });

  it("should handle errors gracefully", async () => {
    const registry = new CommandRegistry();
    const context = createMockContext();

    // Mock resolveFilePath to throw error for this test
    const { resolveFilePath } = await import("../../utils/files.ts");
    vi.mocked(resolveFilePath).mockImplementationOnce(() => {
      throw new Error("File not found");
    });

    const result = await registry.processMessage(
      "@file:nonexistent.ts text",
      context,
    );

    // Commands should NOT be removed from text
    expect(result.processedText).toBe("@file:nonexistent.ts text");
    // Error should be added as content
    expect(result.additionalContent.length).toBe(1);
    expect(result.additionalContent[0].type).toBe("text");
    const textContent = result.additionalContent[0] as {
      type: string;
      text: string;
    };
    expect(textContent.text).toContain("Error adding file to context for");
  });

  it("should not match custom commands ending in punctuation that are followed by non-command word characters", async () => {
    const registry = new CommandRegistry();
    registry.registerCustomCommand({
      name: "@test[1]",
      text: "Test command",
    });

    const context = createMockContext();
    const result = await registry.processMessage("@test[1]foo text", context);

    expect(result.processedText).toBe("@test[1]foo text");
    expect(result.additionalContent).toEqual([]);
  });

  it("should not match custom commands ending in word chars that are followed by non-command word characters", async () => {
    const registry = new CommandRegistry();
    registry.registerCustomCommand({
      name: "@test",
      text: "Test command",
    });

    const context = createMockContext();
    const result = await registry.processMessage("@testfoo text", context);

    expect(result.processedText).toBe("@testfoo text");
    expect(result.additionalContent).toEqual([]);
  });
});
