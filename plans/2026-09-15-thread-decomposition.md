# Objective and Context

Original request, verbatim:

> we have a lot of surface area in the thread class right now. I want to try and decompose it, especially with respsect to how it interacts with the parent objects that instantiate it.
>
> Analyze this. Keep an eye for unnecessary indirection, redundant API surfaces, or things that can be extracted out of thread because they are independent concepts.
>
> Propose some things we could improve, order by impact

Follow-up, verbatim:

> 1. sounds good
> 2. I think this is what *core* is supposed to be. It is the swappable piece and all of the objects with linked lifecycles.
> 3-7 all good
>
> Write up a plan

The accepted direction is to internalize complete submission execution, complete ThreadCore's ownership of replaceable state, centralize construction/fork assembly, extract deferred delivery, simplify supervisor composition, prune redundant APIs, and extract title generation. **ThreadCore is the swappable ownership unit. Do not introduce another generation class around it.**

## Current relationships

- `Thread` owns stable identity, submission queues, yield/result state, logging, and a replaceable `ThreadCore`, but also currently owns the supervisors and EDL registers that must be replaced alongside that core.
- `ThreadCore` owns the inference manager, tools, current agent turn, and disposal. `runAgentLoop` remains the turn-level runner.
- `runSubmission` in compaction wraps a Thread submission externally, handling compact suspensions, reset, and continuation. Both it and `ThreadCompactor` inspect core identity and interruption state.
- `Chat` owns hierarchy/environment orchestration and constructs `NvimThread`; `NvimThread` constructs the server Thread, assembles dependencies again for forks, contributes supervisors, resolves commands, and adapts progress to UI dispatch.
- `ThreadManager` is already a narrow capability used by tools and compact child threads. Script callers reach it through Chat/IPC rather than constructing another kind of server Thread.
- `Thread.result` is a one-shot lifecycle outcome. Submission results and render-only last-result state have different lifetimes and must not be collapsed into it.

## Relevant files

- `node/server/src/thread.ts`: stable handle, construction, submission/continuation, supervisors, reset/fork, title generation.
- `node/server/src/thread-core.ts`: current swappable core and agent-turn/tool execution ownership.
- `node/server/src/thread-api.ts`, `loop-state.ts`: outcome and observable activity contracts.
- `node/server/src/thread-supervisor.ts`: hook contracts and built-in policies.
- `node/server/src/submission/index.ts`: raw/resolved submissions, delivery parsing, and resolution contract.
- `node/server/src/compaction/index.ts`: external submission wrapper and compactor contract.
- `node/server/src/compaction/compactor.ts`: compact child orchestration and observable run history.
- `node/server/src/supervisors/file-supervisor.ts`, `git-supervisor.ts`, `system-reminder-supervisor.ts`: conversation-local delivery/history and resource ownership.
- `node/server/src/thread-logger.ts`: stable archive and compaction records.
- `node/server/src/tools/thread-title.ts`: title tool specification and input validation.
- `node/nvimclient/chat/chat.ts`: fresh/fork ownership, environment setup, hierarchy subscriptions, supervisor policy.
- `node/nvimclient/chat/thread.ts`: UI adapter, duplicated construction, command resolution, submission wrapper.
- `node/nvimclient/chat/thread-view.ts`: read-model consumers to migrate without adding forwarding layers.
- `node/server/src/test-helpers.ts`: server test construction and mock-provider boundary.
- Existing tests: server `thread.test.ts`, `thread-core-context.test.ts`, `thread-supervisor.test.ts`, `compaction/index.test.ts`, supervisor tests; nvim `thread-compact.test.ts`, `thread-abort.test.ts`, `fork-thread.test.ts`, `supervisor-wiring.test.ts`, and view/edited-file tests.

# Design

## Ownership

- **Thread:** stable identity and metadata, archive/shared immutable tool results, mailbox, submission cancellation and complete run-to-rest coordination, lifecycle result/yield contract, chatSupervisors, and stable outward notifications. It owns one replaceable ThreadCore. Compaction is a supplied capability, not a requirement for every thread.
- **ThreadCore:** provider manager, tool execution, EDL registers, file/git/system-info/reminder/edited-file supervisors, preflight counts, generation-bound hooks/subscriptions, and resource disposal. Creation, fork, and disposal operate on this entire unit.
- **Mailbox:** deferred message storage and synchronous queue/batch operations only. The submission coordinator owns delivery-time resolution, compact deferral, reminder activation, and accounting for consumed content. Mailbox has no resolver, logger, cancellation dependency, or Thread reference.
- **ThreadCompactor:** compact child creation/cleanup and compaction history. It depends on ThreadManager, parent ID, and a per-run cancellation signal, not a Thread object.
- **Chat construction functions:** environment/dependency assembly, chat-supervisor selection, fresh/fork construction, and wrapper attachment. Use functions rather than a generic factory/service framework.
- **NvimThread:** UI state, dispatch/debounce, input/error presentation, and observation of the ready server Thread. It does not reconstruct server dependencies or enforce mandatory submission wrapping.

