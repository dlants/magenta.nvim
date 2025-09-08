# Testing in magenta.nvim

To run the full test suite, use `npx vitest run` from the project root. You do not need to cd.
To run a specific test file, use `npx vitest run <file>`. **Important** You do not need to cd.
Tests should make use of the `node/test/preamble.ts` helpers.
When doing integration-level testing, like user flows, use the `withDriver` helper and the interactions in `node/test/driver.ts`. When performing generic user actions that may be reusable between tests, put them into the NvimDriver class as helpers.

As of July 2025, tests are now run in parallel for improved performance. The test infrastructure has been updated to support concurrent test execution.

## Test Environment Setup

**Fixture Files & Directory Structure:**

- Each test gets a fresh temporary directory in `/tmp/magenta-test/{testId}/`
- Files from `node/test/fixtures/` are copied into this temp directory for each test
- Available fixture files include `poem.txt`, `test.jpg`, `sample2.pdf`, `test.bin`, and others
- Nvim runs in this temporary directory, so files can be safely mutated during tests
- The temp directory is automatically cleaned up after each test - no manual cleanup needed
- Use `await getcwd(driver.nvim)` to get the current working directory for file path operations
- The temporary directory is completely isolated between tests

**Test Pattern:**

```typescript
import { withDriver } from "../test/preamble";

test("my test", async () => {
  await withDriver({}, async (driver) => {
    // Test code here - nvim runs in temp dir with fixture files
    // Access cwd with: const cwd = await getcwd(driver.nvim)
  });
});
```

**Custom File Setup:**

```typescript
test("test with custom files", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");
        await fs.writeFile(path.join(tmpDir, "custom.txt"), "content");
        await fs.mkdir(path.join(tmpDir, "subfolder"));
      },
    },
    async (driver) => {
      // Custom files are now available in the test environment
    },
  );
});
```

## Available Mocks & Test Interactions

**Configuring Magenta Options:**

Tests can override magenta options by passing them to `withDriver`:

```typescript
test("test with custom options", async () => {
  await withDriver(
    {
      options: {
        getFileAutoAllowGlobs: ["*.log", "config/*"],
        changeDebounceMs: 100,
        // Any other MagentaOptions can be overridden here
      },
    },
    async (driver) => {
      // Magenta will use the custom options
    },
  );
});
```

Available options include:

- `getFileAutoAllowGlobs` - Array of glob patterns for auto-allowing file reads
- `changeDebounceMs` - Override the default change tracking debounce
- Any other options from `MagentaOptions` type

**Mock Provider Interactions:**

The mock provider (`driver.mockAnthropic`) captures all requests and allows controlled responses:
**Awaiting Requests:**

```typescript
// Wait for any pending request
const request = await driver.mockAnthropic.awaitPendingRequest();

// Wait for request with specific text in message content
const request =
  await driver.mockAnthropic.awaitPendingRequestWithText("specific text");

// Wait for user message (tool results, etc.)
const request = await driver.mockAnthropic.awaitPendingUserRequest();

// Wait for forced tool use requests
const forceRequest =
  await driver.mockAnthropic.awaitPendingForceToolUseRequest();

// Check if there's a pending request with specific text (non-blocking)
const hasPending = driver.mockAnthropic.hasPendingRequestWithText("text");
```

**Responding to Regular Requests:**

```typescript
// Simple text response
request.respond({
  stopReason: "end_turn",
  text: "Response text",
  toolRequests: [],
});

// Response with tool use
request.respond({
  stopReason: "tool_use",
  text: "I'll use a tool",
  toolRequests: [
    {
      status: "ok",
      value: {
        id: "tool_id" as ToolRequestId,
        toolName: "get_file" as ToolName,
        input: { filePath: "./file.txt" as UnresolvedFilePath },
      },
    },
  ],
});

// Response with error tool request
request.respond({
  stopReason: "tool_use",
  text: "Tool failed",
  toolRequests: [
    {
      status: "error",
      rawRequest: { invalid: "request" },
    },
  ],
});
```

**Responding to Force Tool Use Requests:**

```typescript
const forceRequest =
  await driver.mockAnthropic.awaitPendingForceToolUseRequest();

// Successful tool response
await driver.mockAnthropic.respondToForceToolUse({
  toolRequest: {
    status: "ok",
    value: {
      id: "tool_id" as ToolRequestId,
      toolName: "get_file" as ToolName,
      input: { filePath: "./file.txt" as UnresolvedFilePath },
    },
  },
  stopReason: "tool_use",
});

// Error tool response
await driver.mockAnthropic.respondToForceToolUse({
  toolRequest: {
    status: "error",
    rawRequest: { invalid: "data" },
  },
  stopReason: "tool_use",
});
```

