/**
 * Helper function to ensure exhaustive type checking in switch statements.
 * Will cause a TypeScript error if a case is not handled.
 */
export function assertUnreachable(x: never): never {
  throw new Error(`Didn't expect to get here with value: ${JSON.stringify(x)}`);
}
