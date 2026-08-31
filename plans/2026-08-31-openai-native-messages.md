# Objective and Context

> let's write a plan to convert the openai inference manager to properly use native messages internally
>
> OpenAIInferenceManager should *not* be using ProviderMessage as native format! The whole point of the
> native inference manager is so we don't have to round-trip to Provider message and can keep the
> conversion one-directional, and keep our log close to the wire format

`NativeInferenceManager` (`provider-types.ts:333`) is "the provider-specific half of a conversation:
the native message array, its conversion to `ProviderMessage`, and one request at a time".
`AnthropicInferenceManager` honors this: it stores `NativeMessage[]` (`Anthropic.MessageParam` with
the content array narrowed, `anthropic-inference.ts:165`), and derives a memoized
`cachedProviderMessages` through the one-directional
`convertAnthropicMessagesToProvider` (`anthropic-conversion.ts:20`).

`OpenAIInferenceManager` does not. `openai-inference.ts:106` states it outright: "ProviderMessage[]
is the single source of truth; the request body is derived from it on every turn". Consequences:

- `convertProviderMessagesToInput` (`openai.ts:199-434`, ~235 lines) exists to convert *back* from
  the display type to the wire type on every request. Anthropic has no counterpart.
- `ProviderMessage` had to grow wire-carrying fields so the reverse conversion could work:
  - `ProviderThinkingContent.signature` doubles as OpenAI's `encrypted_content` (written
    `openai.ts:777`, read back `openai.ts:410`),
  - `ProviderMetadata = { provider: "openai"; itemId: string }` (`provider-types.ts:225`) exists
    only to smuggle response item ids through the display type (written `openai.ts:556,766,779,805`,
    read back via `itemIdOf` `openai.ts:191-197`).
  Neither is read by any view, archive or compaction code.
- Round-tripping is lossy by construction: `convertResponseOutputToProviderContent` flattens a
  reasoning item's `summary` parts into one `\n\n`-joined string, and the reverse conversion
  re-splits it into a single summary part. Item kinds without a `ProviderMessageContent`
  counterpart are dropped silently, and reasoning items whose `itemId` went missing are dropped
  outright (`openai.ts:386-388`).
- The streaming path *already has* the wire items: `turnItems: ResponseOutputItem[]`
  (`openai-inference.ts:116`) accumulates every completed item and is then discarded, used only to
  derive a stop reason (`:620`).

## Key types

- `OpenAI.Responses.ResponseInputItem` — the wire input element (openai SDK 5.23.2). A flat item
  list, not a message list: `EasyInputMessage`, `ResponseInputItem.Message`,
  `ResponseOutputMessage`, `ResponseFunctionToolCall`, `ResponseFunctionToolCallOutput`,
  `ResponseReasoningItem`, `ResponseFunctionWebSearch`, `ItemReference`, and others.
- `OpenAI.Responses.ResponseOutputItem` — what the stream delivers. **Verified assignable to
  `ResponseInputItem`**, so a completed output item can be appended to the log verbatim. This is the
  enabler for the whole change.
- `ProviderMessage` / `ProviderMessageContent` (`provider-types.ts:60-190`) — the display type.
  After this change it is derived-only for OpenAI, as it already is for Anthropic.
- `NativeMessageIdx` (`provider-types.ts:286`) — opaque branded index into the native array, used
  for fork and rollback.

## Relevant files

- `node/core/src/providers/openai-inference.ts` — the manager being rewritten.
- `node/core/src/providers/openai.ts` — wire conversions and `OpenAIProvider`.
- `node/core/src/providers/openai-conversion.ts` — **new**, the one-directional native → provider
  conversion, mirroring `anthropic-conversion.ts`.
- `node/core/src/providers/anthropic-inference.ts` / `anthropic-conversion.ts` — the pattern to
  follow.
- `node/core/src/providers/provider-types.ts` — `ProviderMessage`, `ProviderMetadata`,
  `NativeInferenceManager`.