Retain `runAgentLoop` and ThreadCore's turn boundary. Internalize the compaction wrapper as Thread's complete submission coordinator, initially by moving/adapting the existing logic rather than adding an exported coordinator class. Extract a private implementation helper only if it reduces coupling; it must not receive a large callback bag reproducing Thread's API.

## Interfaces

The following are target boundary changes, not compatibility aliases to keep indefinitely. Existing types not mentioned remain in place.

### Complete submissions

Use one submission entry point with distinct raw and resolved input forms:

```ts
type ThreadSendResult = RestResult | { type: "queued" };

type SubmissionInput =
  | { type: "raw"; message: PendingMessage }
  | { type: "resolved"; messages: AgentInput[] };

// Public Thread operations:
submit(input: SubmissionInput, delivery?: Delivery): Promise<ThreadSendResult>;
retry(): Promise<RestResult>;
abort(): Promise<{ unsent: ReadonlyArray<QueuedMessage> }>;
```

`SendResult` remains an internal turn/continuation outcome that can include suspension. Both input forms pass through the same submission ownership/cancellation path and consume compact handoffs before settling. Raw input resolves commands at delivery time; resolved input bypasses resolution so literal command text, images, and documents remain intact. Delivery defaults to `now`; `async` and `next` queue only while busy. Remove the public `send` method and `SendOptions` rather than keeping compatibility aliases. `retry()` explicitly reissues the retained log without appending user content or rerunning command resolution, using the same coordinator; the old empty-send `force` mechanism becomes internal bookkeeping rather than a public option. Keep the existing handling of unclaimed suspensions unless a separate behavior change is approved. `abortAgentTurn`, reset-for-compaction, core identity, and interruption tokens become internal mechanisms rather than a protocol parents must execute.

A single submission remains current across its compaction reset and resumed request. A newer immediate submission, abort, or destroy invalidates it. A deferred enqueue does not invalidate it. Awaited steps check submission ownership before mutating current state. Post-compaction continuation stays internal: do not call public `submit` or `retry` recursively, since that would create a replacement submission.

### Compaction

```ts
interface Compactor {
  run(
    messages: ReadonlyArray<ProviderMessage>,
    nextPrompt: string | undefined,
    signal: AbortSignal,
  ): Promise<CompactionOutcome>;
}

type ThreadCompactorDeps = {
  parentThreadId: ThreadId;
  threadManager: ThreadManager;
};
```

Construct ThreadCompactor from these dependencies, inject it into Thread, and let the UI observe the same instance's existing transitions/history. Compact threads receive no compactor. The signal replaces reading Thread's current core; supersession, destruction, or explicit reset invalidates the operation at its owner. Preserve cleanup if cancellation occurs while child creation is awaiting: delete a late-created child before returning aborted.

### Resolution versus observation

Move `resolve: ResolveSubmission` from mutable `ThreadCallbacks` into immutable execution dependencies. Supply fixed notification callbacks at construction; listeners are known up front and do not change during the Thread's lifetime, so no Thread Emitter or dynamic subscription API is needed:

```ts
type ThreadCallbacks = {
  readonly onUpdate: () => void;
  readonly onFilesSent?: (updates: FileUpdates) => void;
  readonly onGitSent?: (update: GitContextUpdate) => void;
  readonly onFileAdded?: (path: AbsFilePath) => void;
};
```

Fresh and forked threads receive their real resolver and fixed callbacks at construction. The construction function wires UI notifications and Chat's hierarchy discovery once; NvimThread neither subscribes dynamically nor replaces callbacks. Thread stores the callback object immutably, and core notifications forward through it only while that core is current. Core replacement therefore requires no parent-side rewiring. Enumerate initial files once construction is complete as today. Callback closures may refer to the completed wrapper binding, but construction must not invoke callbacks before that binding is ready; do not introduce placeholder callbacks or an attachment setter.

