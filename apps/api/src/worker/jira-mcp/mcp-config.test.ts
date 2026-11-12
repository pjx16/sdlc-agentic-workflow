import { describe, expect, it } from 'vitest';
import { mcpEnv, parseMcpConfig } from './mcp-config';

const CONFIG = JSON.stringify({ mcpServers: { atlassian: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', headers: { Authorization: 'Basic ${JIRA_MCP_AUTH}', 'X-Other': '${OTHER:-x}' } } } });

describe('parseMcpConfig', () => {
  it('finds the server name, the host and the environment variables the file refers to', () => {
    expect(parseMcpConfig(CONFIG)).toMatchObject({ serverName: 'atlassian', hosts: ['mcp.atlassian.com'], envNames: ['JIRA_MCP_AUTH', 'OTHER'] });
  });
  it('rejects broken files with a readable message', () => {
    expect(() => parseMcpConfig('nope')).toThrow('not valid JSON');
    expect(() => parseMcpConfig('{}')).toThrow('needs an "mcpServers" object');
    expect(() => parseMcpConfig('{"mcpServers":{}}')).toThrow('needs an "mcpServers" object');
  });
  it('ignores a server without a usable URL when collecting hosts', () => {
    expect(parseMcpConfig('{"mcpServers":{"a":{"command":"x"},"b":{"url":"::bad"}}}').hosts).toEqual([]);
  });
});

describe('mcpEnv', () => {
  it('returns exactly the referenced variables', () => {
    expect(mcpEnv(parseMcpConfig(CONFIG), { JIRA_MCP_AUTH: 'abc', OTHER: 'o', GITHUB_TOKEN: 'secret' } as never)).toEqual({ JIRA_MCP_AUTH: 'abc', OTHER: 'o' });
  });
  it('fails when one is missing instead of passing an empty credential', () => {
    expect(() => mcpEnv(parseMcpConfig(CONFIG), { OTHER: 'o' } as never)).toThrow('JIRA_MCP_AUTH, which is not set');
  });
});
