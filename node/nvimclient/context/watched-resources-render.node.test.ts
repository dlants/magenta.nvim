import type { WatchedResourceView, WatcherName } from "@magenta/server";
import { describe, expect, it } from "vitest";
import { renderToString } from "../tea/view.ts";
import {
  renderWatchedResources,
  renderWatchUpdate,
} from "./context-manager.ts";

const watcher = "github" as WatcherName;

function render(resources: WatchedResourceView[], expanded = false): string {
  return renderToString(
    renderWatchedResources(resources, {
      isExpanded: () => expanded,
      onToggle: () => {},
      onUntrack: () => {},
    }),
  );
}

describe("renderWatchUpdate", () => {
  it("describes full and diff deliveries", () => {
    const text = renderToString(
      renderWatchUpdate({
        resources: [
          { watcher, key: "a", kind: "full", text: "x" },
          { watcher, key: "b", kind: "diff", text: "y" },
        ],
      }),
    );
    expect(text).toContain("github: a tracked");
    expect(text).toContain("github: b updated");
  });
});

describe("renderWatchedResources", () => {
  it("shows loading when there is no state yet", () => {
    const text = render([
      {
        watcher,
        key: "k",
        state: undefined,
        paused: false,
        pendingUpdate: false,
      },
    ]);
    expect(text).toContain("- \uf06e \uf110 github [loading]: k");
  });

  it("shows paused and the error line for failing/unavailable", () => {
    const text = render([
      {
        watcher,
        key: "f",
        state: {
          key: "f",
          status: "failing",
          context: "",
          summary: "s1",
          error: "boom",
        },
        paused: true,
        pendingUpdate: false,
      },
      {
        watcher,
        key: "u",
        state: {
          key: "u",
          status: "unavailable",
          context: "",
          summary: "",
          error: "gone",
        },
        paused: false,
        pendingUpdate: false,
      },
    ]);
    expect(text).toContain(" github [failing, paused]: f s1");
    expect(text).toContain("  boom");
    expect(text).toContain(" github [unavailable]: u");
    expect(text).toContain("  gone");
  });

  it("shows details only when expanded", () => {
    const resource: WatchedResourceView = {
      watcher,
      key: "k",
      state: {
        key: "k",
        status: "active",
        context: "c",
        summary: "sum",
        details: "d1\nd2",
      },
      paused: false,
      pendingUpdate: true,
    };
    const collapsed = render([resource]);
    expect(collapsed).toContain(" github [active, pending update]: k sum");
    expect(collapsed).not.toContain("d1");
    const expanded = render([resource], true);
    expect(expanded).toContain("  d1\n  d2\n");
  });
});
