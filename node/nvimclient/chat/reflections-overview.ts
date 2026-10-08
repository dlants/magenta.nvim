import type {
  ReflectionOriginAnchor,
  ThreadId,
  ThreadOrigin,
} from "@magenta/server";
import { isSelectionAnchor } from "@magenta/server";
import { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import * as TEA from "../tea/tea.ts";
import { d, pos, type VDOMNode, withBindings } from "../tea/view.ts";
import type { SessionView } from "./session-view.ts";

export type ReflectionEntry = {
  threadId: ThreadId;
  origin: Extract<ThreadOrigin, { type: "reflect" }>;
};
export type ReflectionTreeEntry = ReflectionEntry & { depth: number };

/** The thread at the top of `threadId`'s reflection chain. */
export function reflectionRoot(
  session: Pick<SessionView, "getOrigin">,
  threadId: ThreadId,
): ThreadId {
  let id = threadId;
  for (;;) {
    const origin = session.getOrigin(id);
    if (origin?.type !== "reflect") return id;
    id = origin.sourceThreadId;
  }
}

/** Every reflection below `rootId`, depth-first, each followed by its own
 * reflections. */
export function reflectionTree(
  session: Pick<SessionView, "listDerived">,
  rootId: ThreadId,
  depth = 0,
): ReflectionTreeEntry[] {
  return orderedReflections(session, rootId).flatMap((entry) => [
    { ...entry, depth },
    ...reflectionTree(session, entry.threadId, depth + 1),
  ]);
}

/** The source's reflections in anchor order (creation order breaks ties);
 * whole-thread reflections sort after selections in their message. */
export function orderedReflections(
  session: Pick<SessionView, "listDerived">,
  threadId: ThreadId,
): ReflectionEntry[] {
  return session
    .listDerived(threadId, "reflect")
    .map((entry, creationIdx) => ({ entry, creationIdx }))
    .sort(
      (a, b) =>
        a.entry.origin.anchor.messageIdx - b.entry.origin.anchor.messageIdx ||
        contentOrder(a.entry.origin.anchor) -
          contentOrder(b.entry.origin.anchor) ||
        a.creationIdx - b.creationIdx,
    )
    .map(({ entry }) => entry);
}

function contentOrder(anchor: ReflectionOriginAnchor): number {
  return isSelectionAnchor(anchor) ? anchor.contentIdx : Infinity;
}
const HEADER_LINES = 2;

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function renderReflectionsOverview({
  entries,
  label,
  onOpen,
  onDelete,
}: {
  entries: ReflectionTreeEntry[];
  label: (childId: ThreadId) => string;
  onOpen: (childId: ThreadId) => void;
  onDelete: (childId: ThreadId) => void;
}): VDOMNode {
  const header = d`# Reflections\n\n`;
  if (entries.length === 0) {
    return d`${header}No reflections yet. Press r in the thread to reflect on it, or visually select text first to reflect on a passage.\n`;
  }
  return d`${header}${entries.map(({ threadId, origin, depth }) =>
    withBindings(
      d`${"  ".repeat(depth)}> ${truncate(isSelectionAnchor(origin.anchor) ? origin.anchor.reflectionText : "(whole thread)", 60)} — ${truncate(label(threadId), 40)}\n`,
      {
        "<CR>": () => onOpen(threadId),
        dd: () => onDelete(threadId),
      },
    ),
  )}`;
}

/** The entry under a 1-indexed buffer line; entries render one per line. */
export function entryAtLine<T>(entries: T[], line: number): T | undefined {
  const idx = line - 1 - HEADER_LINES;
  return idx >= 0 ? entries[idx] : undefined;
}

/** A read-only overview of a whole reflection tree, keyed by its root: its
 * buffer and TEA app.
 * The sidebar shows the buffer in the right column's display window. */
export class ReflectionsOverview {
  /** The entry under the overview's cursor, drawn with `MagentaReflectActive`
   * in the source thread. Lives here so it can't outlive the overview. */
  activeReflectionId: ThreadId | undefined;

  private constructor(
    readonly threadId: ThreadId,
    private session: SessionView,
    readonly buffer: NvimBuffer,
    private app: TEA.App<undefined>,
    readonly mountedApp: TEA.MountedApp,
  ) {}

  static async open({
    nvim,
    threadId,
    session,
    label,
    onOpen,
    onDelete,
  }: {
    nvim: Nvim;
    threadId: ThreadId;
    session: SessionView;
    label: (childId: ThreadId) => string;
    onOpen: (childId: ThreadId) => void;
    onDelete: (childId: ThreadId) => void;
  }): Promise<ReflectionsOverview> {
    const buffer = await NvimBuffer.create(false, true, nvim);
    await buffer.setName(`[Magenta Reflections ${threadId.replace(/-/g, "")}]`);
    await buffer.setOption("bufhidden", "hide");
    await buffer.setOption("buftype", "nofile");
    await buffer.setOption("swapfile", false);
    await buffer.setDisplayKeymaps();
    await nvim.call("nvim_exec_lua", [
      `require("magenta.keymaps").set_reflections_buffer_keymaps(...)`,
      [buffer.id],
    ]);
    const app = TEA.createApp<undefined>({
      nvim,
      initialModel: undefined,
      View: () =>
        renderReflectionsOverview({
          entries: reflectionTree(session, threadId),
          label,
          onOpen,
          onDelete,
        }),
    });
    const mountedApp = await app.mount({
      nvim,
      buffer,
      startPos: pos(0 as Row0Indexed, 0),
      endPos: pos(-1 as Row0Indexed, -1),
    });
    return new ReflectionsOverview(threadId, session, buffer, app, mountedApp);
  }

  render(): void {
    this.mountedApp.render();
  }

  entryAt(line: number): ReflectionTreeEntry | undefined {
    return entryAtLine(reflectionTree(this.session, this.threadId), line);
  }

  async close(): Promise<void> {
    this.mountedApp.unmount();
    this.app.destroy();
    await this.buffer.delete({ force: true }).catch(() => {
      // Already deleted, e.g. by `:bd`.
    });
  }
}
