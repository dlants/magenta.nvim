# Objective and Context

> I'd like to get rid of this PLACEHOLDER_NATIVE_MESSAGE_IDX thing... Write up a plan

`PLACEHOLDER_NATIVE_MESSAGE_IDX` (`-1 as NativeMessageIdx`, declared in `node/server/src/providers/provider-types.ts`) is written at ~450 sites across the repo. It exists because `nativeMessageIdx` is a **required** field on every `ProviderMessageContent` variant, and three of those variants (`ProviderTextContent`, `ProviderImageContent`, `ProviderDocumentContent`) double as `AgentInput` — the type callers use to *submit* content. Submitted content has not landed in a native message yet, so every producer stamps the sentinel and every consumer of the wire format throws it away (`convertInputToNative`, `convertToolResultToNative` both drop it).

The index is only ever *meaningful* in the derived direction: `convertAnthropicMessagesToProvider` / `convertOpenAIItemsToProvider` assign the real message index when deriving `log.messages` from the native array. Nothing converts back. So the field belongs on the display type and not on the input type.

Key types (all in `node/server/src/providers/provider-types.ts` unless noted):

- `NativeMessageIdx` — branded number, the index of a message in the provider's native array.
- `ProviderMessageContent` — the display union; 13 variants, each currently carrying `nativeMessageIdx`.
- `AgentInput = ProviderTextContent | ProviderImageContent | ProviderDocumentContent` — what `appendUserMessage`, `forceToolUse`, supervisor injections, the mailbox, and `Session.inputMessages` carry.
- `ProviderToolResultContent` — the same three variants, as produced by tools.
- `ProviderToolResult` — what `ToolInvocation.promise` resolves to (`node/server/src/tool-types.ts`), and also a display variant derived by conversion.
- `ExecutedToolResult = Omit<ProviderToolResult, "result"> & {...}` (`tool-types.ts`) — inherits the field transitively.

Two uses of the sentinel are *not* input-shaped and must be handled separately:

- `SystemInfoSupervisor.create` (`thread-supervisor.ts:494`) stores `injectedAt = PLACEHOLDER` to mean "the preamble was already injected, at a point older than any index we can name" — relied on by the clone filter `injectedAt <= nativeMessageIdx`.
- `FileSupervisor.toolApplied` / `getContextUpdate` (`supervisors/file-supervisor.ts:480,578`) default their `nativeMessageIdx` parameter to the sentinel, so history entries recorded outside a request are never truncated away. Used by a large number of tests.

Relevant files:

- `node/server/src/providers/provider-types.ts` — where the types and the constant live.
- `node/server/src/providers/anthropic-conversion.ts`, `openai-conversion.ts` — the only places that mint real indices.
- `node/server/src/providers/anthropic-inference.ts`, `openai-inference.ts` — `appendUserMessage` / `appendToolResults`; drop the field on the way to the wire.
- `node/server/src/tool-executor.ts`, `node/server/src/tools/*` — tool result producers.
- `node/server/src/thread.ts`, `thread-supervisor.ts`, `supervisors/*.ts`, `submission/*.ts`, `session.ts` — injection and submission producers.
- `node/nvimclient/chat/commands/*.ts`, `chat/session-host.ts`, `providers/mock.ts` — nvim-side producers.
- `node/nvimclient/chat/thread-view.ts:826` — the one consumer that reads `content.nativeMessageIdx` off displayed content (the `F` fork binding).

# Design

Split the input flavor of each content type from the displayed flavor: the input types simply do not declare `nativeMessageIdx`, and the display types declare it as they do today. There are only a handful of affected variants, so they are written out rather than generated from a wrapper type.

Because the display types stay exactly as they are today, all consumers (views, renderers, conversion) are unaffected; only *producers* of input change, and they change by deleting a line each. The compiler finds every one of them: `nativeMessageIdx` becomes an excess property on object literals, so there is no silent-drift failure mode.

The `-1` sentinel disappears as a content field. The two history uses that genuinely need "older than anything nameable" get their own named constant in the supervisor layer, where the meaning is local and documented, rather than borrowing a provider-level content sentinel.

## Interfaces

