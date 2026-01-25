import type { Position } from "./embedding/types.ts";

export type ChunkInfo = {
  text: string;
  headingContext?: string;
  start: Position;
  end: Position;
};

// ~500 tokens ≈ 2000 chars
const TARGET_CHUNK_SIZE = 2000;
const CHARACTER_SPLIT_OVERLAP = 200;

type HardBlock = {
  text: string;
  start: Position;
  end: Position;
  headingContext?: string;
};

export type Unit = {
  text: string;
  // Size contribution to chunk limit. URLs don't count.
  size: number;
  start: Position;
  end: Position;
};

type HeadingHierarchy = {
  [depth: number]: string;
};

function getHeadingContext(hierarchy: HeadingHierarchy): string | undefined {
  const parts: string[] = [];
  for (let i = 1; i <= 6; i++) {
    if (hierarchy[i]) {
      parts.push(`${"#".repeat(i)} ${hierarchy[i]}`);
    } else {
      break;
    }
  }
  return parts.length > 0 ? parts.join(" > ") : undefined;
}

function isHeading(line: string): { depth: number; title: string } | undefined {
  // Check if line starts with 1-6 # followed by space
  let hashCount = 0;
  for (let i = 0; i < line.length && i < 7; i++) {
    if (line[i] === "#") {
      hashCount++;
    } else {
      break;
    }
  }
  if (hashCount > 0 && hashCount <= 6 && line[hashCount] === " ") {
    return {
      depth: hashCount,
      title: line.slice(hashCount + 1).trim(),
    };
  }
  return undefined;
}

function isCodeFence(line: string): boolean {
  return line.startsWith("```");
}

function endPosOfLine(lineNum: number, line: string): Position {
  return { line: lineNum, col: line.length || 1 };
}

function splitIntoHardBlocks(text: string): HardBlock[] {
  const lines = text.split("\n");
  const blocks: HardBlock[] = [];
  const headingHierarchy: HeadingHierarchy = {};

  let currentBlock: string[] = [];
  let blockStartLine = 1;
  let blockHeadingContext: string | undefined;
  let inCodeBlock = false;

  function flushBlock(endLineNum: number) {
    if (currentBlock.length > 0) {
      const lastLine = currentBlock[currentBlock.length - 1];
      const hardBlock: HardBlock = {
        text: currentBlock.join("\n"),
        start: { line: blockStartLine, col: 1 },
        end: endPosOfLine(endLineNum, lastLine),
      };
      if (blockHeadingContext) {
        hardBlock.headingContext = blockHeadingContext;
      }
      blocks.push(hardBlock);
      currentBlock = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Track code fence state but don't treat as hard boundary
    if (isCodeFence(line)) {
      inCodeBlock = !inCodeBlock;
      currentBlock.push(line);
      continue;
    }

    if (inCodeBlock) {
      currentBlock.push(line);
      continue;
    }

    // Handle headings as hard boundaries
    const heading = isHeading(line);
    if (heading) {
      flushBlock(lineNum - 1);

      // Update heading hierarchy
      headingHierarchy[heading.depth] = heading.title;
      // Clear deeper headings
      for (let d = heading.depth + 1; d <= 6; d++) {
        delete headingHierarchy[d];
      }

      currentBlock = [line];
      blockStartLine = lineNum;
      blockHeadingContext = getHeadingContext(headingHierarchy);
      continue;
    }

    currentBlock.push(line);
  }

  // Don't forget the last block
  flushBlock(lines.length);

  return blocks;
}

export type SoftChunk = {
  text: string;
  start: Position;
  end: Position;
};

export type Paragraph = { lines: string[]; startLineIdx: number };

export function splitIntoParagraphs(lines: string[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let currentPara: string[] = [];
  let paraStartIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      if (currentPara.length > 0) {
        paragraphs.push({ lines: currentPara, startLineIdx: paraStartIdx });
        currentPara = [];
      }
      paraStartIdx = i + 1;
    } else {
      currentPara.push(lines[i]);
    }
  }
  if (currentPara.length > 0) {
    paragraphs.push({ lines: currentPara, startLineIdx: paraStartIdx });
  }

  return paragraphs;
}

