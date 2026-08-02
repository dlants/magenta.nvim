/**
 * Dev-only capture harness: issues real requests against the ChatGPT Codex
 * backend and records the exact request body and raw stream events as fixtures.
 *
 * The Responses wire protocol (especially reasoning item round-tripping) is
 * poorly documented, so these fixtures are the ground truth the provider and
 * its replay mock are built against.
 *
 *   npx tsx node/core/src/providers/openai-capture.ts [scenario...]
 *
 * Requires `codex login` to have been run (ChatGPT subscription auth).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAuth } from "./codex-auth.ts";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const MODEL = "gpt-5.4";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "openai",
);

type RequestBody = Record<string, unknown>;
type StreamEvent = { type: string } & Record<string, unknown>;
type Turn = { request: RequestBody; events: StreamEvent[] };

/** Stop consuming the stream early, to capture what an abort mid-turn sees. */
type SendOptions = { stopAfterEvents?: number };
type Send = (
  request: RequestBody,
  options?: SendOptions,
) => Promise<StreamEvent[]>;

/**
 * A scenario is a sequence of turns. Each turn builds its request from the
 * events of the preceding turns, which is precisely what we want to pin down:
 * what must be echoed back for the API to accept the follow-up.
 */
type Scenario = {
  name: string;
  run: (send: Send) => Promise<void>;
};

const userMessage = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

const baseRequest = (input: unknown[], extra: RequestBody = {}) => ({
  model: MODEL,
  instructions:
    "You are a terse assistant. Answer in as few words as possible.",
  input,
  stream: true,
  store: false,
  ...extra,
});

const weatherTool = {
  type: "function",
  name: "get_weather",
  description: "Get the current weather for a city.",
  strict: false,
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

/** Output items the model produced, in the shape they must be echoed back. */
function outputItems(events: StreamEvent[]): unknown[] {
  return events
    .filter((e) => e.type === "response.output_item.done")
    .map((e) => e.item);
}

/**
 * Deterministic filler so a prefix reliably exceeds OpenAI's ~1024 token
 * minimum for prompt caching. Deterministic matters: the cache is keyed on an
 * exact prefix, so the same filler must reproduce across turns and runs.
 */
function filler(paragraphs: number, seed: string): string {
  const out: string[] = [];
  for (let i = 0; i < paragraphs; i++) {
    out.push(
      `Section ${seed}.${i}: reference material about widget ${i}. ` +
        `It has a serial number, a color, a mass, and a maintenance schedule. ` +
        `None of these details matter to the question, they exist only to make ` +
        `the prompt prefix long enough to be eligible for prompt caching. ` +
        `Widget ${i} was manufactured in the year ${2000 + i} at plant ${i % 7}.`,
    );
  }
  return out.join("\n\n");
}

/**
 * Unique per process run. Cache state persists on OpenAI's side for minutes, so
 * without this a re-run of a caching scenario would hit the previous run's
 * cache and report a hit where a cold miss is what's being measured.
 */
const RUN_ID = Math.random().toString(36).slice(2, 8);

/** Same content, different key order — used to probe cache byte-sensitivity. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).reverse();
  return Object.fromEntries(entries.map(([k, v]) => [k, reverseKeys(v)]));
}

function stripAnnotations(item: unknown): unknown {
  const typed = item as { content?: { annotations?: unknown }[] };
  if (!Array.isArray(typed.content)) return item;
  return {
    ...(item as object),
    content: typed.content.map(({ annotations: _drop, ...rest }) => rest),
  };
}

/** 1x1 PNG, inline so the harness has no fixture-file dependency. */
const PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function helloPdfDataUrl(): Promise<string> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 100]);
  page.drawText("The magic word is bandersnatch.", {
    font: await doc.embedFont(StandardFonts.Helvetica),
    size: 10,
    x: 10,
    y: 50,
  });
  return `data:application/pdf;base64,${await doc.saveAsBase64()}`;
}

function usage(events: StreamEvent[]) {
  const completed = events.find((e) => e.type === "response.completed");
  return (completed?.response as { usage?: unknown } | undefined)?.usage;
}

