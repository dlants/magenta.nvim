# Objective and Context

User request (verbatim):

> I think it's time to revisit the openai provider.
>
> This commented out code is quite old - the provider/agent contract has changed dramatically.
>
> In the past, while implementing openai responses api, I ended up having a lot of trouble with the openai documentation. The protocol is not clearly described, and it's a challenge to understand the exact sequence of events that happens for various exchanges (thinking, server side search, etc...). I had to write a small harness against the OPENAI api, and try prompting the agent with various prompts, and record the actual request/response sequences to make sure I had valid ground truth.
>
> So let's come up with a plan for how to revive the openai provider.

Follow-up requirements (verbatim):

> one important addendum - I want to use my chatgpt plus account instead of an API token. I think in theory it should work similar to the claude max authentication. I think we'll need to set that up first, before we can try running test prompts and recording wire protocol.

> For recording. The thing I really want to nail is *caching*. So we should verify, during our recordings and implementation, that if we drop parts of the message history on our reply, we are still effectively using the cache

> I think the place to be careful is around things like search, thinking summary, redacted reasoning, etc... That's where the anthropic API is weird too.

The core insight driving this plan: the risky, undocumented part is **the wire protocol and its cache behaviour**, not the class structure. So the plan front-loads capturing ground truth from the live API, turns those captures into committed fixtures, and only then implements the provider against them.

## Current contract

- `Provider` (`node/core/src/providers/provider-types.ts:185-207`) — exactly two methods: `forceToolUse(options): ProviderToolUseRequest` and `createAgent(options: AgentOptions): Agent`. The old `sendMessage(onStreamEvent)` shape is gone.
- `Agent` (`provider-types.ts:310-381`) — a stateful `Emitter<AgentEvents>` owning message history and stream lifecycle: `getState`, `getStreamingBlock`, `getNativeMessageIdx`, `appendUserMessage`, `toolResult`, `continueConversation`, `abort`, `abortToolUse`, `truncateMessages`, `clone`; emits `didUpdate` / `stopped` / `error`.
- `ProviderStreamEvent` is Anthropic-`RawContentBlock*Event`-shaped, extended with `providerMetadata.openai.itemId` (`provider-types.ts:209-211`).
- `getProvider()` (`providers/provider.ts:25-53`) caches by `profile.name` and currently throws "Not implemented" for `"openai"`.
- `ThreadCore.createFreshAgent()` (`thread-core.ts:587-613`) is the only consumer: `getProvider(profile).createAgent({ model, systemPrompt, tools, thinking, reasoning })`.

## Relevant files

- `node/core/src/providers/codex-auth.ts` — **new, done.** Reads and non-interactively refreshes the credentials `codex login` leaves in `$CODEX_HOME/auth.json`.
- `node/core/src/providers/openai-capture.ts` — **new, done.** Dev-only capture harness that issues real requests and writes fixtures.
- `node/core/src/providers/fixtures/openai/*.json` — **new, captured.** `{ turns: [{ request, events }] }` per scenario.
- `node/core/src/providers/fixtures/openai/NOTES.md` — **new.** The written ground truth derived from the fixtures. Read this before implementing anything.
- `node/core/src/providers/anthropic.ts` — reference `Provider` implementation.
- `node/core/src/providers/anthropic-agent.ts` — reference `Agent`: internal `update(Action)` state machine, retry/backoff, `clone`, `abort`, `truncateMessages`.
- `node/core/src/providers/mock-anthropic-client.ts` — the pattern to copy for the replay mock: it drives the **real SDK stream object** off a `ReadableStream`, so accumulation logic is exercised for real.
- `node/core/src/providers/auth-refresh.ts` — existing reactive refresh-on-401 hook.
- `node/providers/openai.ts` / `node/providers/openai.test.ts` — the fully commented-out old implementation. Reference only; wrong layer, depends on `Nvim`.
- `openai` SDK: declared `^5.12.1`, installed `5.23.2`.

# Design

Three layers, in dependency order: **auth → capture → replay harness → implementation**.

## Established ground truth (from the captures)

These supersede the assumptions the first draft of this plan made.

