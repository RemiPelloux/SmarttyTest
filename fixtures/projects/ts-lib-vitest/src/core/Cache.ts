export class Cache<V> {
  private readonly items = new Map<string, V>();

  get(key: string): V | undefined {
    return this.items.get(key);
  }

  set(key: string, value: V): this {
    this.items.set(key, value);
    return this;
  }

  size(): number {
    return this.items.size;
  }
}
