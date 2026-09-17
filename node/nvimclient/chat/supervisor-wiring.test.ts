import {
  AutoCompactSupervisor,
  MaxTokensSupervisor,
  type NativeMessageIdx,
  SubagentSupervisor,
  type ThreadId,
  type ToolName,
  type ToolRequestId,
} from "@magenta/server";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import type { ScriptInvocationId } from "../scripts/script-manager.ts";
import { withDriver } from "../test/preamble.ts";
import { createNvimThread } from "./thread.ts";
import { DockerSupervisor } from "./thread-supervisor.ts";

it("root/user threads get an AutoCompactSupervisor", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    const thread = driver.magenta.chat.getActiveThread();

    expect(
      thread.core.context.chatSupervisors!.some(
        (s) => s instanceof AutoCompactSupervisor,
      ),
    ).toBe(true);
    expect(
      thread.core.context.chatSupervisors!.some(
        (s) => s instanceof SubagentSupervisor,
      ),
    ).toBe(false);
  });
});

it("subagent threads get both SubagentSupervisor and AutoCompactSupervisor", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Use spawn_subagents to do a task.");
    await driver.send();

    const stream1 =
      await driver.mockAnthropic.awaitPendingStreamWithText("spawn_subagents");

    stream1.respond({
      stopReason: "tool_use",
      text: "I'll spawn a subagent to handle this task.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "test-subagent" as ToolRequestId,
            toolName: "spawn_subagents" as ToolName,
            input: {
              agents: [{ prompt: "Do the task and yield the result" }],
            },
          },
        },
      ],
    });

    // Wait for the child subagent stream to start.
    await driver.mockAnthropic.awaitPendingStreamWithText("Do the task");

    const chat = driver.magenta.chat;
    const childThreadId = Object.keys(chat.threadWrappers).find((id) => {
      const wrapper = chat.threadWrappers[id as ThreadId];
      return wrapper?.parentThreadId !== undefined;
    }) as ThreadId | undefined;
    expect(childThreadId).toBeDefined();

    const childWrapper = chat.threadWrappers[childThreadId!];
    if (childWrapper.state !== "initialized")
      throw new Error("Expected initialized child thread");
    const supervisors = childWrapper.thread.core.context.chatSupervisors!;

    expect(supervisors.some((s) => s instanceof SubagentSupervisor)).toBe(true);
    expect(supervisors.some((s) => s instanceof AutoCompactSupervisor)).toBe(
      true,
    );
  });
});

it("a truncated response is continued via MaxTokensSupervisor", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("write me a long thing");
    await driver.send();
    const stream = await driver.mockAnthropic.awaitPendingStream();
    stream.respond({
      stopReason: "max_tokens",
      text: "Here is the beginning of a long",
      toolRequests: [],
    });
    await driver.mockAnthropic.awaitPendingStreamWithText(
      "Your previous response was truncated",
    );
  });
});
const yieldSchema: JSONSchemaType = {
  type: "object",
  properties: { count: { type: "number" } },
  required: ["count"],
};

it("script-spawned thread honors per-thread autoCompactThreshold override", async () => {
  await withDriver(
    { options: { autoCompactThreshold: 300_000 } },
    async (driver) => {
      await driver.showSidebar();

      const overriddenId = await driver.magenta.chat.spawnScriptThread({
        scriptInvocationId: "inv-override" as ScriptInvocationId,
        scriptName: "test-script",
        prompt: "do work",
        yieldSchema: yieldSchema,
        getSandboxRoot: () => undefined,
        autoCompactThreshold: 100_000,
      });

      const defaultId = await driver.magenta.chat.spawnScriptThread({
        scriptInvocationId: "inv-default" as ScriptInvocationId,
        scriptName: "test-script",
        prompt: "do work",
        yieldSchema: yieldSchema,
        getSandboxRoot: () => undefined,
      });

      const chat = driver.magenta.chat;
      const getSupervisor = (id: ThreadId) => {
        const wrapper = chat.threadWrappers[id];
        if (wrapper.state !== "initialized")
          throw new Error("expected initialized thread");
        const sup = wrapper.thread.core.context.chatSupervisors!.find(
          (s): s is AutoCompactSupervisor => s instanceof AutoCompactSupervisor,
        );
        if (!sup) throw new Error("expected AutoCompactSupervisor");
        return sup;
      };

      const overridden = getSupervisor(overriddenId);
      const fallback = getSupervisor(defaultId);

      // The override compacts at 100k; the default only at 300k.
      const ask = async (sup: AutoCompactSupervisor, inputTokenCount: number) =>
        (
          await sup.onBeforeRequest({
            status: "pending",
            inputTokenCount,
            outputTokenCount: 0,
            nativeMessageIdx: 0 as NativeMessageIdx,
          })
        ).type;
      expect(await ask(overridden, 100_000)).toBe("suspend");
      expect(await ask(fallback, 100_000)).toBe("none");
      expect(await ask(fallback, 300_000)).toBe("suspend");
      const sourceWrapper = chat.threadWrappers[overriddenId];
      if (sourceWrapper.state !== "initialized")
        throw new Error("expected source thread");
      await sourceWrapper.thread.abortAndWait();
      const forkId = await chat.handleForkThread({
        sourceThreadId: overriddenId,
      });
      const forkWrapper = chat.threadWrappers[forkId];
      if (forkWrapper.state !== "initialized")
        throw new Error("expected fork thread");
      expect(forkWrapper.thread.core.toolSpecs).toEqual(
        sourceWrapper.thread.core.toolSpecs,
      );
      expect(forkWrapper.thread.core.context.yieldSchema).toEqual(yieldSchema);
      expect(await ask(getSupervisor(forkId), 100_000)).toBe("suspend");
      expect(getSupervisor(forkId)).not.toBe(overridden);
    },
  );
});

it.each([
  {
    threadType: "compact" as const,
    supervised: false,
    expected: [MaxTokensSupervisor, SubagentSupervisor],
  },
  {
    threadType: "docker_root" as const,
    supervised: false,
    expected: [MaxTokensSupervisor, SubagentSupervisor, AutoCompactSupervisor],
  },
  {
    threadType: "subagent" as const,
    supervised: true,
    expected: [MaxTokensSupervisor, DockerSupervisor, AutoCompactSupervisor],
  },
])("constructs $threadType supervised=$supervised with ordered, stable policies", async ({
  threadType,
  supervised,
  expected,
}) => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const source = driver.magenta.chat.getActiveThread();
    // Use the real local collaborators: policy assembly requires no live container.
    const thread = createNvimThread(
      uuidv7() as ThreadId,
      threadType,
      source.core.systemPrompt,
      {
        ...source.context,
        onFileAdded: () => {},
      },
      supervised
        ? {
            docker: {
              containerName: "worker",
              imageName: "worker-image",
              workspacePath: "/workspace",
              hostDir: source.context.cwd,
              supervised: true,
            },
          }
        : {},
    );
    try {
      const policies = thread.core.context.chatSupervisors!;
      expect(policies.map((policy) => policy.constructor)).toEqual(expected);
      expect(thread.compactor).toBe(thread.core.context.compactor);
      expect(thread.compactor === undefined).toBe(threadType === "compact");
      const resolve = thread.core.context.resolve;
      const callbacks = thread.core.callbacks;
      await thread.core.reset({ seed: [], archive: { type: "none" } });
      expect(thread.core.context.chatSupervisors).toBe(policies);
      expect(thread.core.context.resolve).toBe(resolve);
      expect(thread.core.callbacks).toBe(callbacks);
    } finally {
      await thread.destroy();
    }
  });
});