Extract the nvim resolver from the wrapper into a construction helper with the current command-registry/environment dependencies and a getter for the current FileSupervisor. The getter is resolved at delivery time and must not capture a retired core. The factory may close over the completed Thread binding because resolution is never invoked during construction; no placeholder resolver or mutable resolver replacement is needed.

### Environment lifetime and sharing

Environment dependencies live outside the swappable core and are supplied to each replacement core. Reset reuses the thread's existing environment rather than reconstructing file I/O or other environment collaborators. Core disposal owns conversation-local resources, not shared environment dependencies.

- `cwd` and `homeDir` are fixed environment values, not conversation state. Reuse them across resets; do not make them process-global because threads may use different working directories or containers.
- `FsFileIO` has no instance state and may be shared.
- `SandboxFileIO`, used for local threads, captures thread-specific write-approval and sandbox-bypass callbacks. A fork needs bindings for its own permission owner even when it uses the same filesystem and paths. Share underlying services, not another thread's approval routing.
- `DockerFileIO` is container-bound and may be shared where container identity and lifetime match; do not share it across different containers.
- `InMemoryFileIO` owns mutable file contents. Preserve the intended per-compaction-child isolation; do not globalize or recreate that state during a core reset.

Fresh/fork construction chooses the appropriate environment dependencies once. Core creation and history cloning consume those dependencies without taking ownership of their external lifetime. Do not introduce a global registry or pooling abstraction just to avoid constructing cheap stateless adapters.

### Core lifecycle

Move the existing `createCore`, `cloneCore`, supervisor construction, tool-context assembly, and generation-bound event setup into ThreadCore creation/fork routines. Keep the existing `runTurn(messages: AgentInput[]): Promise<SendResult>` and `dispose(): Promise<void>` concepts. Private construction argument records should contain the actual dependencies already present, not an entire Thread reference.

- Core owns and disposes every generation-bound resource, including the file polling timer.
- Fork snapshots native history and linked supervisor history at the same effective native index before awaiting unrelated work.
- Fork copies conversation history and receives the fork's environment dependencies; it does not blindly construct fresh collaborators or blindly retain source collaborators. Share dependencies where environment and permission ownership are identical. Existing FileSupervisor/GitTracker clone helpers retain source collaborators, so allow explicit destination dependencies where they differ. In particular, a local fork must not retain the source thread's write-approval or sandbox-bypass callbacks.
- Core replacement preserves only deliberate thread-level state. Keep current reset/fork semantics for tracked files, edited-file history, reminders, EDL registers, tool-result archive, and pending seed; do not use a generic shallow clone.
- chatSupervisors remain server Thread-owned and survive core replacement; core delivery supervisors do not.

### Mailbox

Extract into `submission/mailbox.ts`, retaining the existing PendingMessage/AgentInput distinction and read-only queue shape internally. Normalize the public SubmissionInput at the mailbox boundary: raw input becomes one tagged raw entry; each resolved AgentInput becomes a tagged resolved entry without invoking the resolver. Branch on the entry's discriminant, not typeof or the inner AgentInput type. Update queued-message rendering and abort's unsent entries to use this same QueueEntry union.

```ts
type DeferredDelivery = "async" | "next";
type QueueEntry =
  | { type: "raw"; message: PendingMessage }
  | { type: "resolved"; input: AgentInput };
type Queues = {
  async: ReadonlyArray<QueueEntry>;
  next: ReadonlyArray<QueueEntry>;
};
// Mailbox operations (all synchronous):
get queues(): Queues;
enqueue(delivery: DeferredDelivery, entries: QueueEntry[]): void;
takeBatch(delivery: DeferredDelivery): QueueEntry[];
prepend(delivery: DeferredDelivery, entries: QueueEntry[]): void;
drain(): QueuedMessage[];
```

Mailbox has no constructor dependencies. Its read-only `queues` getter supports inspection and UI rendering; callers inspect array lengths when needed, with no separate snapshot or count API. `takeBatch` synchronously removes and returns the entries currently in one queue. New arrivals remain in that queue for a later batch. `prepend` restores unprocessed entries ahead of newer arrivals when the coordinator explicitly requests it; mailbox does not interpret their contents.

