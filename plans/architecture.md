# Architecture Split: Control Plane, Runners, Agents, and Clients

## Context

### Objective

Refactor magenta.nvim from a single Node.js process spawned by neovim into four conceptual layers:

1. **Control Plane** — a stateful routing process that manages agents, aggregates state, provides durability and observability. It is **not** an agent — it doesn't do AI work itself. It creates agents, routes messages, and stores state.
2. **Runners** — a logical boundary within the control plane that manages agent execution and environment lifecycle. The runner module accepts tasks from the control plane core, provisions an **environment** (see below), constructs the agent's tools with the environment's backends, runs the agent, waits for it to yield, checkpoints via the environment, and updates control plane state. Initially in-process; can be extracted to a separate process later if needed.
3. **Agents** — the actual AI logic: LLM streaming, tool execution, conversation loop. An agent is spawned by the runner and runs in the same process. **The agent only sees tools** — it has no concept of "filesystem" or "shell" as abstract services. It calls `edl`, `bash_command`, `get_file`, etc. The tool implementations delegate to backends provided by the environment, but the agent doesn't know or care what's behind them. The agent runs until it yields (end of turn, waiting for approval, etc.), then the runner handles checkpointing and reporting.
4. **Clients** — connect to the control plane, display state, and provide environment capabilities (file I/O, LSP, permissions UI). The first client is the neovim plugin; future clients could be a browser UI or TUI/CLI.

### The Control Plane is Not an Agent

A key design principle: the control plane is a **routing mechanism**, not an intelligent actor. It manages state, routes communication between users and agents, and provides durability/observability.

To do planning, create agents, or orchestrate work, you **spawn an agent** with the appropriate _tools_ — tools that allow it to query the control plane for available work and instruct the control plane to spawn other agents. This keeps the control plane simple and predictable while making orchestration composable and extensible.

### The Runner: Lifecycle Management

The **runner** is a module within the control plane that manages agent execution and environment lifecycle. It runs in the same process as the control plane. The runner module can be extracted to a separate process later if scaling demands it.

A runner's responsibilities:

- **Accept tasks** from the control plane core (via in-process function calls; later extractable to process spawning or task queue)
- **Provision the environment** — instantiate the appropriate `Environment` implementation based on the agent's configuration
- **Construct tools** — create the agent's tools, injecting the environment's backends (`FileIO`, `CommandExec`) as their implementations
- **Run the agent** — start the agent with the right config (prompt, thread state, tools)
- **Wait for yield** — the agent runs its conversation loop until it reaches a yield point
- **Checkpoint** — delegate to the environment's `checkpoint()` method (which may git commit+push, snapshot a container, or no-op depending on implementation)
- **Report back** — update control plane state with thread state + checkpoint refs + yield reason (in-process call; extractable to HTTP callback later)

The runner does **not** make AI decisions. It doesn't call LLMs, execute tools, or manage conversation history. It's pure infrastructure: receive task → provision environment → construct tools → run agent → checkpoint → update state.

**Runner lifecycle**: Initially, the runner is an in-process module within the control plane — there is no separate process, just a logical code boundary enforced by TypeScript project references. Later, runners could be extracted to separate processes. The control plane's interface to the runner module is designed to support this extraction.

### Environments

An **environment** is a pluggable bundle that the runner uses to set up an agent's execution context. It provides two things:

1. **Tool backends** — implementations of the interfaces that agent tools depend on. For example, `FileIO` (backing `edl`, `get_file`, `list_directory`) and `CommandExec` (backing `bash_command`). The agent never sees these interfaces — it just calls tools. The tools delegate to these backends.

2. **Lifecycle operations** — how to provision, checkpoint, restore, and dispose of the environment. These are used by the runner, not the agent.

**Permissions live in the environment, not the tools.** The environment wraps its tool backends with permission-checking decorators. When a tool calls `fileIO.writeFile(path, content)`, the environment's permission layer intercepts the call, checks against policy, and may reach out to the user (via the control plane) for approval before delegating to the underlying implementation. The tool and the raw backend are both unaware of permissions — the policy sits cleanly at the boundary between them.

