import { describe, expect, test } from "vitest";
import {
  assertStraceAvailable,
  buildStraceCommand,
  parseStraceViolations,
  StraceUnavailableError,
} from "./strace.ts";

describe("buildStraceCommand", () => {
  test("nests the user command in bash -c under strace with a trace file", () => {
    const cmd = buildStraceCommand("cat /secret.txt", "/tmp/magenta/t.strace");
    expect(cmd).toContain("strace");
    expect(cmd).toContain("-f");
    expect(cmd).toContain("-o '/tmp/magenta/t.strace'");
    expect(cmd).toContain("bash -c 'cat /secret.txt'");
  });

  test("escapes single quotes in the user command", () => {
    const cmd = buildStraceCommand("echo 'hi'", "/tmp/t");
    expect(cmd).toContain(`bash -c 'echo '\\''hi'\\'''`);
  });
});

describe("parseStraceViolations", () => {
  test("captures only EPERM/EACCES syscalls with the right path/target", () => {
    const trace = [
      `execve("/bin/cat", ["cat", "/secret"], 0x7ff) = 0`,
      `openat(AT_FDCWD, "/secret.txt", O_RDONLY) = -1 EACCES (Permission denied)`,
      `openat(AT_FDCWD, "/ok.txt", O_RDONLY) = 3`,
      `[pid 4321] connect(5, {sa_family=AF_INET}, 16) = -1 EPERM (Operation not permitted)`,
      `openat(AT_FDCWD, "/missing", O_RDONLY) = -1 ENOENT (No such file or directory)`,
    ].join("\n");

    const events = parseStraceViolations(trace, "mycmd");
    const lines = events.map((e) => e.line);
    expect(lines).toEqual([
      `openat("/secret.txt") -> EACCES`,
      `connect() -> EPERM`,
    ]);
    expect(events.every((e) => e.command === "mycmd")).toBe(true);
  });

  test("de-duplicates repeated denied syscalls", () => {
    const trace = [
      `openat(AT_FDCWD, "/secret", O_RDONLY) = -1 EACCES (Permission denied)`,
      `openat(AT_FDCWD, "/secret", O_RDONLY) = -1 EACCES (Permission denied)`,
    ].join("\n");
    const events = parseStraceViolations(trace, "c");
    expect(events).toHaveLength(1);
  });

  test("returns nothing for an empty or success-only trace", () => {
    expect(parseStraceViolations("", "c")).toEqual([]);
    expect(
      parseStraceViolations(`openat(AT_FDCWD, "/ok", O_RDONLY) = 3`, "c"),
    ).toEqual([]);
  });
});

describe("assertStraceAvailable", () => {
  test("is a no-op on non-linux platforms", () => {
    expect(() =>
      assertStraceAvailable("darwin", () => ({ ok: false, error: "nope" })),
    ).not.toThrow();
  });

  test("throws StraceUnavailableError on linux when the probe fails", () => {
    expect(() =>
      assertStraceAvailable("linux", () => ({
        ok: false,
        error: "not found",
      })),
    ).toThrow(StraceUnavailableError);
  });

  test("does not throw on linux when the probe succeeds", () => {
    expect(() =>
      assertStraceAvailable("linux", () => ({ ok: true })),
    ).not.toThrow();
  });
});