**Request Inspection:**

```typescript
// Access request properties
console.log(request.messages); // Message history
console.log(request.model); // Model used
console.log(request.tools); // Available tools
console.log(request.systemPrompt); // System prompt (if any)

// For force tool use requests
console.log(forceRequest.spec); // Tool specification
console.log(forceRequest.model); // Model used
console.log(forceRequest.messages); // Message history

// Check if request was aborted
if (request.aborted) {
  // Handle aborted request
}
```

**Advanced Response Patterns:**

```typescript
// Stream individual parts of response
request.streamText("First part of response");
request.streamToolUse(toolRequest);
request.finishResponse("end_turn");

// Respond with errors
request.respondWithError(new Error("Something went wrong"));

// Access tool responses from previous messages
const toolResponses = request.getToolResponses();
```

**Mock Provider:**

- `driver.mockAnthropic` - Pre-configured mock provider that captures all requests
- `await driver.mockAnthropic.awaitPendingForceToolUseRequest()` - Wait for and capture forced tool use requests
- `await driver.mockAnthropic.awaitPendingRequest()` - Wait for regular message requests
- `await driver.mockAnthropic.respondToForceToolUse({...})` - Send mock responses
- No need to manually mock providers - they're already set up in the test infrastructure

**Driver Interactions (prefer these over internal API access):**

- `await driver.editFile("poem.txt")` - Open fixture files
- `await driver.command("normal! gg")` - Execute vim commands
- `await driver.magenta.command("predict-edit")` - Execute magenta commands
- Use real nvim interactions to trigger change tracking naturally

**Testing Best Practices:**

- **DO**: Use realistic nvim interactions (`driver.editFile()`, `driver.command()`)
- **DON'T**: Reach into internal APIs (`driver.magenta.changeTracker.onTextDocumentDidChange()`)
- **DO**: Let the system work naturally - make real edits and let change tracking happen
- **DO**: Write integration tests that exercise the full user flow
- **DON'T**: Mock internal components - use the provided driver and mock provider

**Change Tracker Testing:**

- **DO**: Use `driver.assertChangeTrackerHasEdits(count)` and `driver.assertChangeTrackerContains(changes)` instead of arbitrary timeouts
- **DO**: Be aware that rapid edits may be batched into single changes by the tracker
- **DO**: Use explicit assertions about what changes should be tracked rather than waiting fixed amounts of time
- **DON'T**: Use `setTimeout()` or fixed delays when waiting for change tracking - use the assertion methods instead

**Mock Provider Request Objects:**
Force tool use requests captured by `awaitPendingForceToolUseRequest()` contain:

- `request.spec` - The tool specification used
- `request.model` - Which model was requested
- `request.messages` - The messages array containing user/assistant conversation
- `request.systemPrompt` - The system prompt used (if any)
- `request.defer` - Promise resolution control

**System Prompt vs User Messages:**
When implementing AI features, maintain proper separation:

- **System prompt**: General instructions about the agent's role and behavior ("You have to do your best to predict...")
- **User messages**: Specific contextual data (buffer content, cursor position, recent changes)
  This separation keeps the system prompt focused on behavior while allowing dynamic context in messages.

# Test Writing Best Practices

## Avoid Conditional Expect Statements

**DON'T** write tests with conditional expects like this:

```typescript
if (toolResult && toolResult.type === "tool_result") {
  expect(toolResult.result.status).toBe("ok");
  if (toolResult.result.status === "ok") {
    const textContent = toolResult.result.value.find(
      (item) => item.type === "text",
    );
    if (textContent && textContent.type === "text") {
      expect(textContent.text).toContain("expected content");
    }
  }
}
```

**DO** use TypeScript type assertions and direct expects:

```typescript
const toolResult = toolResultMessage.content[0] as Extract<
  (typeof toolResultMessage.content)[0],
  { type: "tool_result" }
>;
expect(toolResult.type).toBe("tool_result");
expect(toolResult.result.status).toBe("ok");

const result = toolResult.result as Extract<
  typeof toolResult.result,
  { status: "ok" }
>;

const textContent = result.value.find(
  (item) => item.type === "text",
) as Extract<(typeof result.value)[0], { type: "text" }>;
expect(textContent).toBeDefined();
expect(textContent.text).toContain("expected content");
```

## TypeScript Type Narrowing in Tests

Use TypeScript's `Extract` utility type to narrow union types safely:

```typescript
// For narrowing message content
const toolResult = content[0] as Extract<
  (typeof content)[0],
  { type: "tool_result" }
>;

// For narrowing result status
const okResult = toolResult.result as Extract<
  typeof toolResult.result,
  { status: "ok" }
>;

const errorResult = toolResult.result as Extract<
  typeof toolResult.result,
  { status: "error" }
>;
```

