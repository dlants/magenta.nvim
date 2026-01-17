import { NvimBuffer, type Line } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Dispatch } from "../tea/tea.ts";
import path from "node:path";
import fs from "node:fs";
import { getBufferIfOpen } from "../utils/buffers.ts";
import type { Result } from "../utils/result.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ThreadId } from "../chat/types.ts";
import {
  relativePath,
  resolveFilePath,
  type AbsFilePath,
  type NvimCwd,
  FileCategory,
} from "../utils/files.ts";
import { applyInsert, applyReplace } from "../utils/contentEdits.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import type { ProviderToolResultContent } from "../providers/provider-types.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import type { ToolRequest as InsertRequest } from "./insert.ts";
import type { ToolRequest as ReplaceRequest } from "./replace.ts";

type EditRequest = InsertRequest | ReplaceRequest;
type Msg = {
  type: "finish";
  result: Result<ProviderToolResultContent[]>;
};

type EditContext = {
  nvim: Nvim;
  cwd: NvimCwd;
  bufferTracker: BufferTracker;
  myDispatch: Dispatch<Msg>;
  dispatch: Dispatch<RootMsg>;
};

/**
 * Helper function to save buffer changes and check if it's still modified
 * @returns true if successfully saved, false if still modified
 */
async function saveBufferChanges(buffer: NvimBuffer): Promise<boolean> {
  const isModified = await buffer.getOption("modified");
  if (isModified) {
    try {
      await buffer.attemptWrite();
    } catch {
      // ok if this fails
    }
    const stillModified = await buffer.getOption("modified");
    return !stillModified;
  }
  return true;
}

async function handleBufferEdit(
  request: EditRequest,
  absFilePath: AbsFilePath,
  buffer: NvimBuffer,
  notifyApplied: () => void,
  context: EditContext,
): Promise<void> {
  const { myDispatch: dispatch } = context;
  const { filePath } = request.input;

  // First, try and persist any current buffer changes we have to disk, to make sure that the file hasn't changed
  // out from under us.
  if (!(await saveBufferChanges(buffer))) {
    dispatch({
      type: "finish",
      result: {
        status: "error",
        error: `Buffer for ${filePath} has unsaved changes that could not be written to disk.`,
      },
    });
    return;
  }

  if (request.toolName === "insert" && request.input.insertAfter === "") {
    // small performance optimization - don't need to load all the content if we're just appending
    const { content } = request.input;

    const contentLines = content.split("\n") as Line[];
    await buffer.setLines({
      start: -1 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: contentLines,
    });
  } else {
    const lines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
    const bufferContent = lines.join("\n");
    let newContent: string;

    if (request.toolName === "insert") {
      const { insertAfter, content } = request.input;
      const result = applyInsert(bufferContent, insertAfter, content);

      if (result.status === "error") {
        dispatch({
          type: "finish",
          result: {
            status: "error",
            error: `${result.error} in file \`${filePath}\``,
          },
        });
        return;
      }

      newContent = result.content;
    } else if (request.toolName === "replace") {
      const { find, replace } = request.input;
      const result = applyReplace(bufferContent, find, replace);

      if (result.status === "error") {
        dispatch({
          type: "finish",
          result: {
            status: "error",
            error: `${result.error} in file \`${filePath}\``,
          },
        });
        return;
      }

      newContent = result.content;
    } else {
      // This should never happen due to TypeScript, but adding as a safeguard
      dispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Unknown edit operation for file \`${filePath}\``,
        },
      });
      return;
    }

    await buffer.setLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
      lines: newContent.split("\n") as Line[],
    });
  }

  if (!(await saveBufferChanges(buffer))) {
    dispatch({
      type: "finish",
      result: {
        status: "error",
        error: `Failed to modify buffer: Buffer ${filePath} has unsaved changes that could not be written to disk.`,
      },
    });
    return;
  }

  await context.bufferTracker.trackBufferSync(absFilePath, buffer.id);
  notifyApplied();
  dispatch({
    type: "finish",
    result: {
      status: "ok",
      value: [{ type: "text", text: `Successfully applied edits.` }],
    },
  });
}

