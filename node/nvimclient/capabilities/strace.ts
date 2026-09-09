import { execFileSync } from "node:child_process";
import type { SandboxViolationEvent } from "@anthropic-ai/sandbox-runtime";

// strace-based Linux sandbox violation capture.
//
// On Linux (bubblewrap) there is no live violation-log channel like macOS
// seatbelt provides, so we run the user command under strace and synthesize
// structured violation events from syscalls that the sandbox denied
// (EPERM / EACCES). This replaces the old, brittle stderr-regex heuristic.

/** Shell-quote a string for safe embedding inside a `bash -c` command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Build a command that runs `command` under strace, writing the trace to
// `traceFilePath`. The caller is responsible for nesting this *inside* the
// bubblewrap wrap (i.e. pass the returned string to wrapWithSandbox), so that
// bwrap remains the outermost process and we only trace the user command — not
// bwrap's own namespace-setup syscalls (which legitimately return EPERM).
export function buildStraceCommand(
  command: string,
  traceFilePath: string,
): string {
  return [
    "strace",
    "-f",
    "-qq",
    "-e",
    "trace=file,network,process",
    "-e",
    "signal=none",
    "-o",
    shellQuote(traceFilePath),
    "--",
    "bash",
    "-c",
    shellQuote(command),
  ].join(" ");
}

const TRACE_LINE_RE =
  /^(?:\[pid\s+\d+\]\s+)?(\w+)\((.*)\)\s+=\s+-1\s+(EPERM|EACCES)\b/;
const FIRST_STRING_ARG_RE = /"((?:[^"\\]|\\.)*)"/;

// Parse raw strace output into violation events. Only syscalls whose result is
// EPERM/EACCES become events; everything else (successful syscalls, other
// errnos) is ignored. Events are de-duplicated by their rendered `line`.
export function parseStraceViolations(
  traceContent: string,
  command: string,
  timestamp: Date = new Date(),
): SandboxViolationEvent[] {
  const violations: SandboxViolationEvent[] = [];
  const seen = new Set<string>();

  for (const raw of traceContent.split("\n")) {
    const m = raw.match(TRACE_LINE_RE);
    if (!m) continue;
    const syscall = m[1];
    const args = m[2];
    const errno = m[3];
    const argMatch = args.match(FIRST_STRING_ARG_RE);
    const target = argMatch ? argMatch[1] : undefined;
    const line = target
      ? `${syscall}("${target}") -> ${errno}`
      : `${syscall}() -> ${errno}`;
    if (seen.has(line)) continue;
    seen.add(line);
    violations.push({ line, command, timestamp });
  }

  return violations;
}

// Raised when strace is unavailable on Linux. The sandbox refuses to start
// rather than silently degrading, since there is no regex fallback.
export class StraceUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `magenta requires 'strace' to run the Linux sandbox, but it is unavailable: ${detail}.\n` +
        `Install it (e.g. 'apt-get install strace' / 'dnf install strace') and ensure it can attach ` +
        `(kernel.yama.ptrace_scope must permit tracing). The sandbox cannot start without it.`,
    );
    this.name = "StraceUnavailableError";
  }
}

export type StraceProbeResult = { ok: true } | { ok: false; error: string };

export type StraceProbe = () => StraceProbeResult;

// Default probe: actually run strace on a trivial command so we verify it can
// attach (ptrace), not merely that the binary exists.
export const defaultStraceProbe: StraceProbe = () => {
  try {
    execFileSync("strace", ["-f", "-qq", "-e", "trace=none", "--", "true"], {
      stdio: "ignore",
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

// Startup capability check. On non-Linux platforms this is a no-op. On Linux,
// it throws StraceUnavailableError when strace is missing or cannot attach.
export function assertStraceAvailable(
  platform: NodeJS.Platform,
  probe: StraceProbe = defaultStraceProbe,
): void {
  if (platform !== "linux") return;
  const result = probe();
  if (!result.ok) {
    throw new StraceUnavailableError(result.error);
  }
}
