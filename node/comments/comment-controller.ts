import {
  type Comment,
  type CommentId,
  type CommentLocation,
  type CommentStore,
  type HomeDir,
  type NvimCwd,
  relativePath,
  type UnresolvedFilePath,
} from "@magenta/core";
import {
  type BufNr,
  MAGENTA_COMMENT_ANCHOR_NAMESPACE,
  MAGENTA_COMMENT_NAMESPACE,
  NvimBuffer,
} from "../nvim/buffer.ts";
import type { ExtmarkId } from "../nvim/extmarks.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { pos } from "../tea/view.ts";
import { type CommentExtent, renderComment } from "./comment-render.ts";

export type CommentAnchor =
  | { state: "anchored"; bufnr: BufNr; extmarkId: ExtmarkId }
  | { state: "stale"; bufnr: BufNr; lastRow: Row0Indexed };

/**
 * The neovim half of the comment feature: extmark anchors, rendering, and
 * keeping the store's `CommentLocation`s current. The store knows nothing
 * about this class.
 */
export class CommentController {
  private anchors: { [id: CommentId]: CommentAnchor } = {};
  /** Last resolved extent per comment, used for rendering and hit testing. */
  private extents: { [id: CommentId]: CommentExtent } = {};
  private visible = true;
  /** Set while a refresh is stamping, so the `setLocation` calls it makes
   * don't schedule a redundant refresh on top of themselves. */
  private applying = false;
  private onStoreChanged = () => {
    if (!this.applying) {
      void this.refreshAll();
    }
  };

  constructor(
    private nvim: Nvim,
    private cwd: NvimCwd,
    private homeDir: HomeDir,
    private store: CommentStore,
  ) {
    this.store.on("changed", this.onStoreChanged);
  }

  private buffer(bufnr: BufNr) {
    return new NvimBuffer(bufnr, this.nvim);
  }

  private commentIdsInBuffer(bufnr: BufNr): CommentId[] {
    return this.store
      .listOpenCommentIds()
      .filter((id) => this.anchors[id]?.bufnr === bufnr);
  }

  /** Buffers that lost a comment and still need their decoration cleared. */
  private orphanedBufnrs = new Set<BufNr>();

  private commentedBufnrs(): BufNr[] {
    const bufnrs = new Set<BufNr>(this.orphanedBufnrs);
    for (const id of this.store.listOpenCommentIds()) {
      const anchor = this.anchors[id];
      if (anchor) {
        bufnrs.add(anchor.bufnr);
      }
    }
    return [...bufnrs];
  }

  /** How the buffer is named to the agent. */
  private async bufferLabel(bufnr: BufNr): Promise<string> {
    const name = await this.buffer(bufnr).getName();
    if (!name) {
      return `[No Name] (buffer ${bufnr})`;
    }
    if (name.startsWith("/")) {
      return relativePath(this.cwd, name as UnresolvedFilePath, this.homeDir);
    }
    return name;
  }

  private async resolveLocation(
    bufnr: BufNr,
    extent: CommentExtent | undefined,
  ): Promise<CommentLocation> {
    const bufferLabel = await this.bufferLabel(bufnr);
    if (!extent) {
      return { bufferLabel, bufnr, state: "stale" };
    }
    const lines = await this.buffer(bufnr).getLines({
      start: extent.startRow,
      end: (extent.endRow + 1) as Row0Indexed,
    });
    return {
      bufferLabel,
      bufnr,
      lines: { start: extent.startRow + 1, end: extent.endRow + 1 },
      selection: lines.join("\n"),
      state: "anchored",
    };
  }

  /** Read the anchor extmark back, or undefined if it went invalid. */
  private async readExtent(id: CommentId): Promise<CommentExtent | undefined> {
    const anchor = this.anchors[id];
    if (!anchor || anchor.state === "stale") {
      return undefined;
    }
    const buffer = this.buffer(anchor.bufnr);
    if (!(await buffer.isValid())) {
      return undefined;
    }
    const mark = await buffer.getExtmarkById(
      anchor.extmarkId,
      MAGENTA_COMMENT_ANCHOR_NAMESPACE,
    );
    if (!mark || mark.options.invalid) {
      return undefined;
    }
    const startRow = mark.startPos.row as Row0Indexed;
    const endRow = Math.max(mark.endPos.row, startRow) as Row0Indexed;
    return { startRow, endRow };
  }