The submission coordinator owns flush-before-request and flush-at-stop. It takes a batch, resolves raw entries through `ResolveSubmission`, passes resolved entries through unchanged, logs resolution errors, handles compact directives, and activates reminders at the appropriate native index. After each awaited resolution it checks submission ownership and either applies or discards the result. Mid-turn compact deferral, restoring unprocessed entries, and carrying already-consumed content through compaction all remain coordinator responsibilities rather than mailbox behaviors. A stale coordinator must not consume a replacement submission's entries or return obsolete leftovers to its queues. Preserve existing delivery ordering and abort reporting, including explicit accounting for unprocessed entries in a detached batch. Discarding resolved output does not undo command side effects already performed during resolution.

### Policy and public read surfaces

Accept `chatSupervisors: readonly ThreadSupervisor[]` when constructing the server `Thread`, not ThreadCore, defaulting to empty for deliberately bare server fixtures. The shared nvim construction function assembles this list on behalf of Chat: MaxTokens first, then Docker/Subagent policy as appropriate, then auto-compaction last. Compact threads omit auto-compaction. The server Thread retains this list across ThreadCore replacements; ThreadCore owns only its conversation-local context supervisors. Remove both mutable supervisor setters once tests supply their intended chatSupervisors at server Thread construction.

Run chatSupervisors before ThreadCore's context-delivery supervisors, with queued user content injected last. Auto-compaction is last among chatSupervisors, but must precede context delivery so a compact suspension cannot occur after file/git/reminder state has been committed for a request that will not go out. Replace preflightRecorder and yieldGate with explicit fixed execution bookkeeping, preserving exactly when preflight values and successful yield tool results are observed. Do not create a generic middleware framework.

Use `NvimThread.thread` for its server Thread; Thread's private `core` is ThreadCore. Retain meaningful read models (`loopState`, `lastResult`, `result`, `yielded`, messages, tool results, edited files). Do not merge lifecycle result with display status. Keep one tool-spec accessor and one read-only provider-message accessor; copy arrays at callers when necessary. Expose current context-file functionality as a scoped capability rather than adding a Thread forwarding method for every FileSupervisor method. Fixed notification callbacks belong to Thread even if operations use the current capability.

### Title generation

Extract a helper accepting provider, fast-model identifier, system prompt, and user text, returning `Promise<string | undefined>`. Reuse the existing tool specification/validation. Thread keeps title storage and archive recording; the owner triggers automatic generation for an eligible first submission. Capture an owner-side request/revision guard so late automatic results cannot replace manual titles or mutate a destroyed thread. Preserve existing fork/compact title behavior and do not introduce a new title service class.

## Invariants

- ThreadCore is the only swappable generation object; no additional generation wrapper.
- A public submission settles only after internal continuations and compaction are finished, or when superseded/aborted/failed. UI completion notifications occur once for that submission.
- Activity/busy state covers compaction gaps as well as provider turns. Deferred submissions during compaction queue rather than unintentionally canceling the active submission; immediate submissions preempt it.
- Disposed cores and stale asynchronous continuations cannot mutate current state or publish current-thread updates.
- Reset cannot leave a live Thread pointing at an irreversibly disposed core, even if cancellation occurs while disposal is awaiting.
- Resolution happens at delivery time, at most once for each consumed entry. A suspended request cannot consume delivery state it will not send.
- Preserve async/next ordering, flush-start batch boundaries, mid-turn compact deferral, and spent-content carry onto compaction. Preserve current handling of non-text inputs; do not silently expand or narrow the compaction carry contract in this refactor.
- Empty submissions issue a request only for actual pending content; explicit `retry()` can reissue the retained log without new content. Standing reminders/system info alone do not count.
- Fork uses the effective truncated native index, does not abort the source, and does not rerun auto-context discovery/system-prompt generation.
- Shared completed-tool results remain immutable and survive reset/fork. Queue storage and lifecycle result belong to the stable Thread.
- Environment values and collaborators outlive core replacement. Sharing must preserve filesystem/container identity, in-memory isolation, and thread-specific permission ownership; immutable configuration alone does not make a collaborator globally interchangeable.
- Accepted teardown yields prevent future work; ordinary yielded threads retain their existing resumability. Lifecycle result settles at most once.
- Compact threads do not recursively compact; script and subagent structured results retain their existing contracts.
- No new external dependencies; no generic lifecycle, factory, hook, or event framework.

# Stages

## 1. Complete ThreadCore ownership

### Progress (September 16, 2026)

