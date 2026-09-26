// biome-ignore-all lint/complexity/useLiteralKeys: White-box lifecycle tests deliberately access private implementation state.
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import { expect, it } from "vitest";
import type { ScriptInvocationId, ThreadId, ThreadType } from "./chat-types.ts";
import type { TokenBudget } from "./compaction/token-budget.ts";
import { DockerSupervisor } from "./docker-supervisor.ts";
import { withHarness } from "./test/harness.ts";
import { created } from "./test-helpers.ts";
import { TitleSupervisor } from "./thread-assembly.ts";
import {
  MaxTokensSupervisor,
  SubagentSupervisor,
} from "./thread-supervisor.ts";
import type { NvimCwd } from "./utils/files.ts";

it("a truncated response is continued via MaxTokensSupervisor", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "write me a long thing");
    const stream = await h.nextStream();
    stream.respond({
      stopReason: "max_tokens",
      text: "Here is the beginning of a long",
      toolRequests: [],
    });
    await h.streamWithText("Your previous response was truncated");
  }));

const yieldSchema: JSONSchemaType = {
  type: "object",
  properties: { count: { type: "number" } },
  required: ["count"],
};

it("script-spawned thread honors per-thread autoCompactThreshold override", () =>
  withHarness({ options: { autoCompactThreshold: 300_000 } }, async (h) => {
    const overriddenId = await created(
      h.session.spawnScriptThread({
        scriptInvocationId: "inv-override" as ScriptInvocationId,
        scriptName: "test-script",
        prompt: "do work",
        yieldSchema,
        autoCompactThreshold: 100_000,
      }),
    );
    const defaultId = await created(
      h.session.spawnScriptThread({
        scriptInvocationId: "inv-default" as ScriptInvocationId,
        scriptName: "test-script",
        prompt: "do work",
        yieldSchema,
      }),
    );
    const budget = (id: ThreadId) => {
      const sup = h.thread(id).tokenBudget;
      if (!sup) throw new Error("expected token budget");
      return sup;
    };
    const overridden = budget(overriddenId);
    const fallback = budget(defaultId);
    // The override compacts at 100k; the default only at 300k.
    const ask = (sup: TokenBudget, inputTokenCount: number) =>
      sup.check(inputTokenCount).type === "stop" ? "suspend" : "none";
    expect(ask(overridden, 100_000)).toBe("suspend");
    expect(ask(fallback, 100_000)).toBe("none");
    expect(ask(fallback, 300_000)).toBe("suspend");

    const source = h.thread(overriddenId);
    await source.abort();
    const forkId = await created(h.session.forkThread(overriddenId));
    const fork = h.thread(forkId);
    expect(fork.toolSpecs).toEqual(source.toolSpecs);
    expect(fork["context"].yieldSchema).toEqual(yieldSchema);
    expect(ask(budget(forkId), 100_000)).toBe("suspend");
    expect(budget(forkId)).not.toBe(overridden);
  }));

it.each([
  {
    threadType: "compact",
    supervised: false,
    expected: [MaxTokensSupervisor, SubagentSupervisor, TitleSupervisor],
  },
  {
    threadType: "docker_root",
    supervised: false,
    expected: [MaxTokensSupervisor, SubagentSupervisor, TitleSupervisor],
  },
  {
    threadType: "subagent",
    supervised: true,
    expected: [MaxTokensSupervisor, DockerSupervisor, TitleSupervisor],
  },
] satisfies {
  threadType: ThreadType;
  supervised: boolean;
  expected: unknown[];
}[])("constructs $threadType supervised=$supervised with ordered, stable policies", ({
  threadType,
  supervised,
  expected,
}) =>
  withHarness({}, async (h) => {
    const id = await created(
      h.session.createThread({
        profile: h.host.getActiveProfile(),
        threadType,
        ...(supervised
          ? {
              dockerSpawnConfig: {
                containerName: "worker",
                imageName: "worker-image",
                workspacePath: "/workspace",
                hostDir: h.host.cwd as NvimCwd,
                supervised: true,
              },
            }
          : {}),
      }),
    );
    const record = h.session.getThread(id);
    if (record?.state !== "initialized")
      throw new Error("expected an initialized thread");
    const thread = record.thread;
    const policies = thread.submissionSupervisors;
    expect(policies.map((policy) => policy.constructor)).toEqual(expected);
    expect(record.compactor).toBe(thread["context"].compaction?.compactor);
    expect(record.compactor === undefined).toBe(threadType === "compact");
    const resolve = thread["context"].resolve;
    const callbacks = thread.callbacks;
    await thread["replaceCore"]({ archive: { type: "none" } });
    expect(thread.submissionSupervisors).toBe(policies);
    expect(thread["context"].resolve).toBe(resolve);
    expect(thread.callbacks).toBe(callbacks);
  }));

it("forks compact threads without a compactor or auto-compaction policy", () =>
  withHarness({}, async (h) => {
    const sourceId = await created(
      h.session.createThread({
        profile: h.host.getActiveProfile(),
        threadType: "compact",
      }),
    );
    const forkId = await created(h.session.forkThread(sourceId));
    const fork = h.session.getThread(forkId);
    if (fork?.state !== "initialized")
      throw new Error("expected an initialized fork");
    expect(fork.thread.threadType).toBe("compact");
    expect(fork.compactor).toBeUndefined();
    expect(fork.thread["context"].compaction?.compactor).toBeUndefined();
    expect(
      fork.thread.submissionSupervisors.map((policy) => policy.constructor),
    ).toEqual([MaxTokensSupervisor, SubagentSupervisor, TitleSupervisor]);
  }));
