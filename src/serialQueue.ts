/**
 * Serializes async work without unbounded promise-chain growth.
 * When the queue drains, the internal chain resets to a settled promise.
 */
export class SerialQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.chain.then(task, task);
    this.chain = result.then(
      () => this.onSettled(),
      () => this.onSettled(),
    );
    return result;
  }

  private onSettled(): void {
    this.pending -= 1;
    if (this.pending === 0) {
      this.chain = Promise.resolve();
    }
  }
}
