import { it, expect, describe } from "vitest";
import {
  chunkMarkdown,
  splitIntoParagraphs,
  splitByCharacters,
  lexParagraphIntoUnits,
  splitCodeBlockByLines,
} from "./chunker.ts";

it("should return a single chunk for short text", () => {
  const text = "Hello world\nThis is a test";
  const chunks = chunkMarkdown(text, 100);

  expect(chunks).toMatchInlineSnapshot(`
    [
      {
        "end": {
          "col": 14,
          "line": 2,
        },
        "start": {
          "col": 1,
          "line": 1,
        },
        "text": "Hello world
    This is a test",
      },
    ]
  `);
});

describe("splitIntoParagraphs", () => {
  it("should return empty array for empty input", () => {
    expect(splitIntoParagraphs([])).toEqual([]);
  });

  it("should return single paragraph for lines without blanks", () => {
    const lines = ["line 1", "line 2", "line 3"];
    expect(splitIntoParagraphs(lines)).toMatchInlineSnapshot(`
      [
        {
          "lines": [
            "line 1",
            "line 2",
            "line 3",
          ],
          "startLineIdx": 0,
        },
      ]
    `);
  });

  it("should split on blank lines", () => {
    const lines = ["para 1 line 1", "para 1 line 2", "", "para 2 line 1"];
    expect(splitIntoParagraphs(lines)).toMatchInlineSnapshot(`
      [
        {
          "lines": [
            "para 1 line 1",
            "para 1 line 2",
          ],
          "startLineIdx": 0,
        },
        {
          "lines": [
            "para 2 line 1",
          ],
          "startLineIdx": 3,
        },
      ]
    `);
  });

  it("should handle multiple consecutive blank lines", () => {
    const lines = ["para 1", "", "", "", "para 2"];
    expect(splitIntoParagraphs(lines)).toMatchInlineSnapshot(`
      [
        {
          "lines": [
            "para 1",
          ],
          "startLineIdx": 0,
        },
        {
          "lines": [
            "para 2",
          ],
          "startLineIdx": 4,
        },
      ]
    `);
  });

  it("should handle whitespace-only lines as blank", () => {
    const lines = ["para 1", "   ", "para 2"];
    expect(splitIntoParagraphs(lines)).toMatchInlineSnapshot(`
      [
        {
          "lines": [
            "para 1",
          ],
          "startLineIdx": 0,
        },
        {
          "lines": [
            "para 2",
          ],
          "startLineIdx": 2,
        },
      ]
    `);
  });

  it("should handle leading blank lines", () => {
    const lines = ["", "", "para 1"];
    expect(splitIntoParagraphs(lines)).toMatchInlineSnapshot(`
      [
        {
          "lines": [
            "para 1",
          ],
          "startLineIdx": 2,
        },
      ]
    `);
  });

  it("should handle trailing blank lines", () => {
    const lines = ["para 1", "", ""];
    expect(splitIntoParagraphs(lines)).toMatchInlineSnapshot(`
      [
        {
          "lines": [
            "para 1",
          ],
          "startLineIdx": 0,
        },
      ]
    `);
  });
});

