import { describe, expect, it, vi } from "vitest";
import type { ThreadId } from "./chat-types.ts";
import type { TokenBudget } from "./compaction/token-budget.ts";
import { DockerSupervisor } from "./docker-supervisor.ts";
import type { MockAnthropicClient } from "./providers/mock-anthropic-client.ts";
import type {
  NativeMessageIdx,
  Provider,
  ProviderToolUseResponse,
} from "./providers/provider-types.ts";
import {
  cleanupArchive,
  createAgentWithMock,
  resetThread,
  TEST_ARCHIVE_DIR,
  uniqueThreadId,
} from "./test-helpers.ts";
import type { Thread } from "./thread.ts";
import {
  assembleThread,
  type ChatThreadPolicy,
  type PreparedThreadContext,
  type ThreadInitialization,
  TitleSupervisor,
} from "./thread-assembly.ts";
import {
  MaxTokensSupervisor,
  SubagentSupervisor,
} from "./thread-supervisor.ts";
import { Defer } from "./utils/async.ts";

const titleText = [
  {
    type: "text" as const,
    text: "make the thing",
  },
];

/** Drive a real submission far enough that the thread has reported it, then
 * leave the turn hanging: the title is requested before the first turn runs,
 * so nothing here needs the turn to finish. */
async function submitTitleText(
  thread: Thread,
  mockClient: MockAnthropicClient,
) {
  void thread.submit({ type: "resolved", messages: titleText });
  await mockClient.awaitStream();
}

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

const defaultPolicy: ChatThreadPolicy = {
  autoCompactPrompt: "continue where you left off",
};

function freshRoot(policy?: Partial<ChatThreadPolicy>): ThreadInitialization {
  return {
    type: "fresh",
    threadType: "root",
    archiveOptions: { baseDir: TEST_ARCHIVE_DIR },
    policy: { ...defaultPolicy, ...policy },
  };
}

function budgetSettings(budget: TokenBudget | undefined) {
  return budget && { threshold: budget.threshold, handoff: budget.handoff };
}

function setup(args?: {
  initialization?: ThreadInitialization;
  id?: ThreadId;
}) {
  const id = args?.id ?? uniqueThreadId("assembly");
  const { context, mockClient } = createAgentWithMock(undefined, id);
  const forceToolUse = vi.fn();
  const {
    threadType: _threadType,
    turnSupervisors: _turnSupervisors,
    toolLoopSupervisors: _toolLoopSupervisors,
    compaction: _compaction,
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
    initialization: args?.initialization ?? freshRoot(),
    context: prepared,
    callbacks: { onUpdate: () => {} },
  });
  return { id, ...assembled, titleDefer, forceToolUse, mockClient };
}

