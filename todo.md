# top of mind

- look into hooking up progressive tool discovery / tool search
- script improvements
  - think about enriching the script API. Iterate on a thread? Query a thread? Human-in-the-loop?
  - set up an auto-compact supervisor on a thread, especially one inside a script
- edit a previous user message. e on a user message pops it into the input buffer, and resets the thread to that point, so you can change the message and resubmit
- openai agent
- 8j in display buffer (relative column numbers should still work, even with wrapped override)

- bashCommand should show timer when expanded
- archive should be a separate buffer, so it can participate in the jump list properly

# Sandboxes

- we should patch sandbox runtime some more to allow projects to further customize their setup. I haven't been able to get puppeteer tests against localhost to work through the sandbox for example (though running in docker works, thankfully).
- sandboxes on osx still trip up when running sandbox tests... seems like node phones home intermittently? Why?

# Prompt tuning

- the agent is still prone to re-read the file (even force-re-read) before making further edits... maybe we jsut drop the context.md "this file is in your context already" round trip. Also, maybe _reading_ is just a lot cheaper than _generating_ so we could think about having edl send the full edited section back. Something like "the file now reads <full contents of edited section of file>"
- try trimming things down in general...

# token efficiency

- Let's revisit how we summarize files.
- summarize large files even when they're pulled in via contextFiles

# docker

- we're still referencing some files from the host, which the agent can't actually read

# UX

- improve edl display... the script preview's not really useful. Focus on files touched, failed mutations, etc...
- tmux integration (update tab title with active thread title, thread state)
- toggling sandbox to off should auto-approve any current dialogues

# misc features

- asking aside/followup questions about things is a bit awkward... it would be cool to allow one to select a part of the display buffer, and then ask a question about it, with the output appearing within the flow of the original thread

# bug fixes, etc

- "forked to/from thread" persists after compact. We should remove it from the thread on compact
- when we abort during a "sandbox blocked" message, it stays up even as the conversation continues
  - this has broken a few times already, make sure we have a good test for it
- when we terminate/error, the reset for the message places it in the wrong buffer (currently open one, not the one corresponding to the thread that the error happened in)

- error: 2026-06-16T09:32:11  WARN Unexpected error: stream ended without producing a Message with role=assistant Error: stream ended without producing a Message with role=assistant at \_MessageStream.\_MessageStream_getFinalMessage2 (file:///home/aurelia/.local/share/nvim/site/pack/core/opt/magenta/dist/magenta.mjs:46546:17) at \_MessageStream.finalMessage (file:///home/aurelia/.local/share/nvim/site/pack/core/opt/magenta/dist/magenta.mjs:46469:109) at process.processTicksAndRejections (node:internal/process/task_queues:105:5) at async runWithRetry (file:///home/aurelia/.local/share/nvim/site/pack/core/opt/magenta/dist/magenta.mjs:144452:24)
