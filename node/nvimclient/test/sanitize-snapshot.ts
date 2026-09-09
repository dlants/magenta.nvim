/** Normalize message payloads for stable snapshots: strips thread IDs, timing
 * info, and the volatile contents of the system-info block (live timestamp and
 * git state). */
export function sanitizeMessagesForSnapshot<T>(messages: T): T {
  let json = JSON.stringify(messages);
  json = json.replace(
    /\/tmp\/magenta\/threads\/[a-f0-9-]+\//g,
    "/tmp/magenta/threads/<thread-id>/",
  );
  json = json.replace(/\((\d+)ms\)/g, "(<timing>ms)");
  json = json.replace(
    /<system-info>[\s\S]*?<\/system-info>/g,
    "<system-info><normalized></system-info>",
  );
  return JSON.parse(json) as T;
}