- **Endpoint.** ChatGPT-subscription tokens only work against `https://chatgpt.com/backend-api/codex/responses`. It speaks the Responses API but a constrained dialect: `instructions`, `stream: true` and `store: false` are required, and `max_output_tokens` is rejected outright.
- **Models.** Every `*-codex` model is rejected for ChatGPT-account auth (`gpt-5.1-codex`, `gpt-5.2-codex`, `gpt-5.3-codex`, `gpt-5.1-codex-max`, `codex-mini-latest`), as are plain `gpt-5` / `gpt-5.1`. `gpt-5.4`, `gpt-5.4-mini` and `gpt-5.5` work on a Plus plan. This is a live entitlement matter, not a stable API fact, so the model must be profile-configurable with no codex-specific default.
- **Caching.** The cacheable prefix is `instructions` + `tools` + leading `input` items, in that order, and a hit extends only to the first byte of divergence. Note that in magenta the envelope (`instructions` + `tools`) is fixed at thread creation and never changes, so the envelope-sensitivity findings below are background, not a live risk:
  - appending to unchanged history hits well;
  - dropping a *middle* item still hits, covering exactly the prefix before it;
  - dropping the *head* item is a total miss;
  - changing `instructions` alone is a total miss;
  - changing *or merely reordering* `tools` is a total miss;
  - `prompt_cache_key` is not required for a hit;
  - hits are quantized to 128-token blocks.
- **Reasoning round-tripping is not enforced.** Dropping the reasoning item from a follow-up did not error, contrary to the original assumption. Reasoning items should still be preserved for continuity, but their absence is not an invariant violation and must not throw.
- **Echo fidelity is not byte-sensitive.** Reversing JSON key order on echoed items, and omitting reasoning items entirely, both produced an identical `cached_tokens` — the cache is computed on a normalized representation, not raw request bytes. Annotations are not load-bearing either. (Omitting a `web_search_call` item does make the model search again, but we never drop history items mid-stream, so this is a non-issue.)
- **A cancelled stream simply stops.** No terminal event, no `usage`. The agent must synthesize its own stopped state from a partial message.
- **Summary parts are indexed independently of output items** — 11 parts arrived under one reasoning item with `output_index: 0` and `summary_index` 0..10.
- **Multimodal input works inline**: `input_image` with a base64 data URL, and `input_file` with `filename` + `file_data`. No separate upload step.
- A reasoning item can complete with an **empty** `summary` while still carrying `encrypted_content`, so a reasoning block is not guaranteed to have displayable text.
- Server-side search surfaces as a `web_search_call` item carrying only the query; results appear as `annotations` on the following message's content part.

## Where the remaining risk is — resolved by the A/B captures

The suspicion was that search results, thinking summaries and encrypted reasoning — content the *server* generates and we must echo back — would be cache-fragile, as they are on Anthropic. The A/B captures show they are not. Combined with the fact that the envelope is fixed for the life of a thread, caching is not a design constraint on the remaining stages; they are written against the protocol facts above.

## Implementation shape

`node/core/src/providers/openai.ts`:

- `OpenAIProvider implements Provider` — owns the SDK client (base URL and auth mode from the profile), the schema-compat helpers ported from the old file (`makeOpenAICompatible`, `sanitizeSchemaForOpenAI`, `isReasoningModel`, `supportsWebSearch`), `createStreamParameters` (ProviderMessage[] → `Responses.ResponseCreateParamsStreaming`), `forceToolUse`, and `createAgent`. No `Nvim` (core layer forbids it).
- `OpenAIAgent extends Emitter<AgentEvents> implements Agent` — keeps `ProviderMessage[]` as the single source of truth and translates on each request, feeding mapped `ProviderStreamEvent`s into an internal `update(Action)` state machine modeled on `AnthropicAgent`.

Deliberately **not** extracting a shared `BaseAgent` on the first pass; duplication is cheaper than destabilizing the Anthropic path.

Invariants:

- Serialization is deterministic (stable tool order, stable key order). Cheap to do and it keeps the cache prefix stable; the envelope is fixed per-thread anyway, so this is hygiene rather than a correctness constraint.
- History editing appends, or at worst edits late. Any operation that removes leading items (`truncateMessages`, compaction) is a known full cache miss and should be treated as such deliberately.
- `providerMetadata.openai.itemId` round-trips: assistant text, reasoning and search items retain their `id`. Server-generated payloads (`encrypted_content`, search annotations) are echoed back as received rather than reconstructed — not because the cache demands it, but because we cannot regenerate them correctly.
- `web_search_call` items are echoed back in history like any other server-generated item; omitting one makes the model re-run the search.
- Missing reasoning items degrade gracefully — no throw.
- `max_output_tokens` is never sent; the codex backend rejects it.
- The model comes from the profile, with no codex-family default, since those are rejected for ChatGPT-account auth.
- Reasoning config is only sent to reasoning-capable models; web search stays behind `supportsWebSearch`.
- Core must not import anything neovim-specific; `npx tsgo -b` enforces this.
- Abort settles the in-flight promise and leaves a consistent stopped state, matching `AnthropicAgent.abort()`.

