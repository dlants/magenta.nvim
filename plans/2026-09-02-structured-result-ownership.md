# Objective and Context

> yeah structuredResult should live in thread, and definitely not be derived from the native format.

`structuredResult` is the rich, tool-specific payload a tool publishes alongside its wire-visible text (e.g. `BashCommand.StructuredResult` with `outputText`/`exitCode`, `GetFile.StructuredResult` with per-file records). It exists purely for rendering and for supervisors; the model never sees it.

Today it is a required field of the *display/wire* type, so a value has to exist even where none was ever produced:

- `ProviderToolResult` (`node/core/src/providers/provider-types.ts:169`) — the ok branch declares `structuredResult: ToolStructuredResult`. This type is both what tools return and what the converters derive from the native message array.
- `convertAnthropicMessagesToProvider` / `convertOpenAIItemsToProvider` — derive `log.messages` from the native array, where structured data was never serialized, and therefore **fabricate** a `structuredResult`. This is the round-trip that must not exist; it produced the `{ toolName: "bash_command" }`-without-`outputText` value that crashed the bash renderer.
- `structuredToolResults` — a `Map<ToolRequestId, ToolStructuredResult>` owned by the core `Thread` (`node/core/src/thread.ts:155`) and cloned on fork (`thread.ts:246`), but currently handed to the agent as a dep (`agent.ts:154/238`) and written by it (`agent.ts:~256`). The store's owner and its writer are in different objects.
- `NvimThread.rebuildToolResultMap` (`node/chat/thread.ts:737`) — walks the derived messages and *re-attaches* the map's entry over the fabricated one. Where the map has no entry (previous generation after compaction, archived/restored thread), the fabricated value survives into the view.
- `CompletedToolInfo` (`node/core/src/tool-types.ts:73`) — `{ request, result, structuredResult }`, built in `thread-view.ts:~1050` and consumed by the renderers in `node/render-tools/`.
- `ToolResults` (`provider-types.ts:310`) = `ReadonlyMap<ToolRequestId, ProviderToolResult["result"]>` — passed to `appendToolResults` (wire) *and* to `SystemReminderSupervisor.onToolResults` (`system-reminder-supervisor.ts:69`), which reads `structuredResult` for `wasAbbreviated` and per-file reminders.
- `ToolInvocation.promise: Promise<ProviderToolResult>` (`tool-types.ts:97`) — every tool's `execute` returns this.

Files:

- `node/core/src/tool-types.ts` — tool request/result types, `ToolStructuredResult` union, `CompletedToolInfo`.
- `node/core/src/providers/provider-types.ts` — `ProviderToolResult`, `ToolResults`, `NativeInferenceManager`.
- `node/core/src/providers/{anthropic,openai}-conversion.ts` — native → `ProviderMessage` derivation.
- `node/core/src/agent.ts` — turn loop; records tool results.
- `node/core/src/thread.ts` — owns `structuredToolResults`.
- `node/chat/thread.ts` — `rebuildToolResultMap`, the root-side view state.
- `node/chat/thread-view.ts` — builds `CompletedToolInfo`.
- `node/render-tools/*.ts` — consumers.

# Design

Split the one type that is doing two jobs, and keep the structured half entirely above the agent.

- **`ProviderToolResult` becomes purely the wire/display shape**: `{ status: "ok"; value: ProviderToolResultContent[] } | { status: "error"; error }`. No `structuredResult`. The converters then have nothing to invent — the fabrication sites disappear rather than being papered over.
- **A new execution-side type carries the structured payload out of the tool**: tools keep returning one object (no churn in ~15 `execute` bodies), but the extra field is only present on `ExecutedToolResult`, the type of `ToolInvocation.promise`.
- **The thread, not the agent, splits the two.** `createTool` is already a thread-supplied dep (`thread.ts:createAgent`), so the thread wraps each invocation: when the tool's promise resolves it records `structuredResult` into `Thread.structuredToolResults` keyed by `ToolRequestId` and resolves the agent's promise with the stripped `ProviderToolResult`. The agent's dep list loses `structuredToolResults`, `Agent.structuredToolResults` and the `set-active-tool-result` write to it go away, and `agent.ts` stops importing `ToolStructuredResult` altogether. `ToolInvocation.promise` as seen by the agent is `Promise<ProviderToolResult>`; the structured type is a thread-layer concern.
- **`ToolResults` stays wire-only** (`ReadonlyMap<ToolRequestId, ProviderToolResult["result"]>`), so the agent can keep building it from active tools. The one consumer that needs structured data, `SystemReminderSupervisor.onToolResults`, is registered by the thread (`thread.ts:602`), so the thread's hook looks each id up in its own map and passes `(results, structured)` down. Structured data reaches the supervisor from the thread's store, not through the agent's plumbing.
- **Rendering looks up, never inherits**: `CompletedToolInfo.structuredResult` becomes optional and is populated by looking up `thread.structuredToolResults` at view-build time. `rebuildToolResultMap` stops rewriting results and just collects them. Absence — compacted generations, archived threads, results restored from the native array — is then represented honestly as `undefined`, which each renderer must handle (bash already has the `firstValue.text` fallback).
- **`GenericStructuredResult` / `"unknown"` goes away.** It only existed so the converters had something to write. With the field optional, "no structured data" is `undefined`, and `ToolStructuredResult` becomes a union of real per-tool shapes where `toolName === "x"` narrows soundly.