function functionCalls(events: StreamEvent[]) {
  return outputItems(events).filter(
    (item): item is { call_id: string; name: string; arguments: string } =>
      (item as { type?: string }).type === "function_call",
  );
}

const scenarios: Scenario[] = [
  {
    name: "text",
    run: async (send) => {
      await send(baseRequest([userMessage("Say hi in one word.")]));
    },
  },
  {
    name: "tool-call",
    run: async (send) => {
      await send(
        baseRequest([userMessage("What's the weather in Paris?")], {
          tools: [weatherTool],
        }),
      );
    },
  },
  {
    name: "parallel-tool-calls",
    run: async (send) => {
      await send(
        baseRequest(
          [userMessage("What's the weather in Paris and in Tokyo? Use tools.")],
          { tools: [weatherTool], parallel_tool_calls: true },
        ),
      );
    },
  },
  {
    name: "tool-result-followup",
    run: async (send) => {
      const input: unknown[] = [userMessage("What's the weather in Paris?")];
      const first = await send(baseRequest(input, { tools: [weatherTool] }));

      input.push(...outputItems(first));
      for (const call of functionCalls(first)) {
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: "18C, light rain",
        });
      }

      await send(baseRequest(input, { tools: [weatherTool] }));
    },
  },
  {
    name: "reasoning-summary",
    run: async (send) => {
      await send(
        baseRequest(
          [
            userMessage(
              "A bat and a ball cost $1.10. The bat costs $1 more than the ball. How much is the ball?",
            ),
          ],
          {
            reasoning: { effort: "medium", summary: "auto" },
            include: ["reasoning.encrypted_content"],
          },
        ),
      );
    },
  },
  {
    name: "reasoning-tool-roundtrip",
    run: async (send) => {
      const extra = {
        tools: [weatherTool],
        reasoning: { effort: "medium", summary: "auto" },
        include: ["reasoning.encrypted_content"],
      };
      const input: unknown[] = [
        userMessage("Should I bring an umbrella in Paris today?"),
      ];
      const first = await send(baseRequest(input, extra));

      input.push(...outputItems(first));
      for (const call of functionCalls(first)) {
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: "18C, light rain",
        });
      }

      await send(baseRequest(input, extra));
    },
  },
  {
    name: "reasoning-dropped-item-error",
    run: async (send) => {
      // Deliberately malformed: echo back the assistant items but drop the
      // reasoning item. The error records the round-trip invariant.
      const extra = {
        tools: [weatherTool],
        reasoning: { effort: "medium", summary: "auto" },
        include: ["reasoning.encrypted_content"],
      };
      const input: unknown[] = [
        userMessage("Should I bring an umbrella in Paris today?"),
      ];
      const first = await send(baseRequest(input, extra));

      input.push(
        ...outputItems(first).filter(
          (item) => (item as { type?: string }).type !== "reasoning",
        ),
      );
      for (const call of functionCalls(first)) {
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: "18C, light rain",
        });
      }

      await send(baseRequest(input, extra));
    },
  },
  {
    name: "web-search",
    run: async (send) => {
      await send(
        baseRequest([userMessage("Who won the 2026 Super Bowl? Search.")], {
          tools: [{ type: "web_search" }],
        }),
      );
    },
  },
  // --- caching -----------------------------------------------------------
  // Prompt caching is prefix-based: the cache hit extends only as far as the
  // request's leading items match a previously seen request. These scenarios
  // pin down what that means for a client that trims history, which is the
  // decision that actually costs money.
  {
    // Baseline: a long prefix sent twice unchanged, then extended. Establishes
    // that caching engages at all and how it is reported in usage.
    name: "caching-append",
    run: async (send) => {
      const seed = `append-${RUN_ID}`;
      const prefix = [userMessage(filler(40, seed)), userMessage("Ready?")];
      const key = { prompt_cache_key: "magenta-capture-caching-append" };

      const first = await send(baseRequest(prefix, key));
      const second = await send(
        baseRequest([...prefix, ...outputItems(first)], key),
      );
      await send(
        baseRequest(
          [
            ...prefix,
            ...outputItems(first),
            ...outputItems(second),
            userMessage("Name widget 3's plant."),
          ],
          key,
        ),
      );
    },
  },
  {
    // Drop an item from the *middle* of the history on the follow-up. Expected:
    // the cache still covers everything before the removed item, so
    // cached_tokens should be non-zero but smaller than the append case.
    name: "caching-drop-middle",
    run: async (send) => {
      const seed = `drop-middle-${RUN_ID}`;
      const key = { prompt_cache_key: "magenta-capture-caching-drop-middle" };
      const head = userMessage(filler(40, seed));
      const middle = userMessage(filler(20, `${seed}-mid`));
      const tail = userMessage("Ready?");

      const first = await send(baseRequest([head, middle, tail], key));
      await send(
        baseRequest(
          [head, tail, ...outputItems(first), userMessage("And now?")],
          key,
        ),
      );
    },
  },
  {
    // Drop from the *head* of the history — the usual shape of context
    // trimming. Expected: the prefix no longer matches at item 0, so the cache
    // is fully invalidated and cached_tokens should be 0. If so, trimming the
    // oldest messages is far more expensive than it looks.
    name: "caching-drop-head",
    run: async (send) => {
      const seed = `drop-head-${RUN_ID}`;
      const key = { prompt_cache_key: "magenta-capture-caching-drop-head" };
      const head = userMessage(filler(40, seed));
      const middle = userMessage(filler(20, `${seed}-mid`));
      const tail = userMessage("Ready?");

      const first = await send(baseRequest([head, middle, tail], key));
      await send(
        baseRequest(
          [middle, tail, ...outputItems(first), userMessage("And now?")],
          key,
        ),
      );
    },
  },
  {
    // Same prefix, but no prompt_cache_key. Determines whether the key is
    // required for a hit or merely improves routing.
    name: "caching-no-cache-key",
    run: async (send) => {
      const seed = `no-cache-key-${RUN_ID}`;
      const prefix = [userMessage(filler(40, seed)), userMessage("Ready?")];
      const first = await send(baseRequest(prefix));
      await send(baseRequest([...prefix, ...outputItems(first)]));
    },
  },
  {
    // Only the tool list differs. Determines whether tool definitions sit in
    // the cached prefix, i.e. whether enabling/disabling a tool mid-thread
    // costs a full cache miss.
    name: "caching-tools-change",
    run: async (send) => {
      const seed = `tools-${RUN_ID}`;
      const key = { prompt_cache_key: `magenta-capture-caching-tools` };
      const prefix = [userMessage(filler(40, seed)), userMessage("Ready?")];
      await send(baseRequest(prefix, { ...key, tools: [weatherTool] }));
      await send(
        baseRequest(prefix, {
          ...key,
          tools: [
            weatherTool,
            { ...weatherTool, name: "get_time", description: "Get the time." },
          ],
        }),
      );
    },
  },
  {
    // Same as above but with the extra tool prepended rather than appended, to
    // see whether tool ordering matters to the cache.
    name: "caching-tools-reorder",
    run: async (send) => {
      const seed = `tools-reorder-${RUN_ID}`;
      const key = { prompt_cache_key: `magenta-capture-caching-tools-order` };
      const prefix = [userMessage(filler(40, seed)), userMessage("Ready?")];
      const timeTool = {
        ...weatherTool,
        name: "get_time",
        description: "Get the time.",
      };
      await send(
        baseRequest(prefix, { ...key, tools: [weatherTool, timeTool] }),
      );
      await send(
        baseRequest(prefix, { ...key, tools: [timeTool, weatherTool] }),
      );
    },
  },
  {
    // Only the instructions differ between two otherwise identical requests.
    // Determines whether instructions participate in the cached prefix, which
    // decides whether the system prompt can carry volatile content (dates,
    // cwd, context files) without destroying caching.
    name: "caching-instructions-change",
    run: async (send) => {
      const seed = `instructions-${RUN_ID}`;
      const key = { prompt_cache_key: "magenta-capture-caching-instructions" };
      const prefix = [userMessage(filler(40, seed)), userMessage("Ready?")];
      await send(baseRequest(prefix, key));
      await send(
        baseRequest(prefix, {
          ...key,
          instructions: "You are a terse assistant. Answer very briefly.",
        }),
      );
    },
  },
  // --- server-generated content x caching ---------------------------------
  // Reasoning, search results and their encrypted payloads are produced by the
  // server and must be echoed back. Whether we echo them *byte-identically*
  // decides whether the cache survives, so these scenarios measure that
  // directly rather than assuming it.
  {
    // A/B test of echo fidelity, sized so the effect is measurable: turn 0
    // produces a long reasoning + message payload (hundreds of tokens, i.e.
    // several 128-token cache blocks). Turn 1 echoes it verbatim to warm the
    // cache over the whole thing. Turns 2-4 then re-issue the *same* follow-up
    // with the same leading prefix, varying only how the echoed items are
    // serialized. Comparing their cached_tokens isolates the effect of echo
    // fidelity from everything else.
    name: "reasoning-cache-ab",
    run: async (send) => {
      const seed = `reasoning-ab-${RUN_ID}`;
      const extra = {
        reasoning: { effort: "high", summary: "detailed" },
        include: ["reasoning.encrypted_content"],
      };
      const head = [
        userMessage(filler(40, seed)),
        userMessage(
          "Ignoring the reference material, explain in about 400 words how a bicycle stays upright.",
        ),
      ];

      const first = await send(baseRequest(head, extra));
      const produced = outputItems(first);

      // warm
      await send(
        baseRequest(
          [...head, ...produced, userMessage("Summarize that.")],
          extra,
        ),
      );
      // A: verbatim echo — the baseline hit
      await send(
        baseRequest(
          [...head, ...produced, userMessage("Summarize that.")],
          extra,
        ),
      );
      // B: same content, different key order
      await send(
        baseRequest(
          [
            ...head,
            ...produced.map(reverseKeys),
            userMessage("Summarize that."),
          ],
          extra,
        ),
      );
      // C: reasoning items omitted
      await send(
        baseRequest(
          [
            ...head,
            ...produced.filter(
              (item) => (item as { type?: string }).type !== "reasoning",
            ),
            userMessage("Summarize that."),
          ],
          extra,
        ),
      );
    },
  },
  {
    // Same A/B, for server-side search: does echoing the web_search_call item
    // and the annotated message back verbatim preserve the cache, and are the
    // annotations load-bearing?
    name: "search-cache-ab",
    run: async (send) => {
      const seed = `search-ab-${RUN_ID}`;
      const extra = { tools: [{ type: "web_search" }] };
      const head = [
        userMessage(filler(40, seed)),
        userMessage(
          "Search the web and summarize in detail what happened at the 2026 Super Bowl.",
        ),
      ];

      const first = await send(baseRequest(head, extra));
      const produced = outputItems(first);
      const followUp = userMessage("Who was the losing coach?");

      // warm
      await send(baseRequest([...head, ...produced, followUp], extra));
      // A: verbatim echo
      await send(baseRequest([...head, ...produced, followUp], extra));
      // B: annotations stripped from the echoed message
      await send(
        baseRequest(
          [...head, ...produced.map(stripAnnotations), followUp],
          extra,
        ),
      );
      // C: the web_search_call item omitted entirely
      await send(
        baseRequest(
          [
            ...head,
            ...produced.filter(
              (item) => (item as { type?: string }).type !== "web_search_call",
            ),
            followUp,
          ],
          extra,
        ),
      );
    },
  },
  {
    // A trivial prompt at low effort tends to produce a reasoning item with an
    // empty summary but a populated encrypted_content. Confirms such an item is
    // accepted when echoed back.
    name: "reasoning-empty-summary",
    run: async (send) => {
      const extra = {
        reasoning: { effort: "low", summary: "auto" },
        include: ["reasoning.encrypted_content"],
      };
      const input: unknown[] = [userMessage("What is 2 + 2?")];
      const first = await send(baseRequest(input, extra));
      input.push(...outputItems(first), userMessage("And 3 + 3?"));
      await send(baseRequest(input, extra));
    },
  },
  {
    // A long multi-step problem, to force more than one reasoning summary part
    // and pin down how summary_index relates to output_index.
    name: "reasoning-multi-summary",
    run: async (send) => {
      await send(
        baseRequest(
          [
            userMessage(
              "Plan a three-city trip with a fixed budget, then revise it when the budget is cut by 40%. Show your reasoning steps.",
            ),
          ],
          {
            reasoning: { effort: "high", summary: "detailed" },
            include: ["reasoning.encrypted_content"],
          },
        ),
      );
    },
  },
  {
    name: "image-input",
    run: async (send) => {
      await send(
        baseRequest([
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "What color is this image?" },
              { type: "input_image", image_url: PIXEL_PNG, detail: "auto" },
            ],
          },
        ]),
      );
    },
  },
  {
    name: "pdf-input",
    run: async (send) => {
      await send(
        baseRequest([
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "What does this document say?" },
              {
                type: "input_file",
                filename: "hello.pdf",
                file_data: await helloPdfDataUrl(),
              },
            ],
          },
        ]),
      );
    },
  },
  {
    // Abandon the stream partway. Records what a client-side abort actually
    // sees, and therefore what state the agent must be able to recover from.
    name: "abort-midstream",
    run: async (send) => {
      await send(
        baseRequest([userMessage("Count slowly from 1 to 40, one per line.")]),
        { stopAfterEvents: 6 },
      );
    },
  },
  {
    // Records that the codex backend rejects max_output_tokens outright, so
    // mid-stream truncation is not reachable the way it is on the platform API.
    name: "truncation",
    run: async (send) => {
      await send(
        baseRequest([userMessage("Write a 500 word essay about clouds.")], {
          max_output_tokens: 32,
        }),
      );
    },
  },
];

