I'd like to split the current @fork implementation into two:

- @fork should take the existing provider thread and clone it exactly, without amending any messages, then append the @fork user message and continue
- @pivot should do what the plugin currently does - start a new thread from a summary.
