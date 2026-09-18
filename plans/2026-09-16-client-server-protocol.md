So I want to split this project up into a server/client architecture.

We already started down this path - things are organized into two directories, though the boundaries/API between them is still pretty messy.

The client should be the neovim plugin, and contain all the info that's needed for display only.

We should be able to detach and reattach the client - if I stop neovim, and connect from a different neovim instance, I should be able to see all my threads, etc...

I want to spend some time thinking about what the API between the nvim client and the magenta server should look like. I think I want to use websockets.

Desired properties:

- the server should be driven via a client, but also via a cli. Some part of the API should be unified across these two - so things that a client can do, a cli should be able to do too, so we can programmatically drive the server.

- in the future, maybe I want to support multiplayer? In particular, a developer using multiple devices to drive the same session. Like a phone using a web client + a neovim client. Or maybe two engineers collaborating against the same server.

- Right now I run tmux, with multiple sessions + tabs, and vim inside some of those tabs, and multiple threads inside each vim process. This is too much layering. I think I want to drop tmux from this stack, and just rely on magenta. So we need to set up some sort of grouping above the current thread/script list. Like a session, with each nvim client being able to switch between sessions, and see a list of sessions.
  - Separate Neovim's cwd (context selection and path display) from an agent-owned thread cwd (tool execution). File references crossing the API use absolute paths.

# protocol

The server exposes several states we can subscribe to:

- global overview (all session high-level state)
- session overview (single session's state - threads + scripts overview)
- script details (thread overview + log messages)
- thread (actual thread content / messages)

We start by just sending the whole thing every update. We can make things more efficient from there, when needed.

This is all done over a single WS connection. Each piece is independently subscribable, and we can subscribe to multiple threads if we want.

The write direction is a set of actions / operations. session.create, thread.create, thread.send/abort/approve. Everything is driven by id.

# Authentication and access

V1 has no application-level authentication or user accounts. The server binds only to loopback, not all network interfaces, and is intended for local clients.

Future remote access (such as a phone client) will be Tailscale-protected. The details of exposing the server through Tailscale are deferred; public internet access is not a goal.

Connection and subscription IDs identify where updates should go, not who is authorized. Operation IDs, if used for retry deduplication, are also separate from authentication. Collaborator identity and permissions are deferred.

# Execution environments and paths

Separate the client's display/context cwd from the agent's working directory and execution environment. Changing directories in a client, attaching another client, or disconnecting must not change where the agent's tools execute.

- Client cwd: used for shortening displayed paths and resolving client-selected context into absolute paths before submission.
- Execution environment: identifies the filesystem and runtime in which tools operate (initially the server host; also containers). It determines which host/container the agent operates in, independently of the viewing client.
- Thread cwd: agent-owned state identifying where the agent is working within its execution environment. Initialized when the thread is created, it supplies the default working directory for shell commands, with an absolute per-command override. It is not the server process's global cwd.

The initial thread cwd is included in the agent's system info. A `change_directory` tool validates the target directory within the execution environment, updates the thread cwd, and returns the resolved absolute path. Changes are exposed to the agent through context updates, not just an initial system-info field. The current cwd is included in thread snapshots and preserved across compaction.

Changing the thread cwd affects subsequent shell commands, never already-running commands. A `cd` inside a shell command affects only that command's shell, not the thread cwd. Forks and subagents inherit the current cwd as an independent copy, so one agent navigating does not move another.

File references crossing the API use absolute paths interpreted within the target execution environment. An absolute path in a container is not implicitly a path on the server host or client device. Any path mapping must be explicit, including when spawning a subagent in a different environment.

Session grouping does not itself define a filesystem root. Repository discovery, project instructions, and sandbox permissions need explicit roots or scope; they must not follow whichever client's cwd happens to be active. A working directory is not a sandbox boundary.

Open questions: how execution environments and initial thread working directories are selected, whether sessions supply defaults, how repository/project context responds to agent cwd changes, and how unsaved editor contents interact with server-side files.

# Implementation Plan

1. **Introduce server-owned sessions.** A session owns its thread hierarchy and script runs. Move thread creation/forking/deletion, policy assembly, title generation, and script orchestration out of the Neovim layer. Start with one implicit session to preserve current behavior.
2. **Make execution independent of Neovim.** Move filesystem/shell execution, configuration, approval state, and agent cwd into server-owned services. Isolate editor-dependent functionality behind explicit optional capabilities. A session should keep running with no attached editor.
3. **Introduce the API boundary in-process.** Define serializable snapshots and ID-addressed operations. Make the Neovim client render those snapshots and invoke operations instead of reading live `Thread` objects. Keep transport out of this step so ownership and serialization problems are easier to isolate.
4. **Put that boundary over WebSockets.** Add the standalone server process, independently subscribable snapshots, and reconnect handling. Closing Neovim now drops subscriptions, not sessions or execution.
5. **Expose multiple sessions and add the CLI.** Session switching becomes a client navigation feature; the CLI exercises the same operations and subscriptions.