- `node/core/src/providers/mock-openai-client.ts` — the streaming fixture the tests drive.
- `node/core/src/providers/openai-inference.test.ts`, `openai-inference-retry.test.ts`,
  `inference-parity.test.ts`, `openai.test.ts` — the safety net.
- `node/chat/openai-streaming-view.test.ts` — the only end-to-end render test on this path.

# Design

Make `OpenAIInferenceManager` store `ResponseInputItem[]` and derive `ProviderMessage[]` from it,
exactly as the anthropic manager derives from `MessageParam[]`.

## Data flow

Today (bidirectional):

```
stream items ──convertResponseOutputToProviderContent──> ProviderMessage[] (source of truth)
                                                              │
                            convertProviderMessagesToInput ───┘──> ResponseInputItem[] ──> request
```

After (one-directional):

```
stream items ──(verbatim)──> ResponseInputItem[] (source of truth) ──> request
                                     │
                                     └──convertOpenAIItemsToProvider──> cachedProviderMessages (display)
```

## Native representation: a flat item list, not messages

The Responses API input is a flat list; reasoning and function_call items have no enclosing
message. Grouping them into pseudo-messages to mirror Anthropic would reintroduce exactly the
impedance mismatch we are removing. So the native array is flat, and the *display* conversion does
the grouping: consecutive items belonging to the assistant collapse into one `ProviderMessage` with
`role: "assistant"`, consecutive user/tool-output items into one with `role: "user"`. This grouping
is what today's `appendTurnContent` (`openai-inference.ts:292`) does incrementally; it becomes a
pure function of the item list.

`NativeMessageIdx` therefore becomes an index into the item array. It is a branded opaque number and
every consumer (`agent.ts:987` snapshot, `agent.ts:281,429` truncate, `chat.ts:1423` fork,
`thread-view.ts:787` fork binding) treats it as opaque, so the index-space change is invisible to
them. It is strictly finer-grained than today's message index, which makes fork truncation more
precise, not less.

## Stop reason and usage

Anthropic keys `messageStopInfo: Map<number, MessageStopInfo>` by message index
(`anthropic-inference.ts:175`). The OpenAI manager keys the same map by the **item index of the last
item of the assistant turn**; the conversion attaches `stopReason` / `usage` to the
`ProviderMessage` that item lands in. Truncation prunes entries past the cut, as
`truncateMessages` already does for anthropic (`anthropic-inference.ts:647-659`).

## What gets deleted

- `convertProviderMessagesToInput` and its helper `itemIdOf` (`openai.ts:191-434`).
- `ProviderMetadata` (`provider-types.ts:225`) and the `providerMetadata` field from all four
  content types that carry it (`:71,79,86,156,247`).
- `ProviderThinkingContent.signature` (`provider-types.ts:78`) — the OpenAI need disappears with the
  reverse conversion, and the Anthropic writes into it (`anthropic-conversion.ts:218`) are
  display-only and unread. Anthropic's *native* signature handling
  (`anthropic-inference.ts:1039,1064,1121`) is untouched.
- `StreamingBlock`'s `signature` (`provider-types.ts:292`) — display-only and never rendered.
- `mapResponseStreamEvent` (`openai.ts:564`) — already dead in production, test-only.

## Alternatives considered

- *Keep `ProviderMessage` as native but strip the extra fields.* Impossible: the reverse conversion
  needs them. The fields exist because the representation is wrong.
- *Group native items into pseudo-messages.* Preserves today's `NativeMessageIdx` index space at the
  cost of a fake structure the wire format does not have, and complicates append (a reasoning item
  arriving before any message item has no group to join).
- *Store both.* Two sources of truth; the drift is the bug we are removing.

## Interfaces

New file `node/core/src/providers/openai-conversion.ts`, mirroring `anthropic-conversion.ts`:

```ts
export type ItemStopInfo = { stopReason: StreamStopReason; usage: Usage };

/** Native items -> display messages. The only direction. Consecutive items of
 * the same role group into one ProviderMessage; every content block is stamped
 * with the index of the item it came from. */
export function convertOpenAIItemsToProvider(
  validateInput: ValidateInput,
  items: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
  stopInfo?: Map<number, ItemStopInfo>,
): ProviderMessage[];
```

