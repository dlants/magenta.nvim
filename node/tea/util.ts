import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { Line, NvimBuffer } from "../nvim/buffer.ts";
import type { ByteIdx, Position0Indexed, Row0Indexed } from "../nvim/window.ts";

export async function replaceBetweenPositions({
  buffer,
  startPos,
  endPos,
  lines,
  context,
}: {
  buffer: NvimBuffer;
  startPos: Position0Indexed;
  endPos: Position0Indexed;
  lines: Line[];
  context: { nvim: Nvim };
}) {
  try {
    await buffer.setOption("modifiable", true);

    await context.nvim.call("nvim_buf_set_text", [
      buffer.id,
      startPos.row,
      startPos.col,
      endPos.row,
      endPos.col,
      lines,
    ]);

    await buffer.setOption("modifiable", false);
  } catch (e) {
    const err = new Error(
      `Unable to replaceBetweenPositions ${JSON.stringify({ startPos, endPos })}: ${e as string}`,
    );
    context.nvim.logger.error(err);
    throw err;
  }
}

export function calculatePosition(
  startPos: Position0Indexed,
  buf: Buffer,
  indexInText: ByteIdx,
): Position0Indexed {
  let { row, col } = startPos;
  let currentIndex: ByteIdx = 0 as ByteIdx;

  while (currentIndex < indexInText) {
    // 10 == '\n' in hex
    if (buf[currentIndex] == 10) {
      row++;
      col = 0 as ByteIdx;
    } else {
      col++;
    }
    currentIndex++;
  }

  return { row, col };
}

export { calculateStringPosition } from "@magenta/core";

export async function logBuffer(buffer: NvimBuffer, context: { nvim: Nvim }) {
  const lines = await buffer.getLines({
    start: 0 as Row0Indexed,
    end: -1 as Row0Indexed,
  });
  context.nvim.logger.info("buffer:\n" + lines.join("\n") + "\nend");
}

export function strWidthInBytes(str: string) {
  return Buffer.from(str, "utf8").byteLength;
}
