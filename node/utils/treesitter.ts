import { spawn } from "child_process";
import type { Result } from "./result.ts";

export type MinimapLine = {
  line: number; // 1-indexed line number
  text: string; // truncated line content
};

export type MinimapSummary = {
  summary: Record<string, number>; // node_type -> count
};

export type TreeSitterMinimap = {
  language: string;
  lines: (MinimapLine | MinimapSummary)[];
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

-- Helper to get line info for a node
local function get_node_line(node)
  local node_type = node:type()
  if trivial_types[node_type] then
    return nil
  end
  local start_row = node:start()
  local line_num = start_row + 1
  if line_num > #content_lines then
    return nil
  end
  local line_text = content_lines[line_num] or ""
  if #line_text > ${MAX_LINE_LENGTH} then
    line_text = string.sub(line_text, 1, ${MAX_LINE_LENGTH}) .. "..."
  end
  return { line = line_num, text = line_text, node = node }
end

-- Helper to count node types in a range
local function count_types(nodes, start_idx, end_idx)
  local counts = {}
  for i = start_idx, end_idx do
    local node = nodes[i]
    local node_type = node:type()
    if not trivial_types[node_type] then
      counts[node_type] = (counts[node_type] or 0) + 1
    end
  end
  return counts
end

-- Level-based BFS with budget
local result_lines = {}
local budget = ${MAX_MINIMAP_LINES}
local seen_lines = {}

-- Current level nodes (each item has: node, parent_idx for grouping)
local current_level = { { node = root, parent_idx = 0 } }

while #current_level > 0 and budget > 0 do
  -- Collect all non-trivial nodes at this level with their line info
  local level_nodes = {}
  for _, item in ipairs(current_level) do
    local info = get_node_line(item.node)
    if info and not seen_lines[info.line] then
      info.parent_idx = item.parent_idx
      table.insert(level_nodes, info)
    end
  end

  if #level_nodes == 0 then
    -- All nodes at this level are trivial, collect children and continue
    local next_level = {}
    for _, item in ipairs(current_level) do
      local child_count = item.node:child_count()
      for i = 0, child_count - 1 do
        table.insert(next_level, { node = item.node:child(i), parent_idx = item.parent_idx })
      end
    end
    current_level = next_level
  elseif #level_nodes <= budget then
    -- All nodes fit in budget, add them all
    for _, info in ipairs(level_nodes) do
      if not seen_lines[info.line] then
        seen_lines[info.line] = true
        table.insert(result_lines, { line = info.line, text = info.text })
        budget = budget - 1
      end
    end

    -- Collect children for next level
    local next_level = {}
    for idx, info in ipairs(level_nodes) do
      local child_count = info.node:child_count()
      for i = 0, child_count - 1 do
        table.insert(next_level, { node = info.node:child(i), parent_idx = idx })
      end
    end
    current_level = next_level
  else
    -- Need to sample: use bookends + evenly distributed samples
    -- Group nodes by parent
    local parent_groups = {}
    for idx, info in ipairs(level_nodes) do
      local pid = info.parent_idx
      if not parent_groups[pid] then
        parent_groups[pid] = {}
      end
      table.insert(parent_groups[pid], idx)
    end

    -- Count parents and reserve bookends (first + last of each parent)
    local num_parents = 0
    local bookend_indices = {}
    for pid, indices in pairs(parent_groups) do
      num_parents = num_parents + 1
      bookend_indices[indices[1]] = true
      if #indices > 1 then
        bookend_indices[indices[#indices]] = true
      end
    end

    local num_bookends = 0
    for _ in pairs(bookend_indices) do
      num_bookends = num_bookends + 1
    end

    -- Remaining budget for evenly distributed samples
    local remaining_budget = math.max(0, budget - num_bookends)

    -- Select additional sample indices evenly distributed
    local sample_indices = {}
    for idx in pairs(bookend_indices) do
      sample_indices[idx] = true
    end

    if remaining_budget > 0 and #level_nodes > num_bookends then
      -- Evenly distribute remaining samples across non-bookend nodes
      local non_bookend_indices = {}
      for idx = 1, #level_nodes do
        if not bookend_indices[idx] then
          table.insert(non_bookend_indices, idx)
        end
      end

      local step = math.max(1, math.floor(#non_bookend_indices / remaining_budget))
      local count = 0
      for i = 1, #non_bookend_indices, step do
        if count >= remaining_budget then break end
        sample_indices[non_bookend_indices[i]] = true
        count = count + 1
      end
    end

    -- Convert to sorted list
    local sorted_samples = {}
    for idx in pairs(sample_indices) do
      table.insert(sorted_samples, idx)
    end
    table.sort(sorted_samples)

    -- Output sampled nodes with summaries between them
    for i, idx in ipairs(sorted_samples) do
      -- Add summary for skipped nodes before this sample
      local prev_idx = i == 1 and 0 or sorted_samples[i - 1]
      if idx - prev_idx > 1 then
        local type_counts = {}
        for skip_idx = prev_idx + 1, idx - 1 do
          local skip_node = level_nodes[skip_idx].node
          local skip_type = skip_node:type()
          if not trivial_types[skip_type] then
            type_counts[skip_type] = (type_counts[skip_type] or 0) + 1
          end
        end
        if next(type_counts) then
          table.insert(result_lines, { summary = type_counts })
        end
      end

      -- Add the sampled node
      local info = level_nodes[idx]
      if not seen_lines[info.line] then
        seen_lines[info.line] = true
        table.insert(result_lines, { line = info.line, text = info.text })
        budget = budget - 1
      end
    end

    -- Add summary for any skipped nodes after the last sample
    local last_sample = sorted_samples[#sorted_samples]
    if last_sample < #level_nodes then
      local type_counts = {}
      for skip_idx = last_sample + 1, #level_nodes do
        local skip_node = level_nodes[skip_idx].node
        local skip_type = skip_node:type()
        if not trivial_types[skip_type] then
          type_counts[skip_type] = (type_counts[skip_type] or 0) + 1
        end
      end
      if next(type_counts) then
        table.insert(result_lines, { summary = type_counts })
      end
    end

    -- Don't traverse into children when we've had to sample
    current_level = {}
  end
end

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

function isMinimapLine(
  item: MinimapLine | MinimapSummary,
): item is MinimapLine {
  return "line" in item;
}

function formatSummary(summary: Record<string, number>): string {
  const parts = Object.entries(summary)
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => {
      const readableType = type.replace(/_/g, " ");
      return `${count} ${readableType}${count > 1 ? "s" : ""}`;
    });
  return `  ... ${parts.join(", ")} ...`;
}

export function formatMinimap(minimap: TreeSitterMinimap): string {
  const header = `[Tree-sitter minimap (${minimap.language})]\n`;
  const lines = minimap.lines
    .map((item) => {
      if (isMinimapLine(item)) {
        return `${String(item.line).padStart(5)}: ${item.text}`;
      } else {
        return formatSummary(item.summary);
      }
    })
    .join("\n");
  return header + lines;
}
