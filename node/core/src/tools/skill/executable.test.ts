import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeSkill } from "./executable.ts";

let tempDir: string;
let echoScript: string;
let failScript: string;
let rawOutputScript: string;
let stderrScript: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "skill-test-"));

  echoScript = join(tempDir, "echo-skill.sh");
  writeFileSync(
    echoScript,
    `#!/bin/bash
echo "got: $1"
`,
  );
  chmodSync(echoScript, 0o755);

  failScript = join(tempDir, "fail-skill.sh");
  writeFileSync(
    failScript,
    `#!/bin/bash
echo "partial output"
echo "something broke" >&2
exit 1
`,
  );
  chmodSync(failScript, 0o755);

  rawOutputScript = join(tempDir, "raw-output.sh");
  writeFileSync(
    rawOutputScript,
    `#!/bin/bash
echo "just plain text"
`,
  );
  chmodSync(rawOutputScript, 0o755);

  stderrScript = join(tempDir, "stderr-skill.sh");
  writeFileSync(
    stderrScript,
    `#!/bin/bash
echo "line1"
echo "err1" >&2
echo "line2"
`,
  );
  chmodSync(stderrScript, 0o755);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("executeSkill", () => {
  it("executes a skill and returns output including the input params", async () => {
    const result = await executeSkill([echoScript], { foo: "bar" });
    expect(result.status).toBe("ok");
    expect(result.output).toContain('got: {"foo":"bar"}');
  });

  it("returns error with output for non-zero exit code", async () => {
    const result = await executeSkill([failScript], { foo: "bar" });
    expect(result.status).toBe("error");
    expect(result.output).toContain("partial output");
    expect(result.output).toContain("something broke");
    if (result.status === "error") {
      expect(result.error).toContain("exited with code 1");
    }
  });

  it("returns raw stdout as output", async () => {
    const result = await executeSkill([rawOutputScript], {});
    expect(result.status).toBe("ok");
    expect(result.output).toContain("just plain text");
  });

  it("returns error for non-existent command", async () => {
    const result = await executeSkill(["/nonexistent/path"], {});
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("Failed to spawn");
    }
  });

  it("interleaves stdout and stderr in arrival order", async () => {
    const result = await executeSkill([stderrScript], {});
    expect(result.status).toBe("ok");
    expect(result.output).toContain("stdout:");
    expect(result.output).toContain("stderr:");
    expect(result.output).toContain("line1");
    expect(result.output).toContain("err1");
    expect(result.output).toContain("line2");
  });

  it("calls onOutput callback for each line", async () => {
    const lines: { stream: string; text: string }[] = [];
    await executeSkill(
      [stderrScript],
      {},
      {
        onOutput: (line) => lines.push(line),
      },
    );
    const stdoutLines = lines.filter((l) => l.stream === "stdout");
    const stderrLines = lines.filter((l) => l.stream === "stderr");
    expect(stdoutLines.length).toBeGreaterThan(0);
    expect(stderrLines.length).toBeGreaterThan(0);
  });
});
