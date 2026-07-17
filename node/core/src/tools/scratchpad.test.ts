import { describe, expect, it } from "vitest";
import { emptyScratchpad, runScript, type Scratchpad } from "./scratchpad.ts";

function run(scratchpad: Scratchpad, script: string): string {
  const result = runScript(script, scratchpad);
  if (result.status === "error") {
    throw new Error(`unexpected error: ${result.error}`);
  }
  return result.value;
}

function keys(scratchpad: Scratchpad): string[] {
  return scratchpad.entries.map((e) => e.key);
}

describe("scratchpad runScript", () => {
  it("appends keys in order", () => {
    const s = emptyScratchpad();
    run(s, "append a valA\nappend b valB\nappend c valC");
    const out = run(s, "append d valD");
    expect(keys(s)).toEqual(["a", "b", "c", "d"]);
    expect(out).toBe("The scratchpad is now [a, b, c, d]");
  });

  it("deletes a single key and multiple keys, preserving order", () => {
    const s = emptyScratchpad();
    run(s, "append a 1\nappend b 2\nappend c 3\nappend d 4");
    run(s, "delete b");
    expect(keys(s)).toEqual(["a", "c", "d"]);
    run(s, "delete a d");
    expect(keys(s)).toEqual(["c"]);
  });

  it("deleting a missing key is a no-op", () => {
    const s = emptyScratchpad();
    run(s, "append a 1");
    run(s, "delete nope");
    expect(keys(s)).toEqual(["a"]);
  });

  it("get returns the stored value; other ops show only keys", () => {
    const s = emptyScratchpad();
    run(s, "append a hello\nappend b world");
    const out = run(s, "get a");
    expect(out).toBe("a = hello\nThe scratchpad is now [a, b]");
  });

  it("stores a multi-line heredoc value verbatim", () => {
    const s = emptyScratchpad();
    run(s, "append poem <<END\nline one\n  line two\nline three\nEND");
    const out = run(s, "get poem");
    expect(out).toBe(
      "poem = line one\n  line two\nline three\nThe scratchpad is now [poem]",
    );
  });

  it("leaves state unchanged on an invalid line (all-or-nothing)", () => {
    const s = emptyScratchpad();
    run(s, "append a 1");
    const result = runScript("append b 2\nbogus command\nappend c 3", s);
    expect(result.status).toBe("error");
    expect(keys(s)).toEqual(["a"]);
  });

  it("errors and aborts on duplicate-key append", () => {
    const s = emptyScratchpad();
    run(s, "append a 1");
    const result = runScript("append b 2\nappend a 3", s);
    expect(result.status).toBe("error");
    expect(keys(s)).toEqual(["a"]);
  });

  it("move_after places key immediately after the anchor", () => {
    const s = emptyScratchpad();
    run(s, "append a 1\nappend b 2\nappend c 3\nappend d 4");
    run(s, "move_after d a");
    expect(keys(s)).toEqual(["a", "d", "b", "c"]);
  });

  it("move_after with no anchor moves key to the front", () => {
    const s = emptyScratchpad();
    run(s, "append a 1\nappend b 2\nappend c 3");
    run(s, "move_after c");
    expect(keys(s)).toEqual(["c", "a", "b"]);
  });

  it("move_after with a missing key is an error", () => {
    const s = emptyScratchpad();
    run(s, "append a 1");
    expect(runScript("move_after nope", s).status).toBe("error");
    expect(keys(s)).toEqual(["a"]);
  });

  it("move_after with a missing anchor is an error", () => {
    const s = emptyScratchpad();
    run(s, "append a 1\nappend b 2");
    expect(runScript("move_after a nope", s).status).toBe("error");
    expect(keys(s)).toEqual(["a", "b"]);
  });

  it("move_after with key == anchor is an error", () => {
    const s = emptyScratchpad();
    run(s, "append a 1");
    expect(runScript("move_after a a", s).status).toBe("error");
  });

  it("clear empties the scratchpad", () => {
    const s = emptyScratchpad();
    run(s, "append a 1\nappend b 2");
    const out = run(s, "clear");
    expect(keys(s)).toEqual([]);
    expect(out).toBe("The scratchpad is now []");
  });

  it("persists across separate script invocations on the same object", () => {
    const s = emptyScratchpad();
    run(s, "append a 1");
    run(s, "append b 2");
    expect(keys(s)).toEqual(["a", "b"]);
  });
});
