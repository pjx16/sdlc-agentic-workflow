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

  constructor(private readonly behaviour: FakeBehaviour = {}) {}

  async create(options: Docker.ContainerCreateOptions): Promise<ContainerHandle> {
    this.created.push(options);
    const handle = new FakeHandle(`fake-${this.handles.length + 1}`, this.behaviour);
    this.handles.push(handle);
    return handle;
  }

  async removeByLabel(): Promise<number> {
    return 0;
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
