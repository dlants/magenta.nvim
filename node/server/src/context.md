# Cancellation

Async work in the server forms a tree: a submission owns tool loops and compaction runs, a tool loop owns requests and tool batches, a compaction run owns its child threads. Cancellation follows structured concurrency: it flows down the tree, completion flows up, and a node never outlives its children.

Invariants:

- Each level that owns cancellable work holds the handle to its in-flight child (a `Task` handle `{ promise, abort() }` returned by the child, an `ActiveSubmission`, a thread id). Nodes in our layers never accept an `AbortSignal`; they return a `Task`. Signals and `addEventListener("abort")` exist only in leaves wrapping external APIs (SDK requests, `abortableDelay`, auth `fetch`), enforced by `abort-listeners.test.ts`.
- `abort()` only interrupts (sets a flag and forwards to the current child): they abort the in-flight child, reject a pending wait, or cancel a network request. They never tear down state, delete threads, update run state, or emit transitions.
- On abort, a node signals its in-flight child and then awaits that child's settlement. The child cleans up and settles first (with an `aborted` result or `SubmissionAborted`); only then does the parent run its own cleanup, in `finally` or on the aborted branch. Cleanup ordering therefore comes from awaiting, never from listener registration order.
- A node with no in-flight child (between children, or before the first) does its own cleanup directly, and must check its aborted flag before starting another child.
- Abort is a value, never an exception. Every child returns a union with an aborted variant (`{ type: "aborted" }`, or `ABORTED` from `ActiveSubmission.step`/`settled`), and the parent branches on it. A loop has exactly one way out on abort: `return`. Never `throwIfAborted()`, never reject with `AbortError`, never catch an error and re-classify it as an abort by checking a flag. Exceptions are reserved for real failures.
- A node learns of an abort from its child's result. It checks its own aborted flag only in the gaps between children, before starting the next one, and then returns its aborted value.
- Leaves that wrap APIs which reject on abort (SDK streams) convert at the boundary, so the rejection never escapes the leaf.
- Abandoning work instead of joining it (`ActiveSubmission.step`) is only allowed for work whose effects are applied by the caller, so dropping its result drops its effects (e.g. resolving a message, a supervisor's yield decision). Work with its own effects (compaction runs, tool loops, core replacement, a preempted submission) is joined (`ActiveSubmission.settled`).
- A child handle is installed synchronously when the child starts; an abort that lands with no child in flight is seen at the next gap. `abort()` is idempotent and safe after settlement.