Manager state (`openai-inference.ts`):

```ts
private items: OpenAI.Responses.ResponseInputItem[] = [];
private cachedProviderMessages: ProviderMessage[] = [];
private stopInfo = new Map<number, ItemStopInfo>();
/** Index in `items` of the first item of the turn being accumulated. */
private turnStartIdx: number | undefined;
```

`turnItems` disappears: the turn's items are `this.items.slice(turnStartIdx)`.

`createStreamParameters` (`openai.ts:435-462`) changes its `messages` field:

```ts
export type CreateStreamParametersOptions = {
  model: string;
  input: OpenAI.Responses.ResponseInputItem[];  // was: messages: ProviderMessage[]
  tools: ProviderToolSpec[];
  // ...unchanged
};
```

`OpenAIProvider.forceToolUse` (`openai.ts:1093`) is the only other caller; it builds a throwaway
one-shot `ProviderMessage[]` today and will build items directly instead — a single
`{ role: "user", content: [{ type: "input_text", text }] }`, plus the image/document cases.

Shared helper, used by both `appendUserMessage` and `forceToolUse`:

```ts
export function convertInputToNativeItems(
  content: ReadonlyArray<AgentInput>,
): OpenAI.Responses.ResponseInputItem[];
```

## Invariants

- Every `function_call` in the log is answered by a `function_call_output` with the same `call_id`
  before the next request, or is removed. This is what `dropDanglingToolUses`
  (`openai-inference.ts:650`) enforces today on messages; it becomes item-level.
- A `reasoning` item must not be left stranded when the `function_call` it precedes is dropped —
  the API rejects reasoning items that are not followed by the output they reason about. Today's
  message-level pruning cannot express this. **New behavior to get right**; covered by the abort and
  clone tests.
- Display grouping must produce the same `ProviderMessage[]` shape the view already renders.
  `inference-parity.test.ts:132` asserts OpenAI and Anthropic content are structurally equal for the
  same turn; that assertion is the contract.
- Tagged text (`context_update`, `comment_update`, system reminders) is stored on the wire as plain
  `input_text` and re-tagged on the way out by `classifyTextContent`, as `provider-types.ts`
  documents for `ProviderCommentUpdateContent`. Today `appendUserMessage` (`:359`) classifies at
  append time because the native array *is* the display array; after the change classification moves
  into the conversion, matching anthropic (`anthropic-conversion.ts:56`).
- `nativeMessageIdx` is stamped on every derived content block and must round-trip through
  `truncateMessages(idx)` such that fork-at-block truncates the log immediately after that item.
- Reasoning `summary` parts survive verbatim; the `\n\n` join is a display concern only.
- Clones are deep copies with unanswered tool calls pruned (`openai-inference.ts:426`), and share the
  `promptCacheKey` (`:128`).
- A retry discards the current attempt's items: `reset-attempt` (`:149`) truncates back to
  `turnStartIdx`.

# Stages

## Native conversion module — DONE

Implemented in `node/core/src/providers/openai-conversion.ts`, tested in
`openai-conversion.test.ts` (6 tests). Nothing is wired to it yet.

Decisions/deviations:

- `webSearchQuery` and `parseToolRequest` are now exported from `openai.ts` and reused rather than
  duplicated. The resulting `openai.ts -> openai-inference.ts -> openai-conversion.ts -> openai.ts`
  cycle is the one that already exists between the first two modules.
- Role is derived per item by `roleOf`: anything with a `role` field maps assistant -> assistant and
  user/system/developer -> user; `reasoning` / `function_call` / `web_search_call` are assistant;
  `function_call_output` is user; everything else (e.g. `item_reference`) has no display
  representation and is skipped without breaking the grouping of its neighbours.
- `function_call_output` always converts to a `tool_result` with `status: "ok"`. The wire format has
  no error flag, so the error/ok distinction is genuinely not recoverable from the native items;
  this is a real (small) display regression to accept in stage 2.
