import type { RateLimit } from '../worker/agent-runner/result-parser';
import type { FinishStageRun, NewStageRun, StageRunStore } from '../worker/agent-runner/stage-run-store';

/** StageRun persistence in memory, for tests that must not need a database. */
export class MemoryStore implements StageRunStore {
  runs = new Map<string, NewStageRun & { status: string; containerId?: string; finished?: FinishStageRun }>();
  rateLimits: RateLimit[] = [];
  killRequested = new Set<string>();
  async create(run: NewStageRun) {
    const id = `run-${this.runs.size + 1}`;
    this.runs.set(id, { ...run, status: 'queued' });
    return id;
  }
  async markRunning(id: string, containerId: string) {
    Object.assign(this.runs.get(id) as object, { status: 'running', containerId });
  }
  async isKillRequested(id: string) {
    return this.killRequested.has(id);
  }
  async finish(id: string, r: FinishStageRun) {
    Object.assign(this.runs.get(id) as object, { status: r.status, finished: r });
  }
  retryAt = new Map<string, Date>();
  async setRetryAt(id: string, at: Date) {
    this.retryAt.set(id, at);
  }
  async saveRateLimit(l: RateLimit) {
    this.rateLimits.push(l);
  }
}
