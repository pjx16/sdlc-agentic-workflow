import type Docker from 'dockerode';
import type { ContainerEngine, ContainerHandle, OutputStream } from './container-engine';

export interface FakeBehaviour {
  /** Lines the "container" prints, in order. */
  lines?: string[];
  /** How long it runs before exiting on its own (ms). Default 0. */
  runMs?: number;
  exitCode?: number;
  failStart?: boolean;
}

/** A container engine with no Docker behind it, for unit tests of the runner. */
export class FakeEngine implements ContainerEngine {
  readonly created: Docker.ContainerCreateOptions[] = [];
  readonly handles: FakeHandle[] = [];
  /** Labels passed to removeByLabel, and what it reports having removed (or an error to throw). */
  readonly removedLabels: string[] = [];
  removeResult: number | Error = 0;
  /** Images passed to ensureImage. */
  readonly ensuredImages: string[] = [];
  ensureResult: 'present' | 'pulled' | Error = 'present';

  /** One behaviour for every container, or a list: container n uses entry n and the last one repeats. */
  constructor(private readonly behaviour: FakeBehaviour | FakeBehaviour[] = {}) {}

  async create(options: Docker.ContainerCreateOptions): Promise<ContainerHandle> {
    this.created.push(options);
    const list = Array.isArray(this.behaviour) ? this.behaviour : [this.behaviour];
    const handle = new FakeHandle(`fake-${this.handles.length + 1}`, list[Math.min(this.handles.length, list.length - 1)] ?? {});
    this.handles.push(handle);
    return handle;
  }

  async ensureImage(name: string): Promise<'present' | 'pulled'> {
    this.ensuredImages.push(name);
    if (this.ensureResult instanceof Error) throw this.ensureResult;
    return this.ensureResult;
  }

  async removeByLabel(label: string): Promise<number> {
    this.removedLabels.push(label);
    if (this.removeResult instanceof Error) throw this.removeResult;
    return this.removeResult;
  }
}

export class FakeHandle implements ContainerHandle {
  started = false;
  killed = false;
  removed = false;
  private onLine: (line: string, stream: OutputStream) => void = () => undefined;
  private resolveWait!: (code: number) => void;
  private readonly waited = new Promise<number>((resolve) => {
    this.resolveWait = resolve;
  });

  constructor(
    readonly id: string,
    private readonly behaviour: FakeBehaviour,
  ) {}

  async attach(onLine: (line: string, stream: OutputStream) => void): Promise<void> {
    this.onLine = onLine;
  }

  async start(): Promise<void> {
    if (this.behaviour.failStart) throw new Error('cannot start');
    this.started = true;
    setTimeout(() => {
      for (const line of this.behaviour.lines ?? []) this.onLine(line, 'stdout');
    }, 0);
    setTimeout(() => this.resolveWait(this.behaviour.exitCode ?? 0), this.behaviour.runMs ?? 0);
  }

  wait(): Promise<number> {
    return this.waited;
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.resolveWait(137);
  }

  async remove(): Promise<void> {
    this.removed = true;
  }
}
