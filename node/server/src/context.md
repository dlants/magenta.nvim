# Cancellation

Async work in the server forms a tree: a submission owns tool loops and compaction runs, a tool loop owns requests and tool batches, a compaction run owns its child threads. Cancellation follows structured concurrency: it flows down the tree, completion flows up, and a node never outlives its children.

Invariants:

- Each level that owns cancellable work holds the handle to its in-flight child (an `AbortController`/signal it passes down, an `ActiveSubmission`, a thread id).
- Abort listeners only interrupt: they abort the in-flight child, reject a pending wait, or cancel a network request. They never tear down state, delete threads, update run state, or emit transitions.
- On abort, a node signals its in-flight child and then awaits that child's settlement. The child cleans up and settles first (with an `aborted` result or `SubmissionAborted`); only then does the parent run its own cleanup, in `finally` or on the aborted branch. Cleanup ordering therefore comes from awaiting, never from listener registration order.
- A node with no in-flight child (between children, or before the first) does its own cleanup directly, and must check its signal before starting another child.
- Abort is a value, never an exception. Every child returns a union with an aborted variant (`{ type: "aborted" }`, or `ABORTED` from `ActiveSubmission.step`/`settled`), and the parent branches on it. A loop has exactly one way out on abort: `return`. Never `throwIfAborted()`, never reject with `AbortError`, never catch an error and re-classify it as an abort by checking the signal. Exceptions are reserved for real failures.
- A node learns of an abort from its child's result. It checks its own signal only in the gaps between children, before starting the next one, and then returns its aborted value.
- Leaves that wrap APIs which reject on abort (SDK streams) convert at the boundary, so the rejection never escapes the leaf.
- Abandoning work instead of joining it (`untilAborted`, `ActiveSubmission.step`) is only allowed for work whose effects are applied by the caller, so dropping its result drops its effects (e.g. resolving a message, a supervisor's yield decision). Work with its own effects (compaction runs, tool loops, core replacement, a preempted submission) is joined (`ActiveSubmission.settled`).
- Share a signal down the tree while every level aborts together. Derive a child controller when a level must cancel one child without cancelling itself.
