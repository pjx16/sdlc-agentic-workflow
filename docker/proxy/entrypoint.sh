#!/bin/bash
# Writes the Jira MCP host (if set) to the port-3129 allowlist, then starts Squid.
set -e
if [ -n "${JIRA_MCP_HOST:-}" ]; then
  echo "${JIRA_MCP_HOST}" > /etc/squid/mcp_domains.txt
else
  : > /etc/squid/mcp_domains.txt
fi
exec /usr/local/bin/entrypoint.sh "$@"
