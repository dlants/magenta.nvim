import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { HomeDir, ProjectDir } from "../utils/files.ts";
import { OptionsStore } from "./options-store.ts";

const logger = {
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

let root: string;
let projectDir: ProjectDir;
let home: HomeDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "magenta-options-"));
  projectDir = path.join(root, "project") as ProjectDir;
  home = path.join(root, "home") as HomeDir;
  fs.mkdirSync(path.join(projectDir, ".magenta"), { recursive: true });
  fs.mkdirSync(path.join(home, ".magenta"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(dir: string, value: unknown, mtimeSeconds?: number) {
  const file = path.join(dir, ".magenta", "options.json");
  fs.writeFileSync(file, JSON.stringify(value));
  if (mtimeSeconds !== undefined) {
    fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
  }
}

it("is fully configured by ~/.magenta/options.json alone", () => {
  write(home, {
    profiles: [{ name: "only", provider: "mock" }],
    sandbox: { filesystem: { denyRead: [".private"] } },
    autoContext: [],
  });
  const options = new OptionsStore(home, logger).getOptions(projectDir);
  expect(options.profiles.map((p) => p.name)).toEqual(["only"]);
  expect(options.activeProfile).toBe("only");
  expect(options.sandbox.filesystem.denyRead).toContain(".private");
  expect(options.sandbox.filesystem.denyRead).toContain("~/.ssh");
  expect(options.autoContext).toEqual([]);
});

it("uses built-in defaults when no options files exist", () => {
  fs.rmSync(path.join(home, ".magenta"), { recursive: true });
  const options = new OptionsStore(home, logger).getOptions(projectDir);
  expect(options.profiles.length).toBeGreaterThan(0);
});

it("picks up edits to the project options.json on the next call", () => {
  const store = new OptionsStore(home, logger);
  expect(
    store.getOptions(projectDir).sandbox.filesystem.denyRead,
  ).not.toContain(".secret");
  write(
    projectDir,
    { sandbox: { filesystem: { denyRead: [".secret"] } } },
    1000,
  );
  expect(store.getOptions(projectDir).sandbox.filesystem.denyRead).toContain(
    ".secret",
  );
  write(
    projectDir,
    { sandbox: { filesystem: { denyRead: [".other"] } } },
    2000,
  );
  const denyRead = store.getOptions(projectDir).sandbox.filesystem.denyRead;
  expect(denyRead).toContain(".other");
  expect(denyRead).not.toContain(".secret");
});
it("picks up edits and deletion of the user options.json", () => {
  const store = new OptionsStore(home, logger);
  write(
    home,
    { profiles: [{ name: "u1", provider: "anthropic", model: "m" }] },
    1000,
  );
  expect(store.getOptions(projectDir).profiles.map((p) => p.name)).toEqual([
    "u1",
  ]);
  write(
    home,
    { profiles: [{ name: "u2", provider: "anthropic", model: "m" }] },
    2000,
  );
  expect(store.getOptions(projectDir).profiles.map((p) => p.name)).toEqual([
    "u2",
  ]);
  fs.rmSync(path.join(home, ".magenta", "options.json"));
  expect(
    store.getOptions(projectDir).profiles.map((p) => p.name),
  ).not.toContain("u2");
});
it("falls back when a cached project options.json is deleted", () => {
  const store = new OptionsStore(home, logger);
  write(
    projectDir,
    { sandbox: { filesystem: { denyRead: [".secret"] } } },
    1000,
  );
  expect(store.getOptions(projectDir).sandbox.filesystem.denyRead).toContain(
    ".secret",
  );
  fs.rmSync(path.join(projectDir, ".magenta", "options.json"));
  expect(
    store.getOptions(projectDir).sandbox.filesystem.denyRead,
  ).not.toContain(".secret");
});
it("keeps separate cache entries per projectDir, each merged with the user file", () => {
  const other = path.join(root, "other") as ProjectDir;
  fs.mkdirSync(path.join(other, ".magenta"), { recursive: true });
  write(
    home,
    { profiles: [{ name: "u", provider: "anthropic", model: "m" }] },
    1000,
  );
  write(projectDir, { sandbox: { filesystem: { denyRead: [".a"] } } }, 1000);
  write(other, { sandbox: { filesystem: { denyRead: [".b"] } } }, 1000);
  const store = new OptionsStore(home, logger);
  const a = store.getOptions(projectDir);
  const b = store.getOptions(other);
  expect(a.sandbox.filesystem.denyRead).toContain(".a");
  expect(a.sandbox.filesystem.denyRead).not.toContain(".b");
  expect(b.sandbox.filesystem.denyRead).toContain(".b");
  expect(a.profiles.map((p) => p.name)).toEqual(["u"]);
  expect(b.profiles.map((p) => p.name)).toEqual(["u"]);
});
it("warns with the Settings prefix on malformed files and returns usable options", () => {
  const warnings: string[] = [];
  const log = {
    ...logger,
    warn: (m: string) => warnings.push(m),
    error: (m: string) => warnings.push(m),
  };
  fs.writeFileSync(path.join(home, ".magenta", "options.json"), "{ not json");
  fs.writeFileSync(
    path.join(projectDir, ".magenta", "options.json"),
    JSON.stringify({ profiles: "bad" }),
  );
  const options = new OptionsStore(home, log).getOptions(projectDir);
  expect(options.profiles.length).toBeGreaterThan(0);
  expect(warnings.length).toBeGreaterThan(0);
  expect(warnings.every((w) => w.startsWith("Settings: "))).toBe(true);
});
