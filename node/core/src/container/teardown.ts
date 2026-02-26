import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execFile = promisify(execFileCb);

export async function teardownContainer({
  containerName,
  repoPath,
  branch,
  tempDir,
  volumeOverlays,
  force = false,
}: {
  containerName: string;
  repoPath: string;
  branch: string;
  tempDir: string;
  volumeOverlays?: string[] | undefined;
  force?: boolean;
}): Promise<void> {
  // Stop and remove the container
  await execFile("docker", ["rm", "-f", containerName]).catch(() => {});

  // Fetch only the named branch from the temp clone back into the host repo
  const cloneDir = path.join(tempDir, "repo");

  if (fs.existsSync(cloneDir)) {
    if (!force) {
      // Check if branch exists and has diverged in the host repo
      const hostHasRef = await execFile("git", [
        "-C",
        repoPath,
        "rev-parse",
        "--verify",
        branch,
      ]).then(
        () => true,
        () => false,
      );

      if (hostHasRef) {
        // Check if they've diverged: the host branch should be an ancestor of the clone branch
        const cloneRef = await execFile("git", [
          "-C",
          cloneDir,
          "rev-parse",
          branch,
        ]).then((r) => r.stdout.trim());

        const hostRef = await execFile("git", [
          "-C",
          repoPath,
          "rev-parse",
          branch,
        ]).then((r) => r.stdout.trim());

        if (cloneRef !== hostRef) {
          const isAncestor = await execFile("git", [
            "-C",
            repoPath,
            "merge-base",
            "--is-ancestor",
            hostRef,
            cloneRef,
          ]).then(
            () => true,
            () => false,
          );

          if (!isAncestor) {
            throw new Error(
              `Branch "${branch}" has diverged in the host repo. Use force=true to overwrite.`,
            );
          }
        }
      }
    }

    // Fetch the branch. Use + prefix with force to allow non-fast-forward updates.
    const refspec = force ? `+${branch}:${branch}` : `${branch}:${branch}`;
    await execFile("git", ["-C", repoPath, "fetch", cloneDir, refspec]);
  }

  // Clean up volume overlays
  if (volumeOverlays) {
    for (const overlay of volumeOverlays) {
      const volumeName = `${containerName}-${overlay.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      await execFile("docker", ["volume", "rm", volumeName]).catch(() => {});
    }
  }

  // Remove temp directory
  await fs.promises.rm(tempDir, { recursive: true, force: true });
}
