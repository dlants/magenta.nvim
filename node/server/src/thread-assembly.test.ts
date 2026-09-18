import { describe, expect, it, vi } from "vitest";
import type { ThreadId } from "./chat-types.ts";
import { DockerSupervisor } from "./docker-supervisor.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type Provider,
  type ProviderToolUseResponse,
} from "./providers/provider-types.ts";
import {
  cleanupArchive,
  createAgentWithMock,
  TEST_ARCHIVE_DIR,
  uniqueThreadId,
} from "./test-helpers.ts";
import {
  assembleThread,
  type PreparedThreadContext,
  type ThreadInitialization,
  type ThreadPolicy,
} from "./thread-assembly.ts";
import {
  AutoCompactSupervisor,
  MaxTokensSupervisor,
  SubagentSupervisor,
} from "./thread-supervisor.ts";
import { Defer } from "./utils/async.ts";

const titleText = [
  {
    type: "text" as const,
    text: "make the thing",
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
  },
];

function titleResponse(title: string): ProviderToolUseResponse {
  return {
    toolRequest: {
      status: "ok",
      value: {
        id: "title-request",
        toolName: "thread_title",
        input: { title },
      },
    },
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0, cacheHits: 0, cacheMisses: 0 },
  } as unknown as ProviderToolUseResponse;
}

function setup(args?: {
  initialization?: ThreadInitialization;
  policy?: ThreadPolicy;
  id?: ThreadId;
}) {
  const id = args?.id ?? uniqueThreadId("assembly");
  const { context } = createAgentWithMock(undefined, id);
  const forceToolUse = vi.fn();
  const {
    threadType: _threadType,
    chatSupervisors: _chatSupervisors,
    compactor: _compactor,
    ...rest
  } = context;
  const titleDefer = new Defer<ProviderToolUseResponse>();
  const provider: Provider = {
    ...context.provider,
    forceToolUse: () => {
      forceToolUse();
      return {
        abort: () => {},
        aborted: false,
        promise: titleDefer.promise,
      };
    },
  };
  const prepared: PreparedThreadContext = { ...rest, provider };
  const assembled = assembleThread({
    id,
    initialization: args?.initialization ?? {
      type: "fresh",
      threadType: "root",
      archiveOptions: { baseDir: TEST_ARCHIVE_DIR },
    },
    context: prepared,
    callbacks: { onUpdate: () => {} },
    ...(args?.policy ? { policy: args.policy } : {}),
  });
  return { id, ...assembled, titleDefer, forceToolUse };
}

describe("assembleThread", () => {
  it("generates a title from the first submission with no view attached", async () => {
    const { id, thread, titleDefer } = setup();
    thread.callbacks.onSubmission?.(titleText);
    titleDefer.resolve(titleResponse("Make the thing"));
    await titleDefer.promise;
    await vi.waitFor(() => expect(thread.title).toEqual("Make the thing"));
    await thread.destroy();
    await cleanupArchive(id);
  });

  it("requests a title only once, and never for a labelled thread", async () => {
    const { id, thread, forceToolUse } = setup();
    thread.setTitle("label");
    thread.callbacks.onSubmission?.(titleText);
    thread.callbacks.onSubmission?.(titleText);
    expect(forceToolUse).not.toHaveBeenCalled();
    expect(thread.title).toEqual("label");
    await thread.destroy();
    await cleanupArchive(id);
  });

  it("drops a title that arrives after the thread was destroyed", async () => {
    const { id, thread, titleDefer } = setup();
    thread.callbacks.onSubmission?.(titleText);
    await thread.destroy();
    titleDefer.resolve(titleResponse("too late"));
    await titleDefer.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(thread.title).toBeUndefined();
    await cleanupArchive(id);
  });

  it("orders chat supervisors by conversation kind", async () => {
    const root = setup();
    expect(root.thread.chatSupervisors.map((s) => s.constructor)).toEqual([
      MaxTokensSupervisor,
      AutoCompactSupervisor,
    ]);
    expect(root.compactor).toBeDefined();

    const subagent = setup({
      initialization: {
        type: "fresh",
        threadType: "subagent",
        archiveOptions: { baseDir: TEST_ARCHIVE_DIR },
      },
    });
    expect(subagent.thread.chatSupervisors.map((s) => s.constructor)).toEqual([
      MaxTokensSupervisor,
      SubagentSupervisor,
      AutoCompactSupervisor,
    ]);

    const compact = setup({
      initialization: {
        type: "fresh",
        threadType: "compact",
        archiveOptions: { baseDir: TEST_ARCHIVE_DIR },
      },
    });
    expect(compact.thread.chatSupervisors.map((s) => s.constructor)).toEqual([
      MaxTokensSupervisor,
      SubagentSupervisor,
    ]);
    expect(compact.compactor).toBeUndefined();

    const docker = setup({
      policy: {
        docker: {
          containerName: "container",
          imageName: "image",
          workspacePath: "/workspace",
          hostDir: "/host",
          supervised: true,
        },
      },
    });
    expect(docker.thread.chatSupervisors.map((s) => s.constructor)).toEqual([
      MaxTokensSupervisor,
      DockerSupervisor,
      AutoCompactSupervisor,
    ]);

    for (const { id, thread } of [root, subagent, compact, docker]) {
      await thread.destroy();
      await cleanupArchive(id);
    }
  });
});
