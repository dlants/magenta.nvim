# Mock Provider Refactor: Stream-Based Testing

## Overview

The mock provider was refactored from a request-based pattern to a stream-based pattern that more closely mirrors how `AnthropicProviderThread` works internally.

## Key Changes

### 1. Method Renames

- `awaitPendingRequest()` → `awaitPendingStream()`
- `awaitPendingRequestWithText()` → `awaitPendingStreamWithText()`

### 2. Message Access

The mock stream exposes `stream.messages` which contains the Anthropic-formatted messages (`Anthropic.MessageParam[]`), not our internal `ProviderMessage[]` format.

### 3. Tool Result Content Structure

**Important**: Anthropic's `ToolResultBlockParam` has a different structure than our internal `ProviderToolResult`:

```typescript
// Our internal format (ProviderToolResult):
{
  type: "tool_result",
  id: ToolRequestId,
  result: {
    status: "ok" | "error",
    value: ProviderToolResultContent[], // nested here
    error?: string,
  }
}

// Anthropic format (ToolResultBlockParam):
{
  type: "tool_result",
  tool_use_id: string,
  content: string | ContentBlockParam[],  // different field name
  is_error?: boolean,                      // different error indicator
}
```

### 4. Document Blocks are Siblings, Not Nested

When `AnthropicProviderThread.convertToolResultToNative()` processes documents, it adds them as **sibling blocks** in the user message, not nested inside `tool_result.content`:

```typescript
// User message content array:
[
  { type: "tool_result", tool_use_id: "...", content: [], is_error: false },
  { type: "document", source: {...}, title: "..." }  // <-- sibling, not nested!
]
```

This is intentional per Anthropic API requirements. See the comment in `anthropic-thread.ts`:

```typescript
case "document":
  // Documents need special handling - return as separate blocks
  // For now, skip and handle documents separately below
  break;
```

### 5. Helper Function Updates

The helper functions in `node/test/preamble.ts` were updated to work with Anthropic's `ToolResultBlockParam` format:

```typescript
// Old signature:
function assertToolResultContainsText(
  toolResult: ProviderToolResult,
  text: string,
);

// New signature:
function assertToolResultContainsText(
  toolResult: ToolResultBlockParam,
  text: string,
);
```

### 6. Type Imports for Tests

When updating test files, you may need to add these type imports:

```typescript
import type Anthropic from "@anthropic-ai/sdk";

type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type TextBlockParam = Anthropic.Messages.TextBlockParam;
type DocumentBlockParam = Anthropic.Messages.DocumentBlockParam;
```

### 7. Finding Tool Results in Messages

To find a tool result in the stream messages:

```typescript
const stream = await driver.mockAnthropic.awaitPendingStream();

// Find user message containing the tool result
let userMessageContent: ContentBlockParam[] | undefined;
for (const msg of stream.messages) {
  if (msg.role === "user" && Array.isArray(msg.content)) {
    const content = msg.content as ContentBlockParam[];
    const hasToolResult = content.some(
      (block: ContentBlockParam) => block.type === "tool_result",
    );
    if (hasToolResult) userMessageContent = content;
  }
}

// Get the tool result block
const toolResult = userMessageContent.find(
  (block: ContentBlockParam) => block.type === "tool_result",
) as ToolResultBlockParam;

// Check for errors
expect(toolResult.is_error).toBeFalsy();

// Access content (note: might be string or array)
if (Array.isArray(toolResult.content)) {
  const textContent = toolResult.content.find(
    (item: ContentBlockParam) => item.type === "text",
  ) as TextBlockParam;
}
```

### 8. Checking Error Results

```typescript
// Anthropic format for errors:
expect(toolResult.is_error).toBe(true);
const errorContent =
  typeof toolResult.content === "string"
    ? toolResult.content
    : JSON.stringify(toolResult.content);
expect(errorContent).toContain("expected error message");
```

### 9. Type Narrowing with expect()

`expect()` assertions don't narrow TypeScript's discriminated unions. Add explicit guards:

```typescript
expect(documentContent.source.type).toBe("base64");
// This doesn't narrow the type, so add:
if (documentContent.source.type !== "base64")
  throw new Error("Expected base64 source");
// Now TypeScript knows source has media_type and data
expect(documentContent.source.media_type).toBe("application/pdf");
```

### 10. System Reminders in Mock Streams

System reminders are an internal `ProviderMessage` type (`system_reminder`) that get converted to plain text blocks with `<system-reminder>` tags when sent to Anthropic. When testing:

**Sending to Anthropic (in `thread.ts`):**

```typescript
// system_reminder content is converted to text for the provider
if (c.type === "system_reminder") {
  contentToSend.push({ type: "text", text: c.text });
}
```

**In tests checking mock stream messages:**

```typescript
// Search for text blocks containing the system-reminder tag
function findSystemReminderText(
  content: string | ContentBlockParam[],
): TextBlockParam | undefined {
  if (typeof content === "string") return undefined;
  return content.find(
    (c): c is TextBlockParam =>
      c.type === "text" && c.text.includes("<system-reminder>"),
  );
}
```

**Converting back to ProviderMessages (in `anthropic-thread.ts`):**
The `convertBlockToProvider` method detects text blocks with `<system-reminder>` tags and converts them back to `system_reminder` type for proper UI rendering.

## Files Updated

- `node/test/preamble.ts` - Helper functions updated for Anthropic types
- `node/tools/getFile.spec.ts` - All 26 tests passing
- `node/chat/chat.spec.ts` - Method renames only
- `node/chat/thread.spec.ts` - Already using new pattern
- `node/providers/anthropic-thread.spec.ts` - Already using new pattern
