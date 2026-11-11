import { readFileSync } from 'node:fs';

export interface McpConfig {
  /** The file as given (it is written to /context/mcp.json of the Jira stages only). */
  json: string;
  /** The name of the (first) MCP server in the file: tools are called `mcp__<server>__<tool>`. */
  serverName: string;
  /** Environment variables the file refers to as `${NAME}`: the only credentials a Jira stage receives. */
  envNames: string[];
  /** Hosts of the servers' URLs, for the egress allowlist (`JIRA_MCP_HOST`). */
  hosts: string[];
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

/** Reads and checks `JIRA_MCP_CONFIG_PATH`: a Claude Code MCP config with at least one server. Throws a readable error otherwise. */
export function parseMcpConfig(json: string): McpConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('The Jira MCP config is not valid JSON');
  }
  const servers = (parsed as { mcpServers?: Record<string, { url?: unknown }> } | null)?.mcpServers;
  const names = servers && typeof servers === 'object' ? Object.keys(servers) : [];
  if (names.length === 0) throw new Error('The Jira MCP config needs an "mcpServers" object with one server');
  const hosts = names.flatMap((n) => {
    const url = servers?.[n]?.url;
    try {
      return typeof url === 'string' ? [new URL(url).hostname] : [];
    } catch {
      return [];
    }
  });
  const envNames = [...new Set([...json.matchAll(ENV_REF)].map((m) => m[1] as string))];
  return { json, serverName: names[0] as string, envNames, hosts };
}

export function loadMcpConfig(file: string): McpConfig {
  let json: string;
  try {
    json = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`The Jira MCP config ${file} cannot be read`);
  }
  return parseMcpConfig(json);
}

/** The values of the variables the config refers to; a missing one is an error, not an empty credential. */
export function mcpEnv(config: McpConfig, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const missing = config.envNames.filter((n) => !env[n]);
  if (missing.length > 0) throw new Error(`The Jira MCP config refers to ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not set`);
  return Object.fromEntries(config.envNames.map((n) => [n, env[n] as string]));
}