- [x] ThreadCore constructs the provider manager, tool catalog/context, EDL registers, and conversation-local supervisors; it clones linked histories at the effective truncated native index and disposes polling/listeners with its turn.
- [x] Thread retains its environment, shared completed-tool archive, lifecycle/submission state, and fixed outward notification callbacks; existing supervisor/read accessors temporarily forward to the current core.
- [x] FileSupervisor/GitTracker clone routines accept destination collaborators, preventing forks from retaining the source's file permissions or git environment.
- [x] Fixed file-added/sent/git notifications survive reset without parent-side subscriptions. Fresh/fork nvim paths supply real callbacks at construction; fork closures bind to the completed wrapper without placeholder callbacks or replacement.
- [x] Added reset/stale-notification, destination-collaborator, in-memory isolation, destroy-during-reset, and fork permission/bypass regression coverage. Existing historical-boundary/reminder/edited-file/archive cases remain in place.
- [x] Full-project validation: `npx vitest run` (125 files passed, 1697 tests passed; 2 existing skipped tests and 1 todo), `npx vitest run node/server/` (59 files, 1031 tests passed), `npx tsc -b`, and `npx biome check .` (357 files checked). Stage 1 committed as `Stage 1: Complete ThreadCore ownership`.

Decisions: keep the existing submission APIs, mutable resolver field, owner-supervisor setters, and preflight/yield bookkeeping for their planned later stages. Only notification callbacks and their container reference become readonly here. Moving the minimal fork callback wiring forward from stage 4 is necessary to make notifications fixed in stage 1; shared construction/resolver extraction remains stage 4. Environment services remain externally owned; core disposal never destroys file I/O or git clients.

### Stage 1 review follow-up (September 16, 2026)

- [x] Replaced permissive core initialization options with the shared `ThreadCoreInitialization` fresh/fork discriminated union. `Thread.createCore` uses the same union, including explicit fresh initialization on reset.
- [x] Replaced the fork wrapper's prebuilt-core argument and unassigned callback target with a synchronous core factory receiving the existing `NvimThread`. Fork callbacks now come from that wrapper's existing `coreCallbacks()` implementation, just like fresh construction. `Thread.clone` is synchronous because history/resource cloning performs no asynchronous work; this also removes the artificial await between snapshotting and wrapper construction. No placeholder callbacks, attachment setter, or additional lifecycle abstraction was introduced.
- Shared nvim dependency assembly remains stage 4; only the unsafe fork attachment boundary was changed here.
- Validation exposed intermittent Neovim socket startup timeouts in unrelated integration tests across two full-suite runs. Increased the readiness polling deadline from 500 ms to 5 seconds (still returns immediately when ready), rather than adding sleeps or changing production behavior.
- [x] Final full-project validation: `npx vitest run` (125 files passed, 1697 tests passed; 2 existing skipped tests and 1 todo), `npx tsc -b`, `npx biome check .` (357 files checked), and `git diff --check`. Existing historical-index tests now consume synchronous clone results directly.

Validation uncovered an existing `dd` context-file removal failure, reproduced with all node changes temporarily restored to HEAD. Removing a file pruned pending state before refresh compared it, suppressing the update notification. Added the missing removal notification so the existing integration test and full suite can pass.

- Goal: replacing/discarding one core replaces/discards all conversation-local state and resources.
- Move linked state and create/fork/dispose logic into ThreadCore. Thread temporarily forwards existing read APIs to keep this stage focused.
- Separate core-bound notification forwarding from fixed Thread callbacks; forward file-added/sent/update notifications through the constructor-supplied callbacks so reset requires no parent-side rewiring.
- Keep environment dependencies outside ThreadCore and reuse them across reset. When cloning history, supply fork-specific collaborators only where environment or permission ownership differs; remove duplicated conversation-resource destruction from Thread once core disposal owns it.
- Tests:
  - Extend server `thread-core-context.test.ts`: reset disposes old polling, retains tracked context as specified, and publishes only new-core updates.
  - Supply callbacks once at construction, reset, add a file, and observe file-added/context delivery through the same callbacks without rewiring.
  - Reset reuses environment dependencies and preserves in-memory file contents while replacing conversation-local tracking. Distinct compact children remain isolated, and disposing one core does not invalidate shared environment services.
  - Fork at a historical boundary and verify linked histories use the effective truncation index and the intended environment. Local-fork permission requests/bypass checks must use the fork's owner, not the source's.
  - Destroy during reset and late tool completion cannot publish or resurrect a disposed generation.
  - Run existing edited-file, reminder, git, fork, and archive tests.

## 2. Internalize complete submission coordination

