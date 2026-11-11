# SPIKE.md — Milestone 0 findings

Run on 2026-11-11, macOS (Apple Silicon), Docker Desktop 27.3.1. Every result below comes from a real run. Secrets are never recorded here.

Summary: all plan assumptions held except the items in [Deviations](#deviations).

---

## 0.1 Agent image and first `claude -p` run

Image: `docker/agent/Dockerfile` (`node:22-bookworm-slim`, `npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`, user `node`).

```bash
docker build -t sdlc-agent/agent:latest docker/agent
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN sdlc-agent/agent:latest sh -c \
  'id -u; claude --version; echo "Reply with exactly: pong" | claude -p --model haiku'
```

```text
1000
2.1.322 (Claude Code)
pong
```

**CLI version: `2.1.322`.** Use this as the `CLAUDE_CODE_VERSION` build arg (the spike image was built with `latest`, which resolved to 2.1.322; pin it explicitly in Milestone 1).

## 0.2 stream-json and `rate_limit_event`

```bash
echo "Say hi" | claude -p --model haiku --output-format stream-json --verbose
```

Line types seen: `system/init`, `assistant`, `rate_limit_event`, `result/success`. Complete `rate_limit_event`:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1794418200,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.01,"resetsAt":1794418200,"status":"allowed"},"seven_day":{"utilization":0.08,"resetsAt":1794740400,"status":"allowed"}}},"uuid":"1dcb0544-99a9-486f-89cb-1602fd54a114","session_id":"c7d70de1-1124-40d3-a760-16bcf410cdab"}
```

Fields: `rate_limit_info.{status, resetsAt, rateLimitType, overageStatus, overageDisabledReason, isUsingOverage, unifiedWindows.{five_hour,seven_day}.{utilization, resetsAt, status}}`, plus `uuid` and `session_id`.

- A utilization value **exists** for both the 5-hour and the **7-day** window.
- Scale: **fraction 0–1** (`0.01`, `0.08`). Only low values were observed, so a 0–100 scale is not strictly excluded, but 1% and 8% fit the account's real usage. Re-check when usage is higher (see Deviations).
- `resetsAt` is epoch seconds.
- The `result` line carries: `subtype`, `is_error`, `num_turns`, `result`, `session_id`, `total_cost_usd`, `usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`, `modelUsage`, `stop_reason`, `terminal_reason`, `duration_ms`.

## 0.3 `--json-schema` with stream-json

```bash
echo 'Return answer="ok" and n=3.' | claude -p --model haiku --output-format stream-json --verbose \
  --json-schema '{"type":"object","properties":{"answer":{"type":"string"},"n":{"type":"integer"}},"required":["answer","n"]}'
```

Last line (`type: result`, `subtype: success`, `num_turns: 2`) contains:

```json
"result":"{\"answer\":\"ok\",\"n\":3}","structured_output":{"answer":"ok","n":3}
```

`structured_output` appears **on the final `result` line**, as an object. The `result` text also holds the JSON as a string. The fenced-JSON fallback is not needed for this case. Keep it anyway as the plan says (not exercised in this spike).

## 0.4 CLI flags and turn limit

- `--max-turns 2` with a task that needs more: exit code **1**, last line `{"subtype":"error_max_turns","is_error":true,"num_turns":3,"terminal_reason":"max_turns","stop_reason":"tool_use","result":null,"errors":["Reached maximum number of turns (2)"]}`. No `structured_output`.
- `--disallowedTools "WebFetch,WebSearch,Bash"`: the `init` line lists neither Bash nor WebFetch; the model answered `BASH_UNAVAILABLE`. Exit 0.
- `--append-system-prompt "The secret word is PINEAPPLE."`: the model reported `PINEAPPLE`.
- `--dangerously-skip-permissions`: accepted as non-root; `init.permissionMode` was `bypassPermissions`. Tools ran without prompts.
- Model aliases (from `modelUsage`): `haiku` → `claude-haiku-5-5`, `sonnet` → `claude-sonnet-5-5`, `opus` → `claude-opus-5-5`.

## 0.5 Hiding `CLAUDE.md` with an empty bind mount

`/workspace/CLAUDE.md` contained "The magic word in this project is ZEBRA-42."

```bash
# no mount
docker run ... -v $WS:/workspace ... 'cd /workspace && echo "What magic word does your project CLAUDE.md define? If none, say NONE." | claude -p --model haiku'
→ The magic word defined in the project's `/workspace/CLAUDE.md` is **ZEBRA-42**.

