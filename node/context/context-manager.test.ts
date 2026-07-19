import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ProviderMessage,
  ProviderMessageContent,
  ThreadId,
  ToolName,
  ToolRequestId,
} from "@magenta/core";
import {
  type HomeDir,
  pollUntil,
  resolveFilePath,
  type UnresolvedFilePath,
} from "@magenta/core";
import { describe, expect, it } from "vitest";
import { getAllWindows, getcwd } from "../nvim/nvim.ts";
import { withDriver } from "../test/preamble.ts";
import { sanitizeMessagesForSnapshot } from "../test/sanitize-snapshot.ts";
import type { DiffUpdate } from "./context-manager.ts";

it("returns diff when file is edited on disk", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager = driver.magenta.chat.getActiveThread().contextManager;

    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "poem.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    // Add file to context using the helper method
    await driver.addContextFiles("poem.txt");

    // Open the file to track the buffer
    await driver.editFile("poem.txt");
    await contextManager.getContextUpdate();

    // Edit the file on disk (disk-first approach means agent reads from disk)
    const filePath = `${cwd}/poem.txt`;
    const original = fs.readFileSync(filePath, "utf-8");
    const edited = original.replace(
      /^.*$/m,
      "Edited moonlight dances through the trees,",
    );
    fs.writeFileSync(filePath, edited);

    // Get context updates after the edit
    const updates = await contextManager.getContextUpdate();
    const update = updates[absFilePath];
    // Check that it's a diff update
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status === "ok") {
      expect(update.update.value.type).toBe("diff");
      expect(update.absFilePath).toBe(absFilePath);
      // Check that the diff contains the change
      expect((update.update.value as DiffUpdate).patch).toContain(
        "Edited moonlight",
      );
    }
  });
});

it("returns diff when disk changes even if buffer has unsaved changes", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    const contextManager = driver.magenta.chat.getActiveThread().contextManager;

    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "poem.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    await driver.addContextFiles("poem.txt");
    await driver.editFile("poem.txt");

    // Initial read to establish agentView
    await contextManager.getContextUpdate();

    // Modify the file on disk directly (agent reads from disk)
    const filePath = `${cwd}/poem.txt`;
    fs.writeFileSync(filePath, "Disk edit\n");

    // Context update should return a diff (disk-first reads from disk)
    const updates = await contextManager.getContextUpdate();
    const update = updates[absFilePath];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status === "ok") {
      expect(update.update.value.type).toBe("diff");
    }
  });
});

