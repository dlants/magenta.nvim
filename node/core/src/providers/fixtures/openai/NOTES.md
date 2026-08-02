# OpenAI Codex-backend ground truth

Captured with `npx tsx node/core/src/providers/openai-capture.ts [scenario...]`
against `https://chatgpt.com/backend-api/codex/responses` using ChatGPT-subscription
auth (`codex login`). Each fixture is `{ turns: [{ request, events }] }` — the
exact body sent and the raw SSE events received, in order.

## Endpoint / auth

- Only the codex backend accepts ChatGPT-subscription tokens; `api.openai.com` does not.
- Required headers: `Authorization: Bearer <access_token>`, `chatgpt-account-id`,
  `OpenAI-Beta: responses=experimental`, `originator: codex_cli_rs`.
- Required body fields: `instructions`, `stream: true`, `store: false`.
- Model allowlist is narrower than the platform API. `gpt-5.4`, `gpt-5.4-mini` and
  `gpt-5.5` are accepted on a Plus plan; every `*-codex` model
  (`gpt-5.1-codex`, `gpt-5.2-codex`, `gpt-5.3-codex`, `gpt-5.1-codex-max`,
  `codex-mini-latest`) and plain `gpt-5` / `gpt-5.1` are rejected with
  `400 {"detail":"The '<model>' model is not supported when using Codex with a ChatGPT account."}`.
- `max_output_tokens` is rejected outright: `400 {"detail":"Unsupported parameter: max_output_tokens"}`.

## Event sequence

Every turn is framed by `response.created`, `response.in_progress`, ...,
`response.completed`. The terminal `response.completed.response` carries the full
response object including `usage` (`input_tokens`, `input_tokens_details.cached_tokens`,
`output_tokens`, `output_tokens_details.reasoning_tokens`) and the complete `output` array.

Each output item is bracketed by `response.output_item.added` / `.done`, with
`output_index` identifying it. `.done` carries the fully assembled item — this is the
shape that must be echoed back on the next turn.

- text: `output_item.added(message)` → `content_part.added` → `output_text.delta`* →
  `output_text.done` → `content_part.done` → `output_item.done`.
- tool call: `output_item.added(function_call)` → `function_call_arguments.delta`* →
  `function_call_arguments.done` → `output_item.done`. The item has both `id` (`fc_…`)
  and `call_id` (`call_…`); `function_call_output` is keyed by `call_id`.
- parallel tool calls: two complete `function_call` item groups, sequentially, with
  distinct `output_index`. No interleaving of deltas was observed.
- reasoning: `output_item.added(reasoning)` → `reasoning_summary_part.added` →
  `reasoning_summary_text.delta`* → `reasoning_summary_text.done` →
  `reasoning_summary_part.done` → `output_item.done`. Summary parts are indexed by
  `summary_index`, independent of `output_index`. Summary text arrived as a single
  short bolded heading. A reasoning item can complete with an **empty** `summary`
  array while still carrying `encrypted_content` (see `reasoning-summary.json`), so
  a reasoning block is not guaranteed to have displayable text.
- web search: `output_item.added(web_search_call)` → `web_search_call.in_progress` →
  `.searching` → `.completed` → `output_item.done`, then a normal message item. The
  `web_search_call` item carries `action.query` / `action.queries` but no results;
  results only surface as `annotations` on the following message's content part. Tool
  spec is `{ type: "web_search" }`.

## Prompt caching

This is the behaviour that most affects cost, so it was measured directly.
`response.completed.response.usage.input_tokens_details.cached_tokens` reports the
hit; `cache_write_tokens` was always 0 on this backend. Each caching scenario uses a
per-process-run unique filler so a re-run measures a cold cache rather than the
previous run's.

Observed (fixtures `caching-*.json`):

- Caching is **prefix-based and automatic** — no opt-in field required.
- Granularity is coarse, a multiple of 128 tokens (hits of 1280 / 2816 / 3840 were
  observed against ~3000-token prompts), so the tail of the matching prefix is not
  credited.
