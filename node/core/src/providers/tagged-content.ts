import type {
  NativeMessageIdx,
  ProviderMessageContent,
} from "./provider-types.ts";

/** Structured content (system reminders, context updates, ...) reaches the
 * provider as plain tagged text, because that is all the wire format can carry.
 * On the way back into `ProviderMessage[]` it has to be re-tagged, or the view
 * renders it as raw text instead of a structured, collapsible block. Every
 * agent must apply this identically. */
const TAGGED_CONTENT: ReadonlyArray<
  [tag: string, type: ProviderMessageContent["type"]]
> = [
  ["<system-reminder>", "system_reminder"],
  ["<system-info>", "system_info"],
  ["<context_update>", "context_update"],
  ["<fork-notification>", "fork_notification"],
];

export function classifyTextContent(
  text: string,
  nativeMessageIdx: NativeMessageIdx,
): ProviderMessageContent | undefined {
  // Match only at the start: every generator emits the tag as the first thing in
  // its own content block. Matching anywhere would misclassify a user message
  // that merely mentions a tag, hiding the user's own text.
  const trimmed = text.trimStart();
  for (const [tag, type] of TAGGED_CONTENT) {
    if (trimmed.startsWith(tag)) {
      return { type, text, nativeMessageIdx } as ProviderMessageContent;
    }
  }
  return undefined;
}