### Progress (September 17, 2026)

- [x] Added discriminated raw/resolved `submit` and explicit `retry`; migrated callers and removed `send`, `SendOptions`, and the exported compaction wrapper.
- [x] Thread now owns one submission across resolution, provider turns, compaction, reset, and continuation. Deferred submissions see the compaction gap as busy; immediate submissions invalidate the previous owner before awaiting work.
- [x] ThreadCompactor receives only parent ID/ThreadManager dependencies and a per-run AbortSignal. Fresh/fork nvim paths inject the same compactor instance observed by the UI; UI completion observes only the complete public promise.
- [x] Migrated existing suspension assertions to public rest outcomes while retaining low-level runner suspension coverage and cancellation scenarios.
- [x] Added cross-compaction raw/resolved deferred-delivery regressions, preserving literal command text and image/document inputs; retry coverage verifies one-time command resolution, no duplicate retained content, and cancellable compaction.
- [x] Added raw/resolved preemption during irreversible reset and public-submission late-child cleanup tests. Cancelled resets restore a live core without installing stale summaries. Queue draining happens before awaited teardown so an obsolete operation cannot drain replacement work.
- [x] Verified the real nvim compact flow emits no turn-end notification at the handoff and exactly one after its continuation finishes.
- [x] Full validation: `npx vitest run` (125 files passed, 1706 tests passed; 2 existing skipped tests and 1 todo), `npx vitest run node/server/` (59 files, 1040 tests passed), `npx tsc -b`, `npx biome check .` (357 files), and `git diff --check`.

Decisions: retain the existing queue storage/entry representation for stage 3, mutable resolver and policy setup for stage 4, and existing administrative reset/core read surfaces for stage 5. The internal reset path retains submission ownership and serializes a replacement submission behind an in-progress irreversible reset. An existing integration test used the former idle compaction gap as a stop boundary; it now keeps the initial turn below the threshold and tests the subsequent threshold crossing. Archive-cleanup fixtures await pending archive writes before deleting their directories.

- Goal: one `submit(SubmissionInput, delivery?)` operation handles raw and resolved content; explicit `retry()` and explicit/automatic compact work without an external runSubmission wrapper.
- Migrate all raw/programmatic call sites to the discriminated submit input with shared Delivery semantics. Replace empty forced sends with retry(), remove send/SendOptions, and keep post-compaction continuation internal.
- Change Compactor to per-run cancellation and narrow ThreadCompactor dependencies.
- Move compaction handoff/reset/resume under Thread's submission lifetime; remove root wrapping and parent core/signal checks.
- Keep submission identity across reset; distinguish external supersession from an internal continuation. Update busy/render state throughout compaction using existing preparing activity where no agent turn is active.
- Make public outcomes non-suspended; move low-level suspension assertions to internal/core tests as necessary.
- Tests:
  - Migrate compaction/index.test.ts to public Thread calls and preserve its cancellation scenarios rather than deleting them.
  - Raw and resolved submissions share preemption, queueing, and compaction behavior; only raw submissions invoke command resolution. Literal @compact in resolved text remains literal, and images/documents are preserved.
  - Retry reissues the retained failed request without duplicating user content or repeating command effects, and can itself pass through compaction and cancellation.
  - Immediate send during resolution, token counting, compact child creation, compact result waiting, and reset supersedes exactly one old submission.
  - Async/next sends during compaction remain queued and are delivered once afterward.
  - Abort/destroy deletes active or late-created compact children and never resumes the old submission.
  - Explicit compact waits for a busy turn to settle before snapshotting it.
  - Failed compaction, unclaimed suspension, explicit retry, compact-thread behavior, and one-time UI notification remain correct.

## 3. Extract mailbox storage

### Progress (September 17, 2026)

- [x] Added dependency-free Mailbox storage with synchronous enqueue/takeBatch/prepend/drain operations and raw/resolved QueueEntry normalization. Queue inspection, rendering, and abort reports now use the tagged entries; removed the redundant queuedCount accessor.
- [x] Thread retains delivery-time resolution, reminders, errors, compaction detection/deferral, spent-content carry, and ownership checks. Flushes detach a fixed batch; later arrivals stay queued. Unprocessed entries are explicitly tracked for ordered abort reporting and immediate-submission discard.
- [x] Added mailbox ordering/normalization tests and Defer-controlled public-submission regressions for abort leftovers, supersession, reset retention, and arrivals during resolution. Existing delivery-time contents, image/document bypass, compact deferral/carry, suspension, and resolution-error coverage remain passing.
- [x] Full-project validation: `npx vitest run` (126 files passed; 1713 tests passed, 2 skipped tests and 1 todo), `npx vitest run node/server/` (60 files, 1047 tests passed), `npx tsc -b`, `npx biome check .` (359 files), and `git diff --check`.

