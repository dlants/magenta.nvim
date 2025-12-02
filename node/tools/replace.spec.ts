import { describe, expect, it } from "vitest";
import * as Replace from "./replace";
import { type VDOMNode } from "../tea/view";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import type { ToolName } from "./types";
import * as path from "path";
import { getcwd } from "../nvim/nvim";
import * as fs from "node:fs";
import type { UnresolvedFilePath } from "../utils/files";

describe("node/tools/replace.spec.ts", () => {
  it("validate input", () => {
    const validInput = {
      filePath: "test.txt",
      find: "existing text",
      replace: "new text",
    };

    const result = Replace.validateInput(validInput);
    expect(result.status).toEqual("ok");
    if (result.status === "ok") {
      expect(result.value.filePath).toEqual("test.txt");
      expect(result.value.find).toEqual("existing text");
      expect(result.value.replace).toEqual("new text");
    }

    // Test with missing filePath
    const invalidInput1 = {
      find: "existing text",
      replace: "new text",
    };
    const result1 = Replace.validateInput(invalidInput1);
    expect(result1.status).toEqual("error");

    // Test with wrong type
    const invalidInput2 = {
      filePath: 123,
      find: "existing text",
      replace: "new text",
    };
    const result2 = Replace.validateInput(invalidInput2);
    expect(result2.status).toEqual("error");
  });

  it("renderStreamedBlock - with filePath", () => {
    // Define the content to find and replace
    const findText = `\
function oldFunction() {
  return false;
}`;

    const replaceText = `\
function newFunction() {
  return true;
}`;

    // Create the request object
    const request = {
      filePath: "example.js",
      find: findText,
      replace: replaceText,
    };

    // Convert to JSON and simulate a partial stream
    const streamed = JSON.stringify(request);

    const result = Replace.renderStreamedBlock(streamed);
    const resultStr = vdomToString(result);
    expect(resultStr).toContain("Replace [[ -3 / +3 ]]"); // 3 lines in both find and replace
    expect(resultStr).toContain("example.js");
    expect(resultStr).toContain("streaming");
  });

  it("renderStreamedBlock - without filePath", () => {
    // Create a request without filePath
    const request = {
      find: "old text",
      replace: "new text",
    };

    // Convert to JSON
    const streamed = JSON.stringify(request);

    const result = Replace.renderStreamedBlock(streamed);
    const resultStr = vdomToString(result);
    expect(resultStr).toContain("Preparing replace operation");
  });

  it("renderStreamedBlock - with multiline escaped content", () => {
    const findText = `\
const json = { "key": "value" };
const oldCode = "first line";
let thirdLine;`;

    const replaceText = `\
const json = { "key": "updated" };
const newCode = "first line";
let thirdLine;
let fourthLine;`;

    // Create the request object
    const request = {
      filePath: "test.js",
      find: findText,
      replace: replaceText,
    };

    // Convert to JSON
    const streamed = JSON.stringify(request);

    const result = Replace.renderStreamedBlock(streamed);
    const resultStr = vdomToString(result);
    // Should correctly count the newlines
    expect(resultStr).toContain("Replace [[ -3 / +4 ]]");
    expect(resultStr).toContain("test.js");
  });

  it("reproduce exact error from measure-selection-box.tsx", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      const testFile = path.join(cwd, "measure-selection-box.tsx");

      const originalContent = `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";
import { MEASURES } from "../constants";
import { assertUnreachable, filterMeasures } from "../util/utils";
import { MeasureId, MeasureSpec } from "../../iso/measures/index";
import { MeasureStats } from "../../iso/protocol";

export type Model = immer.Immutable<
  | {
      measureStats: MeasureStats;
      state: "typing";
      query: string;
      measures: MeasureSpec[];
    }
  | {
      measureStats: MeasureStats;
      state: "selected";
      measureId: MeasureId;
    }
>;`;

      fs.writeFileSync(testFile, originalContent, "utf-8");

      // Open the file in a buffer to trigger the unloaded buffer scenario
      await driver.nvim.call("nvim_command", [`edit ${testFile}`]);

      await driver.showSidebar();
      await driver.inputMagentaText(
        "Update imports in measure-selection-box.tsx",
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "end_turn",
        text: "I'll update the imports",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "toolu_01Cj7KxmYJ1STqcHiuHFuWJi" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: testFile as UnresolvedFilePath,
                find: `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";
import { MEASURES } from "../constants";
import { assertUnreachable, filterMeasures } from "../util/utils";
import { MeasureId, MeasureSpec } from "../../iso/measures/index";
import { MeasureStats } from "../../iso/protocol";`,
                replace: `import React from "react";
import { Dispatch } from "../tea";
import { MEASURES } from "../constants";
import { assertUnreachable, filterMeasures } from "../util/utils";
import { MeasureId, MeasureSpec } from "../../iso/measures/index";
import { MeasureStats } from "../../iso/protocol";`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️✅ Replace [[ -7 / +6 ]]");

      const fileContent = fs.readFileSync(testFile, "utf-8");
      expect(fileContent).toContain('import { Dispatch } from "../tea";');
      expect(fileContent).not.toContain('import * as immer from "immer";');
      expect(fileContent).not.toContain(
        'import { Update, View } from "../tea";',
      );
    });
  });
  it("reproduce exact error from measure-selection-box.tsx with buffer open", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      const testFile = path.join(cwd, "measure-selection-box-buffer.tsx");

      const originalContent = `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";
import { MEASURES } from "../constants";
import { assertUnreachable, filterMeasures } from "../util/utils";
import { MeasureId, MeasureSpec } from "../../iso/measures/index";
import { MeasureStats } from "../../iso/protocol";

export type Model = immer.Immutable<
  | {
      measureStats: MeasureStats;
      state: "typing";
      query: string;
      measures: MeasureSpec[];
    }
  | {
      measureStats: MeasureStats;
      state: "selected";
      measureId: MeasureId;
    }
>;`;

      fs.writeFileSync(testFile, originalContent, "utf-8");

      // Open the file in a buffer before running the replace
      await driver.command(`edit ${testFile}`);

      await driver.showSidebar();
      await driver.inputMagentaText(
        "Update imports in measure-selection-box-buffer.tsx",
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "end_turn",
        text: "I'll update the imports",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "toolu_01Cj7KxmYJ1STqcHiuHFuWJi" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: testFile as UnresolvedFilePath,
                find: `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";
import { MEASURES } from "../constants";
import { assertUnreachable, filterMeasures } from "../util/utils";
import { MeasureId, MeasureSpec } from "../../iso/measures/index";
import { MeasureStats } from "../../iso/protocol";`,
                replace: `import React from "react";
import { Dispatch } from "../tea";
import { MEASURES } from "../constants";
import { assertUnreachable, filterMeasures } from "../util/utils";
import { MeasureId, MeasureSpec } from "../../iso/measures/index";
import { MeasureStats } from "../../iso/protocol";`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️✅ Replace [[ -7 / +6 ]]");

      const fileContent = fs.readFileSync(testFile, "utf-8");
      expect(fileContent).toContain('import { Dispatch } from "../tea";');
      expect(fileContent).not.toContain('import * as immer from "immer";');
      expect(fileContent).not.toContain(
        'import { Update, View } from "../tea";',
      );
    });
  });

  it("replace on unloaded buffer", async () => {
    await withDriver({}, async (driver) => {
      // First, create a dummy buffer to avoid "cannot unload last buffer" error
      await driver.nvim.call("nvim_command", ["new"]);

      const cwd = await getcwd(driver.nvim);
      const testFile = path.join(cwd, "unloaded-buffer-replace.tsx");

      const originalContent = `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";

export const Component = () => {
  return <div>Hello</div>;
};`;

      fs.writeFileSync(testFile, originalContent, "utf-8");

      // Then open the file to create a buffer
      await driver.nvim.call("nvim_command", [`edit ${testFile}`]);

      // next, open the sidebar
      await driver.showSidebar();

      // First, the agent should read the file to know what content to replace
      await driver.inputMagentaText(
        "Read the file unloaded-buffer-replace.tsx and then update the imports",
      );
      await driver.send();

      const getFileRequest = await driver.mockAnthropic.awaitPendingRequest();
      getFileRequest.respond({
        stopReason: "tool_use",
        text: "I'll read the file first to see the current imports",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "get_file_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: testFile as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`${testFile}\``);

      // Now unload the buffer to test replace on unloaded buffer
      // Get the buffer number
      const bufNr = (await driver.nvim.call("nvim_eval", [
        `bufnr('unloaded-buffer-replace.tsx')`,
      ])) as import("../nvim/buffer").BufNr;

      // Verify buffer is loaded initially
      const isLoadedInitially = await driver.nvim.call("nvim_buf_is_loaded", [
        bufNr,
      ]);
      expect(isLoadedInitially).toBe(true);

      // Unload the buffer using nvim_exec_lua
      await driver.nvim.call("nvim_exec_lua", [
        `vim.api.nvim_buf_call(${bufNr}, function() vim.cmd('bunload') end)`,
        [],
      ]);

      // Verify buffer is unloaded
      const isLoaded = await driver.nvim.call("nvim_buf_is_loaded", [bufNr]);
      expect(isLoaded).toBe(false);

      // Ensure sidebar is still visible after file operations
      await driver.showSidebar();

      // Now the agent can make the replace request on the unloaded buffer
      const replaceRequest = await driver.mockAnthropic.awaitPendingRequest();
      replaceRequest.respond({
        stopReason: "tool_use",
        text: "Now I'll update the imports",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "replace_request" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: testFile as UnresolvedFilePath,
                find: `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";`,
                replace: `import React from "react";
import { Dispatch } from "../tea";`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️✅ Replace [[ -3 / +2 ]]");

      // Check that the tool result is properly returned
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 1];

      expect(toolResultMessage.role).toBe("user");
      expect(Array.isArray(toolResultMessage.content)).toBe(true);

      const toolResult = toolResultMessage.content.find(
        (item) => item.type === "tool_result",
      );

      expect(toolResult).toBeDefined();
      if (!toolResult || toolResult.type !== "tool_result") {
        throw new Error("Expected tool result");
      }

      // Verify the tool result indicates success
      const result = toolResult.result;
      expect(result.status).toBe("ok");

      if (result.status !== "ok") {
        throw new Error("Expected ok status");
      }

      // Check that the file contents are properly updated
      const fileContent = fs.readFileSync(testFile, "utf-8");
      expect(fileContent).toContain('import { Dispatch } from "../tea";');
      expect(fileContent).not.toContain('import * as immer from "immer";');
      expect(fileContent).not.toContain(
        'import { Update, View } from "../tea";',
      );

      // Verify the full content is updated, not empty
      expect(fileContent.trim()).not.toBe("");
      expect(fileContent).toContain("export const Component = () => {");
      expect(fileContent).toContain("return <div>Hello</div>;");

      // Respond to complete the conversation
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've successfully updated the imports.",
      });
    });
  });
});