## Test Structure Patterns

### Basic Test Structure

```typescript
it("should do something", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Trigger the action
    await driver.inputMagentaText(`Some command`);
    await driver.send();

    // Mock the response
    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "tool_use",
      text: "response text",
      toolRequests: [
        /* tool requests */
      ],
    });

    // Assert the UI state
    await driver.assertDisplayBufferContains("Expected UI text");

    // Handle tool result and verify
    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
    const toolResultMessage =
      toolResultRequest.messages[toolResultRequest.messages.length - 1];

    // Type-safe assertions
    expect(toolResultMessage.role).toBe("user");
    expect(Array.isArray(toolResultMessage.content)).toBe(true);

    const toolResult = toolResultMessage.content[0] as Extract<
      (typeof toolResultMessage.content)[0],
      { type: "tool_result" }
    >;
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.result.status).toBe("ok");
  });
});
```

### Tests with File Setup

```typescript
it("should handle custom files", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");
        await fs.writeFile(path.join(tmpDir, "test.txt"), "content");
      },
    },
    async (driver) => {
      // Test implementation
    },
  );
});
```

### Tests with Custom Options

```typescript
it("should respect configuration", async () => {
  await withDriver(
    {
      options: {
        someOption: ["value1", "value2"],
      },
    },
    async (driver) => {
      // Test implementation
    },
  );
});
```

## Mock Provider Patterns

### Awaiting Requests

```typescript
// Wait for regular requests
const request = await driver.mockAnthropic.awaitPendingRequest();

// Wait for forced tool use requests
const forceRequest =
  await driver.mockAnthropic.awaitPendingForceToolUseRequest();
```

### Responding to Requests

```typescript
// Simple response
request.respond({
  stopReason: "end_turn",
  text: "Response text",
  toolRequests: [],
});

// Response with tool use
request.respond({
  stopReason: "tool_use",
  text: "I'll use a tool",
  toolRequests: [
    {
      status: "ok",
      value: {
        id: "tool_id" as ToolRequestId,
        toolName: "tool_name" as ToolName,
        input: { param: "value" },
      },
    },
  ],
});
```

## Common Assertion Patterns

### UI Assertions

```typescript
// Check for presence
await driver.assertDisplayBufferContains("Expected text");

// Check for absence
await driver.assertDisplayBufferDoesNotContain("Unwanted text");

// Get position for interactions
const buttonPos = await driver.assertDisplayBufferContains("[ YES ]");
await driver.triggerDisplayBufferKey(buttonPos, "<CR>");
```

### Tool Result Assertions

```typescript
// Use helper functions when available
assertToolResultContainsText(toolResult, "expected text");
assertToolResultHasImageSource(toolResult, "image/jpeg");

// Manual assertions for specific cases
const result = toolResult.result as Extract<
  typeof toolResult.result,
  { status: "ok" }
>;
const textContent = result.value.find(
  (item) => item.type === "text",
) as Extract<(typeof result.value)[0], { type: "text" }>;
expect(textContent.text).toContain("expected content");
```

### Change Tracker Assertions

```typescript
// Use specific assertions instead of timeouts
await driver.assertChangeTrackerHasEdits(2);
await driver.assertChangeTrackerContains([
  { type: "edit", filePath: "file.txt" },
]);

// DON'T use arbitrary timeouts
// await new Promise(resolve => setTimeout(resolve, 1000)); // ❌
```

## Testing Best Practices

### Integration Over Unit

- Prefer testing complete user flows over isolated units
- Use realistic nvim interactions rather than reaching into internal APIs
- Let the system work naturally (e.g., let change tracking happen through real edits)

### Mock Boundaries

- Mock external services (Anthropic API) but not internal components
- Use the provided driver and mock infrastructure
- Don't manually mock internal classes or methods

### Realistic Interactions

```typescript
// DO: Use realistic interactions
await driver.editFile("poem.txt");
await driver.command("normal! gg");

// DON'T: Reach into internals
// driver.magenta.changeTracker.onTextDocumentDidChange(...); // ❌
```

### File Handling

- Each test gets a fresh temporary directory
- Fixture files are automatically copied for each test
- Files can be safely mutated during tests
- Use the `setupFiles` callback for custom file creation

### Error Testing

- Test both success and error paths
- Verify error messages are meaningful
- Test edge cases like invalid input, missing files, etc.

### Async Patterns

- Always await async operations
- Use the driver's assertion methods that handle timing
- Don't use fixed delays unless absolutely necessary
