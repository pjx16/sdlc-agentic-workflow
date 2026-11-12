# Security Policy

## Supported versions

Only the latest `0.0.x` pre-release is supported, on a best-effort basis, with no response-time promise. This is a pre-release built for the author's own use; see [`CHANGELOG.md`](./CHANGELOG.md).

## Reporting a vulnerability

Please **do not** report security vulnerabilities in public issues, discussions or pull requests.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Include a description, the affected component, steps to reproduce and the potential impact.

Please do not include real tokens, passwords or private repository content in a report. Redact them, or use throwaway values.

## Threat model (short)

**Trusted:** the operator, the host the stack runs on, and the `.env` file.

**Not trusted:** ticket text, repository content and everything an agent writes. A prompt-injected agent is assumed possible.

The boundaries that matter:

- **Agent container ↔ worker.** Agent containers run with all capabilities dropped, `no-new-privileges`, resource limits, no Docker socket and no GitHub or Jira credentials (Jira credentials only in the optional MCP mode). The workspace `.git` directory is mounted read-only. The worker runs git with hooks, fsmonitor, credential helpers and non-HTTPS protocols disabled, pushes only to the stored repository URL, and never follows symlinks in agent-written workspaces.
- **Agent ↔ internet.** The only route out is an egress proxy that allows HTTPS tunnels (CONNECT to port 443) to the Anthropic API and the npm registry. Repositories are restricted to `https://github.com/...`, and the GitHub token is only handed to github.com.
- **Browser ↔ API.** A single-user password login creates a session cookie (httpOnly, SameSite). Requests are denied by default without a session, state-changing requests marked cross-site by `Sec-Fetch-Site` are refused, and the dashboard sends anti-framing headers.

## Known residual risks

These are known and documented. A report about them is not treated as a new vulnerability unless it bypasses a control stated above.

- The worker runs as root with the Docker socket, which is equivalent to root on the host. Run it on a dedicated VM or machine.
- Agents can reach the Anthropic API and the npm registry, and a prompt-injected agent could use them to send repository content out. Only use repositories whose content you are comfortable sending to those services.
- The npm cache volume is shared between projects.
- Never publish the dashboard beyond `127.0.0.1` without a TLS reverse proxy and `COOKIE_SECURE=true`.
- The dashboard has no `script-src` Content-Security-Policy yet.

## Scope

This project runs AI-generated code in containers and holds a GitHub token. Reports about container isolation, credential handling, the egress proxy, authentication and secret redaction are especially welcome.