function softSplitBlock(
  text: string,
  blockStart: Position,
  maxChunkSize: number,
): SoftChunk[] {
  if (text.length <= maxChunkSize) {
    const lines = text.split("\n");
    const lastLine = lines[lines.length - 1];
    return [
      {
        text,
        start: blockStart,
        end: endPosOfLine(blockStart.line + lines.length - 1, lastLine),
      },
    ];
  }

  const chunks: SoftChunk[] = [];
  const lines = text.split("\n");
  const paragraphs = splitIntoParagraphs(lines);

  let currentParas: Paragraph[] = [];
  let currentSize = 0;

  function flushChunk() {
    if (currentParas.length === 0) return;

    const chunkLines: string[] = [];
    for (let i = 0; i < currentParas.length; i++) {
      if (i > 0) chunkLines.push("");
      chunkLines.push(...currentParas[i].lines);
    }
    const startLine = blockStart.line + currentParas[0].startLineIdx;
    const lastPara = currentParas[currentParas.length - 1];
    const endLineIdx = lastPara.startLineIdx + lastPara.lines.length - 1;
    const endLine = blockStart.line + endLineIdx;

    chunks.push({
      text: chunkLines.join("\n"),
      start: { line: startLine, col: 1 },
      end: endPosOfLine(endLine, lastPara.lines[lastPara.lines.length - 1]),
    });
    currentParas = [];
    currentSize = 0;
  }

  for (const para of paragraphs) {
    const paraText = para.lines.join("\n");
    const addedSize = paraText.length + (currentParas.length > 0 ? 2 : 0);

    if (currentSize + addedSize > maxChunkSize && currentParas.length > 0) {
      flushChunk();
    }

    if (paraText.length <= maxChunkSize) {
      currentParas.push(para);
      currentSize += addedSize;
    } else {
      flushChunk();
      const paraStart: Position = {
        line: blockStart.line + para.startLineIdx,
        col: 1,
      };
      const subChunks = splitLargeParagraph(paraText, paraStart, maxChunkSize);
      chunks.push(...subChunks);
    }
  }

  flushChunk();
  return chunks;
}

type LexMode = "text" | "inline-code" | "link-text" | "link-url";

function splitLargeParagraph(
  paragraph: string,
  paraStart: Position,
  maxChunkSize: number,
): SoftChunk[] {
  const units = lexParagraphIntoUnits(paragraph, paraStart);

  if (units.length <= 1) {
    return splitByCharacters(
      paragraph,
      paraStart,
      maxChunkSize,
      CHARACTER_SPLIT_OVERLAP,
    );
  }

  const chunks: SoftChunk[] = [];
  let currentUnits: Unit[] = [];
  let currentSize = 0;

  function flushUnits() {
    if (currentUnits.length === 0) return;
    const lastUnit = currentUnits[currentUnits.length - 1];
    chunks.push({
      text: currentUnits.map((u) => u.text).join(" "),
      start: currentUnits[0].start,
      end: lastUnit.end,
    });
    currentUnits = [];
    currentSize = 0;
  }

  for (const unit of units) {
    const addedSize = unit.size + (currentUnits.length > 0 ? 1 : 0);

    if (currentSize + addedSize > maxChunkSize && currentUnits.length > 0) {
      flushUnits();
    }

    if (unit.size <= maxChunkSize) {
      currentUnits.push(unit);
      currentSize += addedSize;
    } else {
      flushUnits();
      const subChunks = splitByCharacters(
        unit.text,
        unit.start,
        maxChunkSize,
        CHARACTER_SPLIT_OVERLAP,
      );
      chunks.push(...subChunks);
    }
  }

  flushUnits();
  return chunks;
}

export function lexParagraphIntoUnits(
  paragraph: string,
  paraStart: Position,
): Unit[] {
  const units: Unit[] = [];
  let mode: LexMode = "text";
  let currentText = "";
  let currentSize = 0;
  let i = 0;

  let currentLine = paraStart.line;
  let currentCol = paraStart.col;
  let unitStartLine = currentLine;
  let unitStartCol = currentCol;

  function flushUnit() {
    if (currentText.length > 0) {
      const lastLineOfUnit = currentText.split("\n");
      const endLine = unitStartLine + lastLineOfUnit.length - 1;
      const endCol =
        lastLineOfUnit.length === 1
          ? unitStartCol + lastLineOfUnit[0].length - 1
          : lastLineOfUnit[lastLineOfUnit.length - 1].length;

      units.push({
        text: currentText,
        size: currentSize,
        start: { line: unitStartLine, col: unitStartCol },
        end: { line: endLine, col: endCol || 1 },
      });
      currentText = "";
      currentSize = 0;
      unitStartLine = currentLine;
      unitStartCol = currentCol;
    }
  }

  while (i < paragraph.length) {
    const char = paragraph[i];

    switch (mode) {
      case "text": {
        if (char === "`") {
          mode = "inline-code";
          currentText += char;
          currentCol++;
          i++;
        } else if (char === "[") {
          mode = "link-text";
          currentText += char;
          currentCol++;
          i++;
        } else if (char === "\n") {
          flushUnit();
          currentLine++;
          currentCol = 1;
          unitStartLine = currentLine;
          unitStartCol = currentCol;
          i++;
        } else if (
          (char === "." || char === "!" || char === "?") &&
          i + 1 < paragraph.length &&
          /\s/.test(paragraph[i + 1])
        ) {
          currentText += char;
          currentSize += 1;
          currentCol++;
          flushUnit();
          i++;
          while (i < paragraph.length && /\s/.test(paragraph[i])) {
            if (paragraph[i] === "\n") {
              currentLine++;
              currentCol = 1;
            } else {
              currentCol++;
            }
            i++;
          }
          unitStartLine = currentLine;
          unitStartCol = currentCol;
        } else {
          currentText += char;
          currentSize += 1;
          currentCol++;
          i++;
        }
        break;
      }

      case "inline-code": {
        currentText += char;
        currentSize += 1;
        if (char === "\n") {
          currentLine++;
          currentCol = 1;
        } else {
          currentCol++;
        }
        i++;
        if (char === "`") {
          mode = "text";
        }
        break;
      }

      case "link-text": {
        currentText += char;
        if (char === "\n") {
          currentLine++;
          currentCol = 1;
        } else {
          currentCol++;
        }
        i++;
        if (char === "]" && i < paragraph.length && paragraph[i] === "(") {
          mode = "link-url";
          currentText += paragraph[i];
          currentCol++;
          i++;
        } else if (char === "\n") {
          mode = "text";
          flushUnit();
          unitStartLine = currentLine;
          unitStartCol = currentCol;
        }
        break;
      }

      case "link-url": {
        currentText += char;
        if (char === "\n") {
          currentLine++;
          currentCol = 1;
        } else {
          currentCol++;
        }
        i++;
        if (char === ")") {
          mode = "text";
        } else if (char === "\n") {
          mode = "text";
          flushUnit();
          unitStartLine = currentLine;
          unitStartCol = currentCol;
        }
        break;
      }
    }
  }

  flushUnit();
  return units;
}

