import { Client } from 'pg';

/** Arbitrary constant that identifies "the worker" among Postgres advisory locks. */
export const WORKER_LOCK_KEY = 7_321_001;

/**
 * A session-level Postgres advisory lock held on a dedicated connection (F4). The lock lives as long as the
 * connection does, so a second worker process cannot start and a crashed worker releases it automatically.
 */
export class AdvisoryLock {
  private client: Client | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly key: number = WORKER_LOCK_KEY,
  ) {}

  /** True if this process now holds the lock; false if another process does. */
  async acquire(): Promise<boolean> {
    const client = new Client({ connectionString: this.connectionString });
    await client.connect();
    const { rows } = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [this.key]);
    if (!rows[0]?.locked) {
      await client.end();
      return false;
    }
    this.client = client;
    return true;
  }

  async release(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.end(); // closing the session releases the lock
  }
}
