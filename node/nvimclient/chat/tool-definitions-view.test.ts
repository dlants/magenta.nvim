import { describe, it } from "vitest";
import { withDriver } from "../test/preamble.ts";

describe("tool definitions view", () => {
  it("toggles the collapsible tool definitions section", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      const collapsed = await driver.assertDisplayBufferContains(
        "🔧 [Tool Definitions",
      );
      await driver.triggerDisplayBufferKey(collapsed, "=");

      // expanding the section lists tool names, but not full definitions
      const toolRow = await driver.assertDisplayBufferContains("# get_file");
      await driver.assertDisplayBufferDoesNotContain("## get_file");

      // expanding an individual tool shows its full definition
      await driver.triggerDisplayBufferKey(toolRow, "=");
      await driver.assertDisplayBufferContains("## get_file");

      // collapsing the individual tool hides the full definition
      const toolRow2 = await driver.assertDisplayBufferContains("# get_file");
      await driver.triggerDisplayBufferKey(toolRow2, "=");
      await driver.assertDisplayBufferDoesNotContain("## get_file");

      // collapsing the section hides tool names
      const expanded = await driver.assertDisplayBufferContains(
        "🔧 [Tool Definitions",
      );
      await driver.triggerDisplayBufferKey(expanded, "=");

      await driver.assertDisplayBufferDoesNotContain("# get_file");
    });
  });
});