describe("key bindings", () => {
  it("'dd' key correctly removes the middle file when three files are in context", async () => {
    await withDriver({}, async (driver) => {
      // Open context sidebar
      await driver.showSidebar();

      await driver.addContextFiles("poem 3.txt", "poem2.txt", "poem.txt");

      // Press dd on the middle file to remove it
      await driver.triggerDisplayBufferKeyOnContent(`- \`poem2.txt\``, "dd");

      // Wait for the file to be removed from context
      await pollUntil(async () => {
        const content = await driver.getDisplayBufferText();
        if (content.includes(`- \`poem2.txt\``)) {
          throw new Error("Context file not yet removed");
        }
        if (
          !content.includes(`- \`poem 3.txt\``) ||
          !content.includes(`- \`poem.txt\``)
        ) {
          throw new Error("Other context files should still be present");
        }
      });
    });
  });

  it("'Enter' key opens file in existing non-magenta window", async () => {
    await withDriver({}, async (driver) => {
      const normalWindow = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return name === "";
      });

      // Open context sidebar
      await driver.showSidebar();

      // Add file to context using the helper method
      await driver.addContextFiles("poem.txt");

      await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "<CR>");

      await driver.assertWindowCount(
        3,
        "3 windows - display, input and non-magenta window with the buffer open",
      );

      // Verify file is opened in the non-magenta window
      await pollUntil(async () => {
        const winBuffer = await normalWindow.buffer();
        const bufferName = await winBuffer.getName();
        if (!bufferName.includes("poem.txt")) {
          throw new Error(
            `Expected buffer name to contain poem.txt, got ${bufferName}`,
          );
        }
      });
    });
  });

  it("'Enter' key opens file with multiple non-magenta windows", async () => {
    await withDriver({}, async (driver) => {
      await driver.nvim.call("nvim_command", ["new second_window"]);

      await driver.showSidebar();

      // Add file to context using the helper method
      await driver.addContextFiles("poem.txt");

      await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "<CR>");
      await driver.assertWindowCount(4);

      const poemWindow = await driver.findWindow(async (w) => {
        const buffer = await w.buffer();
        const name = await buffer.getName();
        return name.indexOf("poem.txt") > -1;
      });

      const isMagenta = await poemWindow.getVar("magenta");
      expect(isMagenta, "we opened in a non-magenta window").toBeFalsy();
    });
  });

  it("'Enter' key opens file when sidebar is on the left", async () => {
    await withDriver(
      { options: { sidebarPosition: "left" } },
      async (driver) => {
        const initialWindow = (await getAllWindows(driver.nvim))[0];
        await driver.showSidebar();
        await driver.nvim.call("nvim_win_close", [initialWindow.id, true]);
        expect(
          (await getAllWindows(driver.nvim)).length,
          "now only magenta windows open",
        ).toBe(2);

        await driver.addContextFiles("poem.txt");

        const displayWindow = driver.getVisibleState().displayWindow;

        // Get position of the file line to click on
        await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "<CR>");

        await driver.assertWindowCount(3, "Enter should open a new window");

        const fileWindow = await driver.findWindow(async (w) => {
          const buf = await w.buffer();
          const name = await buf.getName();
          return name.includes("poem.txt");
        });
        expect(fileWindow).toBeDefined();

        // Verify window position is on the right (col index 1 is higher for windows on the right)
        const fileWinPos = await fileWindow.getPosition();
        const displayWinPos = await displayWindow.getPosition();
        expect(fileWinPos[1]).toBeGreaterThan(displayWinPos[1]);
      },
    );
  });

  it("'Enter' key opens file when sidebar is on the right", async () => {
    await withDriver(
      { options: { sidebarPosition: "right" } },
      async (driver) => {
        const initialWindow = (await getAllWindows(driver.nvim))[0];
        await driver.showSidebar();
        await driver.nvim.call("nvim_win_close", [initialWindow.id, true]);
        expect(
          (await getAllWindows(driver.nvim)).length,
          "now only magenta windows open",
        ).toBe(2);

        await driver.addContextFiles("poem.txt");

        const displayWindow = driver.getVisibleState().displayWindow;

        // Get position of the file line to click on
        await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "<CR>");

        await driver.assertWindowCount(3, "Enter should open a new window");

        const fileWindow = await driver.findWindow(async (w) => {
          const buf = await w.buffer();
          const name = await buf.getName();
          return name.includes("poem.txt");
        });
        expect(fileWindow).toBeDefined();

        // Verify window position is on the left (col index 1 is lower for windows on the left)
        const fileWinPos = await fileWindow.getPosition();
        const displayWinPos = await displayWindow.getPosition();
        expect(fileWinPos[1]).toBeLessThan(displayWinPos[1]);
      },
    );
  });
});

it("context-files end-to-end", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.addContextFiles("poem.txt");

    await driver.assertDisplayBufferContains(`- \`poem.txt\``);

    await driver.inputMagentaText("check out this file");
    await driver.send();
    const request = await driver.mockAnthropic.awaitPendingUserRequest();
    expect(sanitizeMessagesForSnapshot(request.messages)).toMatchSnapshot();
  });
});

