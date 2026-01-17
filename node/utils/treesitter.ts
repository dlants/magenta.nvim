import { spawn } from "child_process";
import type { Result } from "./result.ts";

export type MinimapLine = {
  line: number; // 1-indexed line number
  text: string; // truncated line content
};

export type TreeSitterMinimap = {
  language: string;
  lines: MinimapLine[];
};

const MINIMAP_TIMEOUT_MS = 5000;
const MAX_MINIMAP_LINES = 100;
const MAX_LINE_LENGTH = 100;

// Lua script to generate tree-sitter minimap
// This script is passed to nvim via stdin
const LUA_SCRIPT = `
local filename = arg[1]
if not filename then
  print(vim.json.encode({ error = "no_filename" }))
  os.exit(0)
end

local ok, content = pcall(function()
  return vim.fn.join(vim.fn.readfile(filename), "\\n")
end)
if not ok then
  print(vim.json.encode({ error = "read_failed", message = content }))
  os.exit(0)
end

-- Detect filetype from filename
local ft = vim.filetype.match({ filename = filename, contents = vim.split(content, "\\n") })
if not ft then
  print(vim.json.encode({ error = "no_filetype" }))
  os.exit(0)
end

-- Check if parser is available
local lang = vim.treesitter.language.get_lang(ft) or ft
local parser_available = pcall(vim.treesitter.language.inspect, lang)
if not parser_available then
  print(vim.json.encode({ error = "no_parser", filetype = ft }))
  os.exit(0)
end

-- Parse the content
local parser_ok, parser = pcall(vim.treesitter.get_string_parser, content, lang)
if not parser_ok then
  print(vim.json.encode({ error = "parse_failed", filetype = ft }))
  os.exit(0)
end

local tree = parser:parse()[1]
local root = tree:root()

-- Split content into lines for extraction
local content_lines = vim.split(content, "\\n")

-- Trivial node types to skip
local trivial_types = {
  ["("] = true, [")"] = true,
  ["{"] = true, ["}"] = true,
  ["["] = true, ["]"] = true,
  [","] = true, [";"] = true,
  [":"] = true, ["="] = true,
  ["<"] = true, [">"] = true,
  ["."] = true, [".."] = true,
  ["=>"] = true, ["->"] = true,
  ["\\n"] = true, [""] = true,
  ["comment"] = true,
}

-- BFS traversal with budget
local result_lines = {}
local budget = ${MAX_MINIMAP_LINES}
local seen_lines = {}

local queue = { root }
local queue_start = 1

while queue_start <= #queue and #result_lines < budget do
  local node = queue[queue_start]
  queue_start = queue_start + 1

  local node_type = node:type()

  -- Skip trivial nodes
  if not trivial_types[node_type] then
    local start_row = node:start()
    local line_num = start_row + 1 -- 1-indexed

    -- Only add if we haven't seen this line
    if not seen_lines[line_num] and line_num <= #content_lines then
      seen_lines[line_num] = true
      local line_text = content_lines[line_num] or ""

      -- Truncate long lines
      if #line_text > ${MAX_LINE_LENGTH} then
        line_text = string.sub(line_text, 1, ${MAX_LINE_LENGTH}) .. "..."
      end

      table.insert(result_lines, { line = line_num, text = line_text })
    end
  end

  -- Add children to queue with quintile selection for large child counts
  local child_count = node:child_count()
  if child_count > 0 then
    if child_count <= 5 then
      -- Add all children
      for i = 0, child_count - 1 do
        table.insert(queue, node:child(i))
      end
    else
      -- Select quintiles: first, 1/4, 1/2, 3/4, last
      local indices = {
        0,
        math.floor(child_count / 4),
        math.floor(child_count / 2),
        math.floor(3 * child_count / 4),
        child_count - 1
      }
      -- Remove duplicates
      local seen_indices = {}
      for _, idx in ipairs(indices) do
        if not seen_indices[idx] then
          seen_indices[idx] = true
          table.insert(queue, node:child(idx))
        end
      end
    end
  end
end

-- Sort by line number
table.sort(result_lines, function(a, b) return a.line < b.line end)

print(vim.json.encode({ language = lang, lines = result_lines }))
os.exit(0)
`;

export async function getTreeSitterMinimap(
  filePath: string,
): Promise<Result<TreeSitterMinimap>> {
  return new Promise((resolve) => {
    // Use -l /dev/stdin to read lua script from stdin, pass filepath as arg
    const nvimProcess = spawn(
      "nvim",
      ["--headless", "-n", "-u", "NONE", "-l", "/dev/stdin", filePath],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    nvimProcess.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    nvimProcess.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Send the lua script via stdin
    nvimProcess.stdin.write(LUA_SCRIPT);
    nvimProcess.stdin.end();

    const timeout = setTimeout(() => {
      nvimProcess.kill("SIGKILL");
      resolve({
        status: "error",
        error: "Tree-sitter parsing timed out after 5 seconds",
      });
    }, MINIMAP_TIMEOUT_MS);

    nvimProcess.on("close", () => {
      clearTimeout(timeout);

      // nvim -l outputs to stderr, so check both
      const output = stdout.trim() || stderr.trim();

      if (!output) {
        resolve({
          status: "error",
          error: `No output from nvim`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(output) as
          | TreeSitterMinimap
          | { error: string; filetype?: string };

        if ("error" in parsed) {
          resolve({
            status: "error",
            error: `Tree-sitter error: ${parsed.error}${parsed.filetype ? ` (filetype: ${parsed.filetype})` : ""}`,
          });
          return;
        }

        resolve({
          status: "ok",
          value: parsed,
        });
      } catch {
        resolve({
          status: "error",
          error: `Failed to parse nvim output: ${output}`,
        });
      }
    });

    nvimProcess.on("error", (err: Error) => {
      clearTimeout(timeout);
      resolve({
        status: "error",
        error: `Failed to spawn nvim: ${err.message}`,
      });
    });
  });
}

export function formatMinimap(minimap: TreeSitterMinimap): string {
  const header = `[Tree-sitter minimap (${minimap.language})]\n`;
  const lines = minimap.lines
    .map((l) => `${String(l.line).padStart(4)}: ${l.text}`)
    .join("\n");
  return header + lines;
}