- Reasoning items always produce a `thinking` block, even with an empty summary, matching today's
  `convertResponseOutputToProviderContent`.
- User-side `input_image` / `input_file` are recovered by parsing the data URL back into a
  `base64` source; unparseable or unsupported media types are dropped.
- `outputText` tolerates the content-part array shape the API has begun returning for
  `function_call_output.output`, which the SDK still types as `string`.
- `classifyTextContent` is applied to user-side text only.


- Goal: `convertOpenAIItemsToProvider` exists and is correct, with nothing wired to it yet.
- Notes: build it from the existing `convertResponseOutputToProviderContent` (`openai.ts:737`) plus
  the grouping logic in `appendTurnContent`, extended to the input-only item kinds
  (`function_call_output`, user messages with `input_text`/`input_image`/`input_file`).
- Tests:
  - Unit tests in `openai-conversion.test.ts` over hand-built item lists: a user text item, an
    assistant turn of reasoning + message + two function_calls, then two function_call_outputs,
    produces exactly two `ProviderMessage`s with the expected grouping and `nativeMessageIdx`
    stamps.
  - Multi-part reasoning summaries join with `\n\n` in display and keep their parts in the source
    items.
  - Tagged text in a user item is re-tagged to `context_update` / `comment_update`, not rendered raw.
  - A web_search_call item plus an annotated message item produce `server_tool_use` content and
    text with url citations.

## Manager storage swap

- Goal: `OpenAIInferenceManager` stores `ResponseInputItem[]`; `log.messages` is derived. The request
  body is built from the items directly. `createStreamParameters` takes `input`;
  `convertProviderMessagesToInput`, `itemIdOf` and `mapResponseStreamEvent` are deleted, and
  `forceToolUse` builds items.
- Notes: this is the bulk of the work — `update()`, `applyStreamEvent`, `appendTurnContent` →
  append-item, `commitAssistantMessage`, `attachStopInfo`, `restamp`, `appendUserMessage`,
  `appendToolResults`, `truncateMessages`, `clone`, `collectRequestedTools`, `deriveStopReason` and
  `dropDanglingToolUses` all move to the item level.
- Tests:
  - `openai-inference.test.ts` and `openai-inference-retry.test.ts` pass with only mechanical
    changes; any assertion that has to change shape is a finding to explain, not to paper over.
  - `inference-parity.test.ts:132` (OpenAI/Anthropic content equality) passes untouched — this is
    the real check that the derived display shape did not drift.
  - New: the request `input` sent on the *second* turn contains the reasoning item with its original
    `id` and `encrypted_content`, and the `function_call` with its `call_id`, byte-identical to what
    the stream delivered. Assert via `stream.params.input` on the mock client, not via the display
    type. This is the regression the whole change is for.
  - New: aborting mid-turn leaves no `function_call` without a `function_call_output` **and** no
    reasoning item stranded by that removal; the next request is accepted.
  - `node/chat/openai-streaming-view.test.ts` passes untouched — incremental render still works,
    i.e. the cache is refreshed per completed item, not per turn.

## Drop the smuggled fields

- Goal: `ProviderMetadata`, `providerMetadata`, `ProviderThinkingContent.signature` and
  `StreamingBlock.signature` are gone from `provider-types.ts` and every writer.
- Notes: `tsc -b` drives this; anthropic's *native* signature handling stays. Expect churn in
  `openai.test.ts`, `openai-inference.test.ts:190`, `archive-renderer.test.ts:25`,
  `compact-renderer.test.ts:47`.
- Tests:
  - Full `npx vitest run` green; `npx tsc -b`; `npx biome check .`.
  - Archive and compaction renderers still produce the same markdown for a thread containing
    thinking blocks (existing snapshot-ish tests in `archive-renderer.test.ts` /
    `compact-renderer.test.ts`).

## Docs

- Goal: `context.md` and `plans/2026-08-30-native-inference-manager.md`'s description of the manager
  no longer describe OpenAI as ProviderMessage-native; the invariant "nothing native escapes the
  manager, and the conversion is one-directional" is written down where the next reader will find it.
- Tests: none; prose only.
