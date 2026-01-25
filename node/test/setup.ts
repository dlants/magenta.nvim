import { beforeEach } from "vitest";
import { enableSequentialCheckpointIds } from "../chat/checkpoint.ts";

beforeEach(() => {
  // Reset checkpoint counter before each test for deterministic IDs
  enableSequentialCheckpointIds();
});
