import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptInvocationId } from "./chat-types.ts";
import { InMemoryFileIO } from "./edl/in-memory-file-io.ts";
import type { ProviderProfile } from "./provider-options.ts";
import { MockAnthropicClient } from "./providers/mock-anthropic-client.ts";
import { DEFAULT_SANDBOX_CONFIG } from "./sandbox-config.ts";
import {
  type ServerHostOptions,
  ServerSessionHost,
} from "./server-session-host.ts";
import { Session } from "./session.ts";
import { pendingMessage } from "./submission/index.ts";
import { FakeClient } from "./test/fakes.ts";
import { MockSandboxManager } from "./test/mock-sandbox-manager.ts";
import {
  awaitNextStream,
  createMockProvider,
  noopLogger,
} from "./test-helpers.ts";
import type { Thread } from "./thread.ts";
import { ABORTED } from "./thread-api.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { Defer } from "./utils/async.ts";
import type { AbsFilePath, Cwd, HomeDir } from "./utils/files.ts";

const profile: ProviderProfile = {
  name: "mock",
  provider: "anthropic",
  model: "claude-3-5-sonnet-20241022",
  fastModel: "claude-3-5-haiku-20241022",
  thinkingModel: "claude-3-5-sonnet-20241022",
};
const options: ServerHostOptions = {
  profiles: [profile],
  activeProfile: "mock",
  sandbox: DEFAULT_SANDBOX_CONFIG,
  issuesDir: "~/.magenta-issues",
  autoContext: [],
  hierarchyContextFileNames: [],
  skillsPaths: [],
  agentsPaths: [],
  maxConcurrentSubagents: 3,
  maxConcurrentFastSubagents: 8,
  autoCompactThreshold: 100000,
  autoCompactPrompt: "compact",
  mcpServers: {},
  customCommands: [{ name: "@hi", text: "custom text" }],
};
const editor = new FakeClient({}, "999");

let dir: string;
let mockClient: MockAnthropicClient;
let session: Session;
let host: ServerSessionHost;
let fileIO: InMemoryFileIO;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "server-host-"));
  mockClient = new MockAnthropicClient();
  const provider = createMockProvider(mockClient);
  fileIO = new InMemoryFileIO({ [path.join(dir, "a.txt")]: "hello" });
  host = new ServerSessionHost({
    logger: noopLogger,
    cwd: dir as Cwd,
    homeDir: dir as HomeDir,
    sandbox: new MockSandboxManager(),
    getOptions: () => options,
    getClient: () => session.getClient(),
    awaitClient: () => session.awaitClient(),
    getProvider: () => provider,
  });
  session = new Session(host);
});
afterEach(async () => {
  await session.dispose();
  await rm(dir, { recursive: true, force: true });
});

async function createThread(): Promise<Thread> {
  const id = await session.createThread({
    profile,
    threadType: "root",
    fileIO,
  });
  if (id === ABORTED) throw new Error("aborted");
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("not initialized");
  return record.thread;
}
const toolNames = (thread: Thread) => thread.toolSpecs.map((s) => s.name);

it("runs a thread with no attached editor", async () => {
  const thread = await createThread();
  expect(toolNames(thread)).not.toContain("hover");
  expect(toolNames(thread)).toContain("edl");
  const done = thread.submit({ type: "raw", message: pendingMessage("edit") });
  const stream = await awaitNextStream(mockClient, undefined);
  stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
    script: `file \`${path.join(dir, "a.txt")}\`\nnarrow /hello/\nreplace "bye"`,
  });
  stream.finishResponse("tool_use");
  const next = await awaitNextStream(mockClient, stream);
  next.finishResponse("end_turn");
  await expect(done).resolves.toMatchObject({ type: "completed" });
  expect(await fileIO.readFile(path.join(dir, "a.txt"))).toBe("bye");
});

it("gives editor tools only to threads created while attached", async () => {
  const before = await createThread();
  session.attachClient(editor);
  const after = await createThread();
  expect(toolNames(before)).not.toContain("hover");
  expect(toolNames(after)).toContain("hover");
});

it("keeps a running submission going when the editor detaches", async () => {
  session.attachClient(editor);
  const thread = await createThread();
  const done = thread.submit({ type: "raw", message: pendingMessage("hi") });
  const stream = await awaitNextStream(mockClient, undefined);
  session.detachClient();
  stream.streamText("still here");
  stream.finishResponse("end_turn");
  await expect(done).resolves.toMatchObject({ type: "completed" });
});

