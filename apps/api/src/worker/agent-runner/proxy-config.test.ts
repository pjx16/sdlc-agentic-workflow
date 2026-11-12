import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const conf = readFileSync(path.resolve(__dirname, '../../../../../docker/proxy/squid.conf'), 'utf8');
const rules = conf.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

describe('squid.conf allowlist (BUILD_PLAN 6.1)', () => {
  it('listens on 3128 and 3129', () => {
    expect(rules).toContain('http_port 3128');
    expect(rules).toContain('http_port 3129');
  });

  it('allows only Anthropic and the npm registry on the base port', () => {
    expect(rules).toContain('acl base_domains dstdomain .anthropic.com registry.npmjs.org');
    expect(rules).toContain('http_access allow port_base base_domains');
  });

  it('allows the Jira MCP hosts only on the MCP port', () => {
    expect(rules).toContain('acl mcp_domains dstdomain "/etc/squid/mcp_domains.txt"');
    expect(rules).toContain('http_access allow port_mcp mcp_domains');
    expect(rules).not.toContain('http_access allow port_base mcp_domains');
  });

  it('only tunnels to port 443 and denies everything else, last', () => {
    expect(rules).toContain('http_access deny connect_method !ssl_ports');
    const access = rules.filter((r) => r.startsWith('http_access'));
    expect(access.at(-1)).toBe('http_access deny all');
  });
});