# with an empty file bind-mounted over it
docker run ... -v $WS:/workspace -v $EMPTY:/workspace/CLAUDE.md:ro ...
→ 0 CLAUDE.md
→ NONE. The project `CLAUDE.md` ... exists but is empty (0 bytes)...
```

**The empty-file mount hides `CLAUDE.md`.** Mode `ours` works as planned. (`CLAUDE.local.md` was not tested separately; same mechanism.)

## 0.6 Squid allowlist and required domains

`docker/proxy/squid.conf` is the §6.1 config unchanged. The agent container sat on an `--internal` network; Squid was on that network and on a normal bridge.

- Claude call through `HTTPS_PROXY=http://proxy:3128`: success. Squid log: `TCP_TUNNEL/200 CONNECT api.anthropic.com:443` (3 tunnels). **No other domain was needed.**
- Direct access from the agent network: `curl: (6) Could not resolve host`.
- Via proxy, `registry.npmjs.org` → `200`; `example.com` → `403` (`TCP_DENIED/403`).
- Port 3129 with `mcp.atlassian.com` in `mcp_domains.txt`: `200`; the same host on port 3128: blocked.
- Gotcha: `cache_log /dev/stderr` made Squid exit (permission denied), so the config does not set it. Read logs with `docker exec ... cat /var/log/squid/access.log`.
- The image sets `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `DISABLE_AUTOUPDATER`. **Not tested:** domains contacted with those variables unset, and a full tool-using run's traffic. I skipped this to save Claude usage. `squid.conf` therefore needs no change.

## 0.7 Jira MCP feasibility

Host: **`https://mcp.atlassian.com/v2/mcp`** (streamable HTTP, SSE responses). The v1 endpoint is being retired.

Authentication (headless, no browser): `Authorization: Basic base64(email:api_token)` with a personal API token. There is no OAuth flow and **no refresh**: the token is static and valid until it expires or is revoked (chosen at creation). An org admin must enable API-token auth. Source: Atlassian's "Configuring authentication via API token" guide.

What was verified with `curl` (no Claude calls):

- `POST initialize` with the Basic header → `200`, `mcp-session-id` returned, `serverInfo.name = atlassian-mcp-server`, protocol `2025-06-18`.
- `tools/list` → **26 tools**. Jira-related, with `readOnlyHint`:
  - read: `getAccessibleAtlassianResources`, `atlassianUserInfo`, `getJiraIssue`, `listJiraIssueComments`, `searchJiraIssuesUsingJql`
  - write: `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`
  - Required params for all Jira tools include `cloudId` (the token is not bound to a site; for this site `GET https://<site>/_edge/tenant_info` returns it).
  - Other tools: Confluence (`getConfluenceContent`, `createConfluenceContent`, `updateConfluenceContent`, `searchConfluence`), Loom, Teamwork Graph, and generic `discover`, `executeRead`, `executeWrite`, `executeDestructive`, `search`.
- Through the proxy: `initialize` returns `200` on port 3129 and is blocked on 3128, as designed.
- **Tool calls failed with the token used**: `getAccessibleAtlassianResources` → 401 "session token is missing the scope claim required"; `searchJiraIssuesUsingJql` → "Cloud id … isn't explicitly granted by the user". The token was a plain (unscoped) API token. The docs say the server needs a token created with `agent-interface` scopes (for Jira: `read:jira:agent-interface`, `write:jira:agent-interface`, `search:jira:agent-interface`, …).

