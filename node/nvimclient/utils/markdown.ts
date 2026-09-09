import path from "node:path";

/** What to append to a code block, so like:
 * ```ts
 * ...
 * ```
 */
export function getMarkdownExt(fileName: string): string {
  return path.extname(fileName).slice(1); // slice to remove the dot
}
