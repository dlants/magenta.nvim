import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type ClipboardProbeResult =
  | { kind: "image"; tmpPath: string }
  | { kind: "none" };

export interface ClipboardImageLogger {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Probe the OS clipboard for an image. If present, save it to a tmp file and
 * return the path. Currently only macOS is supported; Linux/Windows return
 * `{ kind: "none" }`.
 */
export async function probeAndSaveClipboardImage(
  logger: ClipboardImageLogger,
): Promise<ClipboardProbeResult> {
  switch (process.platform) {
    case "darwin":
      return probeMac(logger);
    default:
      logger.warn(
        `Clipboard image paste not yet supported on platform ${process.platform}`,
      );
      return { kind: "none" };
  }
}

async function probeMac(
  logger: ClipboardImageLogger,
): Promise<ClipboardProbeResult> {
  try {
    const { stdout } = await execAsync("osascript -e 'clipboard info'");
    if (!stdout.includes("«class PNGf»")) {
      return { kind: "none" };
    }
  } catch (err) {
    logger.warn(
      `clipboard info probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "none" };
  }

  const tmpPath = path.join(os.tmpdir(), `magenta-paste-${Date.now()}.png`);

  // AppleScript to write clipboard PNG data to a file.
  const script = `set f to open for access POSIX file "${tmpPath}" with write permission
try
  write (the clipboard as «class PNGf») to f
  close access f
on error errMsg
  close access f
  error errMsg
end try`;

  try {
    await execAsync(
      `osascript ${script
        .split("\n")
        .map((line) => `-e ${JSON.stringify(line)}`)
        .join(" ")}`,
    );
  } catch (err) {
    logger.error(
      `failed to save clipboard image: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "none" };
  }

  try {
    const stat = await fs.stat(tmpPath);
    if (!stat.isFile() || stat.size === 0) {
      return { kind: "none" };
    }
  } catch {
    return { kind: "none" };
  }

  return { kind: "image", tmpPath };
}
