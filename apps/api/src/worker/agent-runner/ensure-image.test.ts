import type Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import { DockerodeEngine } from './container-engine';
import { FakeEngine } from './fake-engine';
import { WorkerRunner } from '../worker-runner';

/** The few dockerode calls ensureImage uses. `inspectError` is what getImage().inspect() rejects with, if anything. */
function stubDocker(inspectError?: { statusCode: number }) {
  const calls: string[] = [];
  const docker = {
    getImage: (name: string) => ({
      inspect: async () => {
        calls.push(`inspect ${name}`);
        if (inspectError) throw inspectError;
        return {};
      },
    }),
    pull: async (name: string) => {
      calls.push(`pull ${name}`);
      return {} as NodeJS.ReadableStream;
    },
    modem: { followProgress: (_stream: unknown, done: (err: Error | null) => void) => (calls.push('followProgress'), done(null)) },
  };
  return { docker: docker as unknown as Docker, calls };
}

describe('DockerodeEngine.ensureImage (3.1)', () => {
  it('does not pull an image that is present', async () => {
    const { docker, calls } = stubDocker();
    expect(await new DockerodeEngine(docker).ensureImage('img:1')).toBe('present');
    expect(calls).toEqual(['inspect img:1']);
  });

  it('pulls and waits for the pull only when inspect reports 404', async () => {
    const { docker, calls } = stubDocker({ statusCode: 404 });
    expect(await new DockerodeEngine(docker).ensureImage('img:1')).toBe('pulled');
    expect(calls).toEqual(['inspect img:1', 'pull img:1', 'followProgress']);
  });

  it('rethrows other inspect errors without pulling', async () => {
    const { docker, calls } = stubDocker({ statusCode: 500 });
    await expect(new DockerodeEngine(docker).ensureImage('img:1')).rejects.toBeDefined();
    expect(calls).toEqual(['inspect img:1']);
  });
});

describe('WorkerRunner start-up image check (3.1)', () => {
  const runner = (engine: FakeEngine) =>
    new WorkerRunner({ agentImage: 'agent:1', databaseUrl: 'postgresql://x' } as never, {} as never, {} as never, engine, {} as never) as unknown as { ensureAgentImage(): Promise<void> };

  it('asks the engine for the configured agent image', async () => {
    const engine = new FakeEngine();
    await runner(engine).ensureAgentImage();
    expect(engine.ensuredImages).toEqual(['agent:1']);
  });

  it('logs and carries on when the pull fails', async () => {
    const engine = new FakeEngine();
    engine.ensureResult = new Error('registry unreachable');
    await expect(runner(engine).ensureAgentImage()).resolves.toBeUndefined();
  });
});