async function handleFileEdit(
  request: EditRequest,
  notifyApplied: () => void,
  context: EditContext,
): Promise<void> {
  const { myDispatch } = context;
  const { filePath } = request.input;
  const absFilePath = resolveFilePath(context.cwd, filePath);
  const relFilePath = relativePath(context.cwd, absFilePath);

  if (request.toolName === "insert" && request.input.insertAfter === "") {
    try {
      let fileExists = true;
      try {
        await fs.promises.access(absFilePath);
      } catch {
        fileExists = false;
      }

      if (fileExists) {
        await fs.promises.appendFile(
          absFilePath,
          request.input.content,
          "utf-8",
        );
      } else {
        const dirPath = path.dirname(absFilePath);
        await fs.promises.mkdir(dirPath, { recursive: true });
        await fs.promises.writeFile(
          absFilePath,
          request.input.content,
          "utf-8",
        );
      }
      notifyApplied();

      myDispatch({
        type: "finish",
        result: {
          status: "ok",
          value: [{ type: "text", text: `Successfully applied edits.` }],
        },
      });
      return;
    } catch (error) {
      myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Error accessing file ${absFilePath}: ${(error as Error).message}`,
        },
      });
      return;
    }
  }

  let fileContent;
  try {
    fileContent = await fs.promises.readFile(absFilePath, "utf-8");
  } catch {
    if (request.toolName === "replace" && request.input.find === "") {
      // Special case: empty find parameter with replace on non-existent file
      fileContent = "";
    } else {
      myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `File \`${absFilePath}\` does not exist.`,
        },
      });
      return;
    }
  }

  let newContent: string;

  if (request.toolName === "insert") {
    const { insertAfter, content } = request.input;
    const result = applyInsert(fileContent, insertAfter, content);

    if (result.status === "error") {
      myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `${result.error} in file \`${relFilePath}\`.
          Read the contents of the file and make sure your insertAfter parameter matches the content of the file exactly.`,
        },
      });
      return;
    }

    newContent = result.content;
  } else if (request.toolName === "replace") {
    const { find, replace } = request.input;
    const result = applyReplace(fileContent, find, replace);
    if (result.status === "error") {
      myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `${result.error} in file \`${relFilePath}\`.`,
        },
      });
      return;
    }

    newContent = result.content;
  } else {
    myDispatch({
      type: "finish",
      result: {
        status: "error",
        error: `Unknown edit operation for file \`${relFilePath}\``,
      },
    });
    return;
  }

  try {
    await fs.promises.writeFile(absFilePath, newContent, "utf-8");
    notifyApplied();
    myDispatch({
      type: "finish",
      result: {
        status: "ok",
        value: [{ type: "text", text: `Successfully applied edits.` }],
      },
    });
  } catch (error) {
    myDispatch({
      type: "finish",
      result: {
        status: "error",
        error: `Error writing to file ${absFilePath}: ${(error as Error).message}`,
      },
    });
  }
}

/**
 * Main function to apply edits to a file or buffer
 */
export async function applyEdit(
  request: EditRequest,
  threadId: ThreadId,
  context: EditContext,
): Promise<void> {
  const { filePath } = request.input;
  const { nvim, cwd, myDispatch, dispatch } = context;

  dispatch({
    type: "thread-msg",
    id: threadId,
    msg: {
      type: "take-file-snapshot",
      unresolvedFilePath: filePath,
    },
  });

  const bufferOpenResult = await getBufferIfOpen({
    unresolvedPath: filePath,
    context: { nvim, cwd },
  });

  if (bufferOpenResult.status === "error") {
    myDispatch({
      type: "finish",
      result: {
        status: "error",
        error: bufferOpenResult.error,
      },
    });
    return;
  }

  const absFilePath = resolveFilePath(cwd, filePath);

  const notifyApplied = () =>
    dispatch({
      type: "thread-msg",
      id: threadId,
      msg: {
        type: "context-manager-msg",
        msg: {
          type: "tool-applied",
          absFilePath,
          tool:
            request.toolName == "insert"
              ? {
                  type: "insert",
                  insertAfter: request.input.insertAfter,
                  content: request.input.content,
                }
              : {
                  type: "replace",
                  find: request.input.find,
                  replace: request.input.replace,
                },
          fileTypeInfo: {
            category: FileCategory.TEXT,
            mimeType: "text/plain",
            extension: "",
          },
        },
      },
    });

  if (bufferOpenResult.status === "ok") {
    await handleBufferEdit(
      request,
      absFilePath,
      bufferOpenResult.buffer,
      notifyApplied,
      context,
    );
  } else if (bufferOpenResult.status === "not-found") {
    await handleFileEdit(request, notifyApplied, context);
  }
}
