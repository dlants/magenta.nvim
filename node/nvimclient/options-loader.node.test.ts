import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parseOptions } from "./options.ts";
import { DynamicOptionsLoader } from "./options-loader.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";

const logger = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

it("dynamically picks up sandbox config changes from project options.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "magenta-options-"));
  try {
    const cwd = path.join(root, "project") as NvimCwd;
    const home = path.join(root, "home") as HomeDir;
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const loader = new DynamicOptionsLoader(
      parseOptions(
        { profiles: [{ name: "mock", provider: "mock", model: "mock" }] },
        logger,
      ),
      cwd,
      home,
      logger,
    );
    expect(loader.getOptions().sandbox.filesystem.denyRead).not.toContain(
      ".secret",
    );

    fs.mkdirSync(path.join(cwd, ".magenta"));
    fs.writeFileSync(
      path.join(cwd, ".magenta", "options.json"),
      JSON.stringify({
        sandbox: { filesystem: { denyRead: [".secret"] } },
      }),
    );

    // Project denyRead is appended to the base defaults.
    const denyRead = loader.getOptions().sandbox.filesystem.denyRead;
    expect(denyRead).toContain(".secret");
    expect(denyRead).toContain("~/.ssh");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
