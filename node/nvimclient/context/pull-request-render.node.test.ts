import type {
  PullRequestSnapshot,
  PullRequestUpdate,
  PullRequestViewState,
} from "@magenta/server";
import { describe, expect, it } from "vitest";
import { renderToString } from "../tea/view.ts";
import {
  renderPullRequests,
  renderPullRequestUpdate,
} from "./context-manager.ts";

const URL = "https://github.com/o/r/pull/12";
const ref = { url: URL, owner: "o", repo: "r", number: 12 };
const NOW = 1_000_000;
const snapshot: PullRequestSnapshot = {
  ref,
  title: "Fix it",
  state: "open",
  draft: false,
  headSha: "abcdef1234567",
  checks: [
    { name: "lint", status: "failure", url: "https://ci/lint" },
    { name: "test", status: "pending", url: undefined },
    { name: "build", status: "success", url: undefined },
  ],
  comments: [],
  truncated: false,
};
const changed = (
  fields: Partial<Extract<PullRequestUpdate, { type: "changed" }>>,
): PullRequestUpdate => ({
  type: "changed",
  ref,
  title: "Fix it",
  checks: [],
  comments: [],
  ...fields,
});
const comment = {
  id: "issue:1" as const,
  kind: "issue" as const,
  author: "a",
  body: "b",
  url: "u",
  updatedAt: "t",
};

describe("renderPullRequestUpdate", () => {
  it("describes changed updates", () => {
    const text = renderToString(
      renderPullRequestUpdate({
        pullRequests: [
          changed({
            stateChange: { from: "open", to: "merged" },
            headChange: { from: "a", to: "1234567890" },
            checks: [{ check: snapshot.checks[0], previous: "pending" }],
            comments: [
              { comment, edited: false },
              { comment, edited: true },
            ],
          }),
          changed({
            checks: [snapshot.checks[0], snapshot.checks[1]].map((check) => ({
              check,
              previous: undefined,
            })),
            comments: [{ comment, edited: false }],
          }),
        ],
      }),
    );
    expect(text).toBe(
      ` pr: ${URL} now merged, new head 1234567, 1 check, 2 comments\n pr: ${URL} 2 checks, 1 comment\n`,
    );
  });
});

describe("renderPullRequests", () => {
  const render = (states: PullRequestViewState[]) =>
    renderToString(renderPullRequests(states, NOW));

  it("renders a loaded PR with counts, failed checks and pending update", () => {
    expect(
      render([
        {
          url: URL,
          loaded: true,
          status: { type: "ok", lastPolledAt: NOW - 40_000, nextPollAt: NOW },
          snapshot,
          pending: changed({ comments: [{ comment, edited: false }] }),
        },
      ]),
    ).toBe(
      `\n# pull requests:\n-  Fix it ${URL} (open) checks: 1 pending, 1 passed, 1 failed (polled 40s ago)\n  - failed: lint https://ci/lint\n  - [pending update: 1 comment]\n`,
    );
  });

  it("renders failing with a snapshot and finished", () => {
    const text = render([
      {
        url: URL,
        loaded: true,
        status: {
          type: "failing",
          consecutiveFailures: 3,
          lastError: "boom",
          nextPollAt: NOW,
        },
        snapshot: { ...snapshot, checks: [] },
        pending: undefined,
      },
      {
        url: URL,
        loaded: true,
        status: { type: "finished" },
        snapshot: { ...snapshot, state: "merged", checks: [] },
        pending: undefined,
      },
    ]);
    expect(text).toContain(
      `-  Fix it ${URL} (open) checks: 0 pending, 0 passed, 0 failed\n  - poll failing (3x): boom\n`,
    );
    expect(text).toContain(
      `-  Fix it ${URL} (merged) checks: 0 pending, 0 passed, 0 failed (no longer polling)\n`,
    );
  });

  it("omits state and counts without a snapshot", () => {
    expect(
      render([
        { url: URL, loaded: false, status: { type: "loading" } },
        {
          url: URL,
          loaded: false,
          status: { type: "unavailable", message: "gone" },
        },
        {
          url: URL,
          loaded: false,
          status: {
            type: "failing",
            consecutiveFailures: 1,
            lastError: "x",
            nextPollAt: NOW,
          },
        },
      ]),
    ).toBe(
      `\n# pull requests:\n-  ${URL} (loading)\n-  ${URL}\n  - unavailable: gone\n-  ${URL}\n  - poll failing (1x): x\n`,
    );
  });

  it("renders nothing with no PRs", () => {
    expect(render([])).toBe("");
  });
});