async function main() {
  const requested = process.argv.slice(2);
  const selected = requested.length
    ? scenarios.filter((s) => requested.includes(s.name))
    : scenarios;

  if (!selected.length) {
    throw new Error(
      `No matching scenarios. Available: ${scenarios.map((s) => s.name).join(", ")}`,
    );
  }

  const credentials = await new CodexAuth().getCredentials();
  await fs.mkdir(fixtureDir, { recursive: true });

  for (const scenario of selected) {
    const turns: Turn[] = [];
    const send: Send = async (request, options) => {
      const events = await streamRequest(request, credentials, options);
      turns.push({ request, events });
      return events;
    };

    try {
      await scenario.run(send);
    } catch (e) {
      // Error responses are themselves ground truth; keep whatever we got.
      console.error(`${scenario.name}: ${(e as Error).message}`);
    }

    const file = path.join(fixtureDir, `${scenario.name}.json`);
    await fs.writeFile(file, `${JSON.stringify({ turns }, null, 2)}\n`);
    console.log(`${scenario.name} -> ${file}`);
    turns.forEach((turn, i) => {
      console.log(
        `  turn ${i}: ${turn.events.length} events, usage ${JSON.stringify(usage(turn.events) ?? null)}`,
      );
    });
  }
}

async function streamRequest(
  request: RequestBody,
  credentials: { accessToken: string; accountId: string },
  options: SendOptions = {},
): Promise<StreamEvent[]> {
  const abort = new AbortController();
  const res = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(request),
    signal: abort.signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text();
    return [{ type: "http_error", status: res.status, body }];
  }

  const events: StreamEvent[] = [];
  let buffered = "";
  const decoder = new TextDecoder();

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let boundary = buffered.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (data && data !== "[DONE]") {
          events.push(JSON.parse(data) as StreamEvent);
          if (
            options.stopAfterEvents !== undefined &&
            events.length >= options.stopAfterEvents
          ) {
            abort.abort();
            return events;
          }
        }
        boundary = buffered.indexOf("\n\n");
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  }

  return events;
}

await main();
