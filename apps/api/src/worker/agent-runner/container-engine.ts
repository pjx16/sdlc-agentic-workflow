import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import { LineSplitter } from './line-splitter';

export type OutputStream = 'stdout' | 'stderr';

/** One container, as far as the runner cares. Implemented over dockerode, and by a fake in unit tests. */
export interface ContainerHandle {
  readonly id: string;
  /** Registers the output callback. Must be called before `start()`. */
  attach(onLine: (line: string, stream: OutputStream) => void): Promise<void>;
  start(): Promise<void>;
  /** Resolves with the exit code once the container stops. */
  wait(): Promise<number>;
  kill(): Promise<void>;
  /** Removes the container (forced), ignoring "already gone". */
  remove(): Promise<void>;
}

export interface ContainerEngine {
  create(options: Docker.ContainerCreateOptions): Promise<ContainerHandle>;
  /** Removes every container carrying `label` (for example `sdlc.agent=true`); returns how many. */
  removeByLabel(label: string): Promise<number>;
}

export const CONTAINER_ENGINE = Symbol('CONTAINER_ENGINE');

const ignoreGone = (err: unknown): void => {
  const status = (err as { statusCode?: number }).statusCode;
  if (status === 404 || status === 409) return; // not found, or already being removed / not running
  throw err;
};

class DockerodeHandle implements ContainerHandle {
  constructor(private readonly container: Docker.Container) {}

  get id(): string {
    return this.container.id;
  }

  async attach(onLine: (line: string, stream: OutputStream) => void): Promise<void> {
    const stream = await this.container.attach({ stream: true, stdout: true, stderr: true });
    const out = new PassThrough();
    const err = new PassThrough();
    const outLines = new LineSplitter((l) => onLine(l, 'stdout'));
    const errLines = new LineSplitter((l) => onLine(l, 'stderr'));
    out.on('data', (c: Buffer) => outLines.push(c));
    err.on('data', (c: Buffer) => errLines.push(c));
    this.container.modem.demuxStream(stream, out, err);
    stream.on('end', () => {
      outLines.flush();
      errLines.flush();
    });
  }

  start(): Promise<void> {
    return this.container.start() as unknown as Promise<void>;
  }

  async wait(): Promise<number> {
    const result = (await this.container.wait()) as { StatusCode: number };
    return result.StatusCode;
  }

  async kill(): Promise<void> {
    await this.container.kill().catch(ignoreGone);
  }

  async remove(): Promise<void> {
    await this.container.remove({ force: true, v: true }).catch(ignoreGone);
  }
}

export class DockerodeEngine implements ContainerEngine {
  constructor(private readonly docker: Docker = new Docker()) {}

  async create(options: Docker.ContainerCreateOptions): Promise<ContainerHandle> {
    return new DockerodeHandle(await this.docker.createContainer(options));
  }

  async removeByLabel(label: string): Promise<number> {
    const containers = await this.docker.listContainers({ all: true, filters: { label: [label] } });
    for (const info of containers) await new DockerodeHandle(this.docker.getContainer(info.Id)).remove();
    return containers.length;
  }
}
