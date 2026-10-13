/** Fixed-capacity FIFO; the oldest item is dropped when full. */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    const end = (this.start + this.count) % this.capacity;
    this.items[end] = item;
    if (this.count < this.capacity) this.count++;
    else this.start = (this.start + 1) % this.capacity;
  }

  /** The newest `limit` items, oldest first. */
  last(limit: number): T[] {
    const n = Math.max(0, Math.min(Math.floor(limit), this.count));
    const out: T[] = [];
    for (let i = this.count - n; i < this.count; i++) {
      out.push(this.items[(this.start + i) % this.capacity] as T);
    }
    return out;
  }
}

/** Remembers the most recent `capacity` keys (insertion order) for de-duplication. */
export class RecentKeys {
  private readonly keys = new Set<string>();

  constructor(readonly capacity: number) {}

  has(key: string): boolean {
    return this.keys.has(key);
  }

  /** Returns false when the key was already present. */
  add(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > this.capacity) {
      const oldest = this.keys.values().next();
      if (!oldest.done) this.keys.delete(oldest.value);
    }
    return true;
  }

  get size(): number {
    return this.keys.size;
  }
}
