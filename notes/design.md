# Thread & Agent Architecture

## Compaction Flow Design

Let's think this through... What are the flows we want to support here?

1. the user asks the agent to compact via "@compact user's next message"
2. the agent decides to compact on its own

In the case of 1 , we will have some user message or system-generated message that says:

"You should use the compact tool. The user's next message will be XXXX"

Then we expect the agent to generate a compact tool_use request.

Then we need to process the request by mutating the Agent, which should strip off the end of the message and the compact request.

Finally, we need to remember the user's next message, then append it to the conversation and continue.

So the thread will evolve like:

```
... thread
user: @compact some further instructions
```

Then

```
... thread
user: @compact XXX
agent: thinking
agent: compact tool_use request
```

Then, after the compaction is executed:

```
... compacted thread
```

(NOTE! the user @compact request and everything after is removed! Not just the compact tool_use request)

And finally, after compaction

```
... compacted thread
user: some further instructions
<agent resumes streaming>
```

The user continuation is appended and the thread is resumed

In the case of 2, the agent decides to use the tool itself. In this case I'd like to have an optional parameter to the compact request: "continuation" - what the agent intends to do next.

so to walk it through. We start with the agent deciding to use the tool:

```
... thread
agent: thinking
agent: message
agent: compact tool_use request
```

Then we actually apply the compaction. We know to delete the compact tool_use request, but keep the previous parts of the agent's message. (discarding the thinking block)

```
... compacted thread
agent: message
```

Now we continue on with the agent's continuation

```
...compacted thread
agent: message
agent: continuation message
<agent resumes streaming>
```
