const ENABLED = Boolean(process.env.MAGENTA_TIMINGS);

export type TimingEntry = {
  label: string;
  time_ms: number;
};

const entries: TimingEntry[] = [];

export const isEnabled = (): boolean => ENABLED;

export const record = (label: string): void => {
  if (!ENABLED) return;
  entries.push({ label, time_ms: Date.now() });
};

// Add an entry with an explicit, already-captured timestamp (for events that
// happened before this module was loaded, like the pre-import boot script).
export const addEntry = (entry: TimingEntry): void => {
  if (!ENABLED) return;
  entries.push(entry);
};

export const getEntries = (): TimingEntry[] => entries;