# Stages

## Stage A — ChatGPT subscription auth — **done**

Decision: **do not build our own OAuth flow.** Magenta delegates login to the Codex CLI and only reads/refreshes the credentials it leaves behind. This drops PKCE, the `localhost:1455` callback listener, and the `AuthUI` changes they would have required.

- `codex` (0.118.0, from nixpkgs) added to the dotfiles home-manager config. nixpkgs lags upstream 0.146.0; irrelevant, since we only use the CLI for login.
- `CodexAuth` (`node/core/src/providers/codex-auth.ts`) reads `$CODEX_HOME/auth.json`, decodes the access token's `exp`, refreshes against `https://auth.openai.com/oauth/token` with the Codex client id when within 5 minutes of expiry, and writes rotated tokens back atomically at 0600 after re-reading the file. Concurrent refreshes are coalesced — the refresh token rotates, so a second concurrent refresh would present a spent token. `refreshCredentials()` is the unconditional variant for the reactive 401 path. `login()` spawns `codex login`, streams its output verbatim to an `onOutput` callback (no scraping), supports cancellation via `AbortSignal`, and coalesces concurrent calls so two logins can't fight over the callback port. Errors carry a `kind` discriminant: `not-logged-in`, `credentials-in-keyring`, `refresh-failed`, `codex-not-installed`, `login-failed`.
- Tests (`codex-auth.test.ts`): valid token issues no refresh; a near-expiry token refreshes, persists the *rotated* refresh token, preserves fields we don't own, and leaves the file at 0600; concurrent refreshes issue one request; a rejected refresh produces an actionable `refresh-failed` with no retry loop; a missing `auth.json` is `not-logged-in`; a keyring-configured CLI is distinguished as `credentials-in-keyring`; a missing `codex` binary is `codex-not-installed`.

Deferred to Stage 4 (wiring), because there is nothing to render into yet: the `OpenAIAuth` adapter over `CodexAuth` that the provider consumes, the reactive refresh-on-401 hookup, and the TEA view that displays `login()`'s streamed output with a cancel binding (core emits, root converts to a `RootMsg`; open question whether it hangs off the thread or the chat, since login is per-profile). Also unverified: whether `codex login` behaves correctly without a TTY — fall back to `--device-auth` if not.

Invariant held: tokens are never logged and never written into fixtures. Fixtures record request bodies only, never headers.

## Stage 1 — Capture harness and ground-truth fixtures — **done**

`npx tsx node/core/src/providers/openai-capture.ts [scenario...]` captures 21 scenarios into `fixtures/openai/`, with the findings written up in `fixtures/openai/NOTES.md`:

- protocol: `text`, `tool-call`, `parallel-tool-calls`, `tool-result-followup`, `reasoning-summary`, `reasoning-tool-roundtrip`, `reasoning-dropped-item-error`, `reasoning-empty-summary`, `reasoning-multi-summary`, `web-search`, `image-input`, `pdf-input`, `abort-midstream`, `truncation`
- caching: `caching-{append,drop-middle,drop-head,no-cache-key,instructions-change,tools-change,tools-reorder}`
- echo fidelity A/B: `reasoning-cache-ab`, `search-cache-ab`