- `caching-append`: appending to an unchanged history hits. Turn 1 and turn 2 both
  reported 2816 cached of ~2990 input. This is the normal agent loop and it caches well.
- `caching-drop-middle`: removing an item from the middle still hits, and the hit is
  exactly the prefix *before* the removed item (2816 cached). Everything after the
  edit point is re-priced.
- `caching-drop-head`: removing the first item is a **total miss** — `cached_tokens: 0`.
  This is the important one: trimming the oldest messages, the obvious way to bound
  context, throws away the entire cache. Prefer dropping/summarizing from a fixed
  point *after* a stable prefix, or accept a full re-price when compacting.
- `caching-no-cache-key`: `prompt_cache_key` is **not required** for a hit; the second
  turn hit 2816 cached without it. It only influences routing/affinity.
- `caching-instructions-change`: changing `instructions` alone is a total miss
  (`cached_tokens: 0` on both turns). The system prompt is part of the cached prefix,
  so it must not carry volatile content (timestamps, cwd, changing context files).
- `caching-tools-change`: adding a tool is a total miss.
- `caching-tools-reorder`: merely **reordering** the same two tools is also a total
  miss. Tool serialization order must be stable across turns.

Implication for the provider: the cacheable prefix is
`instructions` + `tools` + the leading `input` items, in that order. All three must be
byte-stable turn to turn, and history editing should only ever append or (at worst)
edit late.


### Echo fidelity vs the cache

`reasoning-cache-ab.json` and `search-cache-ab.json` are controlled A/B tests: turn 0
produces a large payload, turn 1 warms the cache, and turns 2-4 re-issue the *same*
follow-up with an identical leading prefix, varying only how the server-generated
items are echoed. Comparing their `cached_tokens` isolates echo fidelity.

- Reasoning: verbatim echo, key-order-reversed echo, and reasoning-items-omitted all
  reported the **same** hit (3328 of 3549). So the cache is computed on a normalized
  representation, not raw request bytes — JSON key order does not matter, and
  reasoning items contribute nothing to the cached prefix.
- Search: verbatim echo and annotation-stripped echo also reported the same hit
  (6272 of 6773). Annotations are not load-bearing for the cache.
- Omitting the `web_search_call` item, however, made the model **search again** —
  input jumped from 6.7k to 10.7k tokens. The cost of dropping it is a redundant
  server-side search, not a cache miss. That is the more expensive failure mode.

Net: the provider does not need byte-exact echo, but it must not drop
`web_search_call` items, and it must keep `instructions`, tool order and the leading
input items stable (see above), which is where the real cache sensitivity lives.

## Other observations

- `reasoning-multi-summary.json`: 11 summary parts arrived under a single reasoning
  item — `output_index` stayed 0 while `summary_index` ran 0..10. Summary parts are
  indexed independently of output items, so a reasoning block accumulates parts
  rather than producing one item per part.
- `reasoning-empty-summary.json`: at `effort: "low"` the reasoning item completed with
  `summary: []` and a populated `encrypted_content`, and echoing it back on the next
  turn was accepted. Rendering must tolerate a thinking block with no text.
- `image-input.json` / `pdf-input.json`: `input_image` with a base64 data URL and
  `input_file` with `filename` + `file_data` (base64 data URL) both work. The PDF's
  text was read back correctly, so no separate upload step is needed.
- `abort-midstream.json`: cancelling the request mid-stream simply stops the events.
  There is no terminal event and no `usage` — the client is left holding a partial
  message and must synthesize its own stopped state.

## Round-tripping

- The follow-up request is the previous `input` plus every `output_item.done` item,
  plus one `function_call_output` per call. That was accepted as-is.
- `include: ["reasoning.encrypted_content"]` populates `reasoning.encrypted_content`;
  reasoning items round-trip with their `id` (`rs_…`) and encrypted payload.
- **Dropping the reasoning item from the follow-up did not error** — see
  `reasoning-dropped-item-error.json`, whose second turn completes normally. So
  echoing reasoning items is (currently) not enforced by this backend, contrary to the
  assumption in the plan. Preserve them anyway for reasoning continuity, but the
  provider should not treat their absence as an invariant violation.
