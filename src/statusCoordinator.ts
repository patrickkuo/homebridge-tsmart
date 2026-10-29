/**
 * Coordinates optimistic control vs polled status without races.
 *
 * - `generation` bumps on each control (and destroy) so in-flight polls discard stale results
 * - `controlInFlight` gates new polls for the duration of control + settle refresh
 */
export class StatusCoordinator {
  generation = 0;
  controlInFlight = false;

  beginControl(): number {
    this.generation += 1;
    this.controlInFlight = true;
    return this.generation;
  }

  endControl(gen: number): void {
    if (gen === this.generation) {
      this.controlInFlight = false;
    }
  }

  /** Call on accessory destroy so in-flight work becomes stale. */
  invalidate(): void {
    this.generation += 1;
    this.controlInFlight = false;
  }

  shouldApplyPollResult(genAtStart: number): boolean {
    return !this.controlInFlight && this.generation === genAtStart;
  }

  shouldApplyControlRefresh(requiredGen: number): boolean {
    return this.generation === requiredGen;
  }
}
