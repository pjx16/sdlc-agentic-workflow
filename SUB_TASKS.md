# sdlc-agent — Sub-Tasks

Derived from [`BUILD_PLAN.md`](./BUILD_PLAN.md) (Nov 10, 2026 · @Piyush Jaiswal). This file divides the complete build plan into manageable development chunks (sub-tasks), grouped by the plan's milestones (§10).

## How to read this file

- **`BUILD_PLAN.md` stays the single source of truth.** Nothing in it was changed. This file only *organises* it. Line numbers (`L…`) refer to `BUILD_PLAN.md` as of Nov 10, 2026; if that file is edited, refresh them.
- **Nothing is copied or paraphrased from the spec.** Every sub-task lists **Spec references**: the exact sections and line ranges of `BUILD_PLAN.md` that define its requirements. Read those lines before building the sub-task; hand them to a coding agent together with the sub-task.
- **Part A** lists the global sections that apply to every sub-task (summary, design principles, scope, user flows, tech stack, project structure, testing strategy, configuration, non-functional requirements and the rules for the coding agent). Read them first.
- **Part B** holds the sub-tasks. Each has an ID (`<milestone>.<n>`), the sub-tasks it depends on, a short deliverables checklist, a "done when" check and the spec references.
- The **Deliverables** and **Done when** lines restate what the plan already says (they add no new requirements). If a deliverable line and `BUILD_PLAN.md` ever differ, `BUILD_PLAN.md` wins.
- Milestones must be done **in order** (§14): do not start a milestone before the previous one is done, and commit after each milestone. Milestone 0 ends with a stop for the developer's review.
- Inside a milestone, work the sub-tasks in the order listed unless a different order is stated in "Depends on".

## Where each section of the plan lives

| Plan section | Placed in |
| --- | --- |
| §1 Summary, §2 Scope, §3 User flows, §5 Tech stack, §9 Project structure, §10 rules, §11 Testing, §12 Config, §13 NFRs, §14 Coding-agent rules | Part A (whole) |
| §4 Features and acceptance criteria (F1 – F18) | Part B, under the sub-tasks that build each feature |
| §6 Architecture (6.1 – 6.10) | Part B, under the sub-tasks that build each part |
| §7 Data model, §8 API / interfaces | Part B, under the sub-tasks that create or use them (§7 in full under 2.1) |
| §10 Build order (milestones 0 – 13) | Part B structure: one section per milestone, each pointing to its text in §10 |

## Contents