Decisions: administrative reset synchronously restores untouched detached entries before replacing the core, preserving its existing queue-retention semantics. Obsolete flushes only clear their own batch record and cannot restore or consume replacement work. Entries whose resolution has begun remain consumed (including command side effects), matching existing abort behavior. Mailbox owns storage only; detached-batch accounting stays in Thread. Initial overlapping full/core test runs encountered shared archive-fixture collisions and integration timeouts; rerunning the suites sequentially passed without unrelated production/test changes.

- Goal: mailbox owns queue storage; the submission coordinator owns when and how queued entries are resolved and delivered.
- Move only queue storage and synchronous enqueue/takeBatch/prepend/drain operations into mailbox. Use the tagged QueueEntry union consistently in the queues getter, QueuedMessage, rendering, and abort results.
- Keep ResolveSubmission, resolution-error logging, flush orchestration, compact deferral, spent-content carry, ownership checks, native message indices, and reminder activation in the coordinator. Mailbox returns unresolved batches and takes no dependencies. Track detached-batch leftovers explicitly so cancellation and abort reporting retain their existing semantics.
- Tests:
  - Existing deferred-submission tests continue through public Thread entry points.
  - Mailbox batch removal is synchronous: later enqueues remain queued, prepend preserves order ahead of later arrivals, and drain reports delivery labels without resolving or interpreting entries.
  - Commands observe delivery-time file contents; resolved image/document inputs bypass raw-command resolution.
  - Enqueue during an awaited flush follows existing batch boundaries.
  - Supersede or abort while resolution is awaiting: the coordinator discards stale content/reminders, and the obsolete flush cannot consume or restore entries into the replacement submission's queue. Do not assert rollback of command effects already performed during resolution.
  - Suspension does not resolve commands or commit reminders; mid-turn compact and trailing entries move correctly.
  - A failed resolution is visible and does not wedge later delivery.
  - Drained text survives compact suspension exactly once; abort reports unsent entries with correct delivery labels.

### Stage 3 review follow-up

- [x] Made both `Queues` properties readonly as well as their array values, preventing typed callers from replacing the live mailbox queues through `Thread.queued`. Internal storage remains mutable only through mailbox operations.
- [x] Validation: `npx vitest run` (126 files passed; 1713 tests passed, 2 skipped tests and 1 todo), `npx tsc -b`, `npx biome check .` (359 files checked), and `git diff --check` all passed.

## 4. Centralize construction and policy composition

### Progress (September 17, 2026)

- [x] Shared nvim construction functions assemble fresh/fork execution dependencies, the compactor, delivery-time resolver, fixed callbacks, and ordered chat policies before constructing the UI wrapper. NvimThread no longer constructs server Threads or installs policies/resolvers.
- [x] Resolution is a readonly execution dependency; chatSupervisors are constructor-supplied, readonly, and survive core replacement. Removed both mutable supervisor setters and replaced preflight/yield pseudo-supervisors with fixed execution bookkeeping between chat and context policies.
- [x] Migrated server fixtures to constructor-supplied policies/resolvers, including stateful policies for tests that previously swapped hooks during a submission. Bare fixtures still default to no chat policies.
- [x] Added construction-policy coverage for compact, Docker-root, and supervised Docker configurations; fresh/fork command resolution and equivalent tools; script-fork yield-schema/auto-compaction override retention; and hierarchy discovery on the first file added after real compaction.
- [x] Full-project validation: `npx vitest run` (126 files passed; 1717 tests passed, 2 skipped tests and 1 todo), `npx vitest run node/server/` (60 files, 1047 tests passed), `npx tsc -b`, `npx biome check .` (359 files checked), and `git diff --check` all passed.

Decisions: construction functions remain alongside the UI wrapper in the existing nvim thread module, avoiding a new factory abstraction. Forks now use the same script-runner/tool assembly and policy composition as fresh threads. Existing core/read/title surfaces are retained for stage 5. Repeated core-suite runs exposed archive.test.ts deleting the directory concurrently used by server Thread archive fixtures. Isolated that suite in its own UUID-named directory rather than changing production behavior or serializing the test runner. Fork construction preserves per-script yield schemas and clones the source auto-compaction configuration; mutable conversation-local history still belongs to ThreadCore. An initial full run hit a timing-sensitive attention-badge assertion in unrelated hierarchy rendering; the final full run passed without changing that test.

