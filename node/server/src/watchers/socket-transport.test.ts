import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ResourceState, WatcherName } from "./protocol.ts";
import { SocketWatcherTransport } from "./socket-transport.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const state = (context: string): ResourceState => ({
  key: "k",
  status: "active",
  context,
  summary: "s",
});

it("subscribes, receives pushed states and reports close over a real socket", async () => {
  const dir = mkdtempSync("/tmp/mw-");
  dirs.push(dir);
  const socketPath = path.join(dir, "w.sock");
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const msg = JSON.parse(buffer.slice(0, nl)) as { id: number };
        buffer = buffer.slice(nl + 1);
        // Split across writes to exercise line framing.
        const line = JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: state("v1"),
        });
        socket.write(line.slice(0, 10));
        socket.write(`${line.slice(10)}\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  try {
    const connection = await new SocketWatcherTransport().connect({
      name: "w" as WatcherName,
      protocolVersion: 1,
      command: ["false"],
      triggers: [],
      dir,
      socketPath,
    });
    expect(await connection.subscribe("k")).toEqual(state("v1"));

    const pushed: ResourceState[] = [];
    connection.onState((s) => pushed.push(s));
    sockets[0]?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "state", params: state("v2") })}\n`,
    );
    await expect.poll(() => pushed).toEqual([state("v2")]);

    let closed = false;
    connection.onClose(() => {
      closed = true;
    });
    sockets[0]?.destroy();
    await expect.poll(() => closed).toBe(true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

it("fails to connect when nothing listens and the command cannot start one", async () => {
  const dir = mkdtempSync("/tmp/mw-");
  dirs.push(dir);
  await expect(
    new SocketWatcherTransport({ timeoutMs: 200 }).connect({
      name: "w" as WatcherName,
      protocolVersion: 1,
      command: ["true"],
      triggers: [],
      dir,
      socketPath: path.join(dir, "none.sock"),
    }),
  ).rejects.toThrow(/could not connect/);
});