it("handles file deletion during buffer tracking", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager = driver.magenta.chat.getActiveThread().contextManager;

    const cwd = await getcwd(driver.nvim);
    const tempFilePath = resolveFilePath(
      cwd,
      "temp-tracked.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    // Create a temporary file
    await fs.promises.writeFile(tempFilePath, "tracked content");

    // Add file to context using the helper method
    await driver.addContextFiles("temp-tracked.txt");

    // Open the file in a buffer to start tracking it
    await driver.editFile("temp-tracked.txt");

    // Get initial context update to establish buffer tracking
    const firstUpdates = await contextManager.getContextUpdate();
    expect(firstUpdates[tempFilePath]).toBeDefined();

    // Delete the file while it's being tracked
    await fs.promises.unlink(tempFilePath);

    // Get context updates after deletion
    const secondUpdates = await contextManager.getContextUpdate();

    // File should be removed from context and file-deleted update should be returned
    expect(contextManager.files[tempFilePath]).toBeUndefined();
    expect(secondUpdates[tempFilePath]).toBeDefined();
    expect(secondUpdates[tempFilePath].update.status).toBe("ok");
    if (secondUpdates[tempFilePath].update.status === "ok") {
      expect(secondUpdates[tempFilePath].update.value.type).toBe(
        "file-deleted",
      );
    }
  });
});

it("issuing a getFile request adds the file to the context but doesn't send its contents twice", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager = driver.magenta.chat.getActiveThread().contextManager;

    // Verify context is empty initially
    expect(contextManager.files).toEqual({});

    // Issue a getFile request for a binary file
    await driver.inputMagentaText(`Please analyze the image test.jpg`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "I'll analyze the image",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "img_request" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: {
              files: [{ filePath: "test.jpg" as UnresolvedFilePath }],
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("`test.jpg` (~50 tok)");

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    const providerMessages = toolResultRequest.getProviderMessages();

    const flattenedMessages = providerMessages.flatMap((msg) =>
      msg.content.map(
        (content) =>
          `${msg.role};${content.type};${content.type === "text" ? content.text : ""}`,
      ),
    );

    expect(flattenedMessages).toEqual([
      "user;text;Please analyze the image test.jpg",
      "user;system_reminder;",
      "user;system_info;",
      "assistant;text;I'll analyze the image",
      "assistant;tool_use;",
      "user;tool_result;",
      "user;system_reminder;",
    ]);

    // Verify the tool result contains the file content exactly once
    // Now the file should be in context
    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "test.jpg" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );
    expect(contextManager.files[absFilePath]).toBeDefined();
    expect(contextManager.files[absFilePath].fileTypeInfo.category).toBe(
      "image",
    );
  });
});

it("image in context is sent as an image block on first message", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.addContextFiles("test.jpg");

    await driver.assertDisplayBufferContains(`- \`test.jpg\``);

    await driver.inputMagentaText("describe this image");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();

    let userMessageContent: ProviderMessageContent[] | undefined;
    for (const msg of request.messages) {
      if (
        msg.role === "user" &&
        Array.isArray(msg.content) &&
        (msg.content as ProviderMessageContent[]).some(
          (c) => c.type === "image",
        )
      ) {
        userMessageContent = msg.content as ProviderMessageContent[];
        break;
      }
    }

    expect(userMessageContent).toBeDefined();

    const textBlock = userMessageContent!.find(
      (c) => c.type === "text" && c.text.includes("<context_update>"),
    ) as Extract<ProviderMessageContent, { type: "text" }>;
    expect(textBlock).toBeDefined();
    expect(textBlock.text).toContain("test.jpg (image attachment)");
    expect(textBlock.text).not.toContain("(0 lines)");

    const imageBlock = userMessageContent!.find(
      (c) => c.type === "image",
    ) as Extract<ProviderMessageContent, { type: "image" }>;
    expect(imageBlock).toBeDefined();
    expect(imageBlock.source.media_type).toBe("image/jpeg");
    expect(imageBlock.source.data.length).toBeGreaterThan(0);
  });
});

it("autoContext loads on startup and after new-thread", async () => {
  const testOptions = {
    autoContext: [`test-auto-context.md`],
  };

  await withDriver({ options: testOptions }, async (driver) => {
    // Show sidebar and verify autoContext is loaded
    await driver.showSidebar();
    await driver.assertDisplayBufferContains(`- \`test-auto-context.md\``);

    // Create new thread and verify autoContext is loaded
    await driver.magenta.command("new-thread");
    await driver.assertDisplayBufferContains(`- \`test-auto-context.md\``);

    // Check that the content is included in messages when sending
    await driver.inputMagentaText("hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    expect(request.messages).toContainEqual(
      expect.objectContaining<ProviderMessage>({
        role: "user",

        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("test-auto-context.md"),
          }),
        ]) as ProviderMessageContent[],
      }),
    );
  });
});

