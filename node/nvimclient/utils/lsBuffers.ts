interface BufferFlags {
  hidden: boolean; // 'h' flag
  active: boolean; // 'a' flag
  current: boolean; // '%' flag
  alternate: boolean; // '#' flag
  modified: boolean; // '+' flag
  readonly: boolean; // '-' flag
  terminal: boolean; // 'terminal' flag
}

interface BufferEntry {
  id: number; // Buffer number
  flags: BufferFlags; // Parsed status flags
  filePath: string; // File path
  lineNumber: number; // Current line number
}

function parseFlags(flagStr: string): BufferFlags {
  return {
    hidden: flagStr.includes("h"),
    active: flagStr.includes("a"),
    current: flagStr.includes("%"),
    alternate: flagStr.includes("#"),
    modified: flagStr.includes("+"),
    readonly: flagStr.includes("-"),
    terminal: flagStr.includes("t"),
  };
}

/**
 * Parses the output of Neovim's :buffers command into structured data
 *lsResponse.output is like:  "  1  h   \"poem.txt\"   line 1\n  2  a   \"poem2.txt\"  line 1"
 * see docfiles for :buffers to understand output format
 */
export function parseLsResponse(response: string): BufferEntry[] {
  // Split the response into lines and filter out empty lines
  const lines = response.split("\n").filter((line) => line.trim());

  return lines.map((line) => {
    // Remove extra whitespace and split by multiple spaces
    const parts = line.trim().split(/\s+/);

    // Extract filepath by finding the quoted string
    const filepathStart = line.indexOf('"');
    const filepathEnd = line.lastIndexOf('"');
    const filePath = line.slice(filepathStart + 1, filepathEnd);

    return {
      id: parseInt(parts[0], 10),
      flags: parseFlags(parts[1]),
      filePath,
      lineNumber: parseInt(parts[parts.length - 1], 10),
    };
  });
}