export function splitByCharacters(
  text: string,
  start: Position,
  maxChunkSize: number,
  overlap: number = 0,
): SoftChunk[] {
  const chunks: SoftChunk[] = [];
  const step = maxChunkSize - overlap;

  if (step <= 0) {
    throw new Error("overlap must be less than maxChunkSize");
  }

  let i = 0;
  while (i < text.length) {
    const chunkText = text.slice(i, i + maxChunkSize);

    const chunkStart = positionAtOffset(text, start, i);
    const chunkEnd = positionAtOffset(text, start, i + chunkText.length - 1);

    chunks.push({
      text: chunkText,
      start: chunkStart,
      end: chunkEnd,
    });

    i += step;
  }
  return chunks;
}

function positionAtOffset(
  text: string,
  start: Position,
  offset: number,
): Position {
  let line = start.line;
  let col = start.col;

  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }

  return { line, col };
}

export function splitCodeBlockByLines(
  text: string,
  blockStart: Position,
  maxChunkSize: number,
): SoftChunk[] {
  if (text.length <= maxChunkSize) {
    const lines = text.split("\n");
    const lastLine = lines[lines.length - 1];
    return [
      {
        text,
        start: blockStart,
        end: endPosOfLine(blockStart.line + lines.length - 1, lastLine),
      },
    ];
  }

  const lines = text.split("\n");
  const chunks: SoftChunk[] = [];
  let currentLines: string[] = [];
  let currentSize = 0;
  let chunkStartLineIdx = 0;

  function flushChunk() {
    if (currentLines.length === 0) return;
    const chunkText = currentLines.join("\n");
    const lastLine = currentLines[currentLines.length - 1];
    chunks.push({
      text: chunkText,
      start: { line: blockStart.line + chunkStartLineIdx, col: 1 },
      end: endPosOfLine(
        blockStart.line + chunkStartLineIdx + currentLines.length - 1,
        lastLine,
      ),
    });
    currentLines = [];
    currentSize = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const addedSize = line.length + (currentLines.length > 0 ? 1 : 0);

    if (currentSize + addedSize > maxChunkSize && currentLines.length > 0) {
      flushChunk();
      chunkStartLineIdx = i;
    }

    if (line.length <= maxChunkSize) {
      currentLines.push(line);
      currentSize += addedSize;
    } else {
      flushChunk();
      chunkStartLineIdx = i;
      const lineStart: Position = { line: blockStart.line + i, col: 1 };
      const subChunks = splitByCharacters(
        line,
        lineStart,
        maxChunkSize,
        CHARACTER_SPLIT_OVERLAP,
      );
      chunks.push(...subChunks);
      chunkStartLineIdx = i + 1;
    }
  }

  flushChunk();
  return chunks;
}

export function chunkMarkdown(
  text: string,
  maxChunkSize: number = TARGET_CHUNK_SIZE,
): ChunkInfo[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const hardBlocks = splitIntoHardBlocks(text);
  const chunks: ChunkInfo[] = [];

  for (const block of hardBlocks) {
    // Strip leading heading line from text if this block starts with a heading
    let blockText = block.text;
    let blockStart = block.start;
    const firstLine = blockText.split("\n")[0];
    if (isHeading(firstLine)) {
      const newlineIdx = blockText.indexOf("\n");
      if (newlineIdx !== -1) {
        blockText = blockText.slice(newlineIdx + 1);
        blockStart = { line: block.start.line + 1, col: 1 };
      } else {
        // Block is just the heading, skip it
        continue;
      }
    }

    if (blockText.trim().length === 0) {
      continue;
    }

    // Split non-code blocks if needed
    const subChunks = softSplitBlock(blockText, blockStart, maxChunkSize);

    for (const subChunk of subChunks) {
      const chunk: ChunkInfo = {
        text: subChunk.text,
        start: subChunk.start,
        end: subChunk.end,
      };
      if (block.headingContext) {
        chunk.headingContext = block.headingContext;
      }
      chunks.push(chunk);
    }
  }

  return chunks;
}
