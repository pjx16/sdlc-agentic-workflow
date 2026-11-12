import { describe, expect, it } from 'vitest';
import { agentImage, parsePs } from './commands';

describe('parsePs', () => {
  it('reads newline-delimited JSON and a JSON array', () => {
    expect(parsePs('{"Service":"api","State":"running"}\n{"Service":"worker","State":"exited"}\n')).toHaveLength(2);
    expect(parsePs('[{"Service":"api"}]')).toEqual([{ Service: 'api' }]);
    expect(parsePs('')).toEqual([]);
  });
});

describe('agentImage', () => {
  it('follows the compose default: registry, name and the installed version', () => {
    expect(agentImage('SDLC_VERSION=0.0.3\n')).toBe('ghcr.io/pjx16/sdlc-agent-agent:0.0.3');
    expect(agentImage('SDLC_VERSION=0.0.3\nSDLC_REGISTRY=ghcr.io/me\n')).toBe('ghcr.io/me/sdlc-agent-agent:0.0.3');
    expect(agentImage('SDLC_VERSION=0.0.3\nAGENT_IMAGE=my/agent:1\n')).toBe('my/agent:1');
  });
});
