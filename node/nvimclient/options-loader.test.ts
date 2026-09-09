import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { getcwd } from "./nvim/nvim.ts";
import { withDriver } from "./test/preamble.ts";

it("dynamically picks up sandbox config changes from project options.json", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const cwd = await getcwd(driver.nvim);

    // Write a project options.json that changes sandbox config
    const magentaDir = path.join(cwd, ".magenta");
    fs.mkdirSync(magentaDir, { recursive: true });
    fs.writeFileSync(
      path.join(magentaDir, "options.json"),
      JSON.stringify({
        sandbox: {
          filesystem: {
            denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", ".secret"],
          },
        },
      }),
    );

    // Send a message to trigger options reload
    await driver.inputMagentaText("hello");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    request1.respond({
      stopReason: "end_turn",
      text: "hi",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("hi");

    // Verify the sandbox config was updated from project options.json
    // Project denyRead is appended to the base defaults
    expect(driver.magenta.options.sandbox.filesystem.denyRead).toContain(
      ".secret",
    );
  });
});