describe("splitByCharacters", () => {
  it("should return single chunk for text smaller than max", () => {
    const result = splitByCharacters("hello", { line: 1, col: 1 }, 100);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 5,
            "line": 1,
          },
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "hello",
        },
      ]
    `);
  });

  it("should split text into chunks of max size", () => {
    const result = splitByCharacters("abcdefghij", { line: 1, col: 1 }, 4);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 4,
            "line": 1,
          },
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "abcd",
        },
        {
          "end": {
            "col": 8,
            "line": 1,
          },
          "start": {
            "col": 5,
            "line": 1,
          },
          "text": "efgh",
        },
        {
          "end": {
            "col": 10,
            "line": 1,
          },
          "start": {
            "col": 9,
            "line": 1,
          },
          "text": "ij",
        },
      ]
    `);
  });

  it("should handle newlines in text", () => {
    const result = splitByCharacters("ab\ncd\nef", { line: 1, col: 1 }, 4);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 1,
            "line": 2,
          },
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "ab
      c",
        },
        {
          "end": {
            "col": 2,
            "line": 3,
          },
          "start": {
            "col": 2,
            "line": 2,
          },
          "text": "d
      ef",
        },
      ]
    `);
  });

  it("should respect starting position", () => {
    const result = splitByCharacters("hello", { line: 5, col: 10 }, 100, 0);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 14,
            "line": 5,
          },
          "start": {
            "col": 10,
            "line": 5,
          },
          "text": "hello",
        },
      ]
    `);
  });

  it("should create overlapping chunks when overlap is specified", () => {
    const result = splitByCharacters("abcdefghij", { line: 1, col: 1 }, 4, 2);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 4,
            "line": 1,
          },
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "abcd",
        },
        {
          "end": {
            "col": 6,
            "line": 1,
          },
          "start": {
            "col": 3,
            "line": 1,
          },
          "text": "cdef",
        },
        {
          "end": {
            "col": 8,
            "line": 1,
          },
          "start": {
            "col": 5,
            "line": 1,
          },
          "text": "efgh",
        },
        {
          "end": {
            "col": 10,
            "line": 1,
          },
          "start": {
            "col": 7,
            "line": 1,
          },
          "text": "ghij",
        },
        {
          "end": {
            "col": 10,
            "line": 1,
          },
          "start": {
            "col": 9,
            "line": 1,
          },
          "text": "ij",
        },
      ]
    `);
  });

  it("should throw if overlap >= maxChunkSize", () => {
    expect(() => splitByCharacters("test", { line: 1, col: 1 }, 4, 4)).toThrow(
      "overlap must be less than maxChunkSize",
    );
  });
});

describe("splitCodeBlockByLines", () => {
  it("should return single chunk for small code block", () => {
    const result = splitCodeBlockByLines(
      "line1\nline2",
      { line: 1, col: 1 },
      100,
    );
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 5,
            "line": 2,
          },
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "line1
      line2",
        },
      ]
    `);
  });

  it("should split by lines when exceeding max size", () => {
    const result = splitCodeBlockByLines(
      "line1\nline2\nline3",
      { line: 1, col: 1 },
      12,
    );
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 5,
            "line": 2,
          },
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "line1
      line2",
        },
        {
          "end": {
            "col": 5,
            "line": 3,
          },
          "start": {
            "col": 1,
            "line": 3,
          },
          "text": "line3",
        },
      ]
    `);
  });

  it("should fall back to character splitting for long lines", () => {
    // 600 chars with 300 chunk size and 200 overlap (step=100) = 6 chunks
    const longLine = "a".repeat(600);
    const result = splitCodeBlockByLines(longLine, { line: 1, col: 1 }, 300);
    expect(result.length).toBe(6);
    expect(result[0].text.length).toBe(300);
    expect(result[0].start).toEqual({ line: 1, col: 1 });
    expect(result[0].end).toEqual({ line: 1, col: 300 });
    // Second chunk starts at 101 (step=100, 0-indexed pos 100 = col 101)
    expect(result[1].start).toEqual({ line: 1, col: 101 });
    expect(result[1].text.length).toBe(300);
  });

  it("should handle mix of normal and long lines", () => {
    const shortLine = "short line here";
    // 400 chars with step=100 = 4 chunks for long line
    const longLine = "a".repeat(400);
    const endLine = "end";
    const text = `${shortLine}\n${longLine}\n${endLine}`;
    const result = splitCodeBlockByLines(text, { line: 1, col: 1 }, 300);
    // 1 short + 4 long line chunks + 1 end = 6
    expect(result.length).toBe(6);
    expect(result[0].text).toBe(shortLine);
    expect(result[0].start).toEqual({ line: 1, col: 1 });
    // Long line gets split with overlap
    expect(result[1].text.length).toBe(300);
    expect(result[1].start).toEqual({ line: 2, col: 1 });
    expect(result[2].start).toEqual({ line: 2, col: 101 });
    // End line
    expect(result[5].text).toBe(endLine);
    expect(result[5].start).toEqual({ line: 3, col: 1 });
  });

  it("should respect starting position", () => {
    const result = splitCodeBlockByLines("a\nb", { line: 5, col: 1 }, 100);
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 1,
            "line": 6,
          },
          "start": {
            "col": 1,
            "line": 5,
          },
          "text": "a
      b",
        },
      ]
    `);
  });
});

