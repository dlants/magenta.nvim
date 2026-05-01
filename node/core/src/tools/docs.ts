import type { FileIO } from "../capabilities/file-io.ts";
import type { HelpTagsProvider } from "../capabilities/help-tags-provider.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderToolResult,
  type ProviderToolSpec,
} from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

export type Input = { query: string };

export type ToolRequest = GenericToolRequest<"docs", Input>;
export type StructuredResult = {
  toolName: "docs";
  matchCount: number;
  truncated: boolean;
};

export type Match = {
  tag: string;
  filePath: string;
  lineNumber: number;
};

const MAX_MATCHES = 200;

type ExecuteContext = {
  fileIO: FileIO;
  helpTagsProvider: HelpTagsProvider;
};

type ParsedTag = {
  tag: string;
  relFile: string;
  tagsFileDir: string;
};

function parseTagsFile(content: string): { tag: string; relFile: string }[] {
  const results: { tag: string; relFile: string }[] = [];
  for (const line of content.split("\n")) {
    if (!line || line.startsWith("!")) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const tag = parts[0];
    const relFile = parts[1];
    if (!tag || !relFile) continue;
    results.push({ tag, relFile });
  }
  return results;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function joinPath(dir: string, rel: string): string {
  if (!dir) return rel;
  if (rel.startsWith("/")) return rel;
  return `${dir}/${rel}`;
}

function findTagLine(content: string, tag: string): number | undefined {
  const marker = `*${tag}*`;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(marker)) {
      return i + 1;
    }
  }
  return undefined;
}

export function execute(
  request: ToolRequest,
  context: ExecuteContext,
): ToolInvocation {
  let aborted = false;

  const promise = (async (): Promise<ProviderToolResult> => {
    if (aborted) {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: "Request was aborted by the user.",
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
    }

    try {
      const query = request.input.query.toLowerCase();
      const tagsFiles = await context.helpTagsProvider.listTagFiles();

      const matches: ParsedTag[] = [];
      for (const tagsFile of tagsFiles) {
        let content: string;
        try {
          content = await context.fileIO.readFile(tagsFile);
        } catch {
          continue;
        }
        const tagsFileDir = dirOf(tagsFile);
        for (const { tag, relFile } of parseTagsFile(content)) {
          if (tag.toLowerCase().includes(query)) {
            matches.push({ tag, relFile, tagsFileDir });
            if (matches.length > MAX_MATCHES) break;
          }
        }
        if (matches.length > MAX_MATCHES) break;
      }

      const truncated = matches.length > MAX_MATCHES;
      const capped = truncated ? matches.slice(0, MAX_MATCHES) : matches;

      const byFile = new Map<string, ParsedTag[]>();
      for (const m of capped) {
        const absPath = joinPath(m.tagsFileDir, m.relFile);
        const arr = byFile.get(absPath) ?? [];
        arr.push(m);
        byFile.set(absPath, arr);
      }

      type FileEntry = { fileName: string; tags: Match[] };
      const byDir = new Map<string, Map<string, FileEntry>>();
      for (const [absPath, tagEntries] of byFile.entries()) {
        let fileContent: string | undefined;
        try {
          fileContent = await context.fileIO.readFile(absPath);
        } catch {
          fileContent = undefined;
        }
        const dir = dirOf(absPath);
        const fileName = absPath.slice(dir.length + 1);
        let filesInDir = byDir.get(dir);
        if (!filesInDir) {
          filesInDir = new Map();
          byDir.set(dir, filesInDir);
        }
        let entry = filesInDir.get(absPath);
        if (!entry) {
          entry = { fileName, tags: [] };
          filesInDir.set(absPath, entry);
        }
        for (const t of tagEntries) {
          const lineNumber = fileContent
            ? (findTagLine(fileContent, t.tag) ?? 1)
            : 1;
          entry.tags.push({ tag: t.tag, filePath: absPath, lineNumber });
        }
      }

      const totalMatches = capped.length;
      const sortedDirs = [...byDir.keys()].sort();

      let text: string;
      if (totalMatches === 0) {
        text = `No matches for query "${request.input.query}".`;
      } else {
        const header = truncated
          ? `Found ${totalMatches}+ matches (truncated to ${MAX_MATCHES}).\n`
          : `Found ${totalMatches} match${totalMatches === 1 ? "" : "es"}.\n`;
        const sections: string[] = [];
        for (const dir of sortedDirs) {
          const filesInDir = byDir.get(dir);
          if (!filesInDir) continue;
          const lines: string[] = [`${dir}/`];
          const sortedFiles = [...filesInDir.values()].sort((a, b) =>
            a.fileName.localeCompare(b.fileName),
          );
          for (const entry of sortedFiles) {
            lines.push(`  ${entry.fileName}`);
            entry.tags.sort((a, b) => a.tag.localeCompare(b.tag));
            for (const t of entry.tags) {
              lines.push(`    ${t.tag}:${t.lineNumber}`);
            }
          }
          sections.push(lines.join("\n"));
        }
        text = `${header}\n${sections.join("\n\n")}`;
      }

      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }],
          structuredResult: {
            toolName: "docs" as const,
            matchCount: totalMatches,
            truncated,
          },
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
    } catch (error) {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `Failed to search docs: ${error instanceof Error ? error.message : String(error)}`,
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
    }
  })();

  return {
    promise,
    abort: () => {
      aborted = true;
    },
  };
}

export function getSpec(): ProviderToolSpec {
  return {
    name: "docs" as ToolName,
    description:
      "Search neovim help tags across all runtime help files (magenta docs, neovim builtins, plugin help). Returns matching tags with their file paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Substring to match against help tag names (case-insensitive).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.query !== "string") {
    return {
      status: "error",
      error: "expected req.input.query to be a string",
    };
  }
  if (input.query.trim().length === 0) {
    return {
      status: "error",
      error: "expected req.input.query to be a non-empty string",
    };
  }
  return {
    status: "ok",
    value: input as Input,
  };
}
