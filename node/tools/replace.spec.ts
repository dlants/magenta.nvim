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
      await driver.showSidebar();

      const cwd = await getcwd(driver.nvim);
      const testFile = path.join(cwd, "unloaded-buffer-replace.tsx");

      const originalContent = `import React from "react";
import * as immer from "immer";
import { Update, View } from "../tea";

export const Component = () => {
  return <div>Hello</div>;
};`;

      fs.writeFileSync(testFile, originalContent, "utf-8");

      // First, open the file to create a buffer
      await driver.nvim.call("nvim_command", [`edit ${testFile}`]);

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

      // Now try to replace in the file via replace tool
      await driver.inputMagentaText(
        "Update imports in unloaded-buffer-replace.tsx",
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
import { Update, View } from "../tea";`,
                replace: `import React from "react";
import { Dispatch } from "../tea";`,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️✅ Replace [[ -3 / +2 ]]");

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
    });
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
