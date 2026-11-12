import { describe, expect, it } from 'vitest';
import { agentImage, dashboardHost, parsePs } from './commands';

describe('parsePs', () => {
  it('reads newline-delimited JSON and a JSON array', () => {
    expect(parsePs('{"Service":"api","State":"running"}\n{"Service":"worker","State":"exited"}\n')).toHaveLength(2);
    expect(parsePs('[{"Service":"api"}]')).toEqual([{ Service: 'api' }]);
    expect(parsePs('')).toEqual([]);
  });
});

describe('dashboardHost', () => {
  it('uses an IP address or localhost from DASHBOARD_BIND, and maps wildcards to localhost', () => {
    expect(dashboardHost('127.0.0.1')).toBe('127.0.0.1');
    expect(dashboardHost('192.168.1.20')).toBe('192.168.1.20');
    expect(dashboardHost('::1')).toBe('[::1]');
    expect(dashboardHost('localhost')).toBe('localhost');
    expect(dashboardHost('0.0.0.0')).toBe('localhost');
    expect(dashboardHost(undefined)).toBe('localhost');
    expect(dashboardHost('')).toBe('localhost');
  });
  it('never lets anything else from the .env file into the URL', () => {
    for (const bad of ['evil.example.com', 'http://evil.example.com', '127.0.0.1@evil.example.com', '127.0.0.1/../x', 'a b', '1.2.3.4:80']) expect(dashboardHost(bad)).toBe('localhost');
  });
});

describe('agentImage', () => {
  it('follows the compose default: registry, name and the installed version', () => {
    expect(agentImage('SDLC_VERSION=0.0.3\n')).toBe('ghcr.io/pjx16/sdlc-agent-agent:0.0.3');
    expect(agentImage('SDLC_VERSION=0.0.3\nSDLC_REGISTRY=ghcr.io/me\n')).toBe('ghcr.io/me/sdlc-agent-agent:0.0.3');
    expect(agentImage('SDLC_VERSION=0.0.3\nAGENT_IMAGE=my/agent:1\n')).toBe('my/agent:1');
  });
});
