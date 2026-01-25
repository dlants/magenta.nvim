I want to change the way forking works...

Right now when you fork, you cannot go back and continue the thread you forked from... or fork from it again.

There's also a bug currently where the agent can continue streaming into the forked thread (since the result of the fork_thread tool use gets reported to that thread).
