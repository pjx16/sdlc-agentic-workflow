/** Runs housekeeping parts only when due (BUILD_PLAN 6.6 step 1). */
export class Schedule {
  private readonly last = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** True (and the clock restarts) when `name` has not run for `intervalMs`. The first call is always due. */
  due(name: string, intervalMs: number): boolean {
    const t = this.now();
    const previous = this.last.get(name);
    if (previous !== undefined && t - previous < intervalMs) return false;
    this.last.set(name, t);
    return true;
  }
}