```typescript
interface Environment {
  // Tool backends (injected into tools by the runner)
  fileIO: FileIO; // backs edl, get_file, list_directory
  commandExec: CommandExec; // backs bash_command

  // Lifecycle (used by runner, not agent)
  checkpoint(): Promise<CheckpointRef | undefined>;
  restore(ref: CheckpointRef): Promise<void>;
  dispose(): Promise<void>;
}
```

**Interface vs implementation**: Magenta defines the `Environment` interface. Implementations are pluggable:

- **`local`** (built-in) — host filesystem, local shell, optional git checkpointing, restrictive permissions (human-in-the-loop by default). This is what magenta does today.
- **`dev-container`** (built-in) — docker container with shared volume, `docker exec` for commands, git checkpointing, permissive permissions (autonomous by default). The agent process runs in the control plane; only its bash commands and file I/O execute inside the container.
- **Custom** — consumers can provide their own implementations (cloud VMs, remote SSH, custom sandboxes, etc.). The consumer registers environment factories with the control plane.

Different environments naturally have different security properties. A `dev-container` environment isolates the agent from the host — credential isolation (git push credentials stay on the host side), filesystem isolation (agent only sees the workspace volume), and process isolation (agent can't affect the host). A `local` environment relies on permissions and human approval for safety. These are properties of the implementation, not something the agent or tools need to know about.

### Capabilities

When the control plane spawns an agent, it determines what that agent can do:

- **Which tools** — which tools the agent is given (bash, file edit, LSP, etc.)
- **Which environment** — which `Environment` implementation backs those tools
- **Client capabilities** — which client-provided services the agent can request (lsp, editor, etc.), routed through the control plane
- **Control plane capabilities** — which control plane operations the agent can invoke (spawn agents, query/modify the task tree, etc.)

The environment handles permissions internally — they're part of how the tool backends are configured, not a separate grant from the control plane.

### The Control Agent Pattern

An **orchestrator** (or "control agent") is just a regular agent that has been granted **control plane capabilities** as tools. For example:

- `query-tasks` — read the task tree
- `create-task` / `update-task` — add or modify tasks
- `spawn-agent` — create a new agent with a specified capability set and prompt
- `assign-task` — assign a task to an agent

The control agent doesn't have special status in the architecture — it's an agent like any other, with a thread, a provider, and tools. The difference is that its tools talk to the control plane rather than (or in addition to) the filesystem. This means orchestration logic lives in the AI model, not in control plane code, keeping the control plane simple.

A typical flow:

1. User sends a high-level request ("refactor the auth module")
2. Control plane spawns a control agent with planning tools + control plane capabilities
3. Control agent breaks the work into tasks, creates them in the task tree
4. Control agent spawns worker agents for each task, granting them appropriate capabilities (e.g., filesystem + bash for code changes, read-only for review)
5. Worker agents complete tasks and report back
6. Control agent reviews results and reports to the user

### Long-Term Vision

Beyond the core four layers, the architecture supports:

- **Task Tree** — a shared data structure where agents or users can declare work items, blockers, dependencies, and claim work. Stored in the control plane. An "orchestrator agent" is just an agent with tools like `list-tasks`, `create-task`, `assign-task`, `spawn-agent`.
- **Knowledge Base** — a service providing semantic search over project design decisions, architectural context, and past conversations. Could be a control plane service or a standalone service that agents query.
- **Multi-compute** — agents running on different machines (containers, cloud VMs) all connecting back to the same control plane. The control plane handles routing regardless of where agents live.

### Durability and Agent Lifecycle

#### Inspiration: Temporal Workflows

The agent lifecycle draws inspiration from **Temporal** (durable workflow execution). In Temporal's model, workflows are long-lived state machines that orchestrate short-lived activities, with durable state persisted between steps. We adopt this pattern without taking on Temporal as a dependency. If the scale demands it, Temporal could be introduced as a substrate later.

#### The Problem: Agent State is More Than the Thread

An agent's valuable output isn't just its conversation history — it's the **code changes on disk**. Thread messages are a log of what happened, but the filesystem mutations are the actual work product. LLM responses are non-deterministic, so you can't reliably replay a conversation to recreate the same file changes. If a container dies and you lose uncommitted work, the thread history is useless.

Agent state therefore has two components:

1. **Thread state** — conversation messages, tool call history, yield reason (stored in the control plane)
2. **Workspace state** — code changes, environment modifications (persisted by the environment's checkpoint mechanism)

Both must be durably persisted together to form a consistent checkpoint.

#### Checkpointing is an Environment Responsibility

How workspace state is checkpointed depends on the environment implementation:

- **`local` environment** — may use git (commit to a branch), or may simply rely on the host filesystem (no checkpoint, workspace changes are already durable on disk)
- **`dev-container` environment** — typically uses git (commit + push from the host side, using credentials the agent never sees). Could also use container snapshots.
- **Custom environments** — whatever the consumer implements: filesystem snapshots, cloud storage, etc. Or no checkpointing at all for short-lived tasks.

The `Environment` interface exposes `checkpoint()` and `restore()`. The runner calls these at yield points. The agent doesn't know or care about checkpointing — it just signals a yield, and the runner handles the rest.

At **yield points** (end of turn, waiting for user approval, waiting for a child agent, etc.), the runner:

1. Calls `environment.checkpoint()` to persist workspace state
2. Reports thread state + checkpoint ref to the control plane

This forms a consistent checkpoint. The runner handles it automatically.

#### Ephemeral Invocations

Because durable state lives in the environment's checkpoint + the control plane, **agent processes are ephemeral**. They are compute, not state. The runner module orchestrates the lifecycle:

```
Control plane (durable, long-lived state machine)
  ├── runner module: dispatch task
  │   ├── environment.provision()
  │   ├── spawn agent-turn-1 (streams response)
  │   │   └── agent yields: "waiting for user approval on tool_call_123"
  │   ├── environment.checkpoint(), update CP state
  ├── wait: user-approved(tool_call_123)
  ├── runner module: dispatch next turn (environment may be reused or reprovisioned)
  │   ├── spawn agent-turn-2
  │   │   └── agent yields: "turn complete, stop_reason=end_turn"
  │   ├── environment.checkpoint(), update CP state
  ├── wait: user-sends-next-message
  └── ...
```

Between yield points, nothing is running — just data in the checkpoint and the control plane. However, a user can optionally **attach** to a running agent via the control plane's WebSocket for real-time observation and interaction (see "Attachment" below).

Environments can be:

- **Reused** across turns (fast path — still alive, no setup needed)
- **Reclaimed** between turns for other work, then reprovisioned when needed
- **Lost** due to crashes — recovered from last checkpoint

#### Recovery Model

On failure (environment crash, process crash, etc.), the control plane's runner module recovers by:

1. Provisions a new environment
2. Calls `environment.restore(checkpointRef)` to restore workspace state
3. Loads the thread state from the control plane (tagged with the matching checkpoint ref)
4. Re-runs the interrupted turn from the last checkpoint

This is **at-least-once execution with retry from the last checkpoint**. The worst case is re-paying for LLM calls in the interrupted turn.

#### Checkpoint Granularity

More frequent checkpoints = smaller blast radius on failure, but more overhead:

- **Per tool execution cycle** (all tools in one assistant response resolved) — good balance
- **Per yield point** (waiting for external input) — minimum viable
- **Per tool call** — too noisy, diminishing returns

The runner handles checkpointing automatically at yield points. The agent and its tools don't need to know about it.

#### Control Plane as Workflow Orchestrator

The control plane implements the Temporal pattern directly:

- **Durable state**: thread snapshots + checkpoint refs, persisted (initially in-memory/SQLite, later durable storage)
- **Retries**: re-provision environment, restore from checkpoint, retry failed turn
- **Waits/signals**: tracks "agent X is waiting for signal Y" as data; wakes agent when signal arrives
- **Orchestration**: the dispatch loop that decides what to run next

This is a small, understandable state machine — no external workflow engine required.

### Communication

#### Client ↔ Control Plane: JSON-RPC 2.0 over WebSocket

The client↔CP connection is the one truly bidirectional, real-time channel. It uses **JSON-RPC 2.0 over WebSocket**:

- **JSON-RPC 2.0** — proven bidirectional RPC protocol. Both sides can send requests and notifications. Already used by MCP and LSP.
- **WebSocket** — network-capable, natively supported in browsers (future browser client), provides built-in message framing.
- **JSON text encoding** — all data over the wire is JSON. Binary data (images, PDFs) stays on the filesystem; the protocol passes file path references.

This is the primary real-time protocol in the system. It carries user commands, state sync, capability routing, and proxied agent attachment streams. The optional agent attachment WebSocket (see "Attachment" below) is brokered through this connection.

#### Control Plane ↔ Runner ↔ Agent: In-Process (Initially)

Since the runner is a module within the control plane process, and the agent runs in the same process, all communication is via direct function calls and event emitters.

**Control plane → Runner**: The control plane core calls the runner module with task config:

- Task description / prompt
- Thread state (conversation history from last checkpoint)
- Checkpoint ref (opaque to the control plane — produced by the environment)
- Which environment to use and its configuration

**Runner → Agent**: The runner provisions the environment, constructs tools with the environment's backends, and spawns the agent in-process. The agent emits events (streaming tokens, tool calls, yield signals) via a well-defined callback/event interface that the runner observes.

**Runner → Control plane**: On agent events, the runner updates control plane state with thread state + checkpoint ref + yield reason. At yield points, the runner calls `environment.checkpoint()`.

**Key design constraint**: The agent's event/callback interface should be defined cleanly as a protocol-like contract (TypeScript interface), so that it maps naturally to a wire protocol later. This means events should be serializable and self-contained.

> **Future note**: When the runner is extracted to a separate process, the in-process function call / event emitter interface between runner and agent will be swapped for JSON-RPC over WebSocket. Because the interface is designed as a clean, serializable contract, this should be a mechanical change — same messages, different transport. The control plane ↔ runner boundary would similarly become a WebSocket connection at that point.

#### Attachment: Optional Real-Time Client Interaction

For real-time observation and interaction, the system supports an optional **attachment** model, analogous to `tmux attach`:

- The control plane exposes attachment capability for running agents
- When no one is attached, the agent runs fully autonomously — auto-approving routine operations, not streaming output
- When a user attaches (via client → control plane → agent), the WebSocket carries:
  - **Streaming tokens** — real-time LLM output as it's generated
  - **Interactive permission requests** — agent asks, user sees immediately, approves/denies
  - **Credential prompts** — agent needs a secret or token, user provides it in real-time
  - **Mid-turn guidance** — user can inject context ("use the other API endpoint")
  - **Thread state updates** — tool execution progress, status changes
- When the user detaches, the agent continues autonomously from wherever it is

Connection topology:

- **Client ↔ Control Plane**: WebSocket (always-on, bidirectional)
- **Control Plane (runner module) → Agent**: in-process function calls and event emitters (task dispatch, streaming events, yield signals). Designed as a serializable contract so it can be swapped to WebSocket when the runner becomes a separate process.
- **Agent → Environment**: tools delegate to environment backends (`FileIO`, `CommandExec`); the actual execution target depends on the environment implementation (local shell, `docker exec`, SSH, etc.)

The client sends `agent/attach {agentId}` to the control plane, which manages the attachment state for that agent. Since the runner and agent are in-process, no additional WebSocket is needed — the control plane observes agent events (via the in-process event interface) and forwards them to the attached client over the existing client↔CP WebSocket.

**Attachment-gated operations**: Certain high-privilege operations (prod credentials, secure data access, destructive actions) can be configured to **require** an attached user. If no one is attached, the agent yields with `waiting-user-attachment` and blocks until someone connects. This enables seamless transition between:

- **Hands-off mode** — routine feature development, tests, code review. Agent runs autonomously.
- **Hands-on mode** — prod access, security-sensitive work, complex debugging. Agent pauses for human-in-the-loop.

The transition is not a mode switch — it's whether someone is currently plugged in.

#### ACP Inspiration

We borrow ideas from ACP conceptually:

- **Session model** — threads map to ACP "sessions"
- **Client-provided capabilities** — for local/supervised agents, the client can provide fs, LSP, etc. through the control plane

However, we diverge significantly: unsupervised agents don't need real-time capability routing. They operate on their own filesystem in their own container. ACP compatibility can be added as an adapter layer later.

### Repo Organization

We use **TypeScript project references** to enforce boundaries at compile time:

```
node/
  shared/                ← pure types, protocol definitions, utilities
    tsconfig.json        ← no references (standalone)
  core/
    control-pane/        ← state management, routing, agent lifecycle, durability
    runner/              ← module within CP: environment provisioning, tool construction, checkpointing
    agent/               ← pure AI logic: LLM streaming, tool execution, conversation loop
    tsconfig.json        ← references: [shared, agent]  (CP imports agent to manage it via runner module)
  client/                ← neovim bridge, sidebar, VDOM, rendering
    tsconfig.json        ← references: [shared]  (can import its own nvim/ code)
    nvim/                ← neovim RPC code (moved from node/nvim/)
    nvim-node/           ← low-level msgpack RPC (moved from node/nvim/nvim-node/)

TypeScript project references enforce that:

- The agent cannot import control plane or client code
- The control plane CAN import agent code (the runner module within CP manages agent lifecycle)
- The client cannot import control plane, runner, or agent code
- All share types through `shared/`

```

### Key Types at the Boundary

#### Control Plane State (synced to clients via JSON Patch)

The top-level synced object is `ControlPlaneState`. This is the single JSON object that the control plane owns and clients mirror via patches:

```typescript
interface ControlPlaneState {
  threads: ThreadSnapshot[];
  activeThreadId?: ThreadId;
  agents: AgentSnapshot[]; // all running/completed agents
  profiles: Profile[];
  activeProfile: string;
  // Future:
  // taskTree?: TaskNode[];
  // knowledgeBaseStatus?: KBStatus;
}

interface AgentSnapshot {
  id: AgentId;
  threadId: ThreadId;
  status: "starting" | "running" | "idle" | "completed" | "error";
  environmentType: string; // e.g. "local", "dev-container", or custom
  attached: boolean; // whether a user is currently attached via WebSocket
  capabilities: {
    tools: ToolName[];
    clientCapabilities: ClientCapability[]; // lsp, editor, etc.
    controlPlaneCapabilities: CPCapability[]; // spawn-agent, query-tasks, etc.
  };
  // Durability checkpoint — opaque ref produced by the environment
  checkpoint?: {
    ref: CheckpointRef; // environment-specific (git SHA, snapshot ID, etc.)
    yieldReason?:
      | "end-turn"
      | "waiting-user"
      | "waiting-tool-approval"
      | "waiting-child-agent"
      | "waiting-user-attachment";
  };
  // Future:
  // assignedTaskId?: TaskId;
}
```

#### Thread State (agent → control plane → client)

```typescript
interface ThreadSnapshot {
  id: ThreadId;
  title?: string;
  threadType: ThreadType;
  mode: ConversationMode;
  messages: ProviderMessage[];
  streamingBlock?: AgentStreamingBlock;
  latestUsage?: Usage;
  activeTools: ActiveToolSnapshot[];
  systemPrompt: string;
  profile: Profile;
}

interface ActiveToolSnapshot {
  // contextFiles live in the client only (nvim context tracking)
  id: ToolRequestId;
  toolName: ToolName;
  request: ToolRequest;
  state: "running" | "done" | "error" | "pending-user-action";
  result?: ProviderToolResult;
  displayData: ToolDisplayData;
}
```

```typescript
// === Identifiers (branded strings/numbers) ===
(ThreadId, AgentId, ToolRequestId, ToolName, MessageIdx);

// === Already-serializable types ===
(ProviderMessage,
  ProviderMessageContent,
  AgentStreamingBlock,
  Usage,
  StopReason,
  Profile,
  MagentaOptions);
```

### Protocol Methods

#### Client ↔ Control Plane

**Client → Control Plane (Requests)**

```
session/list         → list all threads
session/new          → create new thread (control plane spawns an agent)
session/prompt       → send user message to active thread's agent
session/abort        → abort current generation
session/fork         → fork a thread (spawns new agent)
session/compact      → compact thread history
agent/attach         → attach to a running agent (brokers WS for real-time streaming)
agent/detach         → detach from a running agent (agent continues autonomously)
```

**Control Plane → Client (Requests — capability routing)**

These are forwarded from agents through the control plane:

```
fs/read-file           → read file content (prefer from nvim buffer if open)
fs/write-file          → write file content (to nvim buffer if open)
fs/file-exists         → check if file exists
lsp/hover              → LSP hover at position
lsp/references         → LSP find references
lsp/diagnostics        → LSP workspace diagnostics
permission/request     → ask user for permission (file write, bash command)
editor/open-file       → open file in editor
```

**Control Plane → Client (Notifications — state sync)**

```
state/snapshot         → full ControlPlaneState (on connect, reconnect)
state/patch            → RFC 6902 JSON Patch array (incremental updates)
```

#### Control Plane ↔ Runner ↔ Agent (Internal)

Since the runner is a module within the control plane and agents run in the same process, there is no wire protocol — communication is via in-process function calls and event emitters. The agent emits serializable events (streaming tokens, tool calls, yield signals) through a well-defined interface. This interface is designed as a clean contract that can be swapped to JSON-RPC over WebSocket when the runner is extracted to a separate process.

### State Sync Mechanism

State is synced via **JSON Patch (RFC 6902)** over plain objects, using `fast-json-patch`.

**Runner → Control Plane**: The runner module updates control plane state directly (in-process) at yield points. The control plane merges this into its canonical `ControlPlaneState`.

**Control Plane → Client**: The control plane generates JSON Patches by comparing previous and current state, batched on a ~50ms timer. When a client is attached to a running agent, state updates from the in-process runner/agent are incorporated into patches in real time.

**Recovery**: If a client detects a patch application failure, it requests a fresh `state/snapshot`. Simple and robust.

**Semantic hints**: The client can pattern-match on patch paths to infer what kind of change happened (e.g. a patch at `/threads/*/messages/-` means a new message was appended, useful for scroll-to-bottom behavior).

### What Goes Where

#### CONTROL PLANE (no nvim dependency, no AI/provider dependency)

- Session management — thread registry, active thread tracking
- Agent lifecycle — spawning, monitoring, stopping agents
- Capability granting — determining what tools, environment, and capabilities each agent receives at spawn time
- Capability routing — forwarding agent requests to clients and responses back
- Environment registry — registering environment factories (built-in: `local`, `dev-container`; custom: consumer-provided)
- State aggregation — merging agent state updates into `ControlPlaneState`
- State broadcasting — JSON Patch generation and distribution to clients
- Profile management — storing/switching profiles
- Command processing — `chat/commands/` (interpreting user commands)
- Options parsing — `options.ts`
- Durability — persisting thread snapshots + checkpoint refs at yield points
- Checkpoint management — storing and retrieving opaque checkpoint refs for recovery
- Recovery orchestration — detecting agent failures and retrying from last checkpoint
- Attachment management — managing attachment state and streaming agent updates to attached clients
- Future: task tree management, knowledge base interface

#### RUNNER (module within control plane — no nvim dependency, no AI/provider dependency)

- Environment provisioning — instantiating the appropriate `Environment` implementation
- Tool construction — creating agent tools with environment backends (`FileIO`, `CommandExec`)
- Agent launching — starting the agent with config from the control plane core
- Checkpointing — calling `environment.checkpoint()` at yield points
- Recovery — calling `environment.restore(ref)` to recover from failures
- State reporting — updating control plane state with thread state + checkpoint ref + yield reason (in-process)
- Environment health monitoring — detecting environment failures

#### AGENT (no nvim dependency, no client dependency, no git dependency, no environment dependency)

The agent only sees tools. It has no concept of `FileIO`, `CommandExec`, or `Environment` — those are injected into tool implementations by the runner.

- `chat/thread.ts` — conversation loop, auto-respond, tool orchestration
- `providers/*` — all provider/agent code (Anthropic, Bedrock, etc.)
- `tools/` — tool execution:
  - `bashCommand`, `listDirectory`, `getFile`, `edl`, `spawn-subagent`, `spawn-foreach`, `wait-for-subagents`, `yield-to-parent`, `compact`, `thread-title`
  - Tools accept backend interfaces (e.g. `FileIO`, `CommandExec`) as constructor parameters — they don't import or instantiate them
  - Tools that need client capabilities (LSP, editor) make requests through the control plane
- `edl/` — entirely pure logic with `FileIO` interface
- `providers/system-prompt.ts`, `system-reminders.ts`
- `tools/tool-registry.ts`, `toolManager.ts`, `create-tool.ts`
- `root-msg.ts` — internal agent dispatch (NOT exposed over protocol)

Note: `tools/permissions.ts` moves out of the agent — permissions are enforced by the environment's backend wrappers, not by the tools themselves.

#### CLIENT (neovim-specific)

- `client/nvim/` — all nvim RPC code
- `sidebar.ts` — window/buffer management
- `tea/` — VDOM rendering system
- `lsp.ts` — LSP request proxy (responds to control plane's forwarded `lsp/*` requests)
- `buffer-tracker.ts` — buffer sync tracking (responds to `fs/*` requests)
- `context/context-manager.ts` — file tracking, diff computation (client-side, uses nvim buffers)
- View rendering for all components (thread view, tool views, context views)
- `magenta.ts` — client orchestrator, connecting to control plane and driving the UI

#### SHARED (used by all layers)

- Type definitions for protocols (client↔CP) and internal interfaces (runner↔agent)
- `ProviderMessage`, `ProviderMessageContent`, other content types
- Identifier types (`ThreadId`, `AgentId`, `ToolRequestId`, etc.)
- `MagentaOptions`, `Profile`
- `Environment` interface and `FileIO`, `CommandExec` backend interfaces
- Utility types (`Result`, file path types)
- JSON-RPC transport implementation

### Migration Strategy

The key insight is that we can migrate incrementally, and the control plane / agent split can initially be **in-process**. The separation is enforced by TypeScript project references and clean interfaces, but both run in the same Node process at first.

1. **Extract shared types** into a `shared/` package
2. **Define both protocols** as TypeScript interfaces in `shared/`
3. **Build the transport layer** (JSON-RPC over WebSocket)
4. **Extract agent** by removing nvim dependencies from business logic; create runner module within control plane
5. **Create control plane** that manages agents and routes capabilities
6. **Build client adapter** that connects to control plane
7. **Wire together** — initially in-process, with the option to run agents out-of-process
8. **Future: further isolation** — additional sandboxing or remote execution if needed

### Open Questions

1. **Tool display data**: Currently each tool has `renderSummary()`, `renderPreview()`, `renderDetail()` returning `VDOMNode`. Options:
   a. Agent sends structured display data, client renders
   b. Agent sends pre-rendered text, client displays
   c. Hybrid: agent sends semantic data, client has tool-specific renderers

   **Leaning toward (a)** — structured display data. This keeps agents unaware of rendering and allows different clients to render differently.

   Denis: control pane just sends data. The presentation layer is decided upon by each client. There will be some duplication that way, and some leaking of abstraction (each client needs to know about each tool), but this is fine - presentation will vary a lot by how we're connecting to the control pane.

2. **File I/O routing**: When an agent needs to read/write a file, should it:
   a. Always ask the client (routed through control plane)
   b. Read from filesystem directly, only ask client for buffer-open files
   c. Agent reads filesystem, client notifies control plane about which files are in buffers

   **Leaning toward (c)** — agents with full filesystem permissions (especially in containers) read/write directly. The client notifies the control plane which files are open in buffers. For local agents, the client can optionally intercept writes to update buffers. This simplifies the agent runtime and optimizes for the container case where agents have full permissions.

   Denis: agent works with the FS directly. We bias towards turn-taking with the agent, not simultaneous work. So we just update the agent on what the user changed on followup messages.

3. **Edit prediction**: ~~Removed~~ — feature canned. Not used.

4. **Inline edit**: ~~Removed~~ — feature canned. Not used.

5. **Agent identity and isolation**: How isolated are agents in phase 1?
   - Initially: agents are objects within the control plane process, separated by TypeScript project references. They communicate through in-process function calls that match the protocol interface.
   - Later: agents become separate processes communicating over WebSocket.

   **Decision**: Start in-process, ensure the interface is clean enough to swap to out-of-process later.

6. **Subagent relationship**: Currently `spawn-subagent` creates a child thread within the same process. In the new model:
   a. Subagents are full agents spawned through the control plane
   b. Subagents are lightweight threads within the same agent process

   **Leaning toward (a) long-term, (b) initially** — subagents start as lightweight threads within an agent (preserving current behavior), but the control plane knows about them. Later, the `spawn-subagent` tool can optionally request the control plane to spawn a fully isolated agent.
