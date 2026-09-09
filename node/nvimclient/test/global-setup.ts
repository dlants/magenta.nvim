import { access } from "node:fs/promises";
import * as path from "node:path";
import { $, within } from "zx";

export async function setup() {
  // Get project root by going up from node/nvimclient/test/global-setup.ts to project root
  const projectRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../..",
  );
  const pluginDir = path.join(projectRoot, "test-plugins");
  const blinkDir = path.join(pluginDir, "blink.cmp");
  const blinkTag = "v1.10.2";
  const forceSetup = process.env.FORCE_SETUP === "true";

  // Force remove existing directories if FORCE_SETUP is set
  if (forceSetup) {
    try {
      await $`rm -rf ${blinkDir}`;
    } catch {
      // Ignore errors if directory doesn't exist
    }
  }

  try {
    await access(blinkDir);
  } catch {
    try {
      // Plugin doesn't exist, need to download it. We pin to a v1 tag so the
      // tests don't depend on blink.lib / a native fuzzy binary (the lua fuzzy
      // implementation is configured in minimal-init.lua).
      await $`mkdir -p ${pluginDir}`;
      await $`git clone --depth=1 --branch ${blinkTag} https://github.com/saghen/blink.cmp.git ${blinkDir}`;
    } catch (e) {
      console.error(`Uh-oh. blink.cmp setup failed`);
      console.error(e);
    }
  }

  // Set up git repo in fixtures directory
  const fixturesDir = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "fixtures",
  );

  // Force remove existing git repo if FORCE_SETUP is set
  if (forceSetup) {
    try {
      await $`rm -rf ${path.join(fixturesDir, ".git")}`;
    } catch {
      // Ignore errors if directory doesn't exist
    }
  }

  try {
    await access(path.join(fixturesDir, ".git"));
  } catch {
    try {
      await within(async () => {
        $.cwd = fixturesDir;
        await $`git init`;
      });
    } catch (e) {
      console.error(`Uh-oh. git is already initialized`);
      console.error(e);
    }
  }
}

export async function teardown() {
  // Any global cleanup can go here if needed
}
