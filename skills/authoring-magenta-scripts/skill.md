---
name: authoring-magenta-scripts
description: How to author magenta scripts. Magenta scripts allow for programmatic orchestration of magenta threads. Use this skill when the user explicitly asks you to write a magenta script (not just a regular script).
---

## Discovery and the registerScript contract

Each script package lives in its own subdirectory of a scripts directory
(`.magenta/scripts/<package>/` or `~/.magenta/scripts/<package>/`), so multiple
independent installations can coexist. A package is a directory containing an
`index.ts` entry point.

Magenta discovers scripts by forking each `<package>/index.ts` file. That file
is executed, and all `registerScript()` calls report script definitions to
magenta via IPC.

### The magenta-sdk symlink

Scripts import the SDK from `magenta-sdk`, a symlink inside each package
directory (e.g. `.magenta/scripts/my-package/magenta-sdk`) pointing at
`magenta.nvim/sdk` in the plugin installation. Scripts import it via
`./magenta-sdk/index.ts` (and `./magenta-sdk/testing.ts` for the test harness).

Magenta does **not** create or manage this symlink for you. When authoring a
script package you (the agent or the user) must create it yourself, e.g.:

```
ln -s <plugin>/sdk .magenta/scripts/my-package/magenta-sdk
```

The directory layout looks like:

```
.magenta/scripts/
  my-package/
    magenta-sdk -> <plugin>/sdk
    index.ts
    my-script.ts
  other-package/
    magenta-sdk -> <plugin>/sdk
    index.ts
```

```ts
registerScript(name, description, parameterSchema, runner);
```

- `name`: unique script name (how agents invoke it).
- `description`: shown to agents so they know when to use it.
- `parameterSchema`: a JSON Schema describing the `parameters` the runner receives.
- `runner(parameters, thread, log)`: an async function that does the work.

The runner receives:

- `parameters`: the validated input object.
- `thread(prompt, yieldSchema, options?)`: spawns a real magenta thread seeded
  with `prompt`, equipped with a `yield_to_parent` tool whose input schema is
  `yieldSchema`. Resolves to the structured value the agent yields. Use the
  generic to type the result: `await thread<{ done: boolean }>(...)`.
  `options` may include:
  - `contextFiles`: absolute paths to seed into the thread's context.
  - `systemReminder`: a recurring system reminder injected into the thread.
  - `projectDir` (absolute or `~/`), `profile`, `model`, `tools`.
- `log(message)`: reports progress; surfaced in the magenta Scripts section.

## Minimal end-to-end example

```ts
// index.ts. file
import { registerScript } from "./magenta-sdk/index.ts";

registerScript(
  "summarize-file",
  "Summarizes a file and returns a one-line summary",
  {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  async (params: { path: string }, thread, log) => {
    log(`summarizing ${params.path}`);
    const result = await thread<{ summary: string }>(
      `Read ${params.path} and summarize it in one sentence.`,
      {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    );
    log(`summary: ${result.summary}`);
  },
);
```

## Testing a script

Use the in-process test harness from `./magenta-sdk/testing.ts`. It drives your
runner with test-double `thread`/`log` — no subprocess and no magenta required.
Statically import your script module first so its `registerScript` call runs.

```ts
import { expect, it } from "vitest";
import { runScript } from "./magenta-sdk/testing.ts";
import "./summarize-file.ts"; // registers the script

it("summarizes", async () => {
  const { handle, donePromise } = runScript("summarize-file", {
    path: "README.md",
  });

  const call = await handle.nextThread();
  expect(call.prompt).toContain("README.md");
  call.yield({ summary: "It is a readme." });

  await donePromise;
  expect(handle.logs).toContain("summary: It is a readme.");
});
```

`handle.nextThread()` resolves with each pending `thread()` call (in order),
exposing `prompt`, `yieldSchema`, `options`, and `yield(value)` / `reject(error)`
to settle that specific call. `handle.logs` captures `log()` output.
