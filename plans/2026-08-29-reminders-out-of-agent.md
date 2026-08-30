# Objective and Context

> I think the system reminder mechanisms should be pulled out of the agent into the thread, using hooks.
> the agent should just run the loop, process tools, etc... and invoke hooks.
> The system reminder (and associated state) should sit outside, listen to hooks to update state, and submit system reminders via the `onBeforeRequest` hook

Entities involved:

- `Agent` (`node/core/src/agent.ts`) — the turn loop. Today it also owns reminder state (`outputTokensSinceLastReminder`, `bashTokensSinceLastReminder`, `pendingBashReminder`, `firstBashReminderPending`, `activeReminders`), scans tool structured results for reminder triggers, scans `contextTracker` for markdown `<system_reminder>` blocks, and builds reminders in `prepareUserContent` / `buildToolResponseExtras`.
- `Thread` (`node/core/src/thread.ts`) — owns `ThreadState` (including the reminder fields), the async/next queues, and the `onBeforeRequest` wrapper (`beforeRequest`) that adds `submissions`.
- `ThreadSupervisor` / `composeSupervisors` (`node/core/src/thread-supervisor.ts`) — the existing extension point; `onBeforeRequest` returns injections and/or a suspension.
- `buildSystemReminder` / `ReminderKind` (`node/core/src/providers/system-reminders.ts`) — pure reminder text builder. Unchanged.
- `NvimThread` (`node/chat/thread.ts:508`) — composes `MaxTokensSupervisor` + context supervisors + behavioral supervisors into `core.hooks`.

# Design