it("shows live-updating line counts during streaming", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Create a test file with content to replace
    const cwd = await getcwd(driver.nvim);
    const testFile = path.join(cwd, "streaming-replace.js");
    const originalContent = `\
function oldFunction() {
  const line1 = "old";
  const line2 = "old";
  const line3 = "old";
  return false;
}`;
    fs.writeFileSync(testFile, originalContent);

    await driver.inputMagentaText("Replace the function content");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();

    // Create the actual tool input that would be used
    const toolInput = {
      filePath: "streaming-replace.js",
      find: `\
function oldFunction() {
  const line1 = "old";
  const line2 = "old";
  const line3 = "old";
  return false;
}`,
      replace: `\
function newFunction() {
  const line1 = "new";
  const line2 = "new";
  const line3 = "new";
  const line4 = "extra";
  return true;
}`,
    };

    // Stringify it to get the exact JSON that would be streamed
    const fullJson = JSON.stringify(toolInput);

    // Stream the tool use with gradual JSON building to test line count updates
    const toolIndex = 0;
    request.onStreamEvent({
      type: "content_block_start",
      index: toolIndex,
      content_block: {
        type: "tool_use",
        id: "streaming-replace-tool",
        name: "replace",
        input: {},
      },
    });

    // Stream in chunks to test live updating - each chunk is a delta, not accumulated content
    const chunk1 = fullJson.substring(0, 30); // Partial filePath
    const chunk2 = fullJson.substring(30, 80); // Complete filePath + start of find
    const chunk3 = fullJson.substring(80, 250); // More of find content, some of the replace

    request.onStreamEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk1,
      },
    });

    // At this point we only have partial filePath, should show preparing message
    await driver.assertDisplayBufferContains(
      "⏳ Preparing replace operation...",
    );

    request.onStreamEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk2,
      },
    });

    // Now we should have complete filePath and partial find/replace, can show line counts
    await driver.assertDisplayBufferContains("Replace [[ -2 / +1 ]]");

    request.onStreamEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk3,
      },
    });

    await driver.assertDisplayBufferContains("Replace [[ -6 / +3 ]]");
  });
});

