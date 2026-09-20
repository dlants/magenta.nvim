# Overview

This is a neovim plugin for agentic tool use. The entrypoint is `lua/magenta/init.lua`, which kicks off the `node/nvimclient/magenta.ts` node process. That process establishes a bidirectional bridge, grabbing options from lua and enabling communication between the two halves.

The node code is organized as npm workspaces:

- `node/server/` (`@magenta/server`) — standalone logic with no neovim dependency (tools, providers, Thread/ThreadCore, agent runner, EDL, etc.)
- Root project — neovim-specific code (sidebar, TEA rendering, buffer-tracker, nvim bindings)

The root `tsconfig.json` uses TypeScript project references to enforce the boundary: core cannot import from the root project.

Key entry points:

- `lua/magenta/options.lua` — plugin options
- `lua/magenta/keymaps.lua` — neovim keymaps
- `node/nvimclient/sidebar.ts` — manages the sidebar (chat/input buffers, keymaps)

# Semantic search (pkb)

This repo has a semantic search index over its code and docs, built with [pkb](https://github.com/dlants/pkb). For exploratory / orientation questions ("where is X handled?", "how does Y work?"), use `pkb search` rather than grepping. Reserve `grep` for exact symbol/string lookups.

```bash
pkb search "<natural language query>"   # -k N sets result count (default 5)
```

Each result is a snippet with its file path — treat it as a pointer and open the file to read the real code. The index reflects the last indexed commit on `main`, not your working tree. The `plans/` dir is excluded from the index (see `pkb.toml`).

<system_reminder> Prefer `pkb search <query>` to grep for exploratory queries. </system_reminder>

# Architecture

## Core layer (`@magenta/server`)

- **`Thread`** (`node/server/src/thread.ts`) is the stable server handle. It owns identity/title, archive and shared completed-tool results, mailbox, submission cancellation/coordination, chat policies, and the lifecycle result. Its private `core` is replaced during compaction; parents never inspect core identity or coordinate replacement.
- **`ThreadCore`** (`node/server/src/thread-core.ts`) is the only replaceable conversation unit. It owns the provider manager, tool execution/current turn, EDL registers, context-delivery supervisors (files, git, system info, reminders, edited files), preflight state, and their disposal. Forking snapshots native and linked supervisor histories at the same effective native index.
- **`runAgentLoop`** (`node/server/src/agent.ts`) runs one turn through provider requests and tool batches. It returns a turn handle with activity, cancellation, and a promise; it is not an event emitter. Thread owns policy ordering and continuations beyond that turn.
- **`NativeInferenceManager`** (`node/server/src/providers/provider-types.ts`) owns native history and one request at a time, including retries and stream accumulation. Implementations are `AnthropicInferenceManager` and `OpenAIInferenceManager`. Streaming progress uses a request-scoped callback, not an emitter.
- **`Mailbox`** (`node/server/src/submission/mailbox.ts`) owns synchronous tagged raw/resolved queue storage only. Thread handles delivery-time resolution, detached batches, reminders, compaction deferral, and stale-submission checks.
- **`ThreadCompactor`** (`node/server/src/compaction/compactor.ts`) orchestrates compact children and exposes observable history. It depends on ThreadManager, parent ID, and a per-run AbortSignal, not a Thread reference. Compact threads have no compactor.

`Thread.submit` accepts discriminated raw/resolved input and optional delivery (`now`, `async`, or `next`); `retry()` reissues the retained log without resolving or appending content. One submission owns resolution, turns, compaction, replacement, and continuation until rest. Deferred input queues while busy, including compaction gaps; immediate input preempts. Public promises return `RestResult` (plus `queued` from `submit`), never a `CoreLoopResult` carrying a yield: `RestResult` is just `CoreLoopResult` instantiated with the suspensions the thread did not resolve itself. `result` is the one-shot lifecycle outcome for subagents/scripts, distinct from submission outcomes and render-only `lastResult`.

Execution dependencies (including the resolver) and notification callbacks are supplied at construction. Chat policies survive replacement and run before core context delivery; queued user content is injected last. Environment dependencies also outlive replacement: core disposal releases conversation-local resources, not shared file I/O/git services. Fork construction supplies destination collaborators so local approval/bypass routing belongs to the fork.

The manager's native array is the wire format: `Anthropic.MessageParam[]` for anthropic, `OpenAI.Responses.ResponseInputItem[]` for openai. Requests are built from that array directly. Two invariants hold for both providers:

- **Nothing native escapes the manager.** `ProviderMessage` is a display type. Native items and native streaming blocks (`AnthropicStreamingBlock`, `OpenAIStreamingBlock`) stay inside; streaming progress is reported as the generalized `StreamingBlock`.
- **The conversion is one-directional.** `convertAnthropicMessagesToProvider` (`providers/anthropic-conversion.ts`) and `convertOpenAIItemsToProvider` (`providers/openai-conversion.ts`) derive `log.messages` from the native array and are memoized as `cachedProviderMessages`. There is no conversion back, so `ProviderMessage` never needs to carry wire-only fields, and no information is lost by round-tripping.

## Root layer (neovim-specific)

The root project uses a **single-dispatch TEA architecture**:

- **`RootMsg`** (`node/nvimclient/root-msg.ts`) — a discriminated union of all message types (`ThreadMsg`, `ChatMsg`, `SidebarMsg`).
- **`dispatch`** (`node/nvimclient/magenta.ts`) — the single state update point. Every message flows through `dispatch`, which forwards it to controllers and triggers a re-render.
- **Controllers** (e.g. `Chat`, `NvimThread`) — each maintains its own state and filters `RootMsg` for messages relevant to it. Each controller has a `myDispatch` that wraps local messages into the appropriate `RootMsg` variant.
- **`view`** — declarative TUI rendering using the `d` template literal, with `withBindings` for interactive elements.

## Sessions

**`Session`** (`node/server/src/session.ts`) is the authoritative thread registry. `Magenta` (`node/nvimclient/magenta.ts`) constructs exactly one implicit session, its `NvimSessionHost`, the server `ScriptManager`, and the view adapters; `Magenta.destroy` disposes the script manager and then the session. There is no session picker or global session registry yet, and detach/reattach across processes does not work: the host is in-process.

- Session owns identity, parent/script-invocation associations, pending creation and its cancellation, construction policy (fresh vs. fork), bootstrap submission, labels/title scheduling, lifecycle results, subtree abort, deletion and disposal. It implements `ThreadManager`, so subagent tools and compact children route through it.
- `assembleThread` (`node/server/src/thread-assembly.ts`) builds the ready `{ thread, compactor }` pair: supervisor ordering, compactor creation and automatic title generation. Session never touches `ThreadCore` or compaction replacement.
the delivery-time resolver, hierarchy discovery (supplied to `FileSupervisor` with the file services), and approval- The server `ScriptManager` (`node/server/src/scripts/script-manager.ts`) is session-owned: catalog, child-process IPC, logs, invocation lifecycle, titles and the invocation⇄thread association. It is wired as `session.scriptRunner` before any thread exists.
- Execution never depends on a view: starting input, settling results, and aborting scripts require no `RootMsg` dispatch.

## Core → Root bridge

`Chat` (`node/nvimclient/chat/chat.ts`) is a view adapter over the session: selection, expansion, viewed timestamps, archive navigation, buffers and the `NvimThread` wrappers. `threadWrappers` is a read-only projection of `session.listThreads()`; `Chat.dispose()` drops listeners and wrappers without destroying anything server-side. `ScriptController` (`node/nvimclient/scripts/script-manager.ts`) is the equivalent adapter for scripts. `NvimThread` wraps a ready server handle as `thread`; it owns UI state, debounced dispatch, and input/error presentation, not server execution setup.
- `onUpdate` schedules a `tool-progress` dispatch; views read `thread.loopState`, provider messages, tool results, usage, and edited files directly.
- Context deliveries are not published: `FileSupervisor`/`GitSupervisor` report the `nativeMessageIdx` they committed into, ThreadCore records the structured update against it, and views read it back through `Thread.getContextDelivery`. Forking filters those records at the fork point like the rest of the supervisor history. Hierarchy discovery is a capability on `ThreadCoreContext` that `FileSupervisor` consults itself when a file starts being tracked, so no parent observes file additions. Thread forwards core notifications only while that core is current, so replacement requires no subscriptions or rewiring by parents.
- `onSubmission` reports resolved input to the title scheduler in `thread-assembly.ts`, which uses the helper in `tools/thread-title.ts`, guards late results, and lets Thread own title/archive mutation. No view is involved.
- The wrapper observes the complete `submit`/`retry` promise once for completion notification and error presentation. It neither wraps execution for compaction nor checks the private core. Compactor transition events are observed only to repaint history/status.

Use `thread.contextFiles` for current file inspection/mutation rather than exposing FileSupervisor delivery hooks or lifetime controls. Resolve this capability at delivery time, not by capturing a retired core. Fixed callbacks may close over the completed wrapper because construction does not invoke them.

## Message flow

1. User action → binding or command dispatches a `RootMsg`
2. `dispatch` forwards the message to all controllers
3. Each controller filters for its own messages and updates internal state
4. Controllers may dispatch additional messages to other controllers
5. The view re-renders based on updated state

Key files:

- [root-msg.ts](https://github.com/dlants/magenta.nvim/blob/main/node/nvimclient/root-msg.ts) — root message union
- [magenta.ts](https://github.com/dlants/magenta.nvim/blob/main/node/nvimclient/magenta.ts) — central dispatch loop
- [tea/tea.ts](https://github.com/dlants/magenta.nvim/blob/main/node/nvimclient/tea/tea.ts) — render cycle
- [tea/view.ts](https://github.com/dlants/magenta.nvim/blob/main/node/nvimclient/tea/view.ts) — declarative TUI template

# View System

For comprehensive view system documentation and templating patterns, use `get_file` to access the `doc-views` skill at `.magenta/skills/doc-views/skill.md`.

**Important**: This is NOT React - it's a TUI templating system for neovim buffers.

# Testing

See `.magenta/skills/doc-testing/skill.md`.

Prefer public submissions and real nvim flows with mock providers/Defer-controlled boundaries. Server `test-helpers.ts` contains explicit white-box lifecycle helpers (`resetThread`, `getFileSupervisor`) for tests that must inspect core-owned resources; those are not production APIs or exports from the server barrel.

Quick reference:

- Run tests: `npx vitest run` (from project root, for local development)
- Run specific test: `npx vitest run <file>`

# Type checks

Use `npx tsc -b` to run type checking, from the project root. This uses build mode which handles the workspace project references (building `node/server` declarations first, then checking the root project). You do not need to cd into any subdirectory.

To type-check just the core package: `npx tsc -p node/server/tsconfig.json --noEmit`

To run just the core tests: `npx vitest run node/server/`

# Linting and Formatting

Use `npx biome check .` to run linting and formatting checks. Use `npx biome check --write .` to auto-fix issues.
