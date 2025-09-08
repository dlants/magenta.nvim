# PDF Page-Based Resource Management

## Overview

Replace the current full-PDF text extraction approach with on-demand binary page extraction that preserves exact PDF formatting while using context efficiently.

## Current State

- PDFs are processed with `extractPdfText()` in `node/utils/pdf.ts`
- Full text extraction loses visual elements, formatting, and structure
- Large PDFs consume excessive context space

### Page-Level Access Approach

- Extract individual pages as binary PDF chunks
- Preserve all visual elements and formatting
- Support base64 encoding for AI consumption

## Implementation Plan

### Task 1: PDF Page Extraction Library

**File**: `node/utils/pdf-pages.ts`

**Dependencies**:

- [x] Install pdf-lib: `npm install pdf-lib`

**Interface**:

```typescript
async function extractPDFPage(
  filePath: AbsFilePath,
  pageIndex: number,
): Promise<Result<Uint8Array>>;

async function getPDFPageCount(filePath: AbsFilePath): Promise<Result<number>>;
```

**Implementation**:

- [x] Use pdf-lib's `copyPages()` method for single page binary extraction
- [x] Maintain all dependencies, fonts, and cross-references
- [x] Focus on single page extraction for simplicity

### Task 2: Context Manager Integration

**File**: `node/context/context-manager.ts`

#### New PDF Handling Strategy

**Extended Agent View**:

```typescript
// Extend existing agentView union type
type AgentView =
  | { type: "text"; content: string }
  | { type: "binary"; mtime: number }
  | {
      type: "pdf";
      summary: boolean;
      pages: number[];
      supportsPageExtraction: boolean;
    }; // NEW
```

- [x] **Static Content Assumption**: PDF contents don't change, so we only track what's been sent, not file modification times

#### Tool Integration

**Enhanced Tool**: `get-file`

```typescript
interface GetFileParams {
  filePath: string;
  pdfPage?: number; // 0-based page index for PDF files
}
```

- For PDFs without `pdfPage`: Return basic metadata if supports page extraction, otherwise extracted text
- For PDFs with `pdfPage`: Return specific page as base64 binary content (only if supports page extraction)
- Include page count and basic document information

### Task 3: Message Content Generation

**File**: `node/context/context-manager.ts`

**PDF Basic Messages**:

```typescript
function pdfBasicToContent(
  filePath: AbsFilePath,
  pageCount: number,
): ProviderMessageContent[] {
  return [
    {
      type: "text",
      text: `PDF Document: ${filePath}
Pages: ${pageCount}

Use get-file tool with a pdfPage parameter to access specific pages.`,
    },
  ];
}
```

- [x] **PDF Page Messages**:

```typescript
function pdfPageToContent(
  pageData: Uint8Array,
  pageIndex: number,
  filePath: AbsFilePath,
): ProviderMessageContent[] {
  return [
    {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: pageData.toString("base64"),
      },
      title: `${filePath} - Page ${pageIndex + 1}`,
    },
  ];
}
```

### Task 4: Tool Implementation

**File**: `node/tools/getFile.ts`

**Enhanced Tool**:

- [x] Update the existing `get_file` tool to support PDF page extraction:

```typescript
export const spec: ProviderToolSpec = {
  ...
  input_schema: {
    type: "object",
    properties: {
    ...
      pdfPage: {
        type: "number",
        description:
          "For PDF files only: 0-based page index to extract as binary content.",
      },
    },
    required: ["filePath"],
  },
};
```
