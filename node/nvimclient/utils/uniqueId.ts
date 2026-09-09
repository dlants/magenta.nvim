export class IdCounter {
  private counter: Counter = new Counter();
  constructor(private prefix: string) {}

  get() {
    return this.prefix + this.counter.get();
  }

  last() {
    return this.prefix + this.counter.last();
  }
}

export class Counter {
  private counter: number = 1;

  get() {
    const val = this.counter;
    this.counter += 1;
    return val;
  }

  last() {
    return this.counter - 1;
  }
}