The A/B scenarios settled the question the user raised. Echo fidelity is *not* byte-sensitive: reversing JSON key order and omitting reasoning items both produced an identical `cached_tokens`, so the cache is computed on a normalized representation. Annotations are likewise not load-bearing. (Dropping a `web_search_call` item did make the model search again, but we never drop items, so it doesn't constrain the design.)

The fixtures are ground truth for event *order and shape*, consumed by hand when writing the mock and the agent — they are not replayed as test inputs (see Stage 2).


## Stage 2 — Translation layer + `MockOpenAIClient` — **done**

The fixtures are **reference material, not test inputs**. They tell us the order and shape of the events the backend actually emits (how reasoning summary parts are indexed, how parallel tool calls arrive, what an aborted stream looks like). The tests are hand-written against the mock, in the same style as `mock-anthropic-client.ts`: a test observes the parameters of each request the provider sends and pushes native SDK events back through a real SDK stream.

- Goal: `OpenAIProvider` with `createStreamParameters` (ProviderMessage[] → `Responses.ResponseCreateParamsStreaming`), the schema helpers ported from the old file, and `forceToolUse`. `createAgent` throws for now; `getProvider` still throws for `"openai"`.
- `MockOpenAIClient` (`node/core/src/providers/mock-openai-client.ts`) mirrors `MockAnthropicClient` one-for-one:
  - `responses.create(params)` records a `MockResponseStream`, pushes it onto `streams`, and returns it. `lastStream` / `awaitStream()` as on the Anthropic mock.
  - `MockResponseStream` exposes the recorded `params` (so tests can assert on `instructions`, `tools`, `input` items) plus a `getProviderMessages()` that maps the request's `input` back to `ProviderMessage[]`, matching `MockStream.getProviderMessages()`.
  - Events are pushed as bytes through a `ReadableStream` into the **real** SDK response stream, so accumulation, partial JSON parsing and the final response object all go through real SDK code — same trick as the Anthropic mock.
  - Imperative helpers shaped by the fixtures: `streamText`, `streamToolCall`, `streamToolCallPartial` / `continueToolCallPartial`, `streamReasoningSummary(parts[])`, `streamEmptyReasoning(encryptedContent)`, `streamWebSearchCall(query)` + `streamAnnotatedText`, `emitEvent` for anything exotic, `finishResponse(stopReason, usage)`, `respondWithError`, `abortMidstream()` (closes with no terminal event and no `usage`), and `settle()`.
  - A request-shape validator analogous to `validateToolUseConstraint`: every `function_call` item in `input` must have a matching `function_call_output`.
- Fixture use is confined to one small test that asserts our helpers emit the same event *sequence* the backend does — a shape check, so the mock can't silently drift from reality. Nothing else replays fixtures.
- Tests:
  - `createStreamParameters` produces the expected request shape: `instructions` present, `store: false`, `stream: true`, no `max_output_tokens`, reasoning config only for reasoning models, web search only when supported.
  - Serialization determinism: serializing the same history twice is byte-identical, appending a message changes only the tail, tool order is independent of registration order.
  - Round-trip: mock events → provider stream events → stored `ProviderMessage[]` → `createStreamParameters` carries `encrypted_content`, `web_search_call` items and annotations through unmodified.
  - A history missing its reasoning items still serializes and does not throw.
- Gate: `npx tsgo -b`, `npx vitest run node/core/`, `npx biome check .`. All green.

### What landed

- `node/core/src/providers/openai.ts` — `OpenAIProvider` (`createStreamParameters`,
  `forceToolUse`, `createAgent` throws), the ported schema helpers
  (`makeOpenAICompatible`, `sanitizeSchemaForOpenAI`, `isReasoningModel`,
  `supportsWebSearch`), plus the translation layer:
  `convertProviderMessagesToInput`, `mapResponseStreamEvent`,
  `convertResponseOutputToProviderContent`, `usageFromResponse`.
- `node/core/src/providers/mock-openai-client.ts` — `MockOpenAIClient` /
  `MockResponseStream`, driving a real SDK `Stream` off a `ReadableStream`.
- `node/core/src/providers/openai.test.ts` — 21 tests.

### Decisions / deviations

- **`providerMetadata` added to content types.** `ProviderMetadata` existed only on
  `ProviderBlockStartEvent`, so item ids had nowhere to live in history. Added an
  optional `providerMetadata` to `ProviderTextContent`, `ProviderThinkingContent`,
  `ProviderRedactedThinkingContent` and `ProviderServerToolUseContent`. Additive and
  optional, so the Anthropic path is untouched.
- **Reasoning is modelled as one `thinking` block per reasoning item**, with
  `signature` carrying `encrypted_content`. Summary parts accumulate into that single
  block (separated by a blank line) rather than opening one block per
  `summary_index`, matching `reasoning-multi-summary.json`. `encrypted_content` only
  exists on `output_item.done`, so it arrives as a trailing `signature_delta`. No
  `redacted_thinking` block is produced; an empty summary is simply a thinking block
  with empty text and a signature.
- **Graceful degradation instead of throwing.** Assistant text with no item id
  serializes as an easy message; a thinking block with no item id is dropped (the
  backend tolerates missing reasoning items). Nothing throws on missing metadata.
- **Tools are sorted by name** in `createStreamParameters` and built with a fixed key
  order, since a mere tool reorder is a total cache miss.
- **`forceToolUse` uses the non-streaming Responses endpoint** with
  `tool_choice: {type: "function", name}`, and reuses `getRetryDelay` /
  `MAX_RETRY_DURATION` from `anthropic-agent.ts` with an OpenAI-specific
  `isRetryableOpenAIError` (429/500/502/503/529).
- **Fixture use is a shape check only**, as planned: four tests compare the mock's
  native event-type sequence against `text`, `tool-call`, `web-search`,
  `reasoning-summary` and `reasoning-multi-summary` fixtures (delta runs collapsed,
  since the mock emits one delta per block).
- Web search is opt-in per request (`includeWebSearch`) and additionally gated on
  `supportsWebSearch(model)`.
- The mock validates that every echoed `function_call` has a matching
  `function_call_output`, the analogue of `validateToolUseConstraint`.

### Code review follow-up (Stage 2 revision)

Type representation:

- `ProviderStreamEvent` is no longer purely Anthropic-shaped. `ProviderBlockStartEvent` is
  now a standalone type whose `content_block` is the union
  `ProviderContentBlockStart = Anthropic.RawContentBlockStartEvent["content_block"] |
  ProviderToolUseBlockStart | ProviderServerToolUseBlockStart`. The OpenAI variants exist
  because Anthropic's `ToolUseBlock` requires a `caller` field with no OpenAI analogue —
  that was the sole reason for the old `as never` casts, all four of which are gone
  (the citation and signature deltas turned out to typecheck fine unaided).
- `ProviderMetadata` is now `{ provider: "openai"; itemId: string }` — presence implies a
  usable id, so the three-way "absent" encoding is gone.
- `ProviderThinkingContent.signature` is now optional; `""` no longer means "absent".
  `anthropic.ts` coerces with `?? ""` at its own SDK boundary.
- `ReasoningEffort` / `ReasoningSummary` are shared types in `provider-options.ts`
  (`ReasoningEffort = Exclude<ThinkingEffort, "max">`). `toOpenAIReasoningEffort` maps them
  with a total switch; the one remaining cast is `"xhigh"`, which the API accepts for
  gpt-5.x but the SDK's union does not yet list.
- The installed SDK (5.23.2) types `ResponseFunctionWebSearch` **without** `action` and
  stream annotations as `unknown`, so the review's "narrow on the SDK union" is not
  available. Instead both payloads are narrowed in exactly two documented helpers,
  `webSearchQuery` and `urlCitationOf`, which return `undefined` rather than `""` when the
  shape is not what we expect. Non-`search` web-search actions are dropped, since
  `ProviderServerToolUseContent` cannot represent them.
- `parseToolRequest`'s `as ToolRequest` cast is retained: `ValidateInput` returns
  `Result<Record<string, unknown>>`, so recovering the toolName/input correlation means
  changing a signature shared with the Anthropic path (`anthropic.ts` does the identical
  cast). Deliberately out of scope for this stage.

Mock:

- `responses.create` is now an overloaded method on a `MockResponses` helper class:
  streaming params return a `MockResponseStream`, non-streaming params consume
  `nonStreamingQueue` (a `Response | Error` queue) and record into `nonStreamingRequests`,
  so `forceToolUse` can be driven against the same mock. `mockResponse()` builds a
  complete non-streaming `Response` and is reused by `finishResponse`.
- `pushEvent` / `emitEvent` now take a full `ResponseStreamEvent` minus the
  `sequence_number` the mock stamps, so events can no longer be emitted incomplete; all
  `as Partial<ResponseStreamEvent>` and the `as unknown as` double-casts are gone except a
  single documented one for the `action` field the SDK omits.
- `instructions` normalizes `null` to `undefined`; `inputItemsOfType` is generic over the
  SDK's input-item union.

Tests (32 total, up from 21): `forceToolUse` now covers success + usage, no `function_call`,
wrong tool name, malformed argument JSON, retry-then-succeed, non-retryable error, and abort
during the retry delay. The `tool_result` branch covers a text result, an image-only result
(non-empty `output` plus the trailing user message) and an error result. Reasoning
coalescing has a dedicated test for several thinking blocks sharing one item id folding into
one ordered `reasoning` item.

## Stage 3 — `OpenAIAgent`

Built alongside Stage 2 — the mock and the agent are useless separately, and the point of the mock is to enable a thorough agent test: drive a turn, inspect what the agent accumulated, then inspect the *next* request it generates from that accumulated state.

- Goal: full `Agent` implementation; `createAgent` returns it.
- Tests, hand-written against `MockOpenAIClient`:
  - A text response produces the expected `didUpdate` sequence and a terminal `stopped("end_turn", usage)`, with `cached_tokens` surfaced in usage.
  - A tool call surfaces a `tool_use` block with parsed input and `stopReason: "tool_use"`; `toolResult(...)` + `continueConversation()` issues a follow-up request whose `input` contains the original `function_call` and the matching `function_call_output`, asserted on the mock's recorded params.
  - Two parallel tool calls yield two distinct `tool_use` blocks — the fixtures show them arriving sequentially by `output_index`, not interleaved, so the accumulator keys on `output_index` rather than assuming one open block.
  - Many summary parts accumulate into a *single* thinking block (`summary_index` is independent of `output_index`), not one block per part.
  - An empty-summary reasoning item produces a block with `encrypted_content` and no text that renders and round-trips without crashing.
  - A web search surfaces as a distinct block with its query; the following message's annotations are preserved and the `web_search_call` item appears in the next request.
  - `abortMidstream()` — no terminal event, no `usage` — leaves the agent in a consistent stopped state with partial text retained and usage absent rather than zeroed. This is the one place the OpenAI stream differs structurally from Anthropic's.
  - `clone()` returns a stopped deep copy with history intact and no in-flight block.
- Gate: `npx tsgo -b`, `npx vitest run node/core/`, `npx biome check .`.

## Stage 4 — Wiring and cleanup

- Goal: `getProvider` constructs `OpenAIProvider` for `"openai"` (cached per `profile.name`); delete the commented-out `node/providers/openai.ts` and `node/providers/openai.test.ts`; update `doc/magenta-providers.txt` and `README.md`, which currently state OpenAI was removed.
- Also lands the parts of Stage A that were deferred for want of a consumer:
  - an `OpenAIAuth` adapter over `CodexAuth` that the provider calls for its bearer token and `chatgpt-account-id` header;
  - reactive refresh-on-401 through `auth-refresh.ts`, exactly one retry per request;
  - a TEA view rendering `CodexAuth.login()`'s streamed output with a cancel binding — core emits an event, the root converts it to a `RootMsg`. Decide then whether it hangs off the thread or the chat, since login is per-profile, not per-thread.
- ChatGPT-subscription auth is opt-in via an explicit profile `authType`, never the default, documented as an unofficial integration. The profile must also carry the model, since the working set is an entitlement matter that changes.
- Tests:
  - A `ThreadCore`-level test runs an OpenAI turn end to end through `MockOpenAIClient`, including a tool call executed by the tool manager.
  - Two `openai` profiles with different endpoints yield distinct cached provider instances.
  - A 401 from the backend triggers exactly one refresh-and-retry before surfacing an error.
  - A profile configured with a codex-family model surfaces the backend's rejection as an actionable error naming the models that do work.
- Gate: `npx tsgo -b`, full `npx vitest run`, `npx biome check .`.

# Notes / Open Questions

- Whether to also support platform API keys against `api.openai.com`. The dialects differ (`max_output_tokens`, model names), so this likely wants an explicit backend mode flag rather than pretending the endpoints are the same. Chat Completions (for GLM/OpenRouter/Fireworks) remains out of scope.
- Fixtures live in `node/core/src/providers/fixtures/openai/`, which is not gitignored, so they are committed and diffable — re-running the harness after an OpenAI change makes the diff the changelog. Total is ~1.4MB; the three largest (`reasoning-cache-ab` 376K, `search-cache-ab` 220K, `reasoning-multi-summary` 152K) are large by necessity, since the cache effect is only measurable with payloads spanning several 128-token blocks. Trim them to usage + item skeletons if the size becomes annoying, but keep enough of each to serve as a shape reference.
- The caching scenarios use a per-process-run unique filler (`RUN_ID`) so a re-run measures a cold cache rather than the previous run's. Do not remove this.
- `forceToolUse` should follow `AnthropicProvider.forceToolUse`'s retry semantics rather than the old OpenAI code, which had none.
- The entitlement situation (which models a ChatGPT plan may use) is volatile and currently broken enough that the codex CLI's own default model fails. Re-check with a one-line capture run before blaming our code for a 400.