| Milestone | Sub-tasks |
| --- | --- |
| [0 — Spike](#milestone-0--spike-no-application-code) | 0.1 – 0.9 |
| [1 — Skeleton](#milestone-1--skeleton) | 1.1 – 1.5 |
| [2 — Projects and settings](#milestone-2--projects-and-settings) | 2.1 – 2.7 |
| [3 — Agent runner and egress](#milestone-3--agent-runner-and-egress) | 3.1 – 3.8 |
| [4 — Intake, queue and state machine](#milestone-4--intake-queue-and-state-machine) | 4.1 – 4.7 |
| [5 — Knowledge base, plan and plan gate](#milestone-5--knowledge-base-plan-and-plan-gate) | 5.1 – 5.8 |
| [6 — Breakdown and gate](#milestone-6--breakdown-and-gate) | 6.1 – 6.4 |
| [7 — Subtask TDD loop](#milestone-7--subtask-tdd-loop) | 7.1 – 7.9 |
| [8 — Review, KB update and CI](#milestone-8--review-kb-update-and-ci) | 8.1 – 8.6 |
| [9 — Support queries, hold and retry](#milestone-9--support-queries-hold-and-retry) | 9.1 – 9.3 |
| [10 — Usage gate](#milestone-10--usage-gate) | 10.1 – 10.3 |
| [11 — Jira MCP mode](#milestone-11--jira-mcp-mode-skipped-if-the-spike-found-it-impossible) | 11.1 – 11.4 |
| [12 — Metrics and charts](#milestone-12--metrics-and-charts) | 12.1 – 12.3 |
| [13 — Hardening and reuse](#milestone-13--hardening-and-reuse) | 13.1 – 13.5 |

---

# Part A — Global context (applies to every sub-task; read these sections of `BUILD_PLAN.md` first)

- §1 Summary and design principles — `BUILD_PLAN.md` L5–18

- §2 Scope (v1, out of scope, known limitations) — `BUILD_PLAN.md` L20–56

- §3 User flows (3.1 – 3.8) — `BUILD_PLAN.md` L58–129

- §5 Tech stack — `BUILD_PLAN.md` L283–305

- §9 Project structure — `BUILD_PLAN.md` L760–801

- §10 Build order (rules) — `BUILD_PLAN.md` L803–805

- §11 Testing (fake-claude, unit, integration, e2e, edge cases, commands) — `BUILD_PLAN.md` L918–966

- §12 Config and environment — `BUILD_PLAN.md` L968–1014

- §13 Non-functional requirements — `BUILD_PLAN.md` L1016–1036

- §14 Instructions for the coding agent — `BUILD_PLAN.md` L1038–1046

---

# Part B — Sub-tasks

## Milestone 0 — Spike (no application code)

- Milestone 0 as written in the plan — `BUILD_PLAN.md` L807–820

### 0.1 Agent image and first `claude -p` run

**Depends on:** none
**Deliverables:**
- Build the agent image with Claude Code installed.
- Run `claude -p` on a trivial prompt with `CLAUDE_CODE_OAUTH_TOKEN`, as a non-root user.
- Record the CLI version (it becomes the `CLAUDE_CODE_VERSION` build arg) in `SPIKE.md`, with the exact command and output.

**Done when:** `SPIKE.md` has the command, output and CLI version for plan task 1.

**Spec references**

- §6.4 Running an AI stage — `BUILD_PLAN.md` L394–419

### 0.2 stream-json output and `rate_limit_event`

**Depends on:** 0.1
**Deliverables:**
- Run with `--output-format stream-json --verbose`.
- Record every field of `rate_limit_event`, whether a utilization value and a 7-day figure exist, and the scale of the values.

**Done when:** `SPIKE.md` documents plan task 2 with proof.

**Spec references**

- §6.7 Usage gate — `BUILD_PLAN.md` L507–518
- §6.4 Result parsing, token counts and rate-limit event — `BUILD_PLAN.md` L418–419

### 0.3 `--json-schema` with stream-json

**Depends on:** 0.2
**Deliverables:**
- Check `--json-schema` together with stream-json and record where `structured_output` appears.
- If it does not work, confirm the fenced-JSON fallback in §6.4 works.

**Done when:** `SPIKE.md` documents plan task 3 with proof.

**Spec references**

- §6.4 Result parsing — `BUILD_PLAN.md` L418–419
- §6.5 Stage outputs — `BUILD_PLAN.md` L436–457

### 0.4 CLI flags and turn-limit behaviour

**Depends on:** 0.1
**Deliverables:**
- Check the flags used in §6.4: `--max-turns`, `--disallowedTools`, `--append-system-prompt`, `--dangerously-skip-permissions`, model aliases.
- Record what happens at the turn limit.

**Done when:** `SPIKE.md` documents plan task 4 with proof.

**Spec references**

- §6.4 Entrypoint run-stage and its inputs — `BUILD_PLAN.md` L401–415
- §6.8 Failure handling — `BUILD_PLAN.md` L520–538

### 0.5 Hiding `CLAUDE.md` with an empty bind mount

**Depends on:** 0.1
**Deliverables:**
- Check that bind-mounting an empty file over `/workspace/CLAUDE.md` hides it from Claude Code.
- If not, record that mode `ours` must behave as `both`.

**Done when:** `SPIKE.md` documents plan task 5 with proof.

**Spec references**

- §6.4 Mounts (CLAUDE.md mode `ours`) and prompt/system layering — `BUILD_PLAN.md` L399, L434

### 0.6 Squid allowlist and required domains

**Depends on:** 0.1
**Deliverables:**
- Run behind Squid with the allowlist from §6.1 and record every domain Claude Code needs.
- Update `squid.conf` accordingly.

**Done when:** `SPIKE.md` documents plan task 6 with proof.

**Spec references**

- §6.1 Containers and networks (incl. Squid configuration) — `BUILD_PLAN.md` L309–359

### 0.7 Jira MCP feasibility

**Depends on:** 0.1, 0.6
**Deliverables:**
- Connect Atlassian's official Jira MCP server from the agent image without a browser.
- Record how it authenticates and refreshes its token, the host, and the tool names (these fill `jiraMcp.readTools` and `jiraMcp.writeTools`).
- If it cannot work headlessly, record why; then milestone 11 is skipped and the README states that MCP mode is unavailable.

**Done when:** `SPIKE.md` documents plan task 7 with proof, or the reason it is impossible.

**Spec references**

- F3 Intake (MCP mode) — `BUILD_PLAN.md` L153–165
- GlobalSettings (`jiraMcp`) — `BUILD_PLAN.md` L624–630

### 0.8 `gh` command check

**Depends on:** none
**Deliverables:**
- Run the `gh` commands of §6.3 against a throwaway repository: draft PR, checks JSON shape, ready, comment, edit, view.

**Done when:** `SPIKE.md` documents plan task 8 with proof.

**Spec references**

- §6.3 Jira and GitHub clients — `BUILD_PLAN.md` L375–392

### 0.9 Finish `SPIKE.md` and stop for review

**Depends on:** 0.1 – 0.8
**Deliverables:**
- `SPIKE.md` complete.
- Any deviation from the plan proposed in a "Deviations" section of `SPIKE.md`.
- **Stop** and wait for the developer's review. Do not change the plan and do not start milestone 1 until told to.

**Done when:** `SPIKE.md` is complete and the developer has reviewed it.

**Spec references**

- §10 Milestone 0 (stop rule) — `BUILD_PLAN.md` L807–820
- §14 Instructions for the coding agent — `BUILD_PLAN.md` L1038–1046

---

## Milestone 1 — Skeleton

- Milestone 1 as written in the plan — `BUILD_PLAN.md` L822–829

### 1.1 Monorepo scaffolding

**Depends on:** 0.9
**Deliverables:**
- npm workspaces (`apps/*`, `packages/*`), Turborepo (`turbo.json` tasks: build, dev, test, lint, typecheck).
- The folder layout of §9, TypeScript strict configs, lint and test scripts.
- `.env.example` listing every variable with comments.

**Done when:** `npm test` passes through Turborepo on the empty skeleton.

**Spec references**

- §9 Project structure — `BUILD_PLAN.md` L760–801
- §5 Tech stack — `BUILD_PLAN.md` L283–305
- §12 Development — `BUILD_PLAN.md` L1006–1014

### 1.2 Docker Compose, images and networks

**Depends on:** 1.1
**Deliverables:**
- `docker-compose.yml` with `postgres`, `api`, `worker` (idle placeholder), `dashboard`, `proxy`, the three networks, and the `agent-image` build profile.
- `docker/worker`, `docker/proxy` and `docker/agent` build contexts as far as this milestone needs them.
- `api` runs `prisma migrate deploy` on start when migrations exist; health check on `/health`.

**Done when:** `docker compose up` starts every service.

**Spec references**

- §6.1 Containers and networks — `BUILD_PLAN.md` L309–339
- §6.2 Workspaces and git (DATA_DIR bind mount, npm cache volume) — `BUILD_PLAN.md` L363–367, L373
- §12 Environment variables — `BUILD_PLAN.md` L970–988
- §12 Setup and run — `BUILD_PLAN.md` L996–1004

### 1.3 API foundation: `/health` and error format

**Depends on:** 1.1
**Deliverables:**
- NestJS API with `main.ts` (API) and `worker.ts` (worker entrypoint) in `apps/api`.
- `GET /health` returning `{ ok: true }` with no auth.
- The shared error body format `{ "error": "<code>", "message": "...", "fields"?: { ... } }`.

**Done when:** `/health` answers and errors use the documented format.

**Spec references**

- §8 API / interfaces (intro and Auth and system) — `BUILD_PLAN.md` L675–685

### 1.4 Authentication (F1)

**Depends on:** 1.3
**Deliverables:**
- `POST /auth/login`, `POST /auth/logout`, session cookie, 401 on every other route without a session.
- Login rate limit per IP; argon2 password hashing at API startup; `Session` table with hashed tokens.

**Done when:** login works and unauthenticated API calls return 401.

**Spec references**

- F1 Auth — `BUILD_PLAN.md` L133–138
- Session model — `BUILD_PLAN.md` L672–673
- §8 Auth and system — `BUILD_PLAN.md` L679–685

### 1.5 Dashboard shell: login page, left rail, theme

**Depends on:** 1.4
**Deliverables:**
- Next.js (App Router) + Tailwind dashboard; `/api/*` rewrite to `http://api:4000/*`.
- Login page; left-rail shell behind auth; Tailwind theme with light and dark.

**Done when:** `docker compose up` starts every service, login works through the dashboard, and `npm test` passes.

**Spec references**

- §6.10 Dashboard layout (visual language, navigation) — `BUILD_PLAN.md` L587–590
- F16 Dashboard pages — `BUILD_PLAN.md` L261–264
- §6.1 `dashboard` service row — `BUILD_PLAN.md` L335

---

## Milestone 2 — Projects and settings

- Milestone 2 as written in the plan — `BUILD_PLAN.md` L831–837

### 2.1 Prisma schema and first migration

**Depends on:** 1.2
**Deliverables:**
- Prisma schema for every model in §7, the first migration, migration on API start.

**Done when:** a fresh database migrates on API start and all models exist.

**Spec references**

- §7 Data model (all models) — `BUILD_PLAN.md` L599–673

### 2.2 Shared Zod schemas

**Depends on:** 1.1
**Deliverables:**
- `ProjectSettings`, `GlobalSettings` and DTO schemas in `packages/shared`, with defaults and validation.
- Stage-envelope schemas are added in 3.5.

**Done when:** unit tests cover defaults and validation of the settings schemas.

**Spec references**

- ProjectSettings and GlobalSettings — `BUILD_PLAN.md` L612–630
- Project model (stack prefills) — `BUILD_PLAN.md` L603–611
- §11 Unit tests (Zod) — `BUILD_PLAN.md` L929

### 2.3 Project CRUD and mirror-retry API

**Depends on:** 2.1, 2.2
**Deliverables:**
- Create, edit, soft-disable projects with full validation (`{files}` in the test command template, etc.) and field-level errors.
- Create stores `mirrorStatus` pending. `POST /projects/:id/mirror/retry`.

**Done when:** every project setting round-trips through the API and database with validation errors returned.

**Spec references**

- F2 Projects and settings — `BUILD_PLAN.md` L140–151
- §8 Projects — `BUILD_PLAN.md` L693–704

### 2.4 System and global-settings API

**Depends on:** 2.1, 2.2
**Deliverables:**
- `GET /system`, `PATCH /system/settings`, pause/resume, usage-ignore and intake pause/resume endpoints (the usage-gate logic itself is milestone 10).

**Done when:** global settings round-trip with validation.

**Spec references**

- §8 Auth and system — `BUILD_PLAN.md` L679–691
- GlobalSettings — `BUILD_PLAN.md` L624–630

### 2.5 Worker skeleton: advisory lock and mirror cloning

**Depends on:** 2.1
**Deliverables:**
- Worker entrypoint with a Postgres advisory lock so a second worker process refuses to start.
- Loop skeleton that clones the bare mirror for `pending` projects, checks the base branch exists, and sets `mirrorStatus` to `ok` or `failed` with `mirrorError`.
- `GIT_ASKPASS` helper (`docker/worker/git-askpass-token`) and the worker image with git and gh.

**Done when:** a created project's mirror is cloned by the worker; integration cases cover success, missing base branch and bad URL.

**Spec references**

- F4 Queue and worker loop — `BUILD_PLAN.md` L167–171
- §6.2 Workspaces and git (layout, mirror, auth) — `BUILD_PLAN.md` L361–368
- F2 (mirrorStatus behaviour) — `BUILD_PLAN.md` L142
- §11 Integration (mirror clone) — `BUILD_PLAN.md` L951

### 2.6 Project settings UI

**Depends on:** 2.3
**Deliverables:**
- Projects list and New/Edit pages with sections Repository, Commands, Knowledge base, Instructions, Jira, Stages, Gates, PR, Limits.
- Stack selection pre-fills the three commands; stage-dependency warnings; field-level errors; mirror status (Cloning / Ready / Failed with retry); empty install/typecheck warning.

**Done when:** every setting round-trips through the UI and database with validation errors shown.

**Spec references**

- §6.10 Projects page — `BUILD_PLAN.md` L594
- F2 Projects and settings — `BUILD_PLAN.md` L140–151
- Project and ProjectSettings models — `BUILD_PLAN.md` L603–623

### 2.7 Global settings UI

**Depends on:** 2.4, 1.5
**Deliverables:**
- Settings page: thresholds, poll intervals, stage timeout, retention, model aliases, Jira MCP tool lists.

**Done when:** global settings round-trip through the UI with validation errors shown.

**Spec references**

- §6.10 Settings (global) — `BUILD_PLAN.md` L597
- GlobalSettings — `BUILD_PLAN.md` L624–630

---

## Milestone 3 — Agent runner and egress

- Milestone 3 as written in the plan — `BUILD_PLAN.md` L839–845

### 3.1 Agent image: `run-stage` and `run-cmd`

**Depends on:** 0.9
**Deliverables:**
- `docker/agent` Dockerfile (Node 24, Claude Code pinned by `CLAUDE_CODE_VERSION`, non-root `node`), `run-stage` and `run-cmd` scripts per §6.4.

**Done when:** the image builds under the `build` profile and both entrypoints behave as specified.

**Spec references**

- §6.4 Running an AI stage — `BUILD_PLAN.md` L394–419
- §5 Agent CLI row — `BUILD_PLAN.md` L300

### 3.2 Squid egress proxy

**Depends on:** 1.2
**Deliverables:**
- `docker/proxy` Dockerfile, `squid.conf` with both ports (3128 and 3129), entrypoint writing `JIRA_MCP_HOST` to `/etc/squid/mcp_domains.txt`, extra domains from the spike.

**Done when:** a request to a non-allowlisted host from an agent container fails and the Anthropic host succeeds.

**Spec references**

- §6.1 Services, networks and Squid configuration — `BUILD_PLAN.md` L330–359

### 3.3 `AgentRunner`: container lifecycle

**Depends on:** 3.1, 3.2, 2.5
**Deliverables:**
- dockerode runner: image, user, `--cap-drop=ALL`, `no-new-privileges`, memory/CPU/pids limits, network `sdlc_agent_net`, label, name, mounts, environment.
- Stage timeout (`stageTimeoutMin`), kill via `killRequested` polled every 2 seconds, container removal, `Verify.runCmd` via `run-cmd`.

**Done when:** an integration test runs a fake stage end to end, including a timeout and a kill.

**Spec references**

- §6.4 Running an AI stage — `BUILD_PLAN.md` L394–419
- F5 Agent stage execution — `BUILD_PLAN.md` L173–183
- §6.2 Workspaces and git (DATA_DIR layout, chown) — `BUILD_PLAN.md` L363–367, L371
- §8 Worker interfaces — `BUILD_PLAN.md` L750–758

### 3.4 Prompt and context builder

**Depends on:** 3.3
**Deliverables:**
- Writes `prompt.md` (starting with `<!-- stage: <name> -->`), `system.md`, `schema.json`, `stage.json` and context files into `DATA_DIR/runs/<stageRunId>/`.
- Stage input table, `system.md` per CLAUDE.md mode, `ours` hide-mount decision.

**Done when:** unit tests cover stage sections, `system.md` per mode and the hide-mount decision.

**Spec references**

- §6.4 Run directory, stage inputs, prompt/system layering — `BUILD_PLAN.md` L394–397, L421–434
- §11 Unit tests (prompt and context builder) — `BUILD_PLAN.md` L931

### 3.5 Result parser, stage envelopes and `StageRun` records

**Depends on:** 3.3, 2.2
**Deliverables:**
- Parse the last `result` stream line (`structured_output` or last fenced JSON block); validate with the stage Zod envelope.
- Zod schemas for the §6.5 envelope and every stage `data` shape, converted to JSON Schema.
- Store tokens, cost, turns, duration, session id and CLI version per `StageRun`; keep the latest `rate_limit_event`.
- Failure handling per §6.8 for schema failures and non-zero exits.

**Done when:** a schema failure is retried once and then fails as specified.

**Spec references**

- §6.4 Result parsing — `BUILD_PLAN.md` L418–419
- §6.5 Stage outputs — `BUILD_PLAN.md` L436–457
- StageRun model — `BUILD_PLAN.md` L651–658
- §6.8 Failure handling — `BUILD_PLAN.md` L520–538

### 3.6 Log redaction, log files, SSE endpoint and live log viewer

**Depends on:** 3.3, 1.5
**Deliverables:**
- Redact known secrets from container stdout; write `logs/<stageRunId>.log`.
- `GET /runs/:id/log` as server-sent events with an `end` event.
- Live log viewer in the dashboard (the *Runs* tab of the ticket detail page).

**Done when:** a run's log streams live in the dashboard and contains no known secrets.

**Spec references**

- F5 (logging) — `BUILD_PLAN.md` L181
- §8 Runs — `BUILD_PLAN.md` L724–729
- §6.10 Tickets (Runs tab) — `BUILD_PLAN.md` L592
- §13 Logging and security — `BUILD_PLAN.md` L1018–1023, L1034

### 3.7 `fake-claude` and the test compose overlay

**Depends on:** 3.1
**Deliverables:**
- `test/fake-claude/claude` stub and `scenarios/` as specified in §11.
- `docker-compose.test.yml` mounting `test/fake-claude/claude` over `/usr/local/bin/claude`.

**Done when:** the stub produces valid stream-json for scenario files, including `exitCode` and `delayMs`.

**Spec references**

- §11 Testing (fake-claude) — `BUILD_PLAN.md` L918–925
- §9 Project structure (test/, docker-compose.test.yml) — `BUILD_PLAN.md` L767, L799–801

### 3.8 Integration tests and live smoke test for the runner

**Depends on:** 3.3 – 3.7
**Deliverables:**
- Integration test: fake stage end to end, schema failure, timeout, kill.
- Egress test: non-allowlisted host fails, Anthropic host succeeds.
- Live smoke test (`LIVE_CLAUDE=1`) running a trivial real prompt.

**Done when:** the three conditions of the milestone's "Done when" hold.

**Spec references**

- Milestone 3 done-when — `BUILD_PLAN.md` L845
- §11 Integration tests (stage timeout, kill, schema failure; egress) — `BUILD_PLAN.md` L946, L949
- §11 Commands — `BUILD_PLAN.md` L959–966

---

## Milestone 4 — Intake, queue and state machine

- Milestone 4 as written in the plan — `BUILD_PLAN.md` L847–854

### 4.1 `StateMachine` and `StateTransition` rows

**Depends on:** 2.1
**Deliverables:**
- `StateMachine.transition(ticket, to, actor, reason, stageRunId?)` validating against the §6.6 table; every other pair rejected.
- State change + `StateTransition` row in one transaction; hold/resume semantics including `holdFromStatus`.

**Done when:** unit tests cover every transition in §6.6 and rejection of every other pair.

**Spec references**

- §6.6 State machine — `BUILD_PLAN.md` L459–484
- F15 State machine and Jira mapping — `BUILD_PLAN.md` L252–259
- StateTransition model — `BUILD_PLAN.md` L641–644
- §8 Worker interfaces (StateMachine) — `BUILD_PLAN.md` L753
- §11 Unit tests (state machine) — `BUILD_PLAN.md` L928

### 4.2 Jira status mapping: outbound and inbound approval

**Depends on:** 4.1, 4.4
**Deliverables:**
- Apply `jiraStatusMap` after each transition (REST: find matching transition by name, case-insensitive); store `jiraSyncResult` and error on failure without blocking.
- Inbound approval statuses in REST mode.
- Mapping table UI (one row per state; dropdown from `GET /projects/:id/jira/statuses` in REST mode, free text in MCP mode).

**Done when:** a failed Jira move shows a warning without blocking; a status that does not exist is handled.

**Spec references**

- F15 State machine and Jira mapping — `BUILD_PLAN.md` L252–259
- ProjectSettings (`jiraStatusMap`, `jiraApprovalStatuses`) — `BUILD_PLAN.md` L619–620
- §8 Projects (Jira statuses) — `BUILD_PLAN.md` L695–696, L702
- §6.10 Projects page (Jira section) — `BUILD_PLAN.md` L594

### 4.3 Pasted tickets and local keys

**Depends on:** 2.3
**Deliverables:**
- `POST /tickets` creating a ticket with `source=paste`, local key `<PREFIX>-<n>` (`localKeyPrefix`, `nextLocalNumber`), type and optional feature key; paste works in every Jira mode.
- A ticket is stored once per `(projectId, key)`.

**Done when:** pasted tickets appear as `NEW`.

**Spec references**

- F3 Intake (paste, types, dedup) — `BUILD_PLAN.md` L153–155, L162–165
- §8 Tickets (paste) — `BUILD_PLAN.md` L708–709, L711
- Project and Ticket models — `BUILD_PLAN.md` L603–611, L631–640

### 4.4 `JiraRestClient`

**Depends on:** 2.2
**Deliverables:**
- `JiraClient` interface and `JiraRestClient`: search (paginated), read one issue, comment, transition, create sub-task, list statuses.
- Markdown ↔ ADF conversion both ways; retries with backoff and `Retry-After`; intake paused for 10 minutes when retries run out.

**Done when:** unit tests cover ADF conversion both ways and client behaviour with mocked `fetch`.

**Spec references**

- §6.3 Jira REST — `BUILD_PLAN.md` L375–385
- F3 Intake (REST mode) — `BUILD_PLAN.md` L153–156
- §8 Worker interfaces (JiraClient) — `BUILD_PLAN.md` L750–752
- §11 Unit tests (ADF, Jira type mapping) — `BUILD_PLAN.md` L936

### 4.5 Polling and deduplication

**Depends on:** 4.3, 4.4
**Deliverables:**
- Every `pollIntervalSec`, for each enabled project in REST mode, run the JQL and store tickets as `NEW` (fetching only key, summary, description, issuetype, labels, priority); issue-type mapping.
- Repeated polls never create duplicates; separate switches for pausing intake and pausing the pipeline.

**Done when:** polled tickets appear as `NEW`; duplicate polling creates one ticket; an empty JQL result is handled.

**Spec references**

- F3 Intake — `BUILD_PLAN.md` L153–165
- §6.6 Worker loop (housekeeping) — `BUILD_PLAN.md` L486–495
- §11 Integration (duplicate polling) and edge cases — `BUILD_PLAN.md` L948, L957

### 4.6 Worker loop: picking, pause check, restart recovery

**Depends on:** 4.1, 2.5
**Deliverables:**
- The loop of §6.6: housekeeping parts when due, pause check, pick oldest actionable ticket, run exactly one step, apply the transition.
- One `running` StageRun system-wide; on startup mark `running` runs `failed` (`worker_restart`), remove leftover `sdlc.agent=true` containers, re-queue once without counting an attempt.

**Done when:** the same ticket cannot be picked up twice; restart recovery works.

**Spec references**

- §6.6 Worker loop — `BUILD_PLAN.md` L486–505
- F4 Queue and worker loop — `BUILD_PLAN.md` L167–171
- §6.8 Failure handling — `BUILD_PLAN.md` L520–538
- §11 Integration (worker restart) and edge cases — `BUILD_PLAN.md` L946, L957

### 4.7 Tickets list and detail pages (History tab)

**Depends on:** 4.1, 4.3, 1.5
**Deliverables:**
- Tickets table with key, title, project, state badge, updated time; filters by project and state.
- Ticket detail with the *History* tab (state transitions with Jira sync results) and the API endpoints for lists, detail, transitions.

**Done when:** pasted and polled tickets are listed, every transition is recorded and visible, invalid transitions are rejected.

**Spec references**

- §6.10 Tickets — `BUILD_PLAN.md` L592
- §8 Tickets — `BUILD_PLAN.md` L706–714
- F15 (history display) — `BUILD_PLAN.md` L259

---

## Milestone 5 — Knowledge base, plan and plan gate

- Milestone 5 as written in the plan — `BUILD_PLAN.md` L856–863

### 5.1 Workspace preparation

**Depends on:** 2.5
**Deliverables:**
- `Git.prepareWorkspace(ticket)`: `git remote update --prune` on the mirror, standalone clone with `--no-hardlinks`, remote URL reset, branch checkout, branch naming and slug, `chown -R 1000:1000` before read-write stages.
- Run `installCmd` through `run-cmd`; `node_modules` stays in the workspace; shared `sdlc_npm_cache` volume.

**Done when:** a workspace for a ticket is created on the correct branch with dependencies installed; branch-name and slug unit tests pass.

**Spec references**

- §6.2 Workspaces and git — `BUILD_PLAN.md` L361–373
- §8 Worker interfaces (Git) — `BUILD_PLAN.md` L754
- §11 Unit tests (branch name and slug) — `BUILD_PLAN.md` L936

### 5.2 Orchestrator commit and push (basic)

**Depends on:** 5.1
**Deliverables:**
- `Git.commit(ticket, message)` and `Git.push(ticket)`: only the worker commits, with `git -c core.hooksPath=/dev/null commit --no-verify`, identity from `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`, never forced; a rejected push puts the ticket on hold (`needs_help`).
- The commit guard is added in 7.6; no commit message carries a `Co-Authored-By` trailer or AI attribution.

**Done when:** commits and pushes to a local bare repository work with hooks disabled.

**Spec references**

- §6.2 Commit rules — `BUILD_PLAN.md` L372
- §6.8 (push rejected) — `BUILD_PLAN.md` L520–538
- F9 (no attribution) — `BUILD_PLAN.md` L218
- §8 Worker interfaces (Git) — `BUILD_PLAN.md` L754

### 5.3 KB lookup and index

**Depends on:** 5.1
**Deliverables:**
- Read `<kbDir>/features.json`; treat a missing directory or index as empty.
- Match the ticket's `featureKey` (Jira label `feature:<key>` or the pasted field) to an index entry whose doc file exists.
- `NEW → KB → PLANNING` transitions (`kbBuild` off skips the build).

**Done when:** lookup matches, misses and handles a missing index.

**Spec references**

- F6 Knowledge base lookup and build — `BUILD_PLAN.md` L185–191
- §6.9 Knowledge base index and doc — `BUILD_PLAN.md` L540–551

### 5.4 `kbBuild` stage and docs commit

**Depends on:** 5.3, 5.2, 3.4, 3.5
**Deliverables:**
- `kbBuild` stage (workspace read-write); output restricted to existing index keys or a new doc; `isNew=false` with an unknown key fails the attempt.
- After it, only files under `kbDir` may have changed (others reverted and logged as a warning); commit `docs(<KEY>): add <featureKey> knowledge base doc`; update the index.
- `guidelines/stages/kb-build.md`.

**Done when:** with fake-claude, the docs commit appears on the ticket branch.

**Spec references**

- F6 Knowledge base lookup and build — `BUILD_PLAN.md` L185–191
- §6.4 Stage inputs (kbBuild row) — `BUILD_PLAN.md` L421–423
- §6.5 kbBuild output — `BUILD_PLAN.md` L454
- §6.9 Knowledge base index and doc — `BUILD_PLAN.md` L540–551
- §6.9 Guideline files — `BUILD_PLAN.md` L580–585
- ProjectSettings (stage defaults) — `BUILD_PLAN.md` L613–614

### 5.5 `plan` stage and Jira comment

**Depends on:** 5.3, 3.4, 3.5, 4.4
**Deliverables:**
- `plan` stage (workspace read-only): ticket, KB docs, stack guideline and CLAUDE.md layers in; `planMarkdown`, `risks[]`, `openQuestions[]` out.
- Plan saved on the ticket and posted to Jira as a comment when write-back is on.
- `guidelines/stages/plan.md`.

**Done when:** with fake-claude, a ticket goes from `NEW` to `AWAITING_PLAN_APPROVAL`.

**Spec references**

- F7 Plan and gate — `BUILD_PLAN.md` L193–199
- §6.4 Stage inputs (plan row) — `BUILD_PLAN.md` L421–422, L424
- §6.5 plan output — `BUILD_PLAN.md` L449
- ProjectSettings (jiraWriteBack) — `BUILD_PLAN.md` L617

### 5.6 Plan gate: approve, edit, reject, inbound approval

**Depends on:** 5.5, 4.2, 4.7
**Deliverables:**
- With the gate on, nothing continues until approval (dashboard, or the Jira status in `jiraApprovalStatuses.plan` in REST mode).
- Edit the plan before approving (edited text stored); on approval in REST mode re-read the issue's title and description; reject with a note re-runs `plan` with the note and previous plan.
- Endpoints `POST /tickets/:id/plan/approve` and `/plan/reject`; dashboard plan approve/edit/reject UI.

**Done when:** with fake-claude, a ticket can be edited, approved and rejected.

**Spec references**

- F7 Plan and gate — `BUILD_PLAN.md` L193–199
- §8 Tickets (plan approve/reject) — `BUILD_PLAN.md` L708–709, L715–716
- F15 (inbound approval) — `BUILD_PLAN.md` L258
- §6.6 transitions 3 – 6 — `BUILD_PLAN.md` L463–470

### 5.7 Guideline files: default CLAUDE.md, stacks, KB template

**Depends on:** 1.1
**Deliverables:**
- `guidelines/default-CLAUDE.md`, `guidelines/kb-doc-template.md`, `guidelines/stacks/ts-node.md`, `nestjs.md`, `nextjs.md`, and the stage files for `kb-build` and `plan`, with the required content.
- The remaining stage files (`breakdown`, `tests`, `implement`, `fix`, `review`, `kb-update`, `jira-intake`, `jira-sync`) and `review-checklist.md` are written in the milestone that adds the stage.

**Done when:** the files exist with the required content and are picked up by the prompt builder.

**Spec references**

- §6.9 Guideline files — `BUILD_PLAN.md` L580–585
- §6.9 Knowledge base doc template — `BUILD_PLAN.md` L551
- §9 Project structure (guidelines/) — `BUILD_PLAN.md` L792–798

### 5.8 Guidelines API and page

**Depends on:** 5.7, 1.5
**Deliverables:**
- `GET /guidelines`, `GET /guidelines/*path`, `PUT /guidelines/*path` (only `.md` under `guidelines/`; traversal rejected).
- Guidelines page: file tree and markdown editor with save. Changes apply from the next stage run.

**Done when:** a guideline can be edited in the dashboard and traversal attempts are rejected (unit test).

**Spec references**

- 3.8 Editing guidelines — `BUILD_PLAN.md` L127–129
- §8 Guidelines — `BUILD_PLAN.md` L724–727, L732–734
- §6.10 Guidelines page — `BUILD_PLAN.md` L595
- §11 Unit tests (guidelines path guard) — `BUILD_PLAN.md` L937

---

## Milestone 6 — Breakdown and gate

- Milestone 6 as written in the plan — `BUILD_PLAN.md` L865–869

### 6.1 `breakdown` stage and validation

**Depends on:** 5.6
**Deliverables:**
- `breakdown` stage (workspace read-only): `subtasks` with `seq`, `title`, `description`, `acceptanceCriteria[]` (at least 1), `files[]`, `dependsOn[]`.
- Orchestrator validation: no cycle, no dependency on the same or a later `seq`, `seq` is 1..n, at most `maxSubtasks` (default 8); a rejected output counts as a failed attempt.
- `guidelines/stages/breakdown.md`.

**Done when:** unit tests cover cycles, forward dependencies, bad `seq`, too many subtasks.

**Spec references**

- F8 Breakdown and gate — `BUILD_PLAN.md` L201–206
- §6.4 Stage inputs (breakdown row) — `BUILD_PLAN.md` L421–422, L425
- §6.5 breakdown output — `BUILD_PLAN.md` L450
- §6.9 Guideline files (stage files) — `BUILD_PLAN.md` L583
- §11 Unit tests (breakdown validation) — `BUILD_PLAN.md` L930

### 6.2 Breakdown gate: edit, approve, reject

**Depends on:** 6.1
**Deliverables:**
- `BREAKDOWN → AWAITING_BREAKDOWN_APPROVAL` when the gate is on; dashboard editing of titles, descriptions, criteria and order with the same validation.
- `POST /tickets/:id/breakdown/approve` (stores the edited list; 400 on invalid list) and `/breakdown/reject` (re-runs `breakdown` with the note); approval creates ordered `Subtask` rows and moves to `IN_PROGRESS`.
- Inbound approval status for breakdown in REST mode.

**Done when:** an approved breakdown creates ordered `Subtask` rows; invalid breakdowns are rejected.

**Spec references**

- F8 Breakdown and gate — `BUILD_PLAN.md` L201–206
- §8 Tickets (breakdown approve/reject) — `BUILD_PLAN.md` L708–709, L717–718
- §6.6 transitions 7 – 10 — `BUILD_PLAN.md` L463–464, L471–474
- Subtask model — `BUILD_PLAN.md` L645–650
- F15 (inbound approval) — `BUILD_PLAN.md` L258

### 6.3 Jira sub-task creation

**Depends on:** 6.2, 4.4
**Deliverables:**
- On approval, with `jiraWriteBack.createSubtasks` on, create Jira sub-tasks (issue type `jiraSubtaskTypeName`, default "Sub-task") and store their keys on `Subtask.externalKey`.

**Done when:** Jira sub-tasks are created when write-back is on and their keys stored.

**Spec references**

- F8 (Jira sub-tasks) — `BUILD_PLAN.md` L206
- §6.3 Jira REST (sub-task) — `BUILD_PLAN.md` L375, L382
- ProjectSettings (jiraWriteBack, jiraSubtaskTypeName) — `BUILD_PLAN.md` L617–618

### 6.4 Behaviour when `plan` or `breakdown` is off

**Depends on:** 6.2
**Deliverables:**
- `plan` off: the ticket body becomes the plan (transition 4).
- `breakdown` off: the ticket runs as one subtask whose description is the plan, with acceptance criteria from an "Acceptance criteria" section of the ticket body if present, otherwise the default single criterion (transition 8).
- Stage dependency rules for the UI warnings.

**Done when:** both toggles produce the documented behaviour in tests.

**Spec references**

- F2 Stage dependency rules — `BUILD_PLAN.md` L146–151
- §6.6 transitions 4 and 8 — `BUILD_PLAN.md` L463–464, L467, L472

---

## Milestone 7 — Subtask TDD loop

- Milestone 7 as written in the plan — `BUILD_PLAN.md` L871–876

### 7.1 Subtask state handling and loop orchestration

**Depends on:** 6.2, 5.2
**Deliverables:**
- Subtask states `PENDING → TESTS → VERIFY_RED → IMPLEMENT → VERIFY_GREEN → DONE`, with `VERIFY_GREEN → FIXING → VERIFY_GREEN`; with `tests` off, `PENDING → IMPLEMENT`.
- Process subtasks in order; `IN_PROGRESS → REVIEW` when every subtask is `DONE`.

**Done when:** subtasks move through the documented states.

**Spec references**

- §6.6 Subtask states — `BUILD_PLAN.md` L484
- §6.6 transition 11 — `BUILD_PLAN.md` L463–464, L475
- Subtask model — `BUILD_PLAN.md` L645–650
- 3.3 flow (step 8) — `BUILD_PLAN.md` L88–94

### 7.2 `tests` stage and test-pattern checks

**Depends on:** 7.1, 3.4, 3.5
**Deliverables:**
- `tests` stage (workspace read-write): tests and minimal stubs; `testFiles` must exist and match the test patterns; every new or modified matching file must be listed.
- With `tests` off: the `implement` prompt adds "write tests for your change" and verify-green runs the targeted tests on changed test files if any, otherwise typecheck only.
- `guidelines/stages/tests.md`.

**Done when:** unit tests cover test-pattern checks.

**Spec references**

- F9 Subtask loop (tests stage) — `BUILD_PLAN.md` L208–210
- §6.4 Stage inputs (tests row) — `BUILD_PLAN.md` L421–422, L426
- §6.5 tests output — `BUILD_PLAN.md` L451
- F2 (tests off) — `BUILD_PLAN.md` L149
- §6.9 Guideline files (stage files) — `BUILD_PLAN.md` L583

### 7.3 Verify-red and the `test:` commit

**Depends on:** 7.2
**Deliverables:**
- `Verify.runCmd` / `Verify.red`: typecheck passes AND targeted tests exit non-zero AND output matches none of `verify.redInvalidPatterns`; otherwise retry `tests` once, then hold (`needs_help`).
- Empty install/typecheck commands are skipped with a warning.
- Commit `test(<KEY>): <subtask title>` and record `testCommit`.

**Done when:** unit tests cover verify-red decisions and `redInvalidPatterns`.

**Spec references**

- F9 Verify-red and test commit — `BUILD_PLAN.md` L211–212
- F2 (commands) — `BUILD_PLAN.md` L143
- ProjectSettings (verify) — `BUILD_PLAN.md` L623
- §6.4 run-cmd — `BUILD_PLAN.md` L417
- §8 Worker interfaces (Verify) — `BUILD_PLAN.md` L756
- §6.8 (verify-red invalid) — `BUILD_PLAN.md` L520–528
- §11 Unit tests (verify) — `BUILD_PLAN.md` L932

### 7.4 `implement` stage and verify-green

**Depends on:** 7.3
**Deliverables:**
- `implement` stage (workspace read-write): ticket, plan, subtask, KB doc, `testFiles`; edits files only.
- Verify-green: restore `testFiles` modified since `testCommit` (`git checkout <testCommit> -- <files>`), run install if `package.json` or the lockfile changed, typecheck, targeted tests.
- `guidelines/stages/implement.md`.

**Done when:** tampering with a test file is undone and the original tests decide.

**Spec references**

- F9 Implement and verify-green — `BUILD_PLAN.md` L213–214
- §6.4 Stage inputs (implement row) — `BUILD_PLAN.md` L421–422, L427
- §6.5 implement/fix output — `BUILD_PLAN.md` L452
- §11 Integration (test-file tampering) — `BUILD_PLAN.md` L945

### 7.5 `fix` stage and fix rounds

**Depends on:** 7.4
**Deliverables:**
- On verify-green failure run `fix` with the last 60 lines of failure output, then verify-green again, up to `maxTestFixRounds` (default 2); then hold (`needs_help`).
- `StageRun.reason = tests` on those runs.
- `guidelines/stages/fix.md`.

**Done when:** a failing implementation triggers fix rounds and then `needs_help`.

**Spec references**

- F9 (fix rounds) — `BUILD_PLAN.md` L215
- §6.4 Stage inputs (fix row) — `BUILD_PLAN.md` L421–422, L428
- ProjectSettings (limits) — `BUILD_PLAN.md` L622
- StageRun model (reason) — `BUILD_PLAN.md` L653
- §6.8 (verify-green failing) — `BUILD_PLAN.md` L520–529

### 7.6 Commit guard and agent-made commits

**Depends on:** 5.2
**Deliverables:**
- Before every orchestrator commit fail the stage if the change includes `node_modules/`, any `.env*` file, key or certificate files (`*.pem`, `*.key`), or any file over 1 MB.
- If the agent made its own commits, `git reset --soft` to the pre-stage HEAD and commit from the orchestrator.

**Done when:** unit tests cover `node_modules`, `.env*`, key files, files over 1 MB and agent-made commits squashed back.

**Spec references**

- F9 Commit guard — `BUILD_PLAN.md` L217–218
- §6.2 Commit rules — `BUILD_PLAN.md` L372
- §6.8 (commit guard fails) — `BUILD_PLAN.md` L520–530
- §11 Unit tests (commit guard) — `BUILD_PLAN.md` L933

### 7.7 `feat:` commit and push

**Depends on:** 7.4, 7.6
**Deliverables:**
- Commit `feat(<KEY>): <subtask title>` after verify-green passes, record `featCommit`, push (never forced; rejected push → hold `needs_help`), subtask `DONE`.

**Done when:** a two-subtask ticket produces four commits in order (`test:` then `feat:` per subtask).

**Spec references**

- F9 (feat commit and push) — `BUILD_PLAN.md` L216
- §6.2 Commit rules — `BUILD_PLAN.md` L372
- §6.8 (push rejected) — `BUILD_PLAN.md` L520–531
- Subtask model — `BUILD_PLAN.md` L645–650

### 7.8 Early draft PR and PR description

**Depends on:** 7.7
**Deliverables:**
- After the first subtask open a draft PR against the base branch (`pr.earlyDraft` on; with it off the PR opens after the last subtask) via `gh pr create --draft`, storing `prNumber` and `prUrl`.
- PR description assembled by the orchestrator without AI (template in §6.9).

**Done when:** a draft PR is opened after the first subtask with the description template.

**Spec references**

- F9 (draft PR) — `BUILD_PLAN.md` L216
- §6.3 GitHub — `BUILD_PLAN.md` L386–388
- §6.9 PR description — `BUILD_PLAN.md` L565–578
- ProjectSettings (pr) — `BUILD_PLAN.md` L621
- §8 Worker interfaces (GitHub) — `BUILD_PLAN.md` L755

### 7.9 Integration scenarios for the TDD loop

**Depends on:** 7.1 – 7.8
**Deliverables:**
- Fake-claude scenarios and integration tests: two-subtask ticket with four commits in order; failing implementation → fix rounds → `needs_help`; test-file tampering undone; verify-red invalid (module not found) retries once then holds; draft PR after the first subtask; repository without a typecheck command; push rejected.

**Done when:** the milestone's "Done when" holds.

**Spec references**

- Milestone 7 done-when — `BUILD_PLAN.md` L876
- §11 Integration tests — `BUILD_PLAN.md` L940–951
- §11 Edge cases — `BUILD_PLAN.md` L957

---

## Milestone 8 — Review, KB update and CI

- Milestone 8 as written in the plan — `BUILD_PLAN.md` L878–884

### 8.1 `review` stage and findings storage

**Depends on:** 7.8
**Deliverables:**
- `review` stage (workspace read-only): round 1 gets the diff base→HEAD (lockfiles, `dist/`, snapshots and generated files excluded), acceptance criteria and review checklist; round 2 gets previous findings and only the diff since the last reviewed commit.
- Above `reviewMaxDiffLines` (default 4000) pass the diff stat and tell it to read the diff file by file.
- Findings `{ severity, file, line, issue, rule, fix }`, at most 10 per round, stored as `ReviewFinding`.
- `guidelines/review-checklist.md` and `guidelines/stages/review.md`.

**Done when:** findings are stored per round; round 2 sees only new changes.

**Spec references**

- F10 Review — `BUILD_PLAN.md` L220–225
- §6.4 Stage inputs (review row) — `BUILD_PLAN.md` L421–422, L429
- §6.5 review output — `BUILD_PLAN.md` L453
- ReviewFinding model — `BUILD_PLAN.md` L659–661
- §6.9 Guideline files — `BUILD_PLAN.md` L580–585

### 8.2 Review comment, fix on findings and exit rule

**Depends on:** 8.1, 7.5
**Deliverables:**
- Post the review as one PR comment (template in §6.9) via `gh pr comment`.
- With open critical/high findings and fewer than `maxReviewRounds` (default 2) rounds, run `fix` on those findings only, commit `fix(<KEY>): address review round <n>`, and review again; otherwise end the loop and leave the remaining findings listed.
- Exhausting the review rounds is not a failure.

**Done when:** unit tests cover the review exit rule, round handling and comment rendering.

**Spec references**

- F10 Review — `BUILD_PLAN.md` L220–225
- §6.9 Review comment — `BUILD_PLAN.md` L553–563
- §3.7 (review rounds are not a failure) — `BUILD_PLAN.md` L124
- Ticket model (reviewRound, lastReviewedSha) — `BUILD_PLAN.md` L638
- §6.3 GitHub (comment) — `BUILD_PLAN.md` L388
- §11 Unit tests (review exit rule, rendering) — `BUILD_PLAN.md` L934

### 8.3 `kbUpdate` stage, commit and re-run action

**Depends on:** 8.2, 5.4
**Deliverables:**
- `kbUpdate` stage: ticket diff + existing doc in; updates the doc in place following the template, at most `kbDocMaxLines` (default 300); `done` with no change if unaffected.
- Commit `docs(<KEY>): update <featureKey> knowledge base`, update `builtFromCommit` and `updatedAt`, same "only `kbDir` changed" check as F6.
- "Re-run KB update" action (`POST /tickets/:id/kb-update/rerun`, only in `IN_HUMAN_REVIEW`).
- `guidelines/stages/kb-update.md`.

**Done when:** the KB update commit appears on the ticket branch and the re-run action works.

**Spec references**

- F11 KB update — `BUILD_PLAN.md` L227–231
- §6.4 Stage inputs (kbUpdate row) — `BUILD_PLAN.md` L421–422, L430
- §6.5 kbUpdate output — `BUILD_PLAN.md` L455
- §6.9 Knowledge base index and doc — `BUILD_PLAN.md` L540–551
- §8 Tickets (kb-update rerun) — `BUILD_PLAN.md` L708–709, L722

### 8.4 CI polling and CI fix round

**Depends on:** 8.3
**Deliverables:**
- While `AWAITING_CI`, poll `gh pr checks` every 30 seconds up to `ciTimeoutMin` (default 30), without blocking other work; a PR with no checks counts as passing.
- If checks fail, `pr.ciFixRound` is on and no CI fix has run: `fix` with the last 60 lines of the failing log (`gh run list` / `gh run view --log-failed`), commit `fix(<KEY>): resolve CI failure`, push, poll again.
- Still failing or timed out: hold (`needs_help`), PR stays a draft.

**Done when:** CI-never-finishes and CI-fail-then-fixed cases pass in tests.

**Spec references**

- F12 CI check and PR ready — `BUILD_PLAN.md` L233–238
- §6.3 GitHub (checks, failing log) — `BUILD_PLAN.md` L386, L389–390
- Ticket model (ciFixPending, ciFixDone) — `BUILD_PLAN.md` L638
- ProjectSettings (pr) — `BUILD_PLAN.md` L621
- §6.6 transitions 13 – 14 — `BUILD_PLAN.md` L463–464, L477–478
- §6.6 Worker loop (AWAITING_CI) — `BUILD_PLAN.md` L486–503

### 8.5 PR ready, description rewrite and `IN_HUMAN_REVIEW`

**Depends on:** 8.4
**Deliverables:**
- When checks pass: `gh pr ready`, rewrite the PR description (§6.9), post the review summary comment, move the ticket to `IN_HUMAN_REVIEW`.
- With the Jira mapping, the status change follows the transition.

**Done when:** a ticket runs from the last subtask to `IN_HUMAN_REVIEW`.

**Spec references**

- F12 CI check and PR ready — `BUILD_PLAN.md` L233–238
- §6.3 GitHub (ready, edit) — `BUILD_PLAN.md` L391
- §6.9 PR description and review comment — `BUILD_PLAN.md` L553–578
- 3.3 flow (steps 9 – 13) — `BUILD_PLAN.md` L95–99

### 8.6 Merge and close detection

**Depends on:** 8.5
**Deliverables:**
- Every `pollIntervalSec`, poll PRs of `IN_HUMAN_REVIEW` tickets (`gh pr view --json state,mergedAt`): merged → `DONE`; closed without merge → hold (`pr_closed`).

**Done when:** a merge moves the ticket to `DONE` and a closed PR puts it on hold.

**Spec references**

- F12 (merge and close) — `BUILD_PLAN.md` L238
- §6.3 GitHub (state) — `BUILD_PLAN.md` L392
- §6.6 transitions 15 – 16 — `BUILD_PLAN.md` L463–464, L479–480
- §6.8 (PR closed) — `BUILD_PLAN.md` L520–533
- §11 Edge cases — `BUILD_PLAN.md` L957

---

## Milestone 9 — Support queries, hold and retry

- Milestone 9 as written in the plan — `BUILD_PLAN.md` L886–891

### 9.1 `needs_input` flow and support-query re-queue

**Depends on:** 8.6
**Deliverables:**
- A stage returning `status: needs_input` with a `question` creates a `SupportQuery`, puts the ticket on hold (`awaiting_answer`) and the next actionable ticket starts.
- Answering stores the answer and re-queues the same stage with fresh context; the prompt includes all earlier questions and answers for that stage.
- A stage may ask at most 3 questions per ticket; the 4th holds the ticket (`needs_help`).

**Done when:** a stage question puts a ticket on hold, the next ticket starts, and answering resumes the stage with the answer in its prompt.

**Spec references**

- F13 Support queries — `BUILD_PLAN.md` L240–244
- 3.5 Support query — `BUILD_PLAN.md` L107–112
- §6.5 Stage outputs (envelope) — `BUILD_PLAN.md` L436–447
- SupportQuery model — `BUILD_PLAN.md` L662–665
- §6.8 (support queries) — `BUILD_PLAN.md` L520–534
- §11 Integration (needs_input) — `BUILD_PLAN.md` L943

### 9.2 Support API and page

**Depends on:** 9.1, 1.5
**Deliverables:**
- `GET /support-queries` and `POST /support-queries/:id/answer` (409 if already answered).
- Support page: open questions first, each with ticket, stage, question and an answer box.

**Done when:** a question can be answered in the dashboard and re-queues the stage.

**Spec references**

- §8 Support queries — `BUILD_PLAN.md` L724–727, L730–731
- §6.10 Support page — `BUILD_PLAN.md` L593

### 9.3 Hold, resume, retry and kill actions

**Depends on:** 9.1, 4.1, 3.3
**Deliverables:**
- `POST /tickets/:id/hold`, `/resume`, `/retry` and `POST /runs/:id/kill`, with the semantics of §6.8 (retry re-runs the failed or in-progress stage fresh with counters reset; a killed run becomes `killed` and the ticket goes on hold `manual`).
- An open PR stays a draft and receives a comment explaining why when a ticket goes on hold for `needs_help`.
- Ticket-page buttons for hold, resume, retry and kill.

**Done when:** each of the hold reasons in §3.7 is reachable and recoverable with Retry.

**Spec references**

- 3.7 Hold, needs help and retry — `BUILD_PLAN.md` L121–125
- §6.8 Failure handling — `BUILD_PLAN.md` L520–538
- §6.6 transitions 16 – 18 — `BUILD_PLAN.md` L463–464, L480–482
- F5 (kill) — `BUILD_PLAN.md` L183
- §8 Tickets (hold, resume, retry) — `BUILD_PLAN.md` L708–709, L719–721
- §8 Runs (kill) — `BUILD_PLAN.md` L724–728
- F16 Dashboard pages — `BUILD_PLAN.md` L261–264

---

## Milestone 10 — Usage gate

- Milestone 10 as written in the plan — `BUILD_PLAN.md` L893–897

### 10.1 Usage snapshots and `UsageGate.evaluate`

**Depends on:** 3.5, 4.6
**Deliverables:**
- Record a `UsageSnapshot` after every AI stage, using the latest `rate_limit_event`; `fiveHourPct`/`sevenDayPct` from the event (scale constant from `SPIKE.md`) or from `windowTokens / calibratedWindowTokens × 100`.
- `UsageGate.evaluate(run): { pause, reason, resetsAt }` following the six numbered rules of §6.7; a rate-limit error is treated as `rejected` and the stage is re-queued without counting an attempt.

**Done when:** unit and integration tests cover every branch of §6.7.

**Spec references**

- F14 Usage gate — `BUILD_PLAN.md` L246–250
- §6.7 Usage gate — `BUILD_PLAN.md` L507–518
- UsageSnapshot model — `BUILD_PLAN.md` L666–668
- §8 Worker interfaces (UsageGate) — `BUILD_PLAN.md` L757
- §11 Unit and integration (usage gate) — `BUILD_PLAN.md` L934–935, L947

### 10.2 Pause, resume and ignore actions

**Depends on:** 10.1, 2.4
**Deliverables:**
- Pausing sets `pipelinePaused`, `pausedReason`, `resetsAt`; the pipeline never resumes by itself.
- **Resume** clears the pause; **Ignore usage for this window** sets `usageIgnoredUntil` (current window's reset, or the chosen duration, default 5 hours) and clears the pause; `rejected` still pauses while ignoring.
- Pause, resume and ignore written to the audit log (`Event`).

**Done when:** pause at the 5-hour and 7-day thresholds, Resume, pause then Ignore, and `rejected` while ignoring all behave as specified.

**Spec references**

- F14 Usage gate — `BUILD_PLAN.md` L246–250
- 3.6 Usage pause — `BUILD_PLAN.md` L114–119
- §8 Auth and system (pause, resume, usage/ignore) — `BUILD_PLAN.md` L681–682, L689–691
- §11 Integration (pause scenarios) — `BUILD_PLAN.md` L947

### 10.3 Pause banner and Usage page

**Depends on:** 10.2, 1.5
**Deliverables:**
- Top bar showing pipeline state and the paused banner (reason, reset time) with Resume and Ignore buttons.
- Usage page: snapshots table (`GET /usage/snapshots`), tokens by stage and model, and the calibration field (suggested `calibratedWindowTokens` = `windowTokens` at the last `rejected` snapshot).

**Done when:** the dashboard shows the reason and reset time when paused.

**Spec references**

- §6.10 Navigation and Usage page — `BUILD_PLAN.md` L590, L596
- §6.7 (calibration) — `BUILD_PLAN.md` L518
- §8 Metrics (usage snapshots) — `BUILD_PLAN.md` L736–737, L746

---

## Milestone 11 — Jira MCP mode (skipped if the spike found it impossible)

- Milestone 11 as written in the plan — `BUILD_PLAN.md` L899–903

### 11.1 `JiraMcpClient`, `mcp.json` and the 3129 proxy port

**Depends on:** 0.7, 3.2, 4.4
**Deliverables:**
- `JiraMcpClient` implementing the `JiraClient` interface.
- `mcp.json` generation from `JIRA_MCP_CONFIG_PATH`; `--mcp-config … --strict-mcp-config`, allowed tools per the project's read/write lists, `Bash,Read,Edit,Write,Grep,Glob` disallowed, proxy port 3129.
- Proxy `mcp_domains` from `JIRA_MCP_HOST`.

**Done when:** the client runs a call against a fake MCP server through port 3129.

**Spec references**

- F3 Intake (MCP mode) — `BUILD_PLAN.md` L153–165
- §6.1 Squid configuration — `BUILD_PLAN.md` L341–359
- §6.4 run-stage Jira additions — `BUILD_PLAN.md` L401–415
- §8 Worker interfaces (JiraClient) — `BUILD_PLAN.md` L750–752
- §12 Environment variables (MCP) — `BUILD_PLAN.md` L970–972, L978–979

### 11.2 `jiraIntake` stage and ticket validation

**Depends on:** 11.1
**Deliverables:**
- `jiraIntake` stage (default Haiku, 10 turns, no repository mount, only search/read tools in `jiraMcp.readTools`, exact JQL from settings).
- Output validated against the ticket schema; reject any ticket whose key does not match `^[A-Z][A-Z0-9]+-[0-9]+$` and the project's `jiraProjectKey`. Ticket text is data, never instructions.
- Poll interval `mcpPollIntervalSec` (default 900), skipped while paused.
- `guidelines/stages/jira-intake.md`.

**Done when:** valid intake works and malformed output is rejected against a fake MCP server.

**Spec references**

- F3 Intake (MCP mode) — `BUILD_PLAN.md` L153–165
- §6.4 Stage inputs (jiraIntake row) — `BUILD_PLAN.md` L421–422, L431
- §6.5 jiraIntake output — `BUILD_PLAN.md` L456
- §6.9 Guideline files (stage files) — `BUILD_PLAN.md` L583

### 11.3 `jiraSync` stage (MCP write-back)

**Depends on:** 11.1
**Deliverables:**
- `jiraSync` stage (default Haiku, 8 turns) for comments, transitions and sub-task creation; each call gets one fixed payload (operation, issue key, text or target status) and may call only the tools in `jiraMcp.writeTools`.
- `guidelines/stages/jira-sync.md`.

**Done when:** write-back works through `jiraSync` against a fake MCP server.

**Spec references**

- F3 Intake (MCP mode) — `BUILD_PLAN.md` L153–165
- §6.4 Stage inputs (jiraSync row) — `BUILD_PLAN.md` L421–422, L432
- §6.5 jiraSync output — `BUILD_PLAN.md` L457
- F15 (MCP mapping) — `BUILD_PLAN.md` L256

### 11.4 Per-project mode switch and MCP integration tests

**Depends on:** 11.2, 11.3, 2.6
**Deliverables:**
- UI switch for `jiraMode` (REST, MCP, off) per project.
- Integration tests against a fake MCP server: valid intake, malformed output rejected, write-back via `jiraSync`, the Jira credential reaching only those two stages.

**Done when:** the milestone's "Done when" holds.

**Spec references**

- Milestone 11 done-when — `BUILD_PLAN.md` L903
- §3.2 Add a project (Jira mode) — `BUILD_PLAN.md` L67–77
- F5 (credentials) — `BUILD_PLAN.md` L176
- §11 Integration (Jira MCP) — `BUILD_PLAN.md` L950

---

## Milestone 12 — Metrics and charts

- Milestone 12 as written in the plan — `BUILD_PLAN.md` L905–909

### 12.1 `/metrics/*` endpoints

**Depends on:** 3.5, 10.1
**Deliverables:**
- Read-only endpoints `GET /metrics/summary`, `/usage`, `/tokens` (`groupBy` stage or model), `/tickets-by-state`, `/quality`, `/durations`; range `24h`, `7d` (default) or `30d`.
- Computed from existing tables; no extra tables.

**Done when:** endpoints match the definitions in §8; unit tests cover token grouping, first-pass rate and empty ranges.

**Spec references**

- §8 Metrics — `BUILD_PLAN.md` L736–748
- F17 (data source) — `BUILD_PLAN.md` L277
- §8 Worker interfaces (Metrics) — `BUILD_PLAN.md` L758
- §11 Unit tests (metrics) — `BUILD_PLAN.md` L938

### 12.2 Overview page: cards and charts

**Depends on:** 12.1, 1.5
**Deliverables:**
- Number cards (tickets done this week, first-pass rate, tokens in the current window, queue length), range switch, and the charts: usage over time, tokens by stage, tickets by state, quality, stage duration.
- Recharts wrappers with the minimal theme in `components/charts/`; current activity card and queue list.

**Done when:** every chart renders with seeded data.

**Spec references**

- F17 Dashboard charts — `BUILD_PLAN.md` L266–277
- §6.10 Overview — `BUILD_PLAN.md` L591
- §5 Charts row — `BUILD_PLAN.md` L294

### 12.3 Ticket timeline, "view data" toggle, empty states, themes

**Depends on:** 12.2, 4.7
**Deliverables:**
- Ticket timeline chart on the ticket page (one bar per stage run on a time axis, coloured by outcome) and `GET /tickets/:id/timeline`.
- Every chart: "view data" table toggle, accessible text label, clear empty state, light/dark themes.

**Done when:** every chart renders with seeded data and with none.

**Spec references**

- F17 Dashboard charts — `BUILD_PLAN.md` L266–277
- §8 Tickets (timeline) — `BUILD_PLAN.md` L708–709, L714
- §6.10 Tickets (timeline chart) — `BUILD_PLAN.md` L592
- §13 Accessibility — `BUILD_PLAN.md` L1035

---

## Milestone 13 — Hardening and reuse

- Milestone 13 as written in the plan — `BUILD_PLAN.md` L911–916

### 13.1 Secret redaction and login rate-limit tests

**Depends on:** 3.6, 1.4
**Deliverables:**
- Tests proving secrets are redacted from logs and from everything shown in the dashboard; login rate limit (5 failures in 15 minutes → 429 for 15 minutes).

**Done when:** the tests pass.

**Spec references**

- F1 Auth — `BUILD_PLAN.md` L133–138
- F5 (log redaction) — `BUILD_PLAN.md` L181
- §13 Security — `BUILD_PLAN.md` L1018–1023
- §11 Unit tests (login rate limit) — `BUILD_PLAN.md` L937

### 13.2 Housekeeping job (F18)

**Depends on:** 4.6
**Deliverables:**
- Daily job deleting stage log files older than `logRetentionDays` (default 30) and workspaces of `DONE` tickets older than `workspaceRetentionDays` (default 7); never workspaces of tickets that are not `DONE`.

**Done when:** retention behaviour is covered by tests.

**Spec references**

- F18 Housekeeping — `BUILD_PLAN.md` L279–281
- GlobalSettings (retention) — `BUILD_PLAN.md` L628
- §6.2 DATA_DIR layout — `BUILD_PLAN.md` L363–367

### 13.3 README

**Depends on:** 13.2
**Deliverables:**
- README with setup, every environment variable, GitHub token scopes, a suggested JQL, adding a project, writing guidelines, and the known limitations (and a note that MCP mode is unavailable if the spike found it impossible).

**Done when:** a fresh clone can follow the README to a working system.

**Spec references**

- §2 Known limitations — `BUILD_PLAN.md` L53–56
- §12 Config and environment — `BUILD_PLAN.md` L968–1014
- 3.1 First run and 3.2 Add a project — `BUILD_PLAN.md` L60–77
- Milestone 13 — `BUILD_PLAN.md` L911–916

### 13.4 End-to-end suite and edge-case tests

**Depends on:** 12.3, 11.4
**Deliverables:**
- Playwright suite against the Compose test overlay: log in, create a project, paste a ticket, approve plan and breakdown, answer a support query, pause and use Ignore, open every dashboard page, check every chart with and without data.
- A test for every listed edge case, including the target repository's own `CLAUDE.md` in each of the three modes.

**Done when:** `npm test`, `npm run test:int` and `npm run test:e2e` pass.

**Spec references**

- §11 End-to-end and edge cases — `BUILD_PLAN.md` L953–966
- F5/§6.4 CLAUDE.md modes — `BUILD_PLAN.md` L399, L434

### 13.5 Full end-to-end run with live Claude

**Depends on:** 13.3, 13.4
**Deliverables:**
- One full run on a real small ticket with live Claude, with the result recorded in the README.

**Done when:** a fresh clone follows the README to a working system, and all tests pass.

**Spec references**

- Milestone 13 done-when — `BUILD_PLAN.md` L916
- §11 Commands (live smoke) — `BUILD_PLAN.md` L959–966
