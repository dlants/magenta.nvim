import { NvimBuffer } from "../nvim/buffer.ts";
import { getAllBuffers } from "../nvim/nvim.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import {
  resolveFilePath,
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
  type UnresolvedFilePath,
} from "./files.ts";

export async function getBufferIfOpen({
  unresolvedPath,
  context,
}: {
  unresolvedPath: UnresolvedFilePath | AbsFilePath | RelFilePath;
  context: { nvim: Nvim; cwd: NvimCwd; homeDir: HomeDir };
}): Promise<
  | { status: "ok"; buffer: NvimBuffer }
  | { status: "error"; error: string }
  | { status: "not-found" }
> {
  // Get all buffers and nvim's cwd
  const buffers = await getAllBuffers(context.nvim);
  const absolutePath = resolveFilePath(
    context.cwd,
    unresolvedPath,
    context.homeDir,
  );

  // Find buffer with matching path
  for (const buffer of buffers) {
    const bufferName = await buffer.getName();

    if (
      resolveFilePath(context.cwd, bufferName, context.homeDir) === absolutePath
    ) {
      return { status: "ok", buffer };
    }
  }

  return { status: "not-found" };
}

export async function getOrOpenBuffer({
  unresolvedPath,
  context,
}: {
  unresolvedPath: UnresolvedFilePath;
  context: { nvim: Nvim; cwd: NvimCwd; homeDir: HomeDir };
}): Promise<
  { status: "ok"; buffer: NvimBuffer } | { status: "error"; error: string }
> {
  // First try to get the buffer if it's already open
  const existingBuffer = await getBufferIfOpen({
    unresolvedPath,
    context,
  });

  if (existingBuffer.status === "error") {
    return existingBuffer;
  }

  if (existingBuffer.status === "ok") {
    return existingBuffer;
  }

  const absolutePath = resolveFilePath(
    context.cwd,
    unresolvedPath,
    context.homeDir,
  );

  try {
    await NvimBuffer.bufadd(absolutePath, context.nvim);

    const existingBuffer = await getBufferIfOpen({
      unresolvedPath,
      context,
    });
    if (existingBuffer.status == "error" || existingBuffer.status == "ok") {
      return existingBuffer;
    } else {
      return { status: "error", error: "Unable to open file." };
    }
  } catch (error) {
    return {
      status: "error",
      error: `Failed to open buffer: ${(error as Error).message}`,
    };
  }
}