  /** The comment whose extent covers `row`, if any. At most one. A stale
   * comment covers nothing — its range is gone, so a new comment there is a
   * new comment, not a follow-up. */
  async at(bufnr: BufNr, row: Row0Indexed): Promise<CommentId | undefined> {
    for (const id of this.commentIdsInBuffer(bufnr)) {
      const extent = await this.readExtent(id);
      if (extent && row >= extent.startRow && row <= extent.endRow) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * Anchor a new comment over `rows`. When the range overlaps an existing
   * comment, the text becomes a follow-up message on it instead — there is at
   * most one comment per line.
   */
  async addComment({
    bufnr,
    rows,
    text,
  }: {
    bufnr: BufNr;
    rows: { start: Row0Indexed; end: Row0Indexed };
    text: string;
  }): Promise<CommentId> {
    for (let row = rows.start; row <= rows.end; row++) {
      const existing = await this.at(bufnr, row as Row0Indexed);
      if (existing) {
        this.store.addUserMessage(existing, text);
        await this.refreshAll();
        return existing;
      }
    }

    const buffer = this.buffer(bufnr);
    const lastLine = (
      await buffer.getLines({
        start: rows.end,
        end: (rows.end + 1) as Row0Indexed,
      })
    )[0];
    const extmarkId = await buffer.setExtmark({
      startPos: pos(rows.start, 0),
      endPos: pos(rows.end, lastLine ? lastLine.length : 0),
      options: {
        right_gravity: false,
        end_right_gravity: true,
        invalidate: true,
        undo_restore: false,
      },
      namespace: MAGENTA_COMMENT_ANCHOR_NAMESPACE,
    });

    const extent: CommentExtent = { startRow: rows.start, endRow: rows.end };
    const location = await this.resolveLocation(bufnr, extent);
    const id = this.store.addComment(location, text);
    this.anchors[id] = { state: "anchored", bufnr, extmarkId };
    this.extents[id] = extent;
    await this.refreshAll();
    return id;
  }

  async deleteComment(id: CommentId): Promise<void> {
    this.store.closeComment(id, "deleted");
    await this.dropAnchor(id);
    await this.refreshAll();
  }

  /** Close every comment anchored to a buffer that went away. */
  async closeBuffer(bufnr: BufNr): Promise<void> {
    for (const id of this.commentIdsInBuffer(bufnr)) {
      this.store.closeComment(id, "buffer-unloaded");
      await this.dropAnchor(id);
    }
  }

  private async dropAnchor(id: CommentId) {
    const anchor = this.anchors[id];
    if (anchor) {
      this.orphanedBufnrs.add(anchor.bufnr);
    }
    delete this.anchors[id];
    delete this.extents[id];
    if (anchor && anchor.state === "anchored") {
      const buffer = this.buffer(anchor.bufnr);
      if (await buffer.isValid()) {
        await buffer.deleteExtmark(
          anchor.extmarkId,
          MAGENTA_COMMENT_ANCHOR_NAMESPACE,
        );
      }
    }
  }

  /**
   * Re-read every anchor in this buffer, push the refreshed locations into the
   * store, then clear the render namespace and re-stamp from the store.
   */
  async refreshBuffer(bufnr: BufNr): Promise<void> {
    return this.enqueue(() => this.doRefreshBuffer(bufnr));
  }

  private async doRefreshBuffer(bufnr: BufNr): Promise<void> {
    const buffer = this.buffer(bufnr);
    if (!(await buffer.isValid())) {
      return;
    }
    await buffer.clearAllExtmarks(MAGENTA_COMMENT_NAMESPACE);

    const ids = this.commentIdsInBuffer(bufnr);
    const pending = new Set(this.store.pendingCommentIds());

    for (const id of ids) {
      const extent = await this.readExtent(id);
      let staleRow: Row0Indexed | undefined;
      if (!extent) {
        staleRow = this.extents[id]?.startRow ?? (0 as Row0Indexed);
        this.anchors[id] = { state: "stale", bufnr, lastRow: staleRow };
        this.store.setLocation(
          id,
          await this.resolveLocation(bufnr, undefined),
        );
      } else {
        this.extents[id] = extent;
        const location = await this.resolveLocation(bufnr, extent);
        if (!locationsEqual(this.store.comments[id]?.location, location)) {
          this.store.setLocation(id, location);
        }
      }

      const comment: Comment | undefined = this.store.comments[id];
      if (!comment || !this.visible) {
        continue;
      }
      const renderExtent: CommentExtent =
        extent ??
        ({
          startRow: staleRow ?? (0 as Row0Indexed),
          endRow: staleRow ?? (0 as Row0Indexed),
        } satisfies CommentExtent);
      await renderComment({
        buffer,
        comment,
        extent: renderExtent,
        pending: pending.has(id),
      });
    }
  }

  private refreshing: Promise<void> = Promise.resolve();
  /** Serialized so overlapping refreshes can't interleave stamps. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.refreshing = this.refreshing.then(async () => {
      this.applying = true;
      try {
        await fn();
      } finally {
        this.applying = false;
      }
    });
    return this.refreshing;
  }

  private refreshAll(): Promise<void> {
    return this.enqueue(async () => {
      const bufnrs = this.commentedBufnrs();
      this.orphanedBufnrs.clear();
      for (const bufnr of bufnrs) {
        await this.doRefreshBuffer(bufnr);
      }
    });
  }

  async show(): Promise<void> {
    this.visible = true;
    await this.refreshAll();
  }

  async hide(): Promise<void> {
    this.visible = false;
    for (const bufnr of this.commentedBufnrs()) {
      const buffer = this.buffer(bufnr);
      if (await buffer.isValid()) {
        await buffer.clearAllExtmarks(MAGENTA_COMMENT_NAMESPACE);
      }
    }
  }

  async destroy(): Promise<void> {
    this.store.off("changed", this.onStoreChanged);
    await this.hide();
    for (const id of Object.keys(this.anchors) as CommentId[]) {
      await this.dropAnchor(id);
    }
  }
}

function locationsEqual(
  a: CommentLocation | undefined,
  b: CommentLocation,
): boolean {
  return (
    a !== undefined &&
    a.bufferLabel === b.bufferLabel &&
    a.bufnr === b.bufnr &&
    a.state === b.state &&
    (a.state !== "anchored" ||
      b.state !== "anchored" ||
      (a.selection === b.selection &&
        a.lines.start === b.lines.start &&
        a.lines.end === b.lines.end))
  );
}
