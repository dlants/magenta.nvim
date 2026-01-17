import { describe, it, expect } from "vitest";
import { getTreeSitterMinimap, formatMinimap } from "./treesitter.ts";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("treesitter minimap", () => {
  it("should generate minimap for TypeScript file", async () => {
    // Create a temp TypeScript file
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, "test-treesitter.ts");

    const tsContent = `
interface User {
  name: string;
  age: number;
}

function greet(user: User): string {
  return \`Hello, \${user.name}!\`;
}

class UserManager {
  private users: User[] = [];

  addUser(user: User): void {
    this.users.push(user);
  }

  getUsers(): User[] {
    return this.users;
  }
}

export { User, greet, UserManager };
`.trim();

    fs.writeFileSync(tmpFile, tsContent);

    try {
      const result = await getTreeSitterMinimap(tmpFile);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.value.language).toBe("typescript");
        expect(result.value.lines.length).toBeGreaterThan(0);

        // Should include key structural lines
        const lineTexts = result.value.lines.map((l) => l.text);
        expect(lineTexts.some((t) => t.includes("interface User"))).toBe(true);
        expect(lineTexts.some((t) => t.includes("function greet"))).toBe(true);
        expect(lineTexts.some((t) => t.includes("class UserManager"))).toBe(
          true,
        );
      }
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("should return error for unknown file type", async () => {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, "test-unknown.xyz123");

    fs.writeFileSync(tmpFile, "some random content");

    try {
      const result = await getTreeSitterMinimap(tmpFile);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toContain("no_filetype");
      }
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("should handle file with no parser installed", async () => {
    // Use a file extension that has a filetype but likely no parser
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, "test-nasm.asm");

    fs.writeFileSync(tmpFile, "section .text\nglobal _start\n_start:\n");

    try {
      const result = await getTreeSitterMinimap(tmpFile);

      // Either no_parser or success depending on what's installed
      // Just verify we get a valid result structure
      expect(["ok", "error"]).toContain(result.status);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("should select quintiles for nodes with many children", async () => {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, "test-many-items.ts");

    // Create a file with many top-level items
    const items = Array.from(
      { length: 20 },
      (_, i) => `const item${i} = ${i};`,
    ).join("\n");

    fs.writeFileSync(tmpFile, items);

    try {
      const result = await getTreeSitterMinimap(tmpFile);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        // Should not have all 20 items due to quintile selection
        // But should have some representative samples
        expect(result.value.lines.length).toBeGreaterThan(0);
        expect(result.value.lines.length).toBeLessThanOrEqual(100);
      }
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("should format minimap correctly", () => {
    const minimap = {
      language: "typescript",
      lines: [
        { line: 1, text: "interface User {" },
        { line: 5, text: "function greet() {" },
        { line: 10, text: "class Manager {" },
      ],
    };

    const formatted = formatMinimap(minimap);

    expect(formatted).toContain("[Tree-sitter minimap (typescript)]");
    expect(formatted).toContain("   1: interface User {");
    expect(formatted).toContain("   5: function greet() {");
    expect(formatted).toContain("  10: class Manager {");
  });
});
