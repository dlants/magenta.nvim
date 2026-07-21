import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderToolResult,
  type ProviderToolSpec,
} from "../providers/provider-types.ts";
import type { ToolInvocation, ToolName, ToolRequestId } from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

export type ToolRequest = {
  id: ToolRequestId;
  toolName: "scratchpad";
  input: Input;
};
export type StructuredResult = { toolName: "scratchpad" };

export type ScratchpadEntry = { key: string; value: string };
export type Scratchpad = { entries: ScratchpadEntry[] };

export function emptyScratchpad(): Scratchpad {
  return { entries: [] };
}

export function cloneScratchpad(scratchpad: Scratchpad): Scratchpad {
  return { entries: scratchpad.entries.map((e) => ({ ...e })) };
}

/** The system-reminder line nudging the agent to prune stale scratchpad keys,
 * or undefined when the scratchpad is empty. */
export function scratchpadReminder(scratchpad: Scratchpad): string | undefined {
  if (scratchpad.entries.length === 0) return undefined;
  const keys = scratchpad.entries.map((e) => e.key).join(", ");
  return `Scratchpad keys: [${keys}]. Delete keys you no longer need with the scratchpad tool.`;
}

type Command =
  | { type: "append"; key: string; value: string }
  | { type: "delete"; keys: string[] }
  | { type: "get"; keys: string[] }
  | { type: "move_after"; key: string; anchorKey: string }
  | { type: "move_to_front"; key: string }
  | { type: "clear" };

function parseError(message: string): Result<never> {
  return { status: "error", error: message };
}

export function parseScript(script: string): Result<Command[]> {
  const lines = script.split("\n");
  const commands: Command[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const lineNo = i + 1;
    i++;

    if (trimmed === "") continue;

    const tokens = trimmed.split(/\s+/);
    const cmd = tokens[0];

    switch (cmd) {
      case "append": {
        const m = raw.match(/^\s*append\s+(\S+)(?:[ \t]+(.*))?$/);
        if (!m) {
          return parseError(`line ${lineNo}: append requires a key and value`);
        }
        const key = m[1];
        const remainder = m[2];
        const hd = remainder?.match(/^<<(\S+)$/);
        if (hd) {
          const sentinel = hd[1];
          const valueLines: string[] = [];
          let terminated = false;
          while (i < lines.length) {
            const bodyLine = lines[i];
            i++;
            if (bodyLine.trim() === sentinel) {
              terminated = true;
              break;
            }
            valueLines.push(bodyLine);
          }
          if (!terminated) {
            return parseError(
              `line ${lineNo}: heredoc for key "${key}" was not terminated by "${sentinel}"`,
            );
          }
          commands.push({ type: "append", key, value: valueLines.join("\n") });
        } else {
          if (remainder === undefined || remainder === "") {
            return parseError(`line ${lineNo}: append requires a value`);
          }
          commands.push({ type: "append", key, value: remainder });
        }
        break;
      }
      case "delete": {
        const keys = tokens.slice(1);
        if (keys.length === 0) {
          return parseError(`line ${lineNo}: delete requires at least one key`);
        }
        commands.push({ type: "delete", keys });
        break;
      }
      case "get": {
        const keys = tokens.slice(1);
        if (keys.length === 0) {
          return parseError(`line ${lineNo}: get requires at least one key`);
        }
        commands.push({ type: "get", keys });
        break;
      }
      case "move_after": {
        const key = tokens[1];
        if (!key || tokens.length > 3) {
          return parseError(
            `line ${lineNo}: move_after requires a key and an optional anchor key`,
          );
        }
        const anchorKey = tokens[2];
        commands.push(
          anchorKey !== undefined
            ? { type: "move_after", key, anchorKey }
            : { type: "move_to_front", key },
        );
        break;
      }
      case "clear": {
        if (tokens.length > 1) {
          return parseError(`line ${lineNo}: clear takes no arguments`);
        }
        commands.push({ type: "clear" });
        break;
      }
      default:
        return parseError(`line ${lineNo}: unknown command "${cmd}"`);
    }
  }

  return { status: "ok", value: commands };
}

function evalError(message: string): Result<never> {
  return { status: "error", error: message };
}