**Result: headless auth is possible in principle; the end-to-end read/write call is not yet proven.** Open step: create a scoped token and repeat `getAccessibleAtlassianResources` and `searchJiraIssuesUsingJql`. If scoped tokens cannot be created for this account, Milestone 11 is skipped and the README states that MCP mode is unavailable.

Proposed defaults for `jiraMcp` (names as returned by `tools/list`; confirm after the scoped-token retest):

- `readTools`: `getJiraIssue`, `listJiraIssueComments`, `searchJiraIssuesUsingJql`, `getAccessibleAtlassianResources`
- `writeTools`: `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`

## 0.8 `gh` commands

Run against the private scratch repo `pjx16/sdlc-spike-scratch` (workflow `ci.yml` with trigger `[pull_request, push]`).

```text
$ gh pr create -R pjx16/sdlc-spike-scratch --draft --base main --head spike-branch --title "SPIKE-1: test" --body-file body.md
https://github.com/pjx16/sdlc-spike-scratch/pull/1
$ gh pr view 1 -R ... --json state,mergedAt,isDraft
{"isDraft":true,"mergedAt":null,"state":"OPEN"}
$ gh pr checks 1 -R ... --json name,bucket
[{"bucket":"pass","name":"ok"}]
$ gh pr checks 1 -R ... --json name,bucket        # 25 s later
[{"bucket":"pass","name":"ok"},{"bucket":"pass","name":"ok"}]
$ gh pr comment 1 -R ... --body-file comment.md
https://github.com/pjx16/sdlc-spike-scratch/pull/1#issuecomment-6799605155
$ gh pr edit 1 -R ... --body-file body2.md
https://github.com/pjx16/sdlc-spike-scratch/pull/1
$ gh pr ready 1 -R ...
✓ Pull request pjx16/sdlc-spike-scratch#1 is marked as "ready for review"
$ gh pr view 1 -R ... --json state,mergedAt,isDraft,body
{"body":"Edited body\n","isDraft":false,"mergedAt":null,"state":"OPEN"}
$ gh run list -R ... --branch spike-branch --json databaseId,conclusion --limit 5
[{"conclusion":"success","databaseId":43046425377},{"conclusion":"success","databaseId":43046383684}]
```

All commands and JSON shapes match §6.3. Notes:

- A workflow triggered on both `push` and `pull_request` produces **duplicate check names** (two `ok`). The plan's "all checks pass" logic must not assume unique names.
- Checks can be empty or incomplete right after PR creation; a first call returned only one entry.
- **Not tested:** `gh run view <id> --log-failed` (no failing run was created) and the "PR with no checks" case.

---

## Deviations

1. **Pin the CLI version** to `2.1.322` in `CLAUDE_CODE_VERSION`; do not use `latest`.
2. **Turn limit exit code:** a stage that hits `--max-turns` exits with code 1 and a `result` line with `subtype: error_max_turns`, `result: null`, and no `structured_output`. §6.8 should treat both a non-zero exit and `subtype != success` as a failed attempt, and parse the `result` line even when the exit code is non-zero.
3. **Rate-limit scale:** treat `utilization` as a 0–1 fraction (verified only at 0.01 and 0.08). Add a defensive rule in the usage gate (values above 1 are treated as percent), and re-verify when usage is higher.
4. **Squid:** no allowlist change was needed (`api.anthropic.com` only). Remove or avoid `cache_log /dev/stderr`-style settings; read logs from `/var/log/squid`.
5. **Jira MCP:** use `/v2/mcp`, Basic auth with a scoped API token, and pass `cloudId` on every call. The plan should store the cloud ID (or fetch it from `/_edge/tenant_info`). Unresolved until a scoped token is tested (see 0.7).
6. **GitHub checks:** de-duplicate or tolerate repeated check names and a not-yet-complete first response.

## Cleanup done

Spike containers and networks (`spike-proxy`, `sdlc_spike_net`, `sdlc_spike_egress`) are removed after this run. The scratch repo `pjx16/sdlc-spike-scratch` is removed or left for the developer to delete (see the hand-off message).
