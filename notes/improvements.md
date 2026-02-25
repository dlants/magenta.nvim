# general

- @fork should work at any time - when the agent is streaming, aborted, executing tools, etc...
- speed up startup / stop having to press toggle a bunch

# subagents

- improve subagent display (what type of agent is it? Prompt?)
- when subagents block, show the blocking operation in the parent agent, so you don't have to go into the subagent to unblock the operation
- show preview of what the subagent is doing while it's working
- when a subagent yields, it looks funky (no tool result, etc...)
- yield state is non-recoverable... would be nice if the parent agent could ask followup questions, etc...

# edl

- sometimes the agent tries to find the empty string, this crashes magenta currently
- when streaming the edl tool, only show the last N lines of the streamed text.
- improve the trace by displaying line numbers and context
- approve or deny each file access separately
- maybe add special command to fully print the contents of selection, to aid in exploration
- maybe elaborate on output to make it easier to tell when the selection was messed up?
- investigate treesitter query syntax / matryoshka style file exploration
- context manager. Improve the integration. Actually replay the edits on the agent's view of the file.

# polish

- context manager flicker messes with scrolling
- tools briefly flash as having no response when they complete
- newline issues, double-render of foreach
