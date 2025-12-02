import { describe, expect, it } from "vitest";
import * as Insert from "./insert";
import { type VDOMNode } from "../tea/view";
import { withDriver } from "../test/preamble";
import fs from "node:fs";
import { getcwd } from "../nvim/nvim";
import path from "node:path";
import type { ToolRequestId } from "./toolManager";
import type { ToolName } from "./types";
import type { UnresolvedFilePath } from "../utils/files";

describe("node/tools/insert.spec.ts", () => {
  it("validate input", () => {
    const validInput = {
      filePath: "test.txt",
      insertAfter: "existing text",
      content: "new content",
    };

    const result = Insert.validateInput(validInput);
    expect(result.status).toEqual("ok");
    if (result.status === "ok") {
      expect(result.value.filePath).toEqual("test.txt");
      expect(result.value.insertAfter).toEqual("existing text");
      expect(result.value.content).toEqual("new content");
    }

    // Test with missing filePath
    const invalidInput1 = {
      insertAfter: "existing text",
      content: "new content",
    };
    const result1 = Insert.validateInput(invalidInput1);
    expect(result1.status).toEqual("error");

    // Test with wrong type
    const invalidInput2 = {
      filePath: 123,
      insertAfter: "existing text",
      content: "new content",
    };
    const result2 = Insert.validateInput(invalidInput2);
    expect(result2.status).toEqual("error");
  });

  it("renderStreamedBlock - with filePath", () => {
    // Define the content as a normal multiline string
    const code = `\
const newCode = true;
function test() {
  return true;
}`;

    // Create the request object
    const request = {
      filePath: "example.js",
      insertAfter: "// comment",
      content: code,
    };

    // Convert to JSON and simulate a partial stream
    const streamed = JSON.stringify(request);

    const result = Insert.renderStreamedBlock(
      streamed.slice(0, streamed.length - 4),
    );
    const resultStr = vdomToString(result);
    expect(resultStr).toContain("Insert [[ +3 ]]"); // 3 lines in the content
    expect(resultStr).toContain("example.js");
    expect(resultStr).toContain("streaming...");
  });

  it("renderStreamedBlock - without filePath", () => {
    // Create a request without filePath
    const request = {
      insertAfter: "// comment",
      content: "const newCode = true;",
    };

    // Convert to JSON
    const streamed = JSON.stringify(request);

    const result = Insert.renderStreamedBlock(streamed);
    const resultStr = vdomToString(result);
    expect(resultStr).toContain("⏳ Insert...");
  });

  it("renderStreamedBlock - with escaped content", () => {
    const code = `\
const json = { "key": "value" };
const newLine = "first line"";
let secondLine;`;

    // Create the request object
    const request = {
      filePath: "test.js",
      insertAfter: "// comment",
      content: code,
    };

    // Convert to JSON
    const streamed = JSON.stringify(request);

    const result = Insert.renderStreamedBlock(streamed);
    const resultStr = vdomToString(result);
    // Should correctly count the 2 actual newlines, not the escaped \n in the string
    expect(resultStr).toContain("Insert [[ +3 ]]");
    expect(resultStr).toContain("test.js");
  });
});

it("shows live-updating line counts during streaming", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Create a test file to insert content into
    const cwd = await getcwd(driver.nvim);
    const testFile = path.join(cwd, "streaming-insert.js");
    const originalContent = `\
function existingFunction() {
  // Insert new code after this line
  return true;
}`;
    fs.writeFileSync(testFile, originalContent);

    await driver.inputMagentaText("Add new code to the function");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();

    // Create the actual tool input that would be used
    const toolInput = {
      filePath: "streaming-insert.js",
      insertAfter: `\
  // Insert new code after this line`,
      content: `\
  const newVar1 = 'hello';
  const newVar2 = 'world';
  const newVar3 = 'test';
  console.log(newVar1, newVar2, newVar3);
  console.log('Done!');`,
    };

    // Stringify it to get the exact JSON that would be streamed
    const fullJson = JSON.stringify(toolInput);

    // Stream the tool use with gradual JSON building
    const toolIndex = 0;
    request.onStreamEvent({
      type: "content_block_start",
      index: toolIndex,
      content_block: {
        type: "tool_use",
        id: "streaming-insert-tool",
        name: "insert",
        input: {},
      },
    });

    // Stream in chunks to test live updating - each chunk is a delta, not accumulated content
    const chunk1 = fullJson.substring(0, 30); // Partial filePath
    const chunk2 = fullJson.substring(30, 120); // Complete filePath + insertAfter
    const chunk3 = fullJson.substring(120); // Rest of content

    request.onStreamEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk1,
      },
    });

    // At this point we only have partial filePath, should show preparing message
    await driver.assertDisplayBufferContains("⏳ Insert...");

    request.onStreamEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk2,
      },
    });

    // Now we should have complete filePath and insertAfter, can show line counts
    await driver.assertDisplayBufferContains("Insert [[ +1 ]]");

    request.onStreamEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: chunk3,
      },
    });

    await driver.assertDisplayBufferContains("Insert [[ +5 ]]");
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

