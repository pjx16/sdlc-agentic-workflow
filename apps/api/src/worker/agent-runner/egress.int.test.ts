import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EgressFixture, shellInAgent, startEgress } from '../../testing/docker-fixture';

/** curl through the proxy; prints "<http_code> exit=<curl exit>". Exit 0 with a real code means the tunnel was allowed. */
const through = (port: number, host: string) =>
  `curl -s -o /dev/null -w "%{http_code}" --max-time 15 -x http://proxy:${port} https://${host}/; echo " exit=$?"`;

const outcome = async (script: string) => (await shellInAgent(script)).lines.join(' ');

describe('egress from an agent container (BUILD_PLAN 6.1, F5)', () => {
  let egress: EgressFixture;
  beforeAll(async () => {
    egress = await startEgress('example.org');
  }, 120_000);
  afterAll(async () => egress?.stop());

  it('reaches the Anthropic API through the proxy', async () => {
    const out = await outcome(through(3128, 'api.anthropic.com'));
    expect(out).toMatch(/exit=0/);
    expect(out).not.toMatch(/^000/); // any real HTTP status means the tunnel opened
  }, 60_000);

  it('reaches the npm registry through the proxy', async () => {
    expect(await outcome(through(3128, 'registry.npmjs.org'))).toMatch(/exit=0/);
  }, 60_000);

  it('cannot reach a host that is not on the allowlist', async () => {
    const out = await outcome(through(3128, 'example.com'));
    expect(out).toMatch(/^000/);
    expect(out).not.toMatch(/exit=0/);
  }, 60_000);

  it('cannot bypass the proxy: no direct route and no DNS from the agent network', async () => {
    const out = await outcome('curl -s -o /dev/null -w "%{http_code}" --max-time 8 https://api.anthropic.com/; echo " exit=$?"');
    expect(out).toMatch(/^000/);
    expect(out).not.toMatch(/exit=0/);
  }, 60_000);

  it('allows the Jira MCP host only on the MCP port (3129)', async () => {
    expect(await outcome(through(3129, 'example.org'))).toMatch(/exit=0/);
    expect(await outcome(through(3128, 'example.org'))).not.toMatch(/exit=0/);
    expect(await outcome(through(3129, 'example.com'))).not.toMatch(/exit=0/); // MCP port allows only the configured host
  }, 90_000);

  it('cannot reach the database or other internal services from the agent network', async () => {
    expect(await outcome('getent hosts postgres api worker || echo unresolved')).toBe('unresolved');
  }, 60_000);
});
