import { describe, expect, it, vi } from "vitest";
import { ABORTED, ActiveSubmission, IDLE_SUBMISSION } from "./thread-api.ts";
import { Defer } from "./utils/async.ts";

describe("ActiveSubmission", () => {
  it("aborts a child started after the submission was aborted", async () => {
    const submission = new ActiveSubmission(async () => {});
    void submission.abort();
    const done = new Defer<string>();
    const abort = vi.fn(() => done.resolve("stopped"));
    const result = await submission.settled(() => ({
      promise: done.promise,
      abort,
    }));
    expect(abort).toHaveBeenCalledTimes(1);
    expect(result).toBe(ABORTED);
  });
  it("abandons a step when aborted mid-work", async () => {
    const submission = new ActiveSubmission(async () => {});
    const work = new Defer<string>();
    const stepping = submission.step(() => work.promise);
    void submission.abort();
    expect(await stepping).toBe(ABORTED);
    work.resolve("late");
  });
  it("the idle submission runs work to completion", async () => {
    expect(IDLE_SUBMISSION.aborted).toBe(false);
    expect(await IDLE_SUBMISSION.step(async () => "delivered")).toBe(
      "delivered",
    );
  });
});