Alternative considered: keep the agent as the recorder (its current `set-active-tool-result` write). Rejected — it forces the agent, whose whole job is the wire loop, to carry a display-only union, and it puts the store's writer in a different object from its owner.

Alternative considered: keep the field required and validate/repair values at every boundary (converters, archive read). Rejected — it treats the symptom, and every new boundary is a new place to forget.

Not in scope: persisting structured results to the archive log. After this change an archived thread renders tool results without structured data, which is the same as today's behaviour for compacted generations. Worth a follow-up if the plain rendering is too lossy.

## Interfaces

```ts
// provider-types.ts — wire/display only
export type ProviderToolResult = {
  type: "tool_result";
  id: ToolManager.ToolRequestId;
  result:
    | { status: "ok"; value: ProviderToolResultContent[] }
    | { status: "error"; error: string };
  nativeMessageIdx: NativeMessageIdx;
};

// tool-types.ts — what a tool's execute() resolves to
export type ExecutedToolResult = Omit<ProviderToolResult, "result"> & {
  result:
    | {
        status: "ok";
        value: ProviderToolResultContent[];
        structuredResult?: ToolStructuredResult;
      }
    | { status: "error"; error: string };
};

// tool-types.ts — what the thread's createTool wrapper hands the agent
export type ToolInvocation = { promise: Promise<ProviderToolResult>; abort: () => void; ... };
// ...and what the tool itself produces, seen only by the thread
export type ExecutingToolInvocation = Omit<ToolInvocation, "promise"> & {
  promise: Promise<ExecutedToolResult>;
};

// provider-types.ts — unchanged, wire-only
export type ToolResults = ReadonlyMap<ToolRequestId, ProviderToolResult["result"]>;

// thread.ts
class Thread {
  readonly structuredToolResults: Map<ToolRequestId, ToolStructuredResult>;
}
// AgentDeps no longer has structuredToolResults; Agent has no such field.

// tool-types.ts
export type ToolStructuredResult =
  | BashCommand.StructuredResult | Edl.StructuredResult | ... ;   // no GenericStructuredResult

export type CompletedToolInfo = {
  request: ToolRequest;
  result: ProviderToolResult;
  structuredResult: ToolStructuredResult | undefined;
};
```

## Invariants

- Nothing in `log.messages` (or anything derived from the native array) carries structured data. A tool result reached through a message never yields a structured payload.
- `Thread.structuredToolResults` is the only store; it is populated exactly once per completed tool, by the thread as the tool's promise resolves, and is copied on fork.
- Nothing in `node/core/src/agent.ts` references `ToolStructuredResult`.
- A `structuredResult` whose `toolName` is `"x"` always has tool `x`'s full field set — no partial or renamed values can be constructed.
- Renderers must render correctly with `structuredResult === undefined` (compaction, archive, forked-in results) — no crashes, degraded but sensible output.
- Active-but-unsubmitted tool results (the `phaseActiveTools` branch of `rebuildToolResultMap`) must still render their rich summaries the moment the tool completes.
- `SystemReminderSupervisor.onToolResults` must keep seeing `wasAbbreviated` and `files[].systemReminder` at execution time.

# Stages

## Splitting the result types

- Goal: `ProviderToolResult` has no `structuredResult`; tools resolve `ExecutedToolResult`; the thread's `createTool` wrapper strips it into `Thread.structuredToolResults` and the agent only ever sees the wire shape (no `structuredToolResults` dep, no `ToolStructuredResult` import); the thread's `onToolResults` hook feeds the reminder supervisor from its own map; both converters stop fabricating. `GenericStructuredResult`/`"unknown"` deleted; `nvim_lua`, `mcp`, hover, etc. either publish a real shape or nothing.
- Tests:
  - Converting a native array containing a `bash_command` tool result yields a `ProviderToolResult` with no structured data (anthropic and openai conversion tests) — the object shape itself is the assertion that the round trip is gone.
  - After a turn that runs `bash_command`, `thread.structuredToolResults` holds the full bash payload for that request id, while the corresponding message in `getProviderMessages()` carries only text.
  - The existing bash-abbreviated system reminder test still fires, proving the supervisor still gets execution-time structured data.
  - A forked thread carries the structured results of the source thread.

## Rendering from the thread's map

- Goal: `CompletedToolInfo.structuredResult` is optional and is looked up from `structuredToolResults` in `thread-view.ts`; `rebuildToolResultMap` no longer rewrites results; every renderer handles `undefined`.
- Tests:
  - Rendering a thread whose bash tool result was reconstructed from the native array (i.e. no map entry — the exact crash scenario) shows the tool result text and does not throw.
  - A tool result that completes mid-turn (still in `activeTools`, not yet submitted) renders its rich summary.
  - Renderers with the richest structured output — `get_files`, `edl`, `spawn_subagents` — each render sensibly both with and without a map entry.
  - `assertDisplayBufferContains` on a normal bash turn still shows the exit code / abbreviated log link, i.e. the happy path is unchanged.
