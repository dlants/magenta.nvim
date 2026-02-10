import type { Result } from "../utils/result.ts";

export function validateInput(
  _toolName: unknown,
  input: { [key: string]: unknown },
): Result<unknown> {
  return { status: "ok" as const, value: input };
}