```ts
// provider-types.ts — input flavor (no index)
export type TextContent = {
  type: "text";
  text: string;
  citations?: ProviderWebSearchCitation[] | undefined;
};
export type ImageContent = { type: "image"; source: {...} };
export type DocumentContent = { type: "document"; source: {...}; title?: string };

export type AgentInput = TextContent | ImageContent | DocumentContent;
/** What a tool's ok-result carries. Same three shapes as user input. */
export type ToolResultContent = AgentInput;
export type ToolResultValue =
  | { status: "ok"; value: ToolResultContent[] }
  | { status: "error"; error: string };
/** What a tool produces. The index is assigned when the result lands. */
export type ToolResultInput = {
  type: "tool_result";
  id: ToolRequestId;
  result: ToolResultValue;
};

// display flavor
export type ProviderTextContent = TextContent & { nativeMessageIdx: NativeMessageIdx };
export type ProviderImageContent = ImageContent & { nativeMessageIdx: NativeMessageIdx };
export type ProviderDocumentContent = DocumentContent & { nativeMessageIdx: NativeMessageIdx };
export type ProviderToolResult = ToolResultInput & { nativeMessageIdx: NativeMessageIdx };
// ...remaining variants unchanged (they only ever exist in the display direction)
export type ProviderMessageContent = /* unchanged union */;
```

Note that `ProviderToolResult`'s *nested* contents become input-flavored: only the tool_result block itself is located. Grep confirms no consumer reads an index off a nested tool-result content block; if one turns up, it can read the enclosing block's index instead.

Supervisor-local history index, replacing the two non-input uses. It is a widened
type rather than a sentinel index, so nothing casts an out-of-domain value into
`NativeMessageIdx`:

```ts
// supervisors/history.ts
export type HistoryIdx = NativeMessageIdx | { type: "pre-history" };
export const PRE_HISTORY: HistoryIdx = { type: "pre-history" };
export function historyIdxAtOrBefore(entry: HistoryIdx, idx: NativeMessageIdx): boolean;
export function historyIdxPrecedes(entry: HistoryIdx, previous: HistoryIdx): boolean;
```

`SystemInfoSupervisor.injectedAt`, the `FileSupervisor` history entries and the two defaulted parameters carry `HistoryIdx`. Their behaviour is unchanged; the comparisons become case analysis instead of arithmetic on `-1`.

## Invariants

- `AgentInput` values never reach a consumer that needs an index: everything they touch (`convertInputToNative`, the OpenAI input-item builder, `forceToolUse`) already discards it today.
- Every `ProviderMessageContent` in `log.messages` still carries the index the conversion assigned; the fork keybinding (`thread-view.ts`) and the edited-file grouping (`thread-supervisor.ts:405-414`) keep working unchanged.
- Supervisor histories remain monotonic and truncatable; `PRE_HISTORY` entries are retained by every truncation, exactly as `-1` was.
- Round-tripping stays one-directional: no `ProviderMessageContent` is ever handed back as input. (The one place today that re-injects a display block, `SupervisorChain.beforeRequest` at `thread-supervisor.ts:354-360`, re-stamps the index; with the split it simply strips it, and the excess-property check keeps it honest.)
- `PLACEHOLDER_NATIVE_MESSAGE_IDX` is gone from the `@magenta/server` barrel (`index.ts`) and from `node/nvimclient/providers/provider-types.ts`.

# Stages

## Relocate the two semantic sentinels — DONE

The "older than anything nameable" meaning lives in `node/server/src/supervisors/history.ts`,
but as a *widened type* rather than a fake index (review finding): `HistoryIdx =
NativeMessageIdx | { type: "pre-history" }`, with `PRE_HISTORY`,
`historyIdxAtOrBefore`, `historyIdxPrecedes` and `formatHistoryIdx`. `FileViewEntry`,
`recordView`, `updateAgentsViewOfFiles`, `FileSupervisor.toolApplied` /
`getContextUpdate` and `SystemInfoSupervisor.injectedAt` carry `HistoryIdx`, so no
out-of-domain value is ever cast into `NativeMessageIdx`. Truncation and the
clone filter compare by case, not by arithmetic on `-1`.

The `PLACEHOLDER_NATIVE_MESSAGE_IDX` uses in `thread-core.ts` (fork notification)
and `thread.ts` (compaction summary) are content fields, and disappear in the
"Type split in provider-types" stage — not here.

Review follow-ups addressed in this stage:

