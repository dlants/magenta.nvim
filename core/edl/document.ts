import type { Pos, Range } from "./types.ts";

export class Document {
  private _content: string;
  /** Byte offset of each line start (0-indexed line numbers internally) */
  private _lineStarts: number[];

  constructor(content: string) {
    this._content = content;
    this._lineStarts = computeLineStarts(content);
  }

  get content(): string {
    return this._content;
  }

  get lineCount(): number {
    return this._lineStarts.length;
  }
  get lineStarts(): readonly number[] {
    return this._lineStarts;
  }

  posToOffset(pos: Pos): number {
    const idx = pos.line - 1;
    if (idx < 0 || idx >= this._lineStarts.length) {
      throw new Error(`Line ${pos.line} out of range (1-${this.lineCount})`);
    }
    return this._lineStarts[idx] + pos.col;
  }

  offsetToPos(offset: number): Pos {
    let lo = 0;
    let hi = this._lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo + 1, col: offset - this._lineStarts[lo] };
  }

  lineRange(line: number): Range {
    const idx = line - 1;
    if (idx < 0 || idx >= this._lineStarts.length) {
      throw new Error(`Line ${line} out of range (1-${this.lineCount})`);
    }
    const start = this._lineStarts[idx];
    const end =
      idx + 1 < this._lineStarts.length
        ? this._lineStarts[idx + 1] - 1 // exclude the \n
        : this._content.length;
    return { start, end };
  }

  /** Full document range */
  fullRange(): Range {
    return { start: 0, end: this._content.length };
  }

  getText(range: Range): string {
    return this._content.slice(range.start, range.end);
  }

  splice(range: Range, replacement: string): void {
    this._content =
      this._content.slice(0, range.start) +
      replacement +
      this._content.slice(range.end);
    this._lineStarts = computeLineStarts(this._content);
  }
}

function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}