it("insert requires approval for gitignored file", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const fsPromises = await import("fs/promises");
        const pathModule = await import("path");
        await fsPromises.writeFile(
          pathModule.join(tmpDir, ".gitignore"),
          "ignored-insert.txt\n",
        );
        await fsPromises.writeFile(
          pathModule.join(tmpDir, "ignored-insert.txt"),
          "existing content",
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(
        "Insert content in file ignored-insert.txt",
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
              toolName: "insert" as ToolName,
              input: {
                filePath: "ignored-insert.txt" as UnresolvedFilePath,
                insertAfter: "existing content",
                content: "\nnew content",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        "✏️⏳ May I insert in file `ignored-insert.txt`?",
      );
    },
  );
});

it("insert requires approval for file outside cwd", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Insert content in file /tmp/outside.txt");
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
            toolName: "insert" as ToolName,
            input: {
              filePath: "/tmp/outside.txt" as UnresolvedFilePath,
              insertAfter: "",
              content: "new content",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I insert in file `/tmp/outside.txt`?",
    );
  });
});

it("insert requires approval for hidden file", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(
      path.join(cwd, ".hidden-insert"),
      "existing content",
      "utf-8",
    );

    await driver.showSidebar();
    await driver.inputMagentaText("Insert content in file .hidden-insert");
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
            toolName: "insert" as ToolName,
            input: {
              filePath: ".hidden-insert" as UnresolvedFilePath,
              insertAfter: "existing content",
              content: "\nnew content",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I insert in file `.hidden-insert`?",
    );
  });
});

it("insert requires approval for skills directory file", async () => {
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
          "---\nname: my-skill\ndescription: A test skill\n---\n\n# Content",
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Test that files in skills directory require confirmation for writes
      await driver.inputMagentaText(
        "Insert content in .claude/skills/my-skill/skill.md",
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
              toolName: "insert" as ToolName,
              input: {
                filePath:
                  ".claude/skills/my-skill/skill.md" as UnresolvedFilePath,
                insertAfter: "# Content",
                content: "\nNew content",
              },
            },
          },
        ],
      });

      // Should require approval even though it's a skills file
      await driver.assertDisplayBufferContains(
        "✏️⏳ May I insert in file `.claude/skills/my-skill/skill.md`?",
      );
    },
  );
});

it("insert auto-approves regular files in cwd", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    const testFile = path.join(cwd, "regular-insert-file.txt");
    fs.writeFileSync(testFile, "existing content", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Insert content in regular-insert-file.txt");
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
            toolName: "insert" as ToolName,
            input: {
              filePath: "regular-insert-file.txt" as UnresolvedFilePath,
              insertAfter: "existing content",
              content: "\nnew content",
            },
          },
        },
      ],
    });

    // Should be automatically approved, not show approval dialog
    await driver.assertDisplayBufferContains(
      "✏️✅ Insert [[ +2 ]] in `regular-insert-file.txt`",
    );

    const fileContent = fs.readFileSync(testFile, "utf-8");
    expect(fileContent).toBe("existing content\nnew content");
  });
});

it("insert approval dialog allows user to approve", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(path.join(cwd, ".secret-insert"), "old secret", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Insert content in .secret-insert");
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
            toolName: "insert" as ToolName,
            input: {
              filePath: ".secret-insert" as UnresolvedFilePath,
              insertAfter: "old secret",
              content: "\nnew secret",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I insert in file `.secret-insert`?",
    );

    // Verify the box formatting is displayed correctly
    await driver.assertDisplayBufferContains(`\
┌────────────────┐
│ [ NO ] [ YES ] │
└────────────────┘`);

    const yesPos = await driver.assertDisplayBufferContains("[ YES ]");
    await driver.triggerDisplayBufferKey(yesPos, "<CR>");

    await driver.assertDisplayBufferContains(
      "✏️✅ Insert [[ +2 ]] in `.secret-insert`",
    );

    const fileContent = fs.readFileSync(
      path.join(cwd, ".secret-insert"),
      "utf-8",
    );
    expect(fileContent).toBe("old secret\nnew secret");
  });
});

it("insert approval dialog allows user to reject", async () => {
  await withDriver({}, async (driver) => {
    const cwd = await getcwd(driver.nvim);
    fs.writeFileSync(path.join(cwd, ".secret-insert2"), "old secret", "utf-8");

    await driver.showSidebar();
    await driver.inputMagentaText("Insert content in .secret-insert2");
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
            toolName: "insert" as ToolName,
            input: {
              filePath: ".secret-insert2" as UnresolvedFilePath,
              insertAfter: "old secret",
              content: "\nnew secret",
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      "✏️⏳ May I insert in file `.secret-insert2`?",
    );

    const noPos = await driver.assertDisplayBufferContains("[ NO ]");
    await driver.triggerDisplayBufferKey(noPos, "<CR>");

    await driver.assertDisplayBufferContains(
      "✏️❌ Insert [[ +2 ]] in `.secret-insert2`",
    );

    // Verify file was not modified
    const fileContent = fs.readFileSync(
      path.join(cwd, ".secret-insert2"),
      "utf-8",
    );
    expect(fileContent).toBe("old secret");
  });
});
