/**
 * Intrusive doubly linked list that orders cache entries by recency. The head is
 * the most recently used node and the tail is the least recently used one.
 *
 * Nodes are handed back to the caller on insert so a lookup by key can reorder
 * an entry in constant time instead of walking the list.
 */
export interface RecencyNode<T> {
  key: string;
  value: T;
  prev: RecencyNode<T> | null;
  next: RecencyNode<T> | null;
}

export class RecencyList<T> {
  private head: RecencyNode<T> | null = null;
  private tail: RecencyNode<T> | null = null;
  private count = 0;

  get size(): number {
    return this.count;
  }

  get newest(): RecencyNode<T> | null {
    return this.head;
  }

  get oldest(): RecencyNode<T> | null {
    return this.tail;
  }

  insert(key: string, value: T): RecencyNode<T> {
    const node: RecencyNode<T> = { key, value, prev: null, next: null };
    this.link(node);
    this.count += 1;
    return node;
  }

  /** Removes a linked node. Passing a node that is already out is a corruption. */
  detach(node: RecencyNode<T>): void {
    this.unlink(node);
    this.count -= 1;
  }

  /** Moves a linked node back to the head without changing the size. */
  touch(node: RecencyNode<T>): void {
    if (this.head === node) return;
    this.unlink(node);
    this.link(node);
  }

  /**
   * Walks from the least recently used end toward the most recently used one.
   *
   * The next node is read before the current one is handed out, so a consumer
   * that detaches the node it is looking at does not lose the rest of the walk.
   */
  *fromOldest(): Generator<RecencyNode<T>> {
    let node = this.tail;
    while (node) {
      const previous = node.prev;
      yield node;
      node = previous;
    }
  }

  /** Keys from most to least recently used. */
  keys(): string[] {
    const result: string[] = [];
    let node = this.head;
    while (node) {
      result.push(node.key);
      node = node.next;
    }
    return result;
  }

  clear(): void {
    this.head = null;
    this.tail = null;
    this.count = 0;
  }

  private link(node: RecencyNode<T>): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    this.tail ??= node;
  }

  private unlink(node: RecencyNode<T>): void {
    if (node.prev) node.prev.next = node.next;
    else if (this.head === node) this.head = node.next;

    if (node.next) node.next.prev = node.prev;
    else if (this.tail === node) this.tail = node.prev;

    node.prev = null;
    node.next = null;
  }
}
