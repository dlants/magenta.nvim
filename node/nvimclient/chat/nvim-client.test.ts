import path from "node:path";
import type { AbsFilePath } from "@magenta/server";
import { expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";
import { threadCwdFromNvimCwd } from "../utils/files.ts";
import { createNvimClient } from "./nvim-client.ts";

it("serves lua and lsp requests through the attached client", async () => {
  await withDriver({}, async (driver) => {
    const { nvim, lsp, cwd, homeDir } = driver.magenta;
    const client = await createNvimClient({ nvim, lsp, cwd, homeDir });

    await expect(
      client.request({ type: "lua", code: "return { a = 1 }" }),
    ).resolves.toEqual({ a: 1 });
    await expect(
      client.request({ type: "lua", code: "return nil" }),
    ).resolves.toBeUndefined();

    await driver.editFileAndWaitForLsp("test.ts");
    const hover = await client.request({
      type: "lsp",
      kind: "hover",
      projectDir: threadCwdFromNvimCwd(cwd),
      homeDir,
      filePath: path.join(cwd, "test.ts") as AbsFilePath,
      position: { line: 3, character: 4 },
    });
    expect(hover).toMatchObject([
      {
        context: {
          method: "textDocument/hover",
          params: { position: { line: 3, character: 4 } },
        },
      },
    ]);
  });
});