describe("lexParagraphIntoUnits", () => {
  it("should split by sentences", () => {
    const result = lexParagraphIntoUnits("Hello world. Goodbye world.", {
      line: 1,
      col: 1,
    });
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 12,
            "line": 1,
          },
          "size": 12,
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "Hello world.",
        },
        {
          "end": {
            "col": 27,
            "line": 1,
          },
          "size": 14,
          "start": {
            "col": 14,
            "line": 1,
          },
          "text": "Goodbye world.",
        },
      ]
    `);
  });

  it("should keep inline code together", () => {
    const result = lexParagraphIntoUnits("Use `const x = 1` here.", {
      line: 1,
      col: 1,
    });
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 23,
            "line": 1,
          },
          "size": 22,
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "Use \`const x = 1\` here.",
        },
      ]
    `);
  });

  it("should keep markdown links together with URL not counting toward size", () => {
    const result = lexParagraphIntoUnits(
      "Check [this link](https://example.com/very/long/url) out.",
      { line: 1, col: 1 },
    );
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 57,
            "line": 1,
          },
          "size": 11,
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "Check [this link](https://example.com/very/long/url) out.",
        },
      ]
    `);
  });

  it("should split on newlines", () => {
    const result = lexParagraphIntoUnits("Line one.\nLine two.", {
      line: 1,
      col: 1,
    });
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 9,
            "line": 1,
          },
          "size": 9,
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "Line one.",
        },
        {
          "end": {
            "col": 9,
            "line": 2,
          },
          "size": 9,
          "start": {
            "col": 1,
            "line": 2,
          },
          "text": "Line two.",
        },
      ]
    `);
  });

  it("should handle question marks and exclamation marks as sentence boundaries", () => {
    const result = lexParagraphIntoUnits("What? Yes! Maybe.", {
      line: 1,
      col: 1,
    });
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 5,
            "line": 1,
          },
          "size": 5,
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "What?",
        },
        {
          "end": {
            "col": 10,
            "line": 1,
          },
          "size": 4,
          "start": {
            "col": 7,
            "line": 1,
          },
          "text": "Yes!",
        },
        {
          "end": {
            "col": 17,
            "line": 1,
          },
          "size": 6,
          "start": {
            "col": 12,
            "line": 1,
          },
          "text": "Maybe.",
        },
      ]
    `);
  });

  it("should not split on punctuation inside inline code", () => {
    const result = lexParagraphIntoUnits(
      "Run `console.log('hello!'); return x.y.z;` then exit.",
      { line: 1, col: 1 },
    );
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 53,
            "line": 1,
          },
          "size": 52,
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "Run \`console.log('hello!'); return x.y.z;\` then exit.",
        },
      ]
    `);
  });

  it("should not split on punctuation inside URLs", () => {
    const result = lexParagraphIntoUnits(
      "See [docs](https://example.com/path?foo=bar!&x=y.) here.",
      { line: 1, col: 1 },
    );
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "end": {
            "col": 56,
            "line": 1,
          },
          "size": 10,
          "start": {
            "col": 1,
            "line": 1,
          },
          "text": "See [docs](https://example.com/path?foo=bar!&x=y.) here.",
        },
      ]
    `);
  });
});

it("should handle empty text", () => {
  const chunks = chunkMarkdown("", 100);
  expect(chunks).toMatchInlineSnapshot(`[]`);
});

it("should capture heading context for chunks", () => {
  const text = `# Main Title

Some content under main.

## Subsection

Content in subsection.`;

  const chunks = chunkMarkdown(text, 2000);

  expect(chunks).toMatchInlineSnapshot(`
    [
      {
        "end": {
          "col": 1,
          "line": 4,
        },
        "headingContext": "# Main Title",
        "start": {
          "col": 1,
          "line": 2,
        },
        "text": "
    Some content under main.
    ",
      },
      {
        "end": {
          "col": 22,
          "line": 7,
        },
        "headingContext": "# Main Title > ## Subsection",
        "start": {
          "col": 1,
          "line": 6,
        },
        "text": "
    Content in subsection.",
      },
    ]
  `);
});

it("should update heading hierarchy correctly", () => {
  const text = `# H1