it("autoContext loads home context.md before project context.md", async () => {
  const testOptions = {
    autoContext: ["~/.magenta/context.md", "test-auto-context.md"],
  };

  await withDriver(
    {
      options: testOptions,
      setupHome: async (homeDir) => {
        const fsPromises = await import("node:fs/promises");
        const pathMod = await import("node:path");
        const magentaDir = pathMod.join(homeDir, ".magenta");
        await fsPromises.mkdir(magentaDir, { recursive: true });
        await fsPromises.writeFile(
          pathMod.join(magentaDir, "context.md"),
          "HOME_CONTEXT_CONTENT",
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.assertDisplayBufferContains(`- \`test-auto-context.md\``);

      await driver.inputMagentaText("hello");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();

      let contextText: string | undefined;
      for (const msg of request.messages) {
        if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
        for (const c of msg.content) {
          if (
            c.type === "text" &&
            c.text.includes("HOME_CONTEXT_CONTENT") &&
            c.text.includes("test-auto-context.md")
          ) {
            contextText = c.text;
          }
        }
      }

      expect(contextText).toBeDefined();
      const homeIdx = contextText!.indexOf("HOME_CONTEXT_CONTENT");
      const projectIdx = contextText!.indexOf(
        "This is test auto-context content",
      );
      expect(homeIdx).toBeGreaterThan(-1);
      expect(projectIdx).toBeGreaterThan(-1);
      expect(homeIdx).toBeLessThan(projectIdx);
    },
  );
});

it("large context files are summarized and rendered with a (summary) badge", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const path = await import("node:path");
        const fsPromises = await import("node:fs/promises");
        const lines: string[] = [];
        for (let i = 0; i < 4000; i++) {
          lines.push(`line ${i}: ${"x".repeat(40)}`);
        }
        await fsPromises.writeFile(
          path.join(tmpDir, "huge.txt"),
          lines.join("\n"),
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.addContextFiles("huge.txt");

      await driver.assertDisplayBufferContains("- `huge.txt` [ summary ]");

      await driver.inputMagentaText("describe this file");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();

      request.respond({
        stopReason: "end_turn",
        text: "ok",
        toolRequests: [],
      });

      const contextManager =
        driver.magenta.chat.getActiveThread().contextManager;
      const cwd = await getcwd(driver.nvim);
      const absHuge = resolveFilePath(
        cwd,
        "huge.txt" as UnresolvedFilePath,
        os.homedir() as HomeDir,
      );
      await pollUntil(() => {
        if (contextManager.files[absHuge]?.agentView?.type !== "summary") {
          throw new Error("agentView not yet set to summary");
        }
      });

      await driver.triggerDisplayBufferKeyOnContent("1 file in context", "=");

      await driver.assertDisplayBufferContains("- `huge.txt` (summary)");

      let userMessageContent: ProviderMessageContent[] | undefined;
      for (const msg of request.messages) {
        if (
          msg.role === "user" &&
          Array.isArray(msg.content) &&
          (msg.content as ProviderMessageContent[]).some(
            (c) => c.type === "text" && c.text.includes("<context_update>"),
          )
        ) {
          userMessageContent = msg.content as ProviderMessageContent[];
          break;
        }
      }

      expect(userMessageContent).toBeDefined();
      const textBlock = userMessageContent!.find(
        (c) => c.type === "text" && c.text.includes("<context_update>"),
      ) as Extract<ProviderMessageContent, { type: "text" }>;
      expect(textBlock.text).toContain("[File too large for full context");
      expect(textBlock.text).toContain("[File summary:");
    },
  );
});

