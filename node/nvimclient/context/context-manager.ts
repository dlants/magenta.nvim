import {
  type FileUpdates,
  formatGitHead,
  type GitContextUpdate,
  type PullRequestContextUpdate,
  type PullRequestUpdate,
  type PullRequestViewState,
  type TrackedContextFile,
} from "@magenta/server";
import open from "open";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions } from "../options.ts";
import {
  d,
  type VDOMNode,
  withBindings,
  withExtmark,
  withInlineCode,
} from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  type AbsFilePath,
  displayPath,
  FileCategory,
  type HomeDir,
  type ProjectDir,
} from "../utils/files.ts";
import { formatTokens } from "../utils/tokens.ts";

export type {
  ContextFiles as Files,
  DiffUpdate,
  FileDeletedUpdate,
  FileUpdate,
  FileUpdates,
  Patch,
  ToolApplied as ToolApplication,
  WholeFileUpdate,
} from "@magenta/server";

export type ContextViewContext = {
  cwd: ProjectDir;
  homeDir: HomeDir;
  nvim: Nvim;
  options: MagentaOptions;
};

/** The thread's context files as the view sees them: tracked files, changes
 * not yet delivered, and the operation that removes a file. */
export type ContextFilesData = {
  files: ReadonlyArray<TrackedContextFile>;
  pending: FileUpdates;
  remove: (absFilePath: AbsFilePath) => void;
};

export function openFile(
  absFilePath: AbsFilePath,
  files: ReadonlyArray<TrackedContextFile>,
  context: ContextViewContext,
): void {
  const fileInfo = files.find((f) => f.absFilePath === absFilePath);

  if (fileInfo && fileInfo.fileTypeInfo.category !== FileCategory.TEXT) {
    open(absFilePath).catch((error: Error) => {
      context.nvim.logger.error(
        `Failed to open file with OS: ${error.message}`,
      );
    });
  } else {
    openFileInNonMagentaWindow(absFilePath, {
      nvim: context.nvim,
      cwd: context.cwd,
      homeDir: context.homeDir,
      options: context.options,
    }).catch((e: Error) => context.nvim.logger.error(e.message));
  }
}

function renderUpdateIndicator(
  update: FileUpdates[AbsFilePath]["update"],
): string {
  if (update.status !== "ok") {
    return `[ error: ${update.error} ]`;
  }
  switch (update.value.type) {
    case "diff": {
      const patch = update.value.patch;
      const additions = (patch.match(/^\+[^+]/gm) || []).length;
      const deletions = (patch.match(/^-[^-]/gm) || []).length;
      return `[ +${additions} / -${deletions} ]`;
    }
    case "whole-file": {
      const mediaBlock = update.value.content.find(
        (block) => block.type === "image" || block.type === "document",
      );
      if (mediaBlock) {
        return mediaBlock.type === "image" ? "[ image ]" : "[ document ]";
      }
      let charCount = 0;
      const lastTextBlock = update.value.content.findLast(
        (block) => block.type === "text",
      );
      if (lastTextBlock && lastTextBlock.type === "text") {
        if (lastTextBlock.text.startsWith("[File too large for full context")) {
          return "[ summary ]";
        }
        charCount = lastTextBlock.text.length;
      }
      return `[ +${formatTokens(charCount)} ]`;
    }
    case "file-deleted":
      return "[ deleted ]";
    default:
      assertUnreachable(update.value);
  }
}