describe("assembleThread", () => {
  it("generates a title from the first submission with no view attached", async () => {
    const { id, thread, titleDefer, mockClient } = setup();
    await submitTitleText(thread, mockClient);
    titleDefer.resolve(titleResponse("Make the thing"));
    await titleDefer.promise;
    await vi.waitFor(() => expect(thread.title).toEqual("Make the thing"));
    await thread.destroy();
    await cleanupArchive(id);
  });

  it("requests a title only once, and never for a labelled thread", async () => {
    const { id, thread, forceToolUse, mockClient } = setup();
    thread.setTitle("label");
    await submitTitleText(thread, mockClient);
    await submitTitleText(thread, mockClient);
    expect(forceToolUse).not.toHaveBeenCalled();
    expect(thread.title).toEqual("label");
    await thread.destroy();
    await cleanupArchive(id);
  });

  it("still requests a title after the core was replaced", async () => {
    const { id, thread, titleDefer, forceToolUse, mockClient } = setup();
    await resetThread(thread, { archive: { type: "none" } });
    await submitTitleText(thread, mockClient);
    expect(forceToolUse).toHaveBeenCalledTimes(1);
    titleDefer.resolve(titleResponse("After compaction"));
    await titleDefer.promise;
    await vi.waitFor(() => expect(thread.title).toEqual("After compaction"));
    await thread.destroy();
    await cleanupArchive(id);
  });
  it("never requests a title for a compact thread", async () => {
    const { id, thread, forceToolUse, mockClient } = setup({
      initialization: {
        type: "fresh",
        threadType: "compact",
        archiveOptions: { baseDir: TEST_ARCHIVE_DIR },
      },
    });
    await submitTitleText(thread, mockClient);
    expect(forceToolUse).not.toHaveBeenCalled();
    expect(thread.title).toBeUndefined();
    await thread.destroy();
    await cleanupArchive(id);
  });
  it("drops a title that arrives after the thread was destroyed", async () => {
    const { id, thread, titleDefer, mockClient } = setup();
    await submitTitleText(thread, mockClient);
    await thread.destroy();
    titleDefer.resolve(titleResponse("too late"));
    await titleDefer.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(thread.title).toBeUndefined();
    await cleanupArchive(id);
  });

  it("orders chat supervisors by conversation kind", async () => {
    const root = setup();
    expect(root.thread.turnSupervisors.map((s) => s.constructor)).toEqual([
      MaxTokensSupervisor,
      TitleSupervisor,
    ]);
    expect(root.compactor).toBeDefined();
    expect(root.thread.tokenBudget).toBeDefined();

    const subagent = setup({
      initialization: {
        type: "fresh",
        threadType: "subagent",
        archiveOptions: { baseDir: TEST_ARCHIVE_DIR },
        policy: defaultPolicy,
      },
    });
    expect(subagent.thread.turnSupervisors.map((s) => s.constructor)).toEqual([
      MaxTokensSupervisor,
      SubagentSupervisor,
      TitleSupervisor,
    ]);

    const dockerRoot = setup({
      initialization: {
        type: "fresh",
        threadType: "docker_root",
        archiveOptions: { baseDir: TEST_ARCHIVE_DIR },
        policy: defaultPolicy,
      },
    });
    expect(dockerRoot.thread.turnSupervisors.map((s) => s.constructor)).toEqual(
      [MaxTokensSupervisor, SubagentSupervisor, TitleSupervisor],
    );

    const compact = setup({
      initialization: {
        type: "fresh",
        threadType: "compact",
        archiveOptions: { baseDir: TEST_ARCHIVE_DIR },
      },
    });
    expect(compact.thread.turnSupervisors.map((s) => s.constructor)).toEqual([
      MaxTokensSupervisor,
      SubagentSupervisor,
      TitleSupervisor,
    ]);
    expect(compact.compactor).toBeUndefined();
    expect(compact.thread.tokenBudget).toBeUndefined();

    const docker = setup({
      initialization: freshRoot({
        docker: {
          containerName: "container",
          imageName: "image",
          workspacePath: "/workspace",
          hostDir: "/host",
          supervised: true,
        },
      }),
    });
    expect(docker.thread.turnSupervisors.map((s) => s.constructor)).toEqual([
      MaxTokensSupervisor,
      DockerSupervisor,
      TitleSupervisor,
    ]);

    for (const { id, thread } of [
      root,
      subagent,
      dockerRoot,
      compact,
      docker,
    ]) {
      await thread.destroy();
      await cleanupArchive(id);
    }
  });

  it("passes the host's compaction knobs to a fresh thread", async () => {
    const { id, thread } = setup({
      initialization: freshRoot({
        autoCompactThreshold: 1234,
        autoCompactPrompt: "keep going",
      }),
    });
    const supervisor = thread.tokenBudget;
    expect(budgetSettings(supervisor)).toEqual({
      threshold: 1234,
      handoff: "keep going",
    });
    await thread.destroy();
    await cleanupArchive(id);
  });

  it("inherits kind, compaction settings and title generation on a fork", async () => {
    const source = setup({
      initialization: {
        type: "fresh",
        threadType: "subagent",
        archiveOptions: { baseDir: TEST_ARCHIVE_DIR },
        policy: { autoCompactThreshold: 4321, autoCompactPrompt: "resume" },
      },
    });
    const fork = setup({
      initialization: {
        type: "fork",
        sourceThread: source.thread,
        nativeMessageIdx: 0 as NativeMessageIdx,
      },
    });

    expect(fork.thread.threadType).toEqual("subagent");
    expect(fork.thread.turnSupervisors.map((s) => s.constructor)).toEqual([
      MaxTokensSupervisor,
      SubagentSupervisor,
      TitleSupervisor,
    ]);
    const supervisor = fork.thread.tokenBudget;
    expect(budgetSettings(supervisor)).toEqual({
      threshold: 4321,
      handoff: "resume",
    });

    // The fork's manager is cloned from the source, so its requests go to the
    // source's mock client.
    await submitTitleText(fork.thread, source.mockClient);
    expect(fork.forceToolUse).toHaveBeenCalledTimes(1);
    fork.titleDefer.resolve(titleResponse("Forked work"));
    await fork.titleDefer.promise;
    await vi.waitFor(() => expect(fork.thread.title).toEqual("Forked work"));

    for (const { id, thread } of [source, fork]) {
      await thread.destroy();
      await cleanupArchive(id);
    }
  });
});