export function evaluate(
  commands: Command[],
  scratchpad: Scratchpad,
): Result<{ entries: ScratchpadEntry[]; getOutputs: ScratchpadEntry[] }> {
  const entries = scratchpad.entries.map((e) => ({ ...e }));
  const getOutputs: ScratchpadEntry[] = [];

  for (const command of commands) {
    switch (command.type) {
      case "append": {
        if (entries.some((e) => e.key === command.key)) {
          return evalError(`key "${command.key}" already exists`);
        }
        entries.push({ key: command.key, value: command.value });
        break;
      }
      case "delete": {
        for (const key of command.keys) {
          const idx = entries.findIndex((e) => e.key === key);
          if (idx >= 0) entries.splice(idx, 1);
        }
        break;
      }
      case "get": {
        for (const key of command.keys) {
          const entry = entries.find((e) => e.key === key);
          if (!entry) {
            return evalError(`key "${key}" not found`);
          }
          getOutputs.push({ key: entry.key, value: entry.value });
        }
        break;
      }
      case "move_after": {
        const idx = entries.findIndex((e) => e.key === command.key);
        if (idx < 0) {
          return evalError(`key "${command.key}" not found`);
        }
        if (command.anchorKey === command.key) {
          return evalError(
            `move_after: key "${command.key}" cannot be its own anchor`,
          );
        }
        const anchorIdx = entries.findIndex((e) => e.key === command.anchorKey);
        if (anchorIdx < 0) {
          return evalError(`anchor key "${command.anchorKey}" not found`);
        }
        const [moved] = entries.splice(idx, 1);
        const newAnchorIdx = entries.findIndex(
          (e) => e.key === command.anchorKey,
        );
        entries.splice(newAnchorIdx + 1, 0, moved);
        break;
      }
      case "move_to_front": {
        const idx = entries.findIndex((e) => e.key === command.key);
        if (idx < 0) {
          return evalError(`key "${command.key}" not found`);
        }
        const [moved] = entries.splice(idx, 1);
        entries.unshift(moved);
        break;
      }
      case "clear": {
        entries.length = 0;
        break;
      }
    }
  }

  return { status: "ok", value: { entries, getOutputs } };
}

function snapshotLine(entries: ScratchpadEntry[]): string {
  return `The scratchpad is now [${entries.map((e) => e.key).join(", ")}]`;
}

export function runScript(
  script: string,
  scratchpad: Scratchpad,
): Result<string> {
  const parsed = parseScript(script);
  if (parsed.status === "error") return parsed;

  const evaluated = evaluate(parsed.value, scratchpad);
  if (evaluated.status === "error") return evaluated;

  scratchpad.entries = evaluated.value.entries;

  const parts: string[] = [];
  for (const { key, value } of evaluated.value.getOutputs) {
    parts.push(`${key} = ${value}`);
  }
  parts.push(snapshotLine(scratchpad.entries));

  return { status: "ok", value: parts.join("\n") };
}

export function execute(
  request: ToolRequest,
  context: {
    scratchpad: Scratchpad;
  },
): ToolInvocation {
  const promise = (async (): Promise<ProviderToolResult> => {
    const result = runScript(request.input.script, context.scratchpad);

    if (result.status === "error") {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: result.error,
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
    }

    return {
      type: "tool_result",
      id: request.id,
      result: {
        status: "ok",
        value: [
          {
            type: "text",
            text: result.value,
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ],
        structuredResult: { toolName: "scratchpad" as ToolName },
      },
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    };
  })();

  return {
    promise,
    abort: () => {},
  };
}

export const spec: ProviderToolSpec = {
  name: "scratchpad" as ToolName,
  description: `Use this for listing, counting and remembering things / keepign them on top of your context window.

Submit a \`script\` of one command per line:
\`append <key> value text to the end of the line\`

Use a heredoc for multi-line values:

append <key> <<END
line one
line two
END

Appending an existing key is an error (keys are unique).

\`delete <key> [<key> ...]\` — remove the listed keys (missing keys are ignored).
\`get <key> [<key> ...]\` — prints the values of the listed keys.
\`move_after <key> [<anchorKey>]\` — move <key> immediately after <anchorKey>, or to the front of the list if no anchor is given.
\`clear\` — empty the scratchpad

Every result echoes the ordered keys, e.g. \`The scratchpad is now [a, b, c]\`, plus any \`get\`-ed values.`,
  input_schema: {
    type: "object",
    properties: {
      script: {
        type: "string",
        description: "The scratchpad script",
      },
    },
    required: ["script"],
  },
};

export type Input = {
  script: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.script !== "string") {
    return { status: "error", error: "expected input.script to be a string" };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