it("replace requires approval for gitignored file", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const fsPromises = await import("fs/promises");
        const pathModule = await import("path");
        await fsPromises.writeFile(
          pathModule.join(tmpDir, ".gitignore"),
          "ignored-replace.txt\n",
        );
        await fsPromises.writeFile(
          pathModule.join(tmpDir, "ignored-replace.txt"),
          "old content",
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        "Replace content in file ignored-replace.txt",
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "id" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath: "ignored-replace.txt" as UnresolvedFilePath,
                find: "old content",
                replace: "new content",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        "✏️⏳ May I replace in file `ignored-replace.txt`?",
      );
    },
  );
});

it("replace requires approval for file outside cwd", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Replace content in file /tmp/outside.txt");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: "/tmp/outside.txt" as UnresolvedFilePath,
              find: "old content",
              replace: "new content",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I replace in file `/tmp/outside.txt`?",
    );
  });
});

it("replace requires approval for hidden file", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(path.join(cwd, ".hidden"), "old content", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Replace content in file .hidden");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: ".hidden" as UnresolvedFilePath,
              find: "old content",
              replace: "new content",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I replace in file `.hidden`?",
    );
  });
});

it("replace requires approval for skills directory file", async () => {
  await withDriver(
    {
      options: {
        skillsPaths: [".claude/skills"],
      },
      setupFiles: async (tmpDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create skills directory structure
        await fs.mkdir(path.join(tmpDir, ".claude/skills/my-skill"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(tmpDir, ".claude/skills/my-skill/skill.md"),
          "---\nname: my-skill\ndescription: A test skill\n---\n\n# Old content",
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Test that files in skills directory require confirmation for writes
      await driver.inputMagentaText(
        "Replace content in .claude/skills/my-skill/skill.md",
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "request_id" as ToolRequestId,
              toolName: "replace" as ToolName,
              input: {
                filePath:
                  ".claude/skills/my-skill/skill.md" as UnresolvedFilePath,
                find: "# Old content",
                replace: "# New content",
              },
            },
          },
        ],
      });

      // Should require approval even though it's a skills file
      await driver.assertDisplayBufferContains(
        "✏️⏳ May I replace in file `.claude/skills/my-skill/skill.md`?",
      );
    },
  );
});

