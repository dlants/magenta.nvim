export type Chunk = {
  text: string;
  line: number;
  col: number;
  tokens: Map<string, number>;
};

export type FileSummary = {
  totalLines: number;
  totalChars: number;
  selectedChunks: Chunk[];
};

const TOKEN_PATTERN = /[a-zA-Z0-9_]+/g;
const MAX_CHUNK_CHARS = 200;
const SUB_CHUNK_TARGET = 100;
const FIRST_OCCURRENCE_BONUS = 2;

export function tokenize(text: string): string[] {
  return Array.from(text.matchAll(TOKEN_PATTERN), (m) => m[0]);
}

export function buildFrequencyTable(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  return freq;
}

export function chunkFile(content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        text: line,
        line: i + 1,
        col: 0,
        tokens: buildFrequencyTable(tokenize(line)),
      });
    } else {
      // Split long lines into sub-chunks at token boundaries
      let col = 0;
      while (col < line.length) {
        let end = Math.min(col + SUB_CHUNK_TARGET, line.length);
        // Try to break at a word boundary if not at end of line
        if (end < line.length) {
          const boundary = line.lastIndexOf(" ", end);
          if (boundary > col) {
            end = boundary + 1;
          }
        }
        const text = line.slice(col, end);
        chunks.push({
          text,
          line: i + 1,
          col,
          tokens: buildFrequencyTable(tokenize(text)),
        });
        col = end;
      }
    }
  }

  return chunks;
}

export function computeScopeSize(lines: string[], lineIndex: number): number {
  const baseIndent = getIndentLevel(lines[lineIndex]);
  let count = 0;
  for (let i = lineIndex + 1; i < lines.length; i++) {
    // Skip blank lines
    if (lines[i].trim().length === 0) continue;
    const indent = getIndentLevel(lines[i]);
    if (indent <= baseIndent) break;
    count++;
  }
  return count;
}

function getIndentLevel(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

export function scoreChunk(
  chunk: Chunk,
  freqTable: Map<string, number>,
  totalTokens: number,
  scopeSize: number,
  seenTokens: Set<string>,
): number {
  if (chunk.tokens.size === 0) return 0;

  // Surprise: average self-information with first-occurrence bonus
  let totalSurprise = 0;
  let totalCount = 0;
  for (const [token, count] of chunk.tokens) {
    const freq = freqTable.get(token) ?? 1;
    const selfInfo = -Math.log2(freq / totalTokens);
    const multiplier = seenTokens.has(token) ? 1 : FIRST_OCCURRENCE_BONUS;
    totalSurprise += selfInfo * multiplier * count;
    totalCount += count;
  }
  const surprise = totalCount === 0 ? 0 : totalSurprise / totalCount;

  // Scope bonus
  const scopeBonus = Math.log2(1 + scopeSize);

  // Indentation weight
  const indentLevel = getIndentLevel(chunk.text);
  const indentWeight = 1 / (1 + indentLevel);

  return surprise * (1 + scopeBonus) * indentWeight;
}

export function selectChunks(
  chunks: Chunk[],
  scores: number[],
  charBudget: number,
): Chunk[] {
  if (chunks.length === 0) return [];

  // Create indices sorted by score descending
  const indices = chunks.map((_, i) => i);
  indices.sort((a, b) => scores[b] - scores[a]);

  const selected = new Set<number>();
  // Always include the first chunk
  selected.add(0);
  let totalChars = chunks[0].text.length;

  for (const idx of indices) {
    if (selected.has(idx)) continue;
    const chunkChars = chunks[idx].text.length;
    if (totalChars + chunkChars > charBudget) continue;
    selected.add(idx);
    totalChars += chunkChars;
  }

  // Return in file order
  return Array.from(selected)
    .sort((a, b) => a - b)
    .map((i) => chunks[i]);
}

export function summarizeFile(
  content: string,
  options?: { charBudget?: number },
): FileSummary {
  const charBudget = options?.charBudget ?? 10000;
  const lines = content.split("\n");
  const totalLines = lines.length;
  const totalChars = content.length;

  const chunks = chunkFile(content);
  if (chunks.length === 0) {
    return { totalLines, totalChars, selectedChunks: [] };
  }

  // If the file fits in the budget, return all chunks
  if (totalChars <= charBudget) {
    return { totalLines, totalChars, selectedChunks: chunks };
  }

  const allTokens = tokenize(content);
  const freqTable = buildFrequencyTable(allTokens);
  const totalTokens = allTokens.length;

  // Track first occurrences for bonus scoring
  const seenTokens = new Set<string>();

  const scores: number[] = [];
  for (const chunk of chunks) {
    const scopeSize = computeScopeSize(lines, chunk.line - 1);
    const score = scoreChunk(
      chunk,
      freqTable,
      totalTokens,
      scopeSize,
      seenTokens,
    );
    scores.push(score);
    for (const token of chunk.tokens.keys()) {
      seenTokens.add(token);
    }
  }

  const selectedChunks = selectChunks(chunks, scores, charBudget);
  return { totalLines, totalChars, selectedChunks };
}

export function formatSummary(summary: FileSummary): string {
  const { totalLines, totalChars, selectedChunks } = summary;
  if (selectedChunks.length === 0) {
    return `[File summary: ${totalLines} lines, ${totalChars} chars (empty)]`;
  }

  const parts: string[] = [];
  parts.push(
    `[File summary: ${totalLines} lines, ${totalChars} chars. Showing ${selectedChunks.length} key segments]`,
  );

  const lineNumWidth = String(totalLines).length;

  let prevEndLine = 0;

  for (const chunk of selectedChunks) {
    // Gap summary
    if (chunk.line > prevEndLine + 1) {
      const gapLines = chunk.line - prevEndLine - 1;
      parts.push(`  ... (${gapLines} lines omitted) ...`);
    }

    const lineStr = String(chunk.line).padStart(lineNumWidth);
    if (chunk.col > 0) {
      parts.push(`${lineStr}:${chunk.col}| ${chunk.text}`);
    } else {
      parts.push(`${lineStr}| ${chunk.text}`);
    }

    prevEndLine = chunk.line;
  }

  // Trailing gap
  if (prevEndLine < totalLines) {
    const gapLines = totalLines - prevEndLine;
    parts.push(`  ... (${gapLines} lines omitted) ...`);
  }

  return parts.join("\n");
}
