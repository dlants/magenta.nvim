import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeSkill, getSkillDocs } from "./executable.ts";

let tempDir: string;
let echoScript: string;
let failScript: string;
let docsScript: string;
let rawOutputScript: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "skill-test-"));

  echoScript = join(tempDir, "echo-skill.sh");
  writeFileSync(
    echoScript,
    `#!/bin/bash
echo '{"status":"ok","value":"got: '$1'"}'
`,
  );
  chmodSync(echoScript, 0o755);

  failScript = join(tempDir, "fail-skill.sh");
  writeFileSync(
    failScript,
    `#!/bin/bash
echo '{"status":"error","error":"something broke"}' >&2
exit 1
`,
  );
  chmodSync(failScript, 0o755);

  docsScript = join(tempDir, "docs-skill.sh");
  writeFileSync(
    docsScript,
    `#!/bin/bash
echo "Usage: my-skill <params>"
echo "Params: { foo: string }"
`,
  );
  chmodSync(docsScript, 0o755);

  rawOutputScript = join(tempDir, "raw-output.sh");
  writeFileSync(
    rawOutputScript,
    `#!/bin/bash
echo "just plain text"
`,
  );
  chmodSync(rawOutputScript, 0o755);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("executeSkill", () => {
  it("executes a skill and returns parsed JSON result", async () => {
    const result = await executeSkill([echoScript], { foo: "bar" });
    expect(result.status).toBe("ok");
    expect(result.value).toContain("got:");
  });

  it("returns error for non-zero exit code", async () => {
    const result = await executeSkill([failScript], { foo: "bar" });
    expect(result.status).toBe("error");
    expect(result.error).toContain("exited with code 1");
  });

  it("returns raw stdout as value when output is not JSON", async () => {
    const result = await executeSkill([rawOutputScript], {});
    expect(result.status).toBe("ok");
    expect(result.value).toBe("just plain text");
  });

  it("returns error for non-existent command", async () => {
    const result = await executeSkill(["/nonexistent/path"], {});
    expect(result.status).toBe("error");
    expect(result.error).toContain("Failed to spawn");
  });
});

describe("getSkillDocs", () => {
  it("returns stdout from the command called with no args", async () => {
    const docs = await getSkillDocs([docsScript]);
    expect(docs).toContain("Usage: my-skill");
    expect(docs).toContain("Params: { foo: string }");
  });
});