## H2A

Content A

## H2B

Content B

### H3

Deep content`;

  const chunks = chunkMarkdown(text, 2000);

  expect(chunks).toMatchInlineSnapshot(`
    [
      {
        "end": {
          "col": 1,
          "line": 6,
        },
        "headingContext": "# H1 > ## H2A",
        "start": {
          "col": 1,
          "line": 4,
        },
        "text": "
    Content A
    ",
      },
      {
        "end": {
          "col": 1,
          "line": 10,
        },
        "headingContext": "# H1 > ## H2B",
        "start": {
          "col": 1,
          "line": 8,
        },
        "text": "
    Content B
    ",
      },
      {
        "end": {
          "col": 12,
          "line": 13,
        },
        "headingContext": "# H1 > ## H2B > ### H3",
        "start": {
          "col": 1,
          "line": 12,
        },
        "text": "
    Deep content",
      },
    ]
  `);
});

it("should not split code blocks", () => {
  const codeBlock = "```typescript\nconst x = 1;\n```";
  const text = `# Code Example

${codeBlock}

Some text after.`;

  const chunks = chunkMarkdown(text, 50);

  expect(chunks).toMatchInlineSnapshot(`
    [
      {
        "end": {
          "col": 3,
          "line": 5,
        },
        "headingContext": "# Code Example",
        "start": {
          "col": 1,
          "line": 3,
        },
        "text": "\`\`\`typescript
    const x = 1;
    \`\`\`",
      },
      {
        "end": {
          "col": 16,
          "line": 7,
        },
        "headingContext": "# Code Example",
        "start": {
          "col": 1,
          "line": 6,
        },
        "text": "
    Some text after.",
      },
    ]
  `);
});

it("should handle frontmatter", () => {
  const text = `---
title: Test Doc
tags: [test, example]
---

# Main Content

Body text here.`;

  const chunks = chunkMarkdown(text, 2000);

  expect(chunks).toMatchInlineSnapshot(`
    [
      {
        "end": {
          "col": 1,
          "line": 5,
        },
        "start": {
          "col": 1,
          "line": 1,
        },
        "text": "---
    title: Test Doc
    tags: [test, example]
    ---
    ",
      },
      {
        "end": {
          "col": 15,
          "line": 8,
        },
        "headingContext": "# Main Content",
        "start": {
          "col": 1,
          "line": 7,
        },
        "text": "
    Body text here.",
      },
    ]
  `);
});

it("should split large paragraphs by sentences", () => {
  const longPara = "This is sentence one. ".repeat(10);
  const text = `# Title

${longPara}`;

  const chunks = chunkMarkdown(text, 100);

  expect(chunks).toMatchInlineSnapshot(`
    [
      {
        "end": {
          "col": 87,
          "line": 3,
        },
        "headingContext": "# Title",
        "start": {
          "col": 1,
          "line": 3,
        },
        "text": "This is sentence one. This is sentence one. This is sentence one. This is sentence one.",
      },
      {
        "end": {
          "col": 175,
          "line": 3,
        },
        "headingContext": "# Title",
        "start": {
          "col": 89,
          "line": 3,
        },
        "text": "This is sentence one. This is sentence one. This is sentence one. This is sentence one.",
      },
      {
        "end": {
          "col": 219,
          "line": 3,
        },
        "headingContext": "# Title",
        "start": {
          "col": 177,
          "line": 3,
        },
        "text": "This is sentence one. This is sentence one.",
      },
    ]
  `);
});

it("should correctly calculate positions", () => {
  const text = `# Title

Line 3 content.

Line 5 content.`;

  const chunks = chunkMarkdown(text, 2000);

  expect(chunks).toMatchInlineSnapshot(`
    [
      {
        "end": {
          "col": 15,
          "line": 5,
        },
        "headingContext": "# Title",
        "start": {
          "col": 1,
          "line": 2,
        },
        "text": "
    Line 3 content.

    Line 5 content.",
      },
    ]
  `);
});