- Goal: fresh/fork dependency assembly has one implementation, and NvimThread only wraps an already-configured Thread.
- Extract shared construction functions within the nvim layer; fresh and fork paths share provider/tool/resolver assembly while preserving their different history/environment rules.
- Construct ThreadCompactor independently and pass the same instance to execution and UI observation.
- Supply the immutable resolution dependency and fixed notification callbacks in the shared construction path. Remove preBuilt, placeholder callbacks, callback replacement, and wrapper-owned server construction; do not add a Thread Emitter or dynamic attachment API.
- Compose chatSupervisors once in the shared nvim construction function and pass them to the server Thread constructor, not ThreadCore. Keep auto-compaction last in that list and the entire list before core context delivery. Remove layered setters. Convert preflight/yield gates to fixed execution steps without changing ordering.
- Wire hierarchy discovery through Thread's fixed onFileAdded callback and retain initial-file enumeration after construction.
- Tests:
  - Existing supervisor-wiring tests cover user, subagent, compact, and supervised Docker configurations through real construction.
  - Fresh and forked threads receive equivalent tool/catalog/capability wiring; fork retains local-source restriction.
  - Fresh and fork construction install the real resolver and fixed callbacks without invoking callbacks before the UI wrapper is ready; the first submission never uses placeholders.
  - After compact reset, adding a context file still triggers hierarchy discovery and appears in the next request/UI.
  - Run script/subagent creation/result tests; keep narrow ThreadManager and IPC contracts unchanged.

### Stage 4 review follow-up

- [x] Replaced independent factory `threadType`/optional `fork` inputs with a discriminated fresh/fork initialization union. Fresh construction supplies the type; fork construction derives it exclusively from the source before assembling policies, compaction, and resolver dependencies, matching `Thread.clone`.
- [x] Migrated all construction callers and added a compact-fork regression verifying the inherited type, absence of both UI/server compactors, and exact MaxTokens/Subagent policy composition.
- [x] Full-project validation: `npx vitest run` (126 files passed; 1718 tests passed, 2 skipped tests and 1 todo), `npx tsc -b`, `npx biome check .`, and `git diff --check` passed.

The initial full run encountered an existing process-termination snapshot race in thread-abort.test.ts (SIGTERM versus bash exit 143 output). The complete rerun passed without modifying unrelated abort behavior or snapshots.

## 5. Prune boundaries and extract title generation

- Goal: parents no longer depend on core lifecycle machinery; remaining Thread APIs represent distinct operations or read models.
- Rename NvimThread.core to thread and remove misleading agent getter.
- Audit actual call sites before removing duplicate getters, public abortAgentTurn, inference-manager/context access, and exposed mutable supervisors. Keep core/reset internal unless a real external administrative use requires a separate explicit contract.
- Update views to use existing read models/current context capability, not new forwarding getters for every old path.
- Move automatic title generation to the nvim owner/helper and retain archive/title mutation on Thread.
- Tests:
  - Type checking catches all migrated consumers and enforces the server/root boundary.
  - View, abort, retry, edited-file, fork, script-result, and compaction UI tests pass without private-core access in production.
  - Automatic title is generated once, manual title wins over a late response, failed title generation does not fail a submission, and destroyed threads are not updated.
  - Archive title and compaction records still flush correctly; shared structured tool results still render after reset/fork.

## 6. Integration validation and documentation

- Goal: remove transitional APIs and document the final ownership model instead of retaining parallel old/new paths.
- Update context.md's stale architecture descriptions, server exports, comments, and test helpers to describe Thread, ThreadCore, and the stable UI boundary accurately.
- Run focused suites during each stage, then `npx vitest run node/server/`, relevant nvim integration suites, `npx tsc -b`, and `npx biome check .`. Run the full `npx vitest run` suite before completion where the local environment supports it.
- Tests use existing mock providers and Defer-controlled boundaries for races, not arbitrary sleeps or mocks of the newly extracted components. Use withDriver for root behavior and verify actual outgoing messages/UI results.
- Final review checks that Thread is smaller because responsibilities moved with their state, not because equivalent forwarding layers were added elsewhere. No parent checks ThreadCore identity or manually wraps a submission to make compaction work.