it("wires editor capabilities into threads with the thread's cwd", async () => {
  const threadCwd = path.join(dir, "sub");
  await mkdir(threadCwd);
  const file = path.join(threadCwd, "b.txt");
  await writeFile(file, "hello");
  const spyEditor = new FakeClient(
    {
      lsp: async () => [null],
      fileWritten: async () => undefined,
    },
    "999",
  );
  const fileWrites = () =>
    spyEditor.requests.filter((r) => r.type === "fileWritten");

  const create = async () => {
    const id = await session.createThread({
      profile,
      threadType: "root",
      environmentConfig: { type: "local", cwd: threadCwd as Cwd },
    });
    if (id === ABORTED) throw new Error("aborted");
    const record = session.getThread(id);
    if (record?.state !== "initialized") throw new Error("not initialized");
    return { id, thread: record.thread };
  };
  let last: Awaited<ReturnType<typeof awaitNextStream>> | undefined;
  const runEdit = async (thread: Thread, from: string, to: string) => {
    const done = thread.submit({
      type: "raw",
      message: pendingMessage("edit"),
    });
    const stream = await awaitNextStream(mockClient, last);
    stream.streamToolUse("edl-1" as ToolRequestId, "edl" as ToolName, {
      script: `file \`${file}\`\nnarrow /${from}/\nreplace "${to}"`,
    });
    stream.finishResponse("tool_use");
    const next = await awaitNextStream(mockClient, stream);
    next.finishResponse("end_turn");
    last = next;
    await expect(done).resolves.toMatchObject({ type: "completed" });
  };

  const before = await create();
  session.attachClient(spyEditor);
  await runEdit(before.thread, "hello", "bye");
  expect(fileWrites()).toEqual([]);

  const after = await create();
  const { lspClient } = host.getPrepared(after.id).environment;
  await lspClient?.requestHover(file as AbsFilePath, { line: 0, character: 1 });
  const lspRequest = spyEditor.requests.find((r) => r.type === "lsp");
  expect(lspRequest).toEqual({
    type: "lsp",
    kind: "hover",
    cwd: threadCwd,
    homeDir: dir,
    filePath: file,
    position: { line: 0, character: 1 },
  });
  expect(JSON.parse(JSON.stringify(lspRequest))).toEqual(lspRequest);
  expect(host.getPrepared(after.id).systemInfo.neovimVersion).toBe("999");
  await runEdit(after.thread, "bye", "again");
  expect(fileWrites()).toEqual([{ type: "fileWritten", absPath: file }]);
  expect(await readFile(file, "utf8")).toBe("again");
});

describe("submission resolution", () => {
  const userText = (stream: {
    messages: { role: string; content: unknown }[];
  }) => JSON.stringify(stream.messages.filter((m) => m.role === "user"));

  it("adds @file: context through the thread's fileIO and expands custom commands", async () => {
    const thread = await createThread();
    const abs = path.join(dir, "a.txt");
    const done = thread.submit({
      type: "raw",
      message: pendingMessage(`look @file:${abs} @hi`),
    });
    const stream = await awaitNextStream(mockClient, undefined);
    expect(thread.contextFiles.files[abs as AbsFilePath]).toBeDefined();
    expect(userText(stream)).toContain("custom text");
    stream.finishResponse("end_turn");
    await done;
  });

  it("reports a missing @file:", async () => {
    const thread = await createThread();
    const missing = path.join(dir, "missing.txt");
    const done = thread.submit({
      type: "raw",
      message: pendingMessage(`@file:${missing}`),
    });
    const stream = await awaitNextStream(mockClient, undefined);
    expect(userText(stream)).toContain(
      `Error adding file to context for ${missing}: File ${missing} does not exist`,
    );
    stream.finishResponse("end_turn");
    await done;
  });

  it("expands @diff in a real git repo", async () => {
    const git = (...args: string[]) =>
      promisify(execFile)("git", args, { cwd: dir });
    await git("init", "-q");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(path.join(dir, "d.txt"), "one\n");
    await git("add", ".");
    await git("commit", "-qm", "init");
    await writeFile(path.join(dir, "d.txt"), "two\n");
    const thread = await createThread();
    const done = thread.submit({
      type: "raw",
      message: pendingMessage("@diff:d.txt"),
    });
    const stream = await awaitNextStream(mockClient, undefined);
    expect(userText(stream)).toContain("+two");
    stream.finishResponse("end_turn");
    await done;
  });

  it("expands @staged in a real git repo", async () => {
    const git = (...args: string[]) =>
      promisify(execFile)("git", args, { cwd: dir });
    await git("init", "-q");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(path.join(dir, "s.txt"), "one\n");
    await writeFile(path.join(dir, "clean.txt"), "clean\n");
    await git("add", ".");
    await git("commit", "-qm", "init");
    await writeFile(path.join(dir, "s.txt"), "staged\n");
    await git("add", "s.txt");
    await writeFile(path.join(dir, "s.txt"), "unstaged\n");
    // zx builds a shell string, so shell metacharacters in the path must be quoted
    const weirdName = "we$ird'\"name.txt";
    await writeFile(path.join(dir, weirdName), "weird\n");
    await git("add", weirdName);
    const thread = await createThread();
    const done = thread.submit({
      type: "raw",
      message: pendingMessage(
        `@staged:s.txt @staged:${weirdName} @diff:clean.txt @staged:clean.txt`,
      ),
    });
    // Four real git processes; slow under full-suite load.
    const stream = await awaitNextStream(mockClient, undefined, 10_000);
    const text = userText(stream);
    expect(text).toContain("+staged");
    expect(text).not.toContain("+unstaged");
    expect(text).toContain("+weird");
    expect(text).not.toContain("Error fetching");
    expect(text).toContain("(no unstaged changes)");
    expect(text).toContain("(no staged changes)");
    stream.finishResponse("end_turn");
    await done;
  });
});

