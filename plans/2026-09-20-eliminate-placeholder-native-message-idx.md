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

Supervisor-local sentinel, replacing the two non-input uses:

```ts
// supervisors/history.ts (or alongside the existing history helpers)
/** Older than any message this generation can name: a history entry stamped
 * with it survives every truncation, because `entry.idx <= idx` always holds. */
export const PRE_HISTORY_IDX = -1 as NativeMessageIdx;
```

`SystemInfoSupervisor.create` and the two `FileSupervisor` default parameters use it. Their behaviour is unchanged; only the name and the provenance of the constant change.

## Invariants

- `AgentInput` values never reach a consumer that needs an index: everything they touch (`convertInputToNative`, the OpenAI input-item builder, `forceToolUse`) already discards it today.
- Every `ProviderMessageContent` in `log.messages` still carries the index the conversion assigned; the fork keybinding (`thread-view.ts`) and the edited-file grouping (`thread-supervisor.ts:405-414`) keep working unchanged.
- Supervisor histories remain monotonic and truncatable; `PRE_HISTORY_IDX` entries are retained by every truncation, exactly as `-1` is today.
- Round-tripping stays one-directional: no `ProviderMessageContent` is ever handed back as input. (The one place today that re-injects a display block, `SupervisorChain.beforeRequest` at `thread-supervisor.ts:354-360`, re-stamps the index; with the split it simply strips it, and the excess-property check keeps it honest.)
- `PLACEHOLDER_NATIVE_MESSAGE_IDX` is gone from the `@magenta/server` barrel (`index.ts`) and from `node/nvimclient/providers/provider-types.ts`.

# Stages

## Relocate the two semantic sentinels — DONE

`PRE_HISTORY_IDX` lives in the new `node/server/src/supervisors/history.ts`.
`SystemInfoSupervisor.create` and the two `FileSupervisor` defaults use it.
Full `npx tsc -b`, `npx vitest run` and `npx biome check .` pass.

- Goal: `PLACEHOLDER_NATIVE_MESSAGE_IDX` is used only for content fields; the "older than anything nameable" meaning lives in its own named constant in the supervisor layer. `SystemInfoSupervisor.create` and the `FileSupervisor.toolApplied` / `getContextUpdate` defaults use `PRE_HISTORY_IDX`.
- Tests:
  - Existing: "restores system-info delivery at the clone's effective index" (`thread-core-context.test.ts`) — a fork before and at the head must still inject the preamble exactly once; this is the behaviour `alreadyInjected` encodes.
  - Existing `file-supervisor-delivery.test.ts` clone/truncate cases exercise the defaulted-index history entries.
  - No new test: this stage is a rename with no behavioural surface of its own.

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
