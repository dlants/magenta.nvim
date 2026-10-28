import { afterEach, expect, it } from "vitest";
import type { ClientCommandName } from "../capabilities/client.ts";
import { InMemoryFileIO } from "../edl/in-memory-file-io.ts";
import type { AgentInput } from "../providers/provider-types.ts";
import { FakeClient } from "../test/fakes.ts";
import { createHarness, type Harness } from "../test/harness.ts";
import {
  awaitNextStream,
  createAgentWithMock,
  noopLogger,
  uniqueThreadId,
} from "../test-helpers.ts";
import type { ContextFileAccess } from "../thread.ts";
import type { HomeDir, ProjectDir } from "../utils/files.ts";
import { pendingMessage } from "./index.ts";
import { resolveSubmission } from "./resolve.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

function fakeClient(
  expand: (command: ClientCommandName) => Promise<AgentInput[]>,
) {
  return new FakeClient({
    expandClientCommand: (req) => expand(req.command),
  });
}

/** A thread whose resolver is the real one, with client commands answered by
 * a real session's attached client. */
function setup() {
  const harness = createHarness();
  harnesses.push(harness);
  const { session } = harness;
  const { core, mockClient } = createAgentWithMock(
    undefined,
    uniqueThreadId("client-commands"),
    (message, abandoned) =>
      resolveSubmission(
        message,
        {
          projectDir: "/proj" as ProjectDir,
          homeDir: "/home" as HomeDir,
          fileIO: new InMemoryFileIO({}),
          logger: noopLogger,
          customCommands: [],
          getContextFiles: () => ({}) as unknown as ContextFileAccess,
          canCompact: false,
          awaitClient: () => session.awaitClient(),
        },
        abandoned,
      ),
  );
  return { session, core, mockClient };
}

const texts = (content: ReadonlyArray<{ type: string }>) =>
  content.flatMap((b) =>
    b.type === "text" ? [(b as unknown as { text: string }).text] : [],
  );

it("expands against the client state at delivery, as separate blocks", async () => {
  const { session, core, mockClient } = setup();
  let quickfix = "at submit";
  session.attachClient(
    fakeClient(async (command) => [
      { type: "text", text: `${command}: ${quickfix}` },
    ]),
  );
  void core.submit({
    type: "resolved",
    messages: [{ type: "text", text: "go" }],
  });
  const first = await mockClient.awaitStream();
  core.enqueue({ type: "raw", message: pendingMessage("check @qf") }, "next");
  quickfix = "at delivery";
  first.finishResponse("end_turn");
  const second = await awaitNextStream(mockClient, first);
  const last = core.getProviderMessages().at(-1);
  expect(last?.role).toBe("user");
  const blocks = texts(last?.content ?? []);
  expect(blocks).toContain("check @qf");
  expect(blocks).toContain("qf: at delivery");
  second.finishResponse("end_turn");
});

it("waits for a client to attach, and abort releases the wait", async () => {
  const { session, core, mockClient } = setup();
  const sent = core.submit({
    type: "raw",
    message: pendingMessage("see @diag"),
  });
  await Promise.resolve();
  expect(core.state.type).toBe("running");
  expect(session.awaitingClient).toBe(1);
  session.attachClient(
    fakeClient(async () => [{ type: "text", text: "no problems" }]),
  );
  const stream = await mockClient.awaitStream();
  expect(texts(core.getProviderMessages().at(-1)?.content ?? [])).toContain(
    "no problems",
  );
  stream.finishResponse("end_turn");
  await sent;

  session.detachClient();
  const waiting = core.submit({
    type: "raw",
    message: pendingMessage("@buf"),
  });
  await Promise.resolve();
  expect(session.awaitingClient).toBe(1);
  await core.abort();
  expect(await waiting).toEqual({ type: "aborted" });
  expect(session.awaitingClient).toBe(0);
});

it("turns a failed expansion into an error block and proceeds", async () => {
  const { session, core, mockClient } = setup();
  session.attachClient(
    fakeClient(async () => {
      throw new Error("client gone");
    }),
  );
  const sent = core.submit({
    type: "raw",
    message: pendingMessage("see @buffers"),
  });
  const stream = await mockClient.awaitStream();
  expect(texts(core.getProviderMessages().at(-1)?.content ?? [])).toContain(
    "Error fetching buffers list: client gone",
  );
  stream.finishResponse("end_turn");
  await sent;
});
it("expands repeated and mixed client commands once per match (grouped by command)", async () => {
  const { session, core, mockClient } = setup();
  let calls = 0;
  session.attachClient(
    fakeClient(async (command) => [
      { type: "text", text: `${command} #${++calls}` },
    ]),
  );
  const sent = core.submit({
    type: "raw",
    message: pendingMessage("@buf @qf @buf x"),
  });
  const stream = await mockClient.awaitStream();
  const blocks = texts(core.getProviderMessages().at(-1)?.content ?? []);
  expect(
    blocks.filter((b) => /#\d/.test(b)).map((b) => b.split(" ")[0]),
  ).toEqual(["buf", "buf", "qf"]);
  expect(session.awaitingClient).toBe(0);
  stream.finishResponse("end_turn");
  await sent;
});