describe("auth UI", () => {
  function makeAuthSession(logger = noopLogger) {
    const authHost: ServerSessionHost = new ServerSessionHost({
      logger,
      cwd: dir as Cwd,
      homeDir: dir as HomeDir,
      sandbox: new MockSandboxManager(),
      getOptions: () => options,
      getClient: () => authSession.getClient(),
      awaitClient: () => authSession.awaitClient(),
    });
    const authSession = new Session(authHost);
    return { authHost, authSession };
  }
  function clientWith(calls: string[], supportsAuthUI = true) {
    const client = new FakeClient(
      supportsAuthUI
        ? {
            oauth: async (req) => {
              calls.push(`oauth:${req.authUrl}`);
              return { code: "code" };
            },
          }
        : {},
    );
    client.notify = (n) =>
      calls.push(
        n.type === "authError" ? `error:${n.message}` : `progress:${n.chunk}`,
      );
    return client;
  }
  it("OAuth waits for a client to attach, then prompts it", async () => {
    const { authHost, authSession } = makeAuthSession();
    let code: string | undefined;
    const flow = authHost.authUI.showOAuthFlow("https://x").then((c) => {
      code = c;
    });
    await Promise.resolve();
    expect(code).toBeUndefined();
    expect(authSession.awaitingClient).toBe(1);
    const calls: string[] = [];
    authSession.attachClient(clientWith(calls));
    await flow;
    expect(code).toBe("code");
    expect(calls).toEqual(["oauth:https://x"]);
    expect(authSession.awaitingClient).toBe(0);
  });
  it("aborting a waiting OAuth flow rejects and drops the waiter", async () => {
    const { authHost, authSession } = makeAuthSession();
    const controller = new AbortController();
    const flow = authHost.authUI.showOAuthFlow("https://x", controller.signal);
    expect(authSession.awaitingClient).toBe(1);
    controller.abort();
    await expect(flow).rejects.toThrow(/aborted/);
    expect(authSession.awaitingClient).toBe(0);
    const calls: string[] = [];
    authSession.attachClient(clientWith(calls));
    expect(calls).toEqual([]);
  });
  it("aborting while the client shows the OAuth prompt rejects and drops its late answer", async () => {
    const { authHost, authSession } = makeAuthSession();
    const answer = new Defer<{ code: string }>();
    authSession.attachClient(new FakeClient({ oauth: () => answer.promise }));
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    const flow = authHost.authUI.showOAuthFlow("https://x", controller.signal);
    await Promise.resolve();
    controller.abort(reason);
    await expect(flow).rejects.toBe(reason);
    answer.resolve({ code: "late" });
    await answer.promise;
  });
  it("logs and replays login output from before attach, in order", async () => {
    const logged: string[] = [];
    const { authHost, authSession } = makeAuthSession({
      ...noopLogger,
      error: (m: string) => logged.push(`error:${m}`),
      info: (m: string) => logged.push(`info:${m}`),
    });
    authHost.authUI.showLoginProgress("one");
    authHost.authUI.showError("bad");
    authHost.authUI.showLoginProgress("two");
    expect(logged).toEqual(["info:one", "error:bad", "info:two"]);
    expect(authSession.awaitingClient).toBe(1);
    const calls: string[] = [];
    authSession.attachClient(clientWith(calls));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["progress:one", "error:bad", "progress:two"]);
    authHost.authUI.showLoginProgress("live");
    expect(calls.at(-1)).toBe("progress:live");
  });
  it("output buffered after a replay starts a new wait", async () => {
    const { authHost, authSession } = makeAuthSession();
    authHost.authUI.showLoginProgress("one");
    const first: string[] = [];
    authSession.attachClient(clientWith(first));
    await Promise.resolve();
    await Promise.resolve();
    expect(first).toEqual(["progress:one"]);
    authSession.detachClient();
    authHost.authUI.showLoginProgress("two");
    expect(authSession.awaitingClient).toBe(1);
    const second: string[] = [];
    authSession.attachClient(clientWith(second));
    await Promise.resolve();
    await Promise.resolve();
    expect(second).toEqual(["progress:two"]);
  });
  it("drops buffered output when the next client has no authUI", async () => {
    const { authHost, authSession } = makeAuthSession();
    authHost.authUI.showLoginProgress("lost");
    const calls: string[] = [];
    authSession.attachClient(clientWith(calls, false));
    await Promise.resolve();
    await Promise.resolve();
    authSession.detachClient();
    authSession.attachClient(clientWith(calls));
    await Promise.resolve();
    expect(calls).toEqual([]);
  });
  it("issues OAuth and login output as serializable client effects", async () => {
    const { authHost, authSession } = makeAuthSession();
    const client = new FakeClient({ oauth: async () => ({ code: "c" }) });
    authSession.attachClient(client);
    await expect(authHost.authUI.showOAuthFlow("https://x")).resolves.toBe("c");
    authHost.authUI.showLoginProgress("p");
    authHost.authUI.showError("e");
    expect(client.requests).toEqual([{ type: "oauth", authUrl: "https://x" }]);
    expect(client.notifications).toEqual([
      { type: "loginProgress", chunk: "p" },
      { type: "authError", message: "e" },
    ]);
    const effects = [...client.requests, ...client.notifications];
    expect(JSON.parse(JSON.stringify(effects))).toEqual(effects);
  });
  it("builds a real provider without the test override", () => {
    const { authHost } = makeAuthSession();
    expect(
      authHost.getProvider({ ...profile, name: "smoke-real" }),
    ).toBeDefined();
  });
});
describe("active profile", () => {
  const profileA: ProviderProfile = { ...profile, name: "a" };
  const profileB: ProviderProfile = { ...profile, name: "b" };
  let currentOptions: ServerHostOptions;
  let profileSession: Session;
  let profileHost: ServerSessionHost;
  beforeEach(() => {
    currentOptions = {
      ...options,
      profiles: [profileA, profileB],
      activeProfile: "a",
    };
    const provider = createMockProvider(mockClient);
    profileHost = new ServerSessionHost({
      logger: noopLogger,
      cwd: dir as Cwd,
      homeDir: dir as HomeDir,
      sandbox: new MockSandboxManager(),
      getOptions: () => currentOptions,
      getClient: () => undefined,
      awaitClient: () => profileSession.awaitClient(),
      getProvider: () => provider,
    });
    profileSession = new Session(profileHost);
  });
  afterEach(async () => {
    await profileSession.dispose();
  });
  async function createRootProfile(): Promise<string> {
    const id = await profileSession.createRootThread();
    if (id === ABORTED) throw new Error("aborted");
    return profileHost.getPrepared(id).profile.name;
  }

  it("applies to threads created after it is set", async () => {
    const before = await createRootProfile();
    const changed = vi.fn();
    profileSession.on("settings-changed", changed);
    profileSession.setActiveProfile("b");
    expect(changed).toHaveBeenCalledTimes(1);
    const after = await createRootProfile();
    expect(before).toBe("a");
    expect(after).toBe("b");
  });

  it("applies to script threads without an explicit profile", async () => {
    profileSession.setActiveProfile("b");
    const id = await profileSession.spawnScriptThread({
      scriptInvocationId: "inv" as ScriptInvocationId,
      scriptName: "s",
      prompt: "hi",
      yieldSchema: { type: "object" },
    });
    if (id === ABORTED) throw new Error("aborted");
    expect(profileHost.getPrepared(id).profile.name).toBe("b");
  });
  it("falls back to the default while the name is missing from options", () => {
    profileSession.setActiveProfile("b");
    currentOptions = { ...currentOptions, profiles: [profileA] };
    expect(profileSession.getProfileSelection()).toMatchObject({
      type: "missing",
      name: "b",
      profile: { name: "a" },
    });
    currentOptions = { ...currentOptions, profiles: [profileA, profileB] };
    expect(profileSession.getProfileSelection()).toMatchObject({
      type: "selected",
      profile: { name: "b" },
    });
  });

  it("rejects unknown names without changing the selection", () => {
    profileSession.setActiveProfile("b");
    expect(() => profileSession.setActiveProfile("nope")).toThrow(/nope/);
    expect(profileSession.getActiveProfile().name).toBe("b");
  });
});