export function contextFilesView(
  core: ContextFilesData,
  context: ContextViewContext,
  view: { expanded: boolean; onToggle: () => void },
) {
  const pending = core.pending;
  const allPaths = core.files.map((f) => f.absFilePath);
  if (allPaths.length === 0) {
    return "";
  }

  const pendingPaths = Object.keys(pending) as AbsFilePath[];
  const otherPaths = allPaths
    .filter((p) => !pending[p])
    .sort() as AbsFilePath[];

  const renderFileLine = (
    absFilePath: AbsFilePath,
    indicator: string,
  ): VDOMNode => {
    const pathForDisplay = displayPath(
      context.cwd,
      absFilePath,
      context.homeDir,
    );
    const fileInfo = core.files.find((f) => f.absFilePath === absFilePath);
    const summaryBadge =
      fileInfo?.agentView?.type === "summary" ? " (summary)" : "";
    return withBindings(
      d`- ${withInlineCode(d`\`${pathForDisplay}\``)}${summaryBadge}${indicator}\n`,
      {
        dd: () => core.remove(absFilePath),
        "<CR>": () => openFile(absFilePath, core.files, context),
      },
    );
  };

  const pendingLines = pendingPaths
    .sort()
    .map((p) =>
      renderFileLine(p, ` ${renderUpdateIndicator(pending[p].update)}`),
    );

  if (otherPaths.length === 0) {
    return d`${pendingLines}`;
  }

  const marker = view.expanded ? "▼" : "▶";
  const label =
    pendingPaths.length > 0
      ? `${otherPaths.length.toString()} other file${otherPaths.length === 1 ? "" : "s"} in context`
      : `${otherPaths.length.toString()} file${otherPaths.length === 1 ? "" : "s"} in context`;
  const toggleLine = withBindings(d`${marker} ${label}\n`, {
    "=": () => view.onToggle(),
  });

  if (!view.expanded) {
    return d`${pendingLines}${toggleLine}`;
  }

  const otherLines = otherPaths.map((p) => renderFileLine(p, ""));
  return d`${pendingLines}${toggleLine}${otherLines}`;
}

export function renderGitUpdate(
  gitUpdate: GitContextUpdate | undefined,
): VDOMNode {
  if (!gitUpdate) {
    return d``;
  }
  return d`${gitUpdate.repos.map((update) => {
    if (update.type === "gone") {
      return d`󰊢 git: ${update.repoRoot} is no longer a git repository\n`;
    }
    const { current } = update;
    const branch = current.branch ?? "(detached HEAD)";
    return d`󰊢 git: ${branch} @ ${formatGitHead(current)} (${update.repoRoot})\n`;
  })}`;
}

export function renderPullRequestUpdate(
  update: PullRequestContextUpdate | undefined,
): VDOMNode {
  if (!update) return d``;
  return d`${update.pullRequests.map((pr) => {
    if (pr.type === "tracked") {
      const { snapshot } = pr;
      return d` pr: ${snapshot.ref.url} tracked (${snapshot.state}, ${snapshot.checks.length.toString()} checks, ${snapshot.comments.length.toString()} comments)\n`;
    }
    return d` pr: ${pr.ref.url} ${describeUpdate(pr)}\n`;
  })}`;
}
function describeUpdate(update: PullRequestUpdate): string {
  if (update.type === "tracked") return "tracked";
  const parts: string[] = [];
  if (update.stateChange) parts.push(`now ${update.stateChange.to}`);
  if (update.headChange)
    parts.push(`new head ${update.headChange.to.slice(0, 7)}`);
  if (update.checks.length)
    parts.push(
      `${update.checks.length.toString()} check${update.checks.length === 1 ? "" : "s"}`,
    );
  if (update.comments.length)
    parts.push(
      `${update.comments.length.toString()} comment${update.comments.length === 1 ? "" : "s"}`,
    );
  return parts.join(", ");
}
const MAX_TITLE_LENGTH = 50;
function truncateTitle(title: string): string {
  return title.length > MAX_TITLE_LENGTH
    ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : title;
}
function formatAgo(ms: number, now: number): string {
  return `${Math.max(0, Math.round((now - ms) / 1000)).toString()}s ago`;
}
export function renderPullRequests(
  pullRequests: ReadonlyArray<PullRequestViewState>,
  now: number = Date.now(),
): VDOMNode {
  if (!pullRequests.length) return d``;
  return d`\n${withExtmark(d`# pull requests:`, { hl_group: "@markup.heading.1.markdown" })}\n${pullRequests.map(
    (pr) => {
      const { status } = pr;
      const snapshot = pr.loaded ? pr.snapshot : undefined;
      const pending = pr.loaded ? pr.pending : undefined;
      const failed =
        snapshot?.checks.filter((c) => c.status === "failure") ?? [];
      const counts = snapshot
        ? ` checks: ${snapshot.checks.filter((c) => c.status === "pending").length.toString()} pending, ${snapshot.checks.filter((c) => c.status === "success").length.toString()} passed, ${failed.length.toString()} failed`
        : "";
      const statusText =
        status.type === "ok"
          ? ` (polled ${formatAgo(status.lastPolledAt, now)})`
          : status.type === "loading"
            ? " (loading)"
            : status.type === "finished"
              ? " (no longer polling)"
              : "";
      const state = snapshot ? ` (${snapshot.state})` : "";
      const title = snapshot ? `${truncateTitle(snapshot.title)} ` : "";
      const failedLines = failed.map(
        (c) => d`  - failed: ${c.name}${c.url ? ` ${c.url}` : ""}\n`,
      );
      const pendingLine = pending
        ? d`  - [pending update: ${describeUpdate(pending)}]\n`
        : d``;
      const statusLine =
        status.type === "failing"
          ? d`  - poll failing (${status.consecutiveFailures.toString()}x): ${status.lastError}\n`
          : status.type === "unavailable"
            ? d`  - unavailable: ${status.message}\n`
            : d``;
      return d`-  ${title}${pr.url}${state}${counts}${statusText}\n${failedLines}${pendingLine}${statusLine}`;
    },
  )}`;
}
export function renderContextUpdate(
  contextUpdates: FileUpdates | undefined,
  files: ReadonlyArray<TrackedContextFile>,
  context: ContextViewContext,
  view: {
    expandedUpdates: { [absFilePath: string]: boolean };
    onToggle: (absFilePath: AbsFilePath) => void;
  },
) {
  if (!(contextUpdates && Object.keys(contextUpdates).length)) {
    return "";
  }

  const fileUpdates = [];
  for (const path in contextUpdates) {
    const absFilePath = path as AbsFilePath;
    const update = contextUpdates[absFilePath];
    const pathForDisplay = displayPath(
      context.cwd,
      absFilePath,
      context.homeDir,
    );

    if (update.update.status === "ok") {
      let changeIndicator = "";
      switch (update.update.value.type) {
        case "diff": {
          const patch = update.update.value.patch;
          const additions = (patch.match(/^\+[^+]/gm) || []).length;
          const deletions = (patch.match(/^-[^-]/gm) || []).length;
          changeIndicator = `[ +${additions} / -${deletions}, ${formatTokens(patch.length)} ]`;
          break;
        }
        case "whole-file": {
          let charCount = 0;
          let mediaKind: "image" | "document" | undefined;
          let isSummary = false;
          for (const block of update.update.value.content) {
            if (block.type === "text") {
              if (block.text.startsWith("[File too large for full context")) {
                isSummary = true;
              }
              charCount += block.text.length;
            } else if (block.type === "image" || block.type === "document") {
              mediaKind = block.type;
            }
          }
          changeIndicator = mediaKind
            ? `[ ${mediaKind} ]`
            : isSummary
              ? `[ summary, ${formatTokens(charCount)} ]`
              : `[ ${formatTokens(charCount)} ]`;
          break;
        }
        case "file-deleted": {
          changeIndicator = "[ deleted ]";
          break;
        }
        default:
          assertUnreachable(update.update.value);
      }

      const pdfInfo =
        update.update.value.type === "whole-file"
          ? formatPdfInfo({
              summary: update.update.value.pdfSummary,
              pages: update.update.value.pdfPage
                ? [update.update.value.pdfPage]
                : undefined,
            })
          : "";

      const expanded = view.expandedUpdates[absFilePath];
      let expandedBody: VDOMNode = d``;
      if (expanded) {
        const value = update.update.value;
        if (value.type === "diff") {
          expandedBody = d`${value.patch}\n`;
        } else if (value.type === "whole-file") {
          const hasMedia = value.content.some(
            (block) => block.type === "image" || block.type === "document",
          );
          if (hasMedia) {
            expandedBody = d`binary format\n`;
          } else {
            const text = value.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
            expandedBody = d`${text}\n`;
          }
        }
      }

      const fileLine = withBindings(
        d`- \`${pathForDisplay}\`${pdfInfo} ${changeIndicator}`,
        {
          "<CR>": () => openFile(absFilePath, files, context),
          "=": () => view.onToggle(absFilePath),
        },
      );

      fileUpdates.push(d`${fileLine}\n${expandedBody}`);
    } else {
      fileUpdates.push(
        d`- \`${pathForDisplay}\` [Error: ${update.update.error}]\n`,
      );
    }
  }

  return fileUpdates.length > 0 ? d`Context Updates:\n${fileUpdates}\n` : "";
}

function formatPageRanges(pages: number[]): string {
  if (pages.length === 0) return "";

  const ranges: string[] = [];
  let start = pages[0];
  let end = pages[0];

  for (let i = 1; i < pages.length; i++) {
    if (pages[i] === end + 1) {
      end = pages[i];
    } else {
      if (start === end) {
        ranges.push(start.toString());
      } else {
        ranges.push(`${start}-${end}`);
      }
      start = pages[i];
      end = pages[i];
    }
  }

  if (start === end) {
    ranges.push(start.toString());
  } else {
    ranges.push(`${start}-${end}`);
  }

  return ranges.join(", ");
}

function formatPdfInfo(options: {
  summary?: boolean | undefined;
  pages?: number[] | undefined;
}): string {
  const parts: string[] = [];

  if (options.summary) {
    parts.push("summary");
  }

  if (options.pages && options.pages.length === 1) {
    parts.push(`page ${options.pages[0]}`);
  } else if (options.pages && options.pages.length > 1) {
    const pageRanges = formatPageRanges(options.pages);
    parts.push(`pages ${pageRanges}`);
  }

  if (parts.length > 0) {
    return ` (${parts.join(", ")})`;
  }

  return "";
}
