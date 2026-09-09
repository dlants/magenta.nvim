export type EventMap = Record<string, unknown[]>;

type Listener<Args extends unknown[]> = (...args: Args) => void;

export class Emitter<Events extends EventMap> {
  private listeners: {
    [K in keyof Events]?: Set<Listener<Events[K]>>;
  } = {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }
    this.listeners[event].add(listener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners[event]?.delete(listener);
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.listeners[event];
    if (set) {
      for (const listener of set) {
        listener(...args);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners = {};
  }
}