it("out-of-process file change surfaces in the pending-context view", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const contextManager = driver.magenta.chat.getActiveThread().contextManager;

    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "poem.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    await driver.addContextFiles("poem.txt");
    await contextManager.getContextUpdate();

    await fs.promises.writeFile(
      absFilePath,
      "completely different content\nwith several new lines\nadded here\n",
    );

    await pollUntil(
      async () => {
        const content = await driver.getDisplayBufferText();
        if (!content.match(/- `poem\.txt` \[ \+\d+ \/ -\d+ \]/)) {
          throw new Error("pending diff entry for poem.txt not yet shown");
        }
      },
      { timeout: 5000 },
    );
  });
});

async function setupHierarchy(tmpDir: string): Promise<void> {
  await fs.promises.mkdir(path.join(tmpDir, "nested", "dir"), {
    recursive: true,
  });
  await fs.promises.writeFile(
    path.join(tmpDir, "nested", "dir", "file.txt"),
    "leaf content",
  );
  await fs.promises.writeFile(
    path.join(tmpDir, "nested", "context.md"),
    "nested context",
  );
}

describe("hierarchy context discovery", () => {
  it("user's @file: adds parent context.md", async () => {
    await withDriver(
      {
        setupFiles: setupHierarchy,
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText("@file:nested/dir/file.txt");
        await driver.send();

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "end_turn",
          text: "ok",
          toolRequests: [],
        });

        const contextManager =
          driver.magenta.chat.getActiveThread().contextManager;
        await pollUntil(() => {
          const paths = Object.values(contextManager.files).map(
            (f) => f.relFilePath as string,
          );
          if (!paths.includes("nested/dir/file.txt")) {
            throw new Error(
              `nested/dir/file.txt not yet tracked, got: ${paths.join(",")}`,
            );
          }
          if (!paths.includes("nested/context.md")) {
            throw new Error(
              `nested/context.md not yet tracked, got: ${paths.join(",")}`,
            );
          }
        });
      },
    );
  });

  it("agent's get_file adds parent context.md", async () => {
    await withDriver(
      {
        setupFiles: setupHierarchy,
      },
      async (driver) => {
        await driver.showSidebar();
        const contextManager =
          driver.magenta.chat.getActiveThread().contextManager;

        await driver.inputMagentaText("Please read the leaf file");
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        request.respond({
          stopReason: "tool_use",
          text: "Reading file",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "get_leaf" as ToolRequestId,
                toolName: "get_files" as ToolName,
                input: {
                  files: [
                    { filePath: "nested/dir/file.txt" as UnresolvedFilePath },
                  ],
                },
              },
            },
          ],
        });

        await pollUntil(() => {
          const paths = Object.values(contextManager.files).map(
            (f) => f.relFilePath as string,
          );
          if (!paths.includes("nested/dir/file.txt")) {
            throw new Error("leaf file not yet tracked");
          }
          if (!paths.includes("nested/context.md")) {
            throw new Error("nested/context.md not yet discovered");
          }
        });
      },
    );
  });

  it("subagent spawn triggers discovery for contextFiles", async () => {
    await withDriver(
      {
        setupFiles: setupHierarchy,
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText("Use spawn_subagents");
        await driver.send();

        const stream1 = await driver.mockAnthropic.awaitPendingStream();
        stream1.respond({
          stopReason: "tool_use",
          text: "Spawning",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "spawn_test" as ToolRequestId,
                toolName: "spawn_subagents" as ToolName,
                input: {
                  agents: [
                    {
                      prompt: "Subagent task with leaf",
                      contextFiles: [
                        "nested/dir/file.txt" as UnresolvedFilePath,
                      ],
                    },
                  ],
                },
              },
            },
          ],
        });

        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Subagent task with leaf",
        );

        const chat = driver.magenta.chat;
        const childThreadId = Object.keys(chat.threadWrappers).find(
          (id) =>
            chat.threadWrappers[id as ThreadId].parentThreadId !== undefined,
        ) as ThreadId | undefined;
        expect(childThreadId).toBeDefined();
        const childWrapper = chat.threadWrappers[childThreadId!];
        if (childWrapper.state !== "initialized") {
          throw new Error("expected subagent thread to be initialized");
        }

        const subContextManager = childWrapper.thread.contextManager;
        await pollUntil(() => {
          const paths = Object.values(subContextManager.files).map(
            (f) => f.relFilePath as string,
          );
          if (!paths.includes("nested/dir/file.txt")) {
            throw new Error("subagent does not have leaf file yet");
          }
          if (!paths.includes("nested/context.md")) {
            throw new Error("subagent did not discover nested/context.md");
          }
        });
      },
    );
  });

  it("initialFiles (autoContext) triggers discovery", async () => {
    await withDriver(
      {
        options: { autoContext: ["nested/dir/file.txt"] },
        setupFiles: setupHierarchy,
      },
      async (driver) => {
        await driver.showSidebar();
        const contextManager =
          driver.magenta.chat.getActiveThread().contextManager;
        await pollUntil(() => {
          const paths = Object.values(contextManager.files).map(
            (f) => f.relFilePath as string,
          );
          if (!paths.includes("nested/dir/file.txt")) {
            throw new Error("leaf file not loaded");
          }
          if (!paths.includes("nested/context.md")) {
            throw new Error("nested/context.md not discovered");
          }
        });
      },
    );
  });

  it("cloned thread inherits parent's discovered context files", async () => {
    await withDriver(
      {
        setupFiles: setupHierarchy,
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.addContextFiles("nested/dir/file.txt");

        const parentThread = driver.magenta.chat.getActiveThread();
        await pollUntil(() => {
          const paths = Object.values(parentThread.contextManager.files).map(
            (f) => f.relFilePath as string,
          );
          if (!paths.includes("nested/context.md")) {
            throw new Error("parent did not discover nested/context.md");
          }
        });

        const forkedThreadId = await driver.magenta.chat.handleForkThread({
          sourceThreadId: parentThread.id,
        });

        const forkedWrapper =
          driver.magenta.chat.threadWrappers[forkedThreadId];
        if (forkedWrapper.state !== "initialized") {
          throw new Error("forked thread should be initialized");
        }

        const forkedFiles = Object.values(
          forkedWrapper.thread.contextManager.files,
        ).map((f) => f.relFilePath as string);
        expect(forkedFiles).toContain("nested/dir/file.txt");
        expect(forkedFiles).toContain("nested/context.md");
      },
    );
  });

  it("discovery cascade is idempotent - no duplicate fileAdded events", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.promises.mkdir(path.join(tmpDir, "a", "b", "c"), {
            recursive: true,
          });
          await fs.promises.writeFile(
            path.join(tmpDir, "a", "b", "c", "leaf.txt"),
            "leaf",
          );
          await fs.promises.writeFile(
            path.join(tmpDir, "a", "b", "context.md"),
            "B context",
          );
          await fs.promises.writeFile(
            path.join(tmpDir, "a", "context.md"),
            "A context",
          );
        },
      },
      async (driver) => {
        await driver.showSidebar();
        const contextManager =
          driver.magenta.chat.getActiveThread().contextManager;

        const addedEvents: string[] = [];
        contextManager.on("fileAdded", (absFilePath) => {
          addedEvents.push(absFilePath);
        });

        await driver.addContextFiles("a/b/c/leaf.txt");

        await pollUntil(() => {
          const paths = Object.values(contextManager.files).map(
            (f) => f.relFilePath as string,
          );
          if (
            !paths.includes("a/b/c/leaf.txt") ||
            !paths.includes("a/b/context.md") ||
            !paths.includes("a/context.md")
          ) {
            throw new Error("not all files discovered yet");
          }
        });

        const uniqueAdded = new Set(addedEvents);
        expect(uniqueAdded.size).toBe(addedEvents.length);
      },
    );
  });

  it("hierarchyContextFileNames: [] disables discovery", async () => {
    await withDriver(
      {
        options: { hierarchyContextFileNames: [] },
        setupFiles: setupHierarchy,
      },
      async (driver) => {
        await driver.showSidebar();
        await driver.addContextFiles("nested/dir/file.txt");

        const contextManager =
          driver.magenta.chat.getActiveThread().contextManager;
        const paths = Object.values(contextManager.files).map(
          (f) => f.relFilePath,
        );
        expect(paths).toContain("nested/dir/file.txt");
        expect(paths).not.toContain("nested/context.md");
      },
    );
  });
});