A new `SystemReminderSupervisor` holds all reminder state and emits reminders as `onBeforeRequest` injections. It is owned by the core `Thread` (not by `NvimThread`), because the `Thread` is also the thing that already activates reminders coming out of message resolution (`Thread.submit` / `resolveQueued`) and that resets agent state on compaction. `Thread` consults it in its `beforeRequest` wrapper, after the externally-supplied `this.hooks.onBeforeRequest`, appending its injections last (so they sit immediately before the user's own content, as today). External hook composition (`composeSupervisors` from `NvimThread`) is untouched.

The agent then needs to report two things it currently consumes itself:

1. **Tool results** — a new fire-and-forget `AgentHooks.onToolResults(results)` fired from `executeTools` once every tool has settled and before `onBeforeRequest` for the continuation. The supervisor reads `wasAbbreviated` (bash) and `files[].systemReminder` (get_files) from it.
2. **Output tokens** — `RequestContext` gains `outputTokenCount`: the cumulative output tokens in the runner's log, summed on demand. "Since the last reminder" is the supervisor's own business, so it keeps the last value it saw and diffs. The agent's `accountUsage` / `usageAccountedCount` bookkeeping and the token fields on `ThreadState` all go away.

While moving it, the policy also changes: today every user message carries a "subsequent" reminder unconditionally (and resets the counter), which sends far too many. The new rule is a single one — the token interval — applied uniformly to every request the supervisor sees, whether it is a user submission or a tool-result continuation. There is no user-message special case, so the supervisor needs to know nothing about queued user content.

Everything else about reminders — `system_reminder` vs `text` content type — collapses: the agent already funnels reminder content through `toAgentInput`, which maps `system_reminder` to `text`, so injecting plain text is behaviour-preserving.

## Interfaces

```ts
// thread-api.ts
export type AgentHooks = {
  onYield?: ...;
  onBeforeRequest?: ...;
  onToolApplied?: OnToolApplied;
  /** Every requested tool has settled; results are about to be written.
   * Fire-and-forget, consulted before `onBeforeRequest` for the continuation. */
  onToolResults?: (results: ToolResults) => void;
};

// thread-supervisor.ts
export type RequestContext = {
  inputTokenCount: number | undefined;
  isFirstMessage: boolean;
  /** Cumulative output tokens in the agent's message log. */
  outputTokenCount: number;
} & RequestContextKind;

// system-reminder-supervisor.ts (new)
export class SystemReminderSupervisor {
  constructor(opts: {
    threadType: ThreadType;
    subagentConfig?: SubagentConfig | undefined;
    contextTracker: ContextTracker;
  });
  activateReminder(text: string): void;   // called by Thread on resolved messages
  onToolResults(results: ToolResults): void;
  onBeforeRequest(ctx: RequestContext): SupervisorAction;
  get activeReminders(): ReadonlySet<string>;  // rendering / tests
}
```

`ThreadState` loses `outputTokensSinceLastReminder`, `bashTokensSinceLastReminder`, `pendingBashReminder`, `firstBashReminderPending`, `activeReminders`. `AgentAction` loses `increment-output-tokens`, `reset-output-tokens`, `mark-bash-output-abbreviated`, `activate-reminder`, `reset-bash-reminder`; `reset-agent-state` stops touching them. `Thread` exposes `get activeReminders()` delegating to the supervisor for anything that reads them today.

## Invariants

- `onBeforeRequest` fires exactly once per request that is actually issued to the inference endpoint — the opening request of a submission and each continuation carrying tool results — and never for a retry of one, nor at a stop that issues nothing.
- A reminder emitted with a user submission is ordered *after* all other injections and *before* the user's text — preserved because `Thread` appends the reminder supervisor's injections last, and the agent already puts `submissions` after `injections`.
- `threadType: "compact"` produces no reminders (`buildSystemReminder` already returns `undefined`; the supervisor is simply not constructed).
- The bash-summary reminder fires on every request that carries an abbreviated bash output — no token gating, so `BASH_REMINDER_TOKEN_INTERVAL` and the `bashTokensSinceLastReminder` / `firstBashReminderPending` state disappear entirely; the flag is set by `onToolResults` and cleared when the reminder goes out.
- The standing reminder — the skills/bash/edl/subagent block, plus the extra reminders derived from `get_files` results and markdown files in context, today's `ReminderKind: "subsequent"` — fires every `SYSTEM_REMINDER_MIN_TOKEN_INTERVAL` output tokens, and its counter resets only when it fires. Rename the kind to `"standing"` while we are here: "subsequent" only made sense against an "initial" variant that no longer exists.
- The very first request of a thread emits no reminder (zero tokens elapsed). The reminder text is not otherwise present in the request, so this needs a test: a `<system_reminder>` block in a markdown file that is read into context, or in an agent definition, must reach the model at least once — either shipped verbatim with the content it came from, or via the first standing reminder that fires.
- Compaction starts from clean reminder state: `Thread` mints a fresh `SystemReminderSupervisor` where it dispatches `reset-agent-state` today, rather than reaching into an existing one.

# Stages

## hook plumbing — DONE

- Goal: `RequestContext` carries `outputTokenCount`; `AgentHooks.onToolResults` exists and fires from `executeTools`. No behaviour change — the agent still builds reminders from its own state.
- Tests:
  - Existing `node/chat/system-reminders.test.ts` and `node/core/src/agent.test.ts` still pass unchanged (this stage is a pure addition).
  - A core test asserting that for a turn with a tool call, the continuation's `RequestContext` includes the assistant message's output tokens in `outputTokenCount`, and that `onToolResults` fired before `onBeforeRequest`.

Notes:

- `outputTokenCount` is computed on demand in `Agent.applyBeforeRequestActions` by summing `usage.outputTokens` over `runner.log.messages`; the existing `accountUsage` bookkeeping is untouched in this stage.
- `onToolResults` fires in `Agent.executeTools` right after the results map is complete (and after `set-mode: normal`), so it precedes the abort/yield checks and the continuation's `onBeforeRequest`.
- Deviation: `AnthropicRunner` rebuilt `cachedProviderMessages` *before* recording `messageStopInfo` for a finished message, so the last message's `usage`/`stopReason` only appeared one rebuild later. Reordered those two lines; two `getMessages()` snapshots (`thread-abort.test.ts`, `thread.test.ts`) gained the now-present `usage`/`stopReason` on the final assistant message and were updated.
- Test-only churn: every `RequestContext` literal in supervisor tests gained `outputTokenCount: 0`.

Review follow-ups (stage 1):

- `onToolResults` fires unconditionally, including on turns that abort or yield and issue no continuation. That is deliberate — a consumer accumulating state off results (abbreviated bash output) needs it carried into the next request even if that request belongs to a later turn — and is now documented on the hook in `thread-api.ts` and covered by two tests (`agent.test.ts`: abort during tool_use, yield_to_parent).
- `outputTokenCount` stays `number` with a 0 fallback for messages lacking usage: it feeds a monotonic "tokens since the last reminder" gate, where an under-count costs at most one request of delay and an `undefined` would stall the gate. Documented at the definition. Test extended to a second tool turn, asserting the cumulative sum (42 + 8) rather than the last message's usage.
- Reviewer also suggested turning `ProviderMessage` into a streaming/finished discriminated union to remove the optional `usage`/`stopReason`. Declined for this stage: it touches every provider, runner and snapshot, and is unrelated to pulling reminders out of the agent.

## reminder supervisor

- Goal: `SystemReminderSupervisor` implements the full policy; `Thread` owns it, feeds it `onToolResults`, routes resolved-message reminders into it, re-mints it on compaction, and appends its injections in `beforeRequest`. All reminder state and logic deleted from `Agent` and `ThreadState`.
- Tests:
  - `node/chat/system-reminders.test.ts` (integration, via mock provider), updated for the new policy: no reminder on a user message that is under the token interval, interval-gated reminders during auto-respond and across user turns alike, bash-summary reminder after abbreviated output, get_files-derived reminders, markdown `<system_reminder>` propagation, none for compact threads.
  - `node/core/src/thread.test.ts` reminder assertions move from `state.activeReminders` to `thread.activeReminders`.
  - A unit test that a user submission arriving under the interval emits no reminder, and one arriving over it does.

## drop the turn-end request context

`onBeforeRequest` fires today with `kind: "turn-end"` at a stop that issues no request, purely so `AutoCompactSupervisor` can suspend while the thread is at rest (waiting for the user's next message would put that message in the log first). That is an end-of-turn question wearing a before-request costume: three context supervisors open with a `kind === "turn-end"` guard just to opt out of it.

- Move it to `onEndTurn`: `EndTurnAction` gains `{ type: "suspend"; reason: SuspendReason }`, and `EndTurnContext` gains `inputTokenCount` so `AutoCompactSupervisor` can answer there. `composeSupervisors`' `onEndTurn` merge takes the first `suspend`, otherwise joins `send-message` texts as it does now.
- `RequestContextKind` loses `TurnEndRequest`; `Agent.applyStopHooks` loses its `kind` parameter and only consults the hooks when a continuation is actually planned, so `Thread.continuation` asks `onEndTurn` for the resting case and `applyStopHooks` for the continuing one.
- The `turn-end` guards come out of `FileContextSupervisor`, `GitSupervisor` and `CommentSupervisor` — the case can no longer reach them.

- Goal: `onBeforeRequest` fires only when a request is about to be issued.
- Tests:
  - Auto-compaction still triggers at a resting `end_turn` stop once the input token threshold is breached (existing `thread-compact` tests).
  - `agent.test.ts:1589` / `:1617` — which assert the `["submission", "continuation", "turn-end"]` sequence — become assertions that no hook fires at a resting stop.
  - The context supervisors never drain their pending updates at a stop that issues no request (their existing `turn-end` tests, restated as "no consultation happens").

## cleanup

- Goal: `Agent` has no knowledge of reminders; `grep -n "Reminder" node/core/src/agent.ts` is empty. `npx tsc -b`, `npx vitest run`, `npx biome check .` clean.
- Tests: full suite.
