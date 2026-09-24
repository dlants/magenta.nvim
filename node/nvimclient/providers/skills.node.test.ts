import * as fs from "node:fs";
import {
  FsFileIO,
  type Logger,
  loadSkills,
  type ProviderOptions,
} from "@magenta/server";
import { expect, it } from "vitest";
import { BUILTIN_SKILLS_PATH } from "../options.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

it("discovers the built-in authoring-magenta-scripts skill and it documents the harness", async () => {
  const skills = await loadSkills({
    cwd: "/nonexistent" as NvimCwd,
    homeDir: "/nonexistent" as HomeDir,
    logger,
    fileIO: new FsFileIO(),
    options: {
      skillsPaths: [BUILTIN_SKILLS_PATH, ".claude/skills"],
    } as ProviderOptions,
  });

  expect(Object.keys(skills)).toContain("authoring-magenta-scripts");
  const body = await fs.promises.readFile(
    skills["authoring-magenta-scripts"].skillFile,
    "utf-8",
  );
  expect(body).toContain("registerScript");
  expect(body).toContain("./magenta-sdk/testing.ts");
  expect(body).toContain("runScript");
});