- `Thread.enqueue` dispatches `DeferredDelivery` with an exhaustive `switch` and an
  `assertUnreachable` default.
- `BatchRun<T, D extends AsyncDisposition>`: the redundant `Disposition |` bound is gone.
- `ThreadCore.create` takes the named `ThreadCoreSeed` again rather than two adjacent
  trailing optionals.
- The fork seam index is reported by the server (`ThreadCore.forkSeamIdx`, exposed as
  `Thread.forkSeamIdx`) instead of being recomputed in `chat.ts` as
  `getProviderMessages().length - 1`. The nvim side no longer assumes the seam is last
  and cannot write `messageViewState[-1]`.
- Content flushed ahead of a compaction found by a later queue is no longer dropped:
  `flushQueuesForNextTurn` folds it into the compaction's `nextPrompt`, the same way a
  single flush folds its own preceding content.
- The compaction summary is held on `Thread.opening` (consumed by the first turn that
  runs against the replacement core) rather than riding only the one continuation, so a
  submission that preempts the continuation still opens with the summary. `replaceCore`
  clears it, and the empty-send gate counts it as content.

- Goal: the sentinel value is gone from the content types' neighbourhood; the "older than
  anything nameable" meaning is a case of `HistoryIdx` in the supervisor layer.
- Tests:
  - Existing: "restores system-info delivery at the clone's effective index"
    (`thread-core-context.test.ts`) and the `file-supervisor-delivery.test.ts` clone/truncate
    cases cover the widened history index.
  - New: `mailbox.test.ts` "closes a live checkout when another one opens, restoring its own
    queue" pins the implicit-close/restore-to-own-queue invariant.
  - New: `thread.test.ts` "compacts on an @compact that reaches prompt time in the async
    queue" and "carries async content flushed ahead of a next-queue @compact into its prompt".
  - New: `agent.test.ts` "still opens with the summary when the continuation is preempted".
  - New assertions in `fork-thread.test.ts`: the next user message merges into the seam
    notice, and no two consecutive user messages exist.
  - Not added: a fork-with-`inputMessages` marker test. With the seam index coming from the
    server, the marker no longer depends on the log's length at the time Chat computes it,
    so the scenario the review worried about is no longer representable.
## Type split in provider-types

- Goal: input and display flavors are separate types; `AgentInput`, `ToolResultContent`, `ToolResultInput` have no `nativeMessageIdx`. The repo does not compile yet — the point of the stage is the error list.
- Tests: `npx tsc -p node/server/tsconfig.json --noEmit` produces errors only at producer sites (excess property) and none at consumer sites. A consumer error means the display type lost a field it needs, and the split is wrong there.

## Server producers

- Goal: `npx tsc -p node/server/tsconfig.json --noEmit` is clean. Touches `tool-executor.ts`, every tool in `tools/`, `utils/pdf-pages.ts`, `thread.ts`, `thread-supervisor.ts` (the re-stamp in `beforeRequest` becomes a strip), `supervisors/*.ts`, `submission/index.ts`, `session.ts`, `thread-core.ts`, `providers/anthropic-inference.ts`.
- Tests:
  - `npx vitest run node/server/` — the existing suites are the regression net here; `inference-parity.test.ts` and the anthropic/openai conversion tests confirm the wire format is byte-identical.
  - Existing `agent.test.ts` "nativeMessageIdx plumbing" cases confirm indices are still assigned correctly in the derived direction — they are the reason this refactor is safe.

## Nvim client, barrel and constant removal

- Goal: `npx tsc -b` is clean with `PLACEHOLDER_NATIVE_MESSAGE_IDX` deleted from `provider-types.ts`, from the `@magenta/server` barrel, and from `node/nvimclient/providers/provider-types.ts`. Chat commands (`file`, `diff`, `diagnostics`, `buffers`, `quickfix`, `implementplan`, `registry`), `session-host.ts` and `providers/mock.ts` stop stamping it.
- Tests:
  - `npx vitest run` in full; the nvim-driver suites (`fork-keybinding.test.ts`, `chat-view-adapter.test.ts`, `thread-compact.test.ts`) verify the display index still drives forking and message-view state.
  - `grep -rn PLACEHOLDER_NATIVE_MESSAGE_IDX node/ --include=*.ts` returns nothing outside `dist/`.
  - `npx biome check .`
