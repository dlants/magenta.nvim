import type { Result } from "../../utils/result.ts";
import type { ProviderToolSpec } from "../../agent/provider-types.ts";
import type { ToolName, GenericToolRequest } from "../types.ts";

const BASH_COMMAND_DESCRIPTION = `Run a command in a bash shell.
For example, you can run \`ls\`, \`echo 'Hello, World!'\`, or \`git status\`.
The command will time out after 1 min.
You should not run commands that require user input, such as \`git commit\` without \`-m\` or \`ssh\`.
You should not run commands that do not halt, such as \`docker compose up\` without \`-d\`, \`tail -f\` or \`watch\`.

Long output will be abbreviated (first 10 + last 20 lines). Full output is saved to a log file that can be read with get_file. You do not need to use head/tail/grep to limit output - just run the command directly.
You will get the stdout and stderr of the command, as well as the exit code, so you do not need to do stream redirects like "2>&1".

For searching file contents, prefer \`rg\` (ripgrep) which is available on this system. Examples:
- \`rg "pattern"\` - search recursively in current directory
- \`rg "pattern" path/to/dir\` - search in specific directory
- \`rg "pattern" path/to/file\` - search in specific file
- \`echo "text" | rg "pattern"\` - search in piped input

For finding files by name, prefer \`fd\` which is available on this system. Note: fd skips hidden files and gitignored files by default. Examples:
- \`fd "pattern"\` - find files matching pattern recursively
- \`fd "pattern" path/to/dir\` - find in specific directory
- \`fd -e ts\` - find files with specific extension
- \`fd -t f "pattern"\` - find only files (not directories)
- \`fd -t d "pattern"\` - find only directories
`;

export type Input = {
  command: string;
};

export type ToolRequest = GenericToolRequest<ToolName, Input>;

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.command !== "string") {
    return {
      status: "error",
      error: "expected input.command to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}

export const spec: ProviderToolSpec = {
  name: "bash_command" as ToolName,
  description: BASH_COMMAND_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run in the terminal",
      },
    },
    required: ["command"],
  },
};