it("replace auto-approves regular files in cwd", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    const testFile = path.join(cwd, "regular-file.txt");
    fs.writeFileSync(testFile, "old content", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Replace content in regular-file.txt");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: "regular-file.txt" as UnresolvedFilePath,
              find: "old content",
              replace: "new content",
            },
          },
        },
      ],
    });

    // Should be automatically approved, not show approval dialog
    await driver.assertDisplayBufferContains(
      "✏️✅ Replace [[ -1 / +1 ]] in `regular-file.txt`",
    );

    const fileContent = fs.readFileSync(testFile, "utf-8");
    expect(fileContent).toBe("new content");
  });
});

it("replace approval dialog allows user to approve", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(path.join(cwd, ".secret"), "old secret", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Replace content in .secret");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: ".secret" as UnresolvedFilePath,
              find: "old secret",
              replace: "new secret",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I replace in file `.secret`?",
    );

    // Verify the box formatting is displayed correctly
    await driver.assertDisplayBufferContains(`\
┌────────────────┐
│ [ NO ] [ YES ] │
└────────────────┘`);

    const yesPos = await driver.assertDisplayBufferContains("[ YES ]");
    await driver.triggerDisplayBufferKey(yesPos, "<CR>");

    await driver.assertDisplayBufferContains(
      "✏️✅ Replace [[ -1 / +1 ]] in `.secret`",
    );

    const fileContent = fs.readFileSync(path.join(cwd, ".secret"), "utf-8");
    expect(fileContent).toBe("new secret");
  });
});

it("replace approval dialog allows user to reject", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(path.join(cwd, ".secret"), "old secret", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Replace content in .secret");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: ".secret" as UnresolvedFilePath,
              find: "old secret",
              replace: "new secret",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I replace in file `.secret`?",
    );

    const noPos = await driver.assertDisplayBufferContains("[ NO ]");
    await driver.triggerDisplayBufferKey(noPos, "<CR>");

    await driver.assertDisplayBufferContains(
      "✏️❌ Replace [[ -1 / +1 ]] in `.secret`",
    );

    // Verify file was not modified
    const fileContent = fs.readFileSync(path.join(cwd, ".secret"), "utf-8");
    expect(fileContent).toBe("old secret");
  });
});
function vdomToString(node: VDOMNode): string {
  if (typeof node === "string") {
    return node;
  }

  if (node.type === "string") {
    return node.content;
  }

  if (node.type === "node" && Array.isArray(node.children)) {
    return node.children.map((child) => vdomToString(child)).join("");
  }

  return "";
}
