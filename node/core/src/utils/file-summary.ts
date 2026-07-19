export type Chunk = {
  text: string;
  line: number;
  /** Last source line covered by this chunk. Defaults to `line` for single-line
   * chunks; larger when a scope-opening line was grouped with its body. */
  endLine?: number;
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
// How much a scope-opening line's size boosts its score. scopeBonus grows with
// sqrt(scopeSize), so a block twice as long is ~1.4x as significant (not 2x).
const SCOPE_WEIGHT = 1.5;
// How much each level of indentation dampens a line's score. Kept small so that
// nested block headers (e.g. methods) still compete with top-level lines.
const INDENT_PENALTY = 0.15;

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

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.length > MAX_CHUNK_CHARS) {
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
          endLine: i + 1,
          col,
          tokens: buildFrequencyTable(tokenize(text)),
        });
        col = end;
      }
      i++;
      continue;
    }

    // If this non-blank line opens a scope, group it with the following
    // in-scope lines until we're about to cross the max-chunk threshold. Blank
    // lines are skipped as headers: they have indent 0, so they'd otherwise
    // swallow the whole following indented block.
    if (line.trim().length > 0 && computeScopeSize(lines, i) > 0) {
      const baseIndent = getIndentLevel(line);
      let lastLine = i;
      let lenSoFar = line.length;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        const isBlank = next.trim().length === 0;
        if (!isBlank && getIndentLevel(next) <= baseIndent) break;
        if (lenSoFar + 1 + next.length > MAX_CHUNK_CHARS) break;
        lenSoFar += 1 + next.length;
        // Only extend the chunk to non-blank lines so we don't keep trailing
        // blanks; consumed blanks get reprocessed (and filtered as empty).
        if (!isBlank) lastLine = j;
        j++;
      }
      const text = lines.slice(i, lastLine + 1).join("\n");
      chunks.push({
        text,
        line: i + 1,
        endLine: lastLine + 1,
        col: 0,
        tokens: buildFrequencyTable(tokenize(text)),
      });
      // Advance past every consumed line (j is the first line not folded into
      // this chunk) so no source line ends up in two chunks. Trailing blank
      // lines between lastLine and j are dropped rather than re-chunked.
      i = j;
      continue;
    }

    chunks.push({
      text: line,
      line: i + 1,
      endLine: i + 1,
      col: 0,
      tokens: buildFrequencyTable(tokenize(line)),
    });
    i++;
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
): number {
  if (chunk.tokens.size === 0) return 0;

  // Surprise: total self-information carried by the line. Using the sum (not the
  // average) means a nearly contentless line like `if (` scores low even when it
  // opens a large scope, while a signature packed with rare identifiers scores
  // high.
  let surprise = 0;
  for (const [token, count] of chunk.tokens) {
    const freq = freqTable.get(token) ?? 1;
    const selfInfo = -Math.log2(freq / totalTokens);
    surprise += selfInfo * count;
  }

  // Scope bonus: larger enclosed blocks (class/function headers) matter more,
  // but with diminishing returns.
  const scopeBonus = SCOPE_WEIGHT * Math.sqrt(scopeSize);

  // Indentation weight: mild penalty per indent level.
  const indentLevel = getIndentLevel(chunk.text);
  const indentWeight = 1 / (1 + INDENT_PENALTY * indentLevel);

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
    // Skip chunks with no informative content (e.g. blank lines). These have
    // zero length, so they'd otherwise always fit the budget and clutter the
    // summary with empty lines between omitted-gap markers.
    if (scores[idx] <= 0) continue;
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

  const scores: number[] = [];
  for (const chunk of chunks) {
    const scopeSize = computeScopeSize(lines, chunk.line - 1);
    const score = scoreChunk(chunk, freqTable, totalTokens, scopeSize);
    scores.push(score);
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

  let prevLine: number | null = null;

  for (const chunk of selectedChunks) {
    if (chunk.col > 0) {
      // Sub-chunk continuation of the same source line.
      parts.push(chunk.text);
      continue;
    }
    // Emit a line-number header at the start of each contiguous run.
    if (prevLine === null || chunk.line !== prevLine + 1) {
      parts.push(`L${chunk.line}`);
    }
    parts.push(chunk.text);
    prevLine = chunk.endLine ?? chunk.line;
  }

  return parts.join("\n");
}
