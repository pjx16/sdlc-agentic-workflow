# sdlc-agent — Build Plan, version 1.0.0

Nov 14, 2026 · @Piyush Jaiswal

This plan changes the system described in [`../v0.0.0/BUILD_PLAN.md`](../v0.0.0/BUILD_PLAN.md) (the v0 plan) and in
[`docs/architecture/v1.0.0`](../../architecture/v1.0.0/README.md). Anything this plan does not mention stays as the v0
plan defines it. When the two disagree, this plan wins.

## 1. Summary

Version 1.0.0 makes the pipeline easier to run, easier to trust and easier to steer:

1. **One job per agent.** Agents that currently do two or more jobs are split, so each prompt is short, each agent
   gets only the context it needs, and each one can run on the cheapest model that suits its job.
2. **An orchestrator that decides.** The state machine still decides which moves are *legal*. When more than one
   is legal, a small AI orchestrator picks one and records why.
3. **Every stage can be rerun.** A user can send a ticket back to any stage that has already finished, with a note.
   Everything after that stage becomes stale. Loops are allowed but capped.
4. **Errors are classified and recovered by policy.** Every failure gets a code, a source (Claude, agent, workspace,
   integration, user) and a recovery rule. Errors on Claude's side are shown as such on the dashboard.
5. **An inbox for everything that needs a human.** Approvals, open questions, holds and errors that need action
   become support tickets in one inbox. The dashboard always shows what is waiting for you.
6. **A scoped AI assistant.** From any support ticket you can chat with an assistant that gets only that item's
   context. It can draft an answer or a plan change for you to apply.
7. **Plans live in Confluence.** The solution or bug analysis is published as a Confluence page and kept up to date
   there. Jira gets a link instead of the full text.
8. **Onboarding replaces the long project form.** The user gives a repo URL and, optionally, a Jira project key.
   Code fetches the facts. Two agents propose the commands, the Jira status mapping, the issue-type routing, the
   intake label and the Confluence space. The user confirms the proposal.
9. **Operations and usage you can read.**
   - a plain-English timeline per ticket
   - an operations page
   - a continuous record of Claude usage
   - usage broken down by model
   - charts of how fast the 5-hour and weekly usage percentages are rising
10. **Two fixes:**
    - The worker no longer shows as "offline" while it is busy.
    - Claude usage is recorded over time.
11. **Jira through REST only.** Jira MCP mode and its two agents are removed. Pasted tickets stay.

**Design principles (unchanged from v0, plus three)**

1. Code does everything that needs no judgment: Jira, Confluence, git, GitHub, CI polling, test checks and state
   tracking.
2. Agents only edit files. The orchestrator code makes every commit, push, PR, Jira call and Confluence call.
3. Every AI stage is a fresh, narrow, capped run.
4. **New:** one agent, one job. If a prompt says "and also", it is two agents.
5. **New:** AI chooses only among moves that code has already checked are legal. It never invents a move, and it
   never changes state on its own. The assistant only drafts; the user applies.
6. **New:** history is append-only. Branches are never force-pushed, outputs are versioned rather than
   overwritten, and every move is recorded.

## 2. Decisions taken

| # | Question | Decision |
| --- | --- | --- |
| D1 | When a stage that writes code is rerun, what happens to the branch? | **New commits on top.** Never rewrite or force-push. Stale work is removed with a revert commit (§6.6). |
| D2 | Keep pasted tickets? | **Yes.** Paste and Jira intake both stay. A project without a Jira key accepts pasted tickets only. |
| D3 | Does moving a ticket back in Jira by hand trigger a rerun? | **No, not in v1.** Only approval statuses come in from Jira, as today. Reruns start from the dashboard. |
| D4 | After a rerun, what happens to later work? | **Everything after the rerun stage becomes stale, always.** No partial keep. |
| D5 | Jira transport | **REST API only.** MCP mode is removed. |
| D6 | Document hub | **Confluence only** in v1, behind a small `DocumentHub` interface. Confluence is optional per project; without it, plans go to Jira comments as today. |
| D7 | May the assistant run while a pipeline stage runs? | **Yes, at most one assistant session at a time.** It is interactive and should not wait behind a long stage. It counts toward the usage gate and stops when the pipeline is paused for limits. |
| D8 | Where do support tickets live? | **In the dashboard inbox.** Blocking ones also get a Jira comment and, when there is a PR, a PR comment. Today's hold notifier does the PR part, for `needs_help` holds only. |

## 3. Scope

**In scope**

- Fixing the worker "offline" status and recording Claude usage over time (§6.1, §6.2)
- Removing Jira MCP mode
- Error codes, recovery policies, and showing Claude errors on the dashboard (§6.3)
- Structured events, the ticket timeline, the operations page and usage analytics (§6.4)
- The inbox and support tickets (§6.5)
- The scoped assistant chat (§6.6)
- Project onboarding with two proposing agents (§6.7)
- The rerun engine (§6.8)
- Splitting the agents (§4, §6.9)
- Publishing plans to Confluence (§6.10)
- The orchestrator decision hook (§6.11)

**Out of scope for v1**

- Reruns triggered from Jira (D3); reading Confluence comments back in
- Issue trackers other than Jira; Jira over MCP; document hubs other than Confluence
- Git hosts other than GitHub
- Several workers working in parallel
- Push or email notifications (the inbox badge and the PWA are the notice in v1)

## 4. Agents

### 4.1 Roster

| # | Agent | Stage key | One job | Model | Workspace | Replaces (v0) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `orchestrator` | `orchestrate` | Pick the next move from the legal set | sonnet; thinking only at decision points | none | (new) |
| 2 | `assistant` | `assist` | Answer the user's questions about one support ticket and draft a response | sonnet (haiku selectable) | read-only, small turn limit | (new) |
| 3 | `repo-profiler` | `repoProfile` | Propose stack, install/typecheck/test commands, KB folder, test-file pattern | sonnet | read-only | project form fields |
| 4 | `onboarding-advisor` | `onboardAdvise` | Propose Jira status mapping, approval statuses, issue-type routing, intake label, Confluence space | haiku | none (facts given in prompt) | project form fields |
| 5 | `feature-mapper` | `featureMap` | Match the ticket to an existing KB feature key, or say it is new | haiku | read-only | `kbBuild` step 1 |
| 6 | `documentor` | `kbBuild`, `kbUpdate` | Create or refresh one feature doc | sonnet | writes `kbDir` only | `kbBuild` + `kbUpdate` |
| 7 | `solution-architect` | `solutionDesign` | Feature: goal, approach, acceptance criteria, out of scope | opus | read-only | `plan` (features) |
| 8 | `bug-investigator` | `bugInvestigation` | Bug: root cause with `file:line` evidence, acceptance criteria for the fix | opus | read-only | `plan` (bugs) |
| 9 | `technical-architect` | `technicalDesign` | Files, order and subtasks with criteria (output only, no Jira writes) | sonnet | read-only | `breakdown` + the file list from `plan` |
| 10 | `test-writer` | `tests` | Failing tests for one subtask | sonnet | writes | `tests` |
| 11 | `coder` | `implement` | Make one subtask's tests pass | sonnet | writes | `implement` (without the test-writing fallback) |
| 12 | `fixer` | `fix` | Remove one named failure (tests, review findings or CI) | sonnet | writes | `fix` |
| 13 | `pr-reviewer` | `prReview` | Correctness, and whether every acceptance criterion is met and tested | sonnet | read-only | `review` (part) |
| 14 | `quality-reviewer` | `qualityReview` | Readability and the repo's standards | haiku | read-only | `review` (part) |
| 15 | `security-reviewer` | `securityReview` | Security only; runs when the diff touches risky areas | sonnet | read-only | `review` (part) |
| 16 | `ci-triager` | `ciTriage` | Classify a failed CI run as code, flaky test or infrastructure | haiku | none (log given) | the CI part of `fix` |

Removed: `sdlc-jira-intake` and `sdlc-jira-sync`, since all Jira work is done by REST code (D5).

Models are defaults. A per-stage override stays available under the project's **Advanced** settings.

### 4.2 Rules every agent follows

- One prompt file per agent in `guidelines/stages/`, generated into `.claude/agents/` as today.
- Every agent returns the v0 envelope (`done | needs_input | blocked`) with a Zod-validated `data` shape per stage.
  The `assistant` is the exception: it returns chat messages, with an optional structured draft (§6.6).
- An agent never calls Jira, Confluence, git push or GitHub. Agents that write may edit files only. The commit guard
  and the KB guard still apply.
- No agent asks the user anything directly. Questions become support tickets (§6.5).
- Every agent run, including `assist` and `orchestrate`, is a `StageRun`, so its tokens, cost and model appear in
  the usage figures.

### 4.3 Which agent runs, by ticket state

The ticket states keep their v0 names, so the database enums, dashboard and Jira mapping do not churn. Inside a
state, the agent is chosen by ticket kind (from the Jira issue type, or picked on the paste form) and by rules.

| Ticket state | Agents |
| --- | --- |
| `KB` | `feature-mapper`, then `documentor` only when the feature is new |
| `PLANNING` | `solution-architect` (feature) or `bug-investigator` (bug); the result is published to Confluence (§6.10) |
| `BREAKDOWN` | `technical-architect` |
| `IN_PROGRESS` | per subtask: `test-writer` → (red check) → `coder` → (green check) → `fixer` loop |
| `REVIEW` | `pr-reviewer` + `quality-reviewer` + (if triggered) `security-reviewer`, findings merged; `fixer` for critical/high |
| `KB_UPDATE` | `documentor` (refresh) |
| `AWAITING_CI` | on failure: `ci-triager`, then `fixer` for code failures; a support ticket for infrastructure failures |

The security reviewer is triggered by code rules: a changed path or diff line matches the project's risk patterns
(auth, sessions, crypto, SQL or raw queries, request parsing, file system, shell, secrets, dependency manifests). The
orchestrator may also add it (§6.11).

A `chore` kind with a small description may skip `PLANNING`, but only through an orchestrator decision, and only
when the plan gate is off.

## 5. Build order

Each phase is one stack of PRs: one branch per phase, built on the previous phase, with one commit per sub-task.
Do not start a phase before the previous one is merged to `dev`.

| Phase | Name | Why this position |
| --- | --- | --- |
| 0 | Fixes and Jira REST only | Two bugs users hit today; removes MCP code before anything is built on it |
| 1 | Error codes and recovery | Every later phase reports failures through it |
| 2 | Events, operations and usage analytics | Every later phase logs through it; usage charts need phase 0's data |
| 3 | Inbox and support tickets | Gives every later phase one place to ask the user |
| 4 | Assistant chat | Opens from a support ticket |
| 5 | Project onboarding | Independent of the pipeline; the biggest setup win |
| 6 | Rerun engine | The new stages must be rerunnable from day one |
| 7 | Agent split | Needs phases 1, 2, 3 and 6 |
| 8 | Confluence document hub | Publishes the output of the split planning agents |
| 9 | Orchestrator | Needs the full set of moves from phases 6 and 7 |

## 6. Design

### 6.1 Worker "offline" fix

**Root cause.** The heartbeat is written only at the end of each worker iteration: `recordTick` runs in the
`finally` of `tick()` in `apps/api/src/worker/loop/worker-loop.ts`. One iteration can:

- run a whole stage (`runStep`, often several minutes)
- clone a mirror (`cloneMirrors`)
- poll Jira (`housekeeping`)

The dashboard calls the worker offline when the heartbeat is older than 30 seconds (`WORKER_ONLINE_MS` in
`system-settings.service.ts`). So the worker shows as offline whenever it is busy for more than 30 seconds.

**Fix.**

- **A heartbeat that does not depend on the loop.** A timer in the worker process writes the heartbeat every 5
  seconds, whether or not an iteration is running. `recordTick` keeps recording the iteration's outcome but no longer
  doubles as the heartbeat.
- **Report what the worker is doing.** `WorkerStatus` gets `phase` (`idle | cloning | intake | stage | housekeeping
  | paused | not_configured`), `phaseDetail` (for example "running coder on SDA-12, subtask 2/4"), `phaseSince`,
  `startedAt`, `pid` and `version`.
- **Four states on the dashboard:**
  - **Online, idle**
  - **Online, busy**, showing the phase and for how long
  - **Stalled**: heartbeat fresh, but the phase has not changed for longer than the stage time limit plus 5 minutes
  - **Offline**: heartbeat older than 30 seconds, meaning the process is not running
- **Make restarts visible.** On start, the worker writes a `Worker started (version, pid)` event. Three starts
  within 10 minutes write an `error` event, "Worker is restarting repeatedly", and show a banner.
- **Check the process.** Add a Docker healthcheck to the `worker` service in the compose files. It runs a small
  command that fails when the process's own heartbeat is older than 30 seconds, so `docker ps` shows a hung worker
  as unhealthy.

### 6.2 Recording Claude usage over time

**Root cause.** `UsageSnapshot` rows are written only after a stage, and only in some cases:

- `UsageGate.afterStage` writes nothing when the stage's stream had no `rate_limit_event` and no calibration is set.
- The container-error path in `agent-runner.ts` returns before the gate is called.

So nothing is recorded while the worker is idle, and little or nothing is recorded during runs whose stream carried
no rate-limit event. Snapshots also carry no link to the run or the model.

**Fix.**

- **Record after every run.** Every `StageRun` that ends (done, failed, killed, or a container error) writes one
  snapshot.
  - With a `rate_limit_event`: the 5-hour and weekly percentages, the status and the reset time, with
    `source = event`.
  - Without one: the token-window estimate (`source = estimate`), with the percentages left empty unless a
    calibration exists.
- **Link snapshots.** `UsageSnapshot` gets `stageRunId` and `model`.
- **Keep every window.** If the event carries more windows than five-hour and seven-day (for example a per-model
  weekly window), store them in a new `windows` JSON column instead of dropping them.
- **Sample while idle (spike first).** Sub-task 0.5 is a time-boxed spike: find a way to read the current 5-hour and
  weekly utilisation without running a model call, for example whatever Claude Code's own usage view uses.
  - If a supported, free way exists, a timer records a snapshot every 10 minutes while the worker is idle.
  - If not, no probe calls are made. Spending usage to measure usage is not acceptable, and the charts show the gaps
    honestly.
- **Retention.** Keep snapshots at full detail for 90 days. After that, reduce them to one per hour.

### 6.3 Error codes and recovery

**Data.** `StageRun` gets `errorCode` (enum) and `errorSource` (enum). The existing `error` text stays, for detail.
Errors outside a stage run (Jira and Confluence write-back, git, GitHub, CI polling) are recorded as events (§6.4)
with the same codes.

**Policy table.** It lives in `packages/shared/src/error-policy.ts` and is the single source for the worker, the API
and the dashboard.

| Code | Source | Detected from | Recovery | Message shown |
| --- | --- | --- | --- | --- |
| `CLAUDE_AUTH` | claude | auth failure pattern in the result or stderr | Pause all Claude stages globally; banner; support ticket. Ticket does not fail. | "Claude rejected the credential. Update it in Settings → Connections." |
| `CLAUDE_RATE_LIMIT` | claude | rate-limit result | Pause until the reset time, then resume | "Claude rate limit reached. Resuming at {time}." |
| `CLAUDE_USAGE_LIMIT` | claude | usage-limit message, or the usage gate | Pause until the reset time, then resume | "Claude usage limit reached. Resuming at {time}." |
| `CLAUDE_API_ERROR` | claude | overloaded (529), 5xx, network error | Auto-retry 3× with backoff (1, 4, 10 min), then hold | "Claude API error ({detail}). Retry {n}/3 at {time}." |
| `CLAUDE_CONTEXT_TOO_LONG` | claude | prompt-too-long result | Hold | "The input for {stage} was too large ({sizes})." |
| `TURN_LIMIT` | agent | turn limit reached | Retry once with 1.5× turns, then hold | "{agent} ran out of turns." |
| `INVALID_OUTPUT` | agent | envelope or `data` failed validation | Retry once with the validation errors in the prompt, then hold | "{agent} returned output that did not match the expected shape." |
| `NEEDS_INPUT` | agent | envelope `needs_input` | Hold with the question | the agent's question |
| `BLOCKED` | agent | envelope `blocked` | Hold with the reason | the agent's reason |
| `GUARD_VIOLATION` | agent | commit guard or KB guard | Revert the files, retry once, then hold | "{agent} edited files it may not change: {files}." |
| `TESTS_STILL_FAILING` | workspace | green check after the fix-round limit | Hold | "Tests still fail after {n} fix rounds." |
| `CONTAINER_ERROR` | workspace | container start or exit failure | Retry once, then fail | "The agent container failed: {detail}." |
| `TIMEOUT` | workspace | wall-clock limit | Retry once, then fail | "{stage} took longer than {limit}." |
| `GIT_ERROR` | integration | git command failed | Retry 3× with backoff, then hold | "Git failed: {detail}." |
| `GITHUB_ERROR` | integration | GitHub API failed | Retry 3× with backoff, then hold | "GitHub failed: {detail}." |
| `JIRA_ERROR` | integration | Jira REST failed | Write-back: retry 3× and log a warning, never block the ticket. Intake: retry next poll. | "Jira failed: {detail}." |
| `CONFLUENCE_ERROR` | integration | Confluence REST failed | Retry 3×, then fall back to a Jira comment and log a warning; never block | "Confluence failed: {detail}. The plan was posted to Jira instead." |
| `KILLED` | user | kill from the dashboard | None | "Stopped from the dashboard." |

Every "hold" in this table also opens a support ticket (§6.5).

**Every stage can run twice safely.**

- Stages that write code start from the current branch head and record `StageRun.startSha` and `endSha` (§6.8).
- Jira writes check state first:
  - Comments carry a hidden marker (`[sdlc-agent:{ticketKey}:{purpose}:{version}]`), and an existing marker means skip.
  - A transition reads the current status first.
  - Creating a sub-task searches for an earlier one by marker label first.
- Confluence updates send the expected page version, so a repeated update is refused instead of applied twice.
- The worker's restart recovery (`restart-recovery.ts`) uses the policy table: a run that was interrupted is
  treated as `CONTAINER_ERROR`.

**Dashboard.** Every error shows a source badge (Claude / Agent / Workspace / Jira / Confluence / GitHub / Git /
User), the message, the suggested action, and for automatic retries, the time of the next attempt. Global Claude
problems (`CLAUDE_AUTH`, the limit pauses) show a banner on every page.

### 6.4 Events, operations and usage analytics

**Event model.** Extend `Event` with:

- `level`: `info | warn | error`
- `source`: `system | orchestrator | claude | agent | jira | confluence | github | git | ci | user`
- `stageRunId` and `subtaskId` (optional)
- `errorCode` (optional)
- `data` (JSON, optional)

`message` is always one plain-English sentence that someone who doesn't know the code can read. Examples:

- `Coder finished subtask 2/4 · 3m12s · 18 turns · $0.21 · 7 tests passing`
- `Claude API overloaded (529) · retry 1/3 at 14:32`
- `Orchestrator chose fixer over re-plan: 2 high findings, both in cancel.service.ts`
- `Rerun of PLANNING requested by user: "use the existing booking repository"`
- `Jira transition to "In Review" skipped: not available from "Blocked"`

**Where events come from.** Helpers write them for each kind of happening (`events.stageStarted`,
`events.stageFinished`, `events.transition`, `events.decision`, `events.error`, …), so the messages stay consistent.
Code never writes free-form event strings.

**Worker and API logs.** Every log line carries `ticket`, `stage`, `run` and `subtask` when they are known, in one
readable one-line format. The raw stream-json log of each run stays on disk and is linked from the timeline.

**Ticket timeline.** The ticket page shows one stream of state changes, stage runs (with duration, turns, tokens and
cost), orchestrator decisions, support tickets, errors and reruns. Stale runs are greyed out and marked "stale".

**Operations page** (new, `/operations`):

- worker state from §6.1 (idle, busy, stalled or offline), uptime, restarts, and queue depth
- **stuck tickets**: no active run and no state change for longer than a threshold (default 30 min in an
  actionable state, 24 h in an awaiting state)
- failure rate by stage and by error code, for the last 24 hours and 7 days
- loop and retry counts by stage, and average duration, tokens and cost by stage
- error rates for Claude, Jira, Confluence and GitHub
- the 20 most recent `error`-level events, each linking to its ticket

**Usage page additions.**

- **By model.** Computed from `StageRun` (model, tokens by kind, cost, runs), for a chosen period, per day:
  - each model's tokens and cost, and its share of the total
  - for each model, the split by stage
  - the share of the 5-hour and weekly percentage each model used. This is an **estimate**: each rise in percentage
    between two snapshots is split across the runs in that interval by their tokens. The page labels it as an
    estimate.
- **How fast usage is rising.** Two charts, computed on the server from the snapshots in §6.2:
  - **5-hour window:** percentage points per hour
  - **weekly window:** percentage points per day
  - Each series is split at window resets (a new `resetsAt`, or a drop in percentage), so a reset never shows as a
    fall.
  - The latest rate is projected forward ("at this rate you reach the 80% threshold at 16:40"), using the thresholds
    from Settings.
  - Gaps with no data are drawn as gaps, not interpolated.
- The overview page shows a small version of both rate charts, plus the current percentages.

### 6.5 Inbox and support tickets

**Rule.** Anything that needs a human becomes exactly one support ticket. Nothing that needs a human is shown only
as a ticket state, a log line or a Jira comment.

**Kinds**

| Kind | Raised by | Blocking? | Resolving it does |
| --- | --- | --- | --- |
| `approval` | plan or breakdown waiting at a gate | yes | approve → move on; reject with a note → rerun the stage (§6.8) |
| `question` | `needs_input` from any agent | yes | the answer is attached and the ticket resumes |
| `open_question` | each entry of a plan's `openQuestions` | no: the plan used a default | answer → kept with the plan approval; "rerun plan with answers" is offered |
| `hold` | every hold in the error policy (§6.3), loop limit, `BLOCKED` | yes | resume, rerun, or mark the ticket failed |
| `ci_infra` | `ci-triager` says infrastructure | yes | "fixed, re-run CI" or hold |
| `onboarding` | an onboarding proposal is ready (§6.7) | yes, for that project | opens the review screen |
| `credential` | `CLAUDE_AUTH`, a Jira, Confluence or GitHub auth failure | yes, globally | resolved automatically when the credential test passes |
| `pr_ready` | ticket reaches `IN_HUMAN_REVIEW` | no | resolved when the PR is merged (the merge poller) |

**Data.** The `SupportQuery` table becomes `SupportTicket` (renamed by a migration that keeps existing rows):

- `kind`, `title`, `body` (markdown), `priority` (`blocking | normal | fyi`)
- `status`: `open | answered | resolved | dismissed`
- `projectId`, `ticketId` (nullable for global items such as credentials), `stageRunId` (nullable), `stage`
- `defaultAnswer`, for `open_question`
- `response`: the answer or the decision
- `resolvedBy`, `createdAt`, `resolvedAt`
- `dedupeKey`, so the same problem never opens two tickets

**Inbox** (new, `/inbox`, also the top of the overview page):

- grouped as **Blocking** (the pipeline is waiting), **Approvals**, **Questions**, **FYI**; oldest first in each group
- a count badge in the sidebar, on blocking and approval items
- each item shows the ticket, the stage, why it needs you, how long it has waited, and one-click actions (approve,
  reject with a note, answer, resume, rerun, open the assistant)
- resolved items move to a history tab

**Outside the dashboard.** Blocking items also get a Jira comment and, when there is a PR, a PR comment (D8). This
extends the existing hold notifier.

### 6.6 Assistant chat

**What it is for.** Getting help with one support ticket: understanding a plan before approving it, working out
the answer to an agent's question, or deciding what to do about a hold.

**Opening it.** An "Ask the assistant" button on every support ticket, and on the ticket page for its current state.

**Scoped context (built by code, never the whole repo).** Each kind gets a fixed context pack:

| Kind | Context pack |
| --- | --- |
| `approval` (plan) | ticket summary, current plan, plan diff against the previous version if any, feature doc, open questions |
| `approval` (breakdown) | ticket summary, approved plan's acceptance criteria, subtasks |
| `question`, `open_question` | the question, the asking stage's summary, the relevant plan section, feature doc |
| `hold`, `ci_infra` | error code and message, the last 60 lines of the run's log or the CI log tail, the stage's inputs summary |

The assistant has **read-only** access to the project's mirror, with a small turn limit (default 8 tool calls per
message), for "check the code" questions.

**Drafts, not actions.** The assistant can return a structured draft next to its reply:

- an answer to the question
- an edited plan (shown as a diff)
- a rerun note

The user applies a draft with one click, and that goes through the normal support-ticket action. The assistant itself
never changes anything.

**Token limits.**

- One conversation per support ticket, continued with the CLI's session resume.
- After 10 messages, older turns are replaced by a short summary.
- A per-conversation token cap, set in global settings, shows a warning when reached.
- Every message is a `StageRun` with stage `assist`, so it counts in the usage figures and the usage gate.

**Running it** (D7). It runs in an agent container like any stage, but outside the worker loop's
one-stage-at-a-time rule. At most one assistant session runs at a time. The worker's "a stage is running" check
excludes `assist` runs. Assistant sessions are refused while the pipeline is paused for limits.

### 6.7 Project onboarding

**What the user enters**

1. Repo URL (required)
2. Jira project key, for example `SDA` (optional; without it the project takes pasted tickets only, D2)

Atlassian site, email and API token (used for both Jira and Confluence), and the GitHub token, are entered once in
Settings → Connections (the existing `Credential` model). Everything else is proposed.

**Flow**

1. **Collect facts (code, no AI).**
   - GitHub: default branch, languages, whether the repo is reachable with the token. Clone the mirror.
   - Jira, when a key is given:
     - `GET /rest/api/3/project/{key}`: name, issue types, and which issue type is the sub-task type
     - `GET /rest/api/3/project/{key}/statuses`: statuses per issue type, with their category
     - labels in use: a JQL search `project = {key}` over recent issues, requesting only `labels`. Jira has no
       per-project label endpoint.
   - Confluence, when the credential can reach it: the list of spaces the user can write to.
2. **`repo-profiler`** reads the mirror and proposes:
   - stack
   - `installCmd`, `typecheckCmd`, `testCmdTemplate`
   - `kbDir`
   - the test-file pattern, and one example test file

   Code then runs the install and typecheck commands once in an agent container and records whether they passed.
3. **`onboarding-advisor`** gets the facts from step 1 (no access of its own) and proposes:
   - **status map**: each internal state → one Jira status or none. Several states may share a status.
   - **approval statuses**: the Jira statuses that mean "plan approved" and "breakdown approved"
   - **issue-type routing**: each issue type → `feature | bug | chore | ignore`. Sub-task and Epic types default
     to `ignore`.
   - **intake label**: `sdlc-agent` unless the facts suggest a clash. The intake query is generated as
     `project = {key} AND labels = {label} AND issuetype in ({routed types}) ORDER BY created ASC`, and stays
     editable under Advanced.
   - **Confluence space**: the space whose key or name best matches the Jira project. Pages go under a parent page
     "sdlc-agent plans", created on confirm. The user can pick another space, or none.
4. **Review screen.** This is an `onboarding` support ticket. It has one card per section, each with *Accept* or
   *Edit*. The status map and the label must be explicitly accepted. A **dry run** then shows "N tickets currently
   match" and lists up to 5.
5. **Confirm.** The project becomes active.

**Labels.** Jira cannot create a label on its own; a label exists once it is applied to an issue. Onboarding
therefore tells the user the label name and how to apply it. If the dry run finds no matching tickets, the card
says "Label not used yet. Add it to a ticket to start." The project can still be confirmed.

**Data.**

- `Project.onboardingStatus`: `draft | profiling | proposed | confirmed`. The worker ignores projects that are not
  `confirmed`.
- `Project.onboardingProposal` (JSON): the stored proposal, so the user can leave and come back.
- `ProjectSettings.jiraIssueTypeRouting`: issue type name → kind.
- `ProjectSettings.confluence`: `{ spaceKey, parentPageId } | null`.
- Re-running onboarding from the project page creates a new proposal and never changes settings until it is
  confirmed again.

**Settings that leave the project form**

| Setting (v0) | v1 |
| --- | --- |
| `stack`, `installCmd`, `typecheckCmd`, `testCmdTemplate`, `kbDir` | proposed by `repo-profiler`; editable on the review card |
| `baseBranch` | the GitHub default branch; editable on the review card |
| `jiraMode` | `rest` when a key is given, otherwise `off` |
| `jiraJql` | generated from the label; Advanced |
| `jiraStatusMap`, `jiraApprovalStatuses` | proposed by `onboarding-advisor` |
| `jiraSubtaskTypeName` | detected from the issue types |
| `stages.*` (model, turns) | global defaults; per-project override under Advanced |
| `intake.mcpPollIntervalSec` | removed (MCP); the REST poll interval becomes global |
| `jiraWriteBack.*`, `pr.*`, `limits.*` | defaults; Advanced |

### 6.8 Rerun engine and loops

**Kinds of move.** `StateTransition` gets:

- `kind`: `advance | rerun | hold | resume | fail | retry | approve | reject`
- `note`: the user's instructions for a rerun, or the reason for a reject

The forward moves of the v0 plan stay as `advance`.

**User reruns.** From any state except `DONE` (and `ON_HOLD` or `FAILED`, which use resume and retry), a user may
rerun any earlier stage that has completed for this ticket. Inside `IN_PROGRESS`, a user may rerun one subtask's
tests or implementation, which generalises today's `redo-tests`. Reruns start from the ticket page or from a support
ticket.

**What a rerun does, in order:**

1. Refuse while a run is active for the ticket. Kill it first.
2. Check the loop guard (below).
3. Mark every `StageRun` and `StageArtifact` after the rerun point as stale (`supersededAt`,
   `supersededByTransitionId`), and resolve their open support tickets as `dismissed` (D4).
4. **Remove stale code with a revert commit** (D1). Let `S` be the `startSha` of the earliest stale run that wrote
   code.
   - If any commit in `S..HEAD` was not made by the orchestrator (a human pushed to the branch), raise a `hold`
     support ticket, "Branch has commits not made by sdlc-agent: {shas}", and do nothing.
   - Otherwise run `git revert --no-commit S..HEAD` and commit it as
     `revert: drop work superseded by rerun of {stage} ({ticketKey})`, then push normally. Never force-push.
5. Record the `rerun` transition, with its note and actor.
6. Move Jira to the mapped status of the target state, and post a marker comment: "Rerun of {stage} requested:
   {note}". This is outbound only (D3).
7. The stage runs again. Its prompt gets the note, and its previous output as "previous attempt (stale)" so the
   agent can see what to change.
8. The ticket moves forward from there as normal. Approval gates apply again.

**Versioned outputs.** A new `StageArtifact` table holds every version of the plan, the breakdown, the review
findings per round, and the KB doc pointer:

- `ticketId`, `stage`, `version`
- `data` (JSON)
- `stageRunId`
- `supersededAt`
- `externalUrl`, `externalId`, `externalVersion`: the Confluence page (§6.10)

Ticket fields that today hold "the current plan" read the latest version that is not stale. The dashboard shows
older versions next to the current one.

**Commit range per run.** Stages that write code record `StageRun.startSha` and `endSha`. A run that made no commit
records the same SHA in both.

**Loop guard.** Each back-edge has a limit per ticket. Going over it raises a `hold` support ticket with the new hold
reason `loop_limit`.

| Back-edge | Default limit | Configurable |
| --- | --- | --- |
| green check → `fixer` (per subtask) | 2 rounds | yes |
| review → `fixer` | 2 rounds | yes |
| CI → `fixer` | 1 round | yes |
| user rerun of the same stage | 5 | yes |
| orchestrator-proposed re-plan | 1 | yes |

**State machine.** `checkTransition` in `packages/shared/src/state-machine.ts` gets the move kind. `advance` uses
the v0 table. `rerun` is allowed from state X to any state listed before X in the forward order, if that stage has a
completed run. A pure helper `legalMoves(ticket, history)` returns every legal move, with its kind. The worker, the
API, the dashboard and the orchestrator all use it.

### 6.9 Agent split

- One prompt file per agent (§4.1), in the same style as the v0 stage prompts.
- `STAGE_NAMES`, `STAGE_WORKSPACE` and the default models per stage are updated, and a Zod `data` schema is added
  for each new stage.
- `PLANNING` dispatches by ticket kind. `bug-investigator` and `solution-architect` both return `planMarkdown`,
  `risks` and `openQuestions`, so the plan gate and `technical-architect` take either one unchanged.
  `bug-investigator` adds `rootCause: { file, line, explanation }`. Each `openQuestions` entry becomes an
  `open_question` support ticket, with the default the plan chose.
- `technical-architect` returns the v0 breakdown shape plus `filesByOrder`. Jira sub-tasks are then created by REST
  code, as today.
- `REVIEW` runs the reviewers one after another (one worker, one container at a time). It then merges their findings,
  removing duplicates by `file`, `line` and a normalised issue. Only critical and high findings trigger the fixer.
  Quality findings are capped at medium.
- `ci-triager` returns `{ kind: 'code' | 'flaky' | 'infra', failingCommand?, summary }`:
  - `code` → `fixer`
  - `flaky` → re-run CI once
  - `infra` → a `ci_infra` support ticket
- The `coder` loses its test-writing fallback. With the tests stage turned off, the subtask goes straight to `coder`,
  and the green check runs the existing tests only.

### 6.10 Confluence document hub

**Interface.** `DocumentHub` has three operations:

- `publish(ticket, artifact) → { url, id, version }`
- `update(id, expectedVersion, artifact) → { version }`
- `test()`

v1 has one implementation, `ConfluenceHub`, using the Confluence Cloud REST API (pages v2) and the Atlassian
credential.

**What is published.** The `PLANNING` output (solution design or bug investigation) of every ticket in a project
with Confluence configured. There is one page per ticket:

- title `{ticketKey} — {summary}`
- under the project's parent page
- body: the plan, risks and open questions (with answers once given), and a status line ("Draft, waiting for
  approval", "Approved on {date}", "Superseded by rerun on {date}")

**Updates go to the same page.**

- A plan rerun updates the existing page, creating a new Confluence version, so Confluence keeps the history.
- Approval and answered open questions update the status line and the questions section.
- Each update sends the expected version. On a version conflict (someone edited the page), the update is applied on
  top of the latest version, after a short "Edited outside sdlc-agent" note, and a `warn` event is written.

**Jira.** The ticket gets one comment with the page link and status. The comment is updated through its marker, not
posted again on every version. The v0 behaviour of posting the full plan as a Jira comment remains only for projects
without Confluence, or as the fallback after a `CONFLUENCE_ERROR`.

**Formatting.** A converter in code turns the plan's markdown into Confluence storage format: headings, lists, code
blocks, tables, links and `file:line` references as code. It is unit-tested and has no AI involvement.

**What stays where.** The dashboard stays the place to approve, and still shows the plan itself. Confluence is the
readable, shareable copy. Comments on the Confluence page are not read back in v1.

### 6.11 Orchestrator

**When it runs.** After every stage finishes, and on every worker tick for a ticket with no active run, code calls
`legalMoves`.

- No legal move: wait.
- **Exactly one legal move: code takes it.** No AI call. This is the common case.
- Several legal moves: the `orchestrator` agent is called.

**Decision points** (where several moves are legal):

- `REVIEW` with findings: fix, or raise a support ticket (for example, findings that contradict the plan)
- after a loop limit is close: one more round, propose a re-plan, or raise a support ticket
- `KB` skipped or not for a tiny change
- whether to add `security-reviewer` when the code rules did not trigger it
- `chore` tickets: skip `PLANNING` (only with the plan gate off)
- CI failure classified `flaky` twice in a row: re-run, or raise a support ticket

**Input** (short, never code or diffs):

- ticket key, kind, state
- the legal moves, with their kinds
- the last 5 events
- the last stage's envelope summary
- attempt and loop counts
- severities of open findings
- open support tickets for the ticket

**Output:** `{ move, reason, inputs? }`. `move` must be one of the legal moves. Anything else is replaced by the
code's default move for that point and logged as a `warn` event.

**Thinking.** The orchestrator runs without extended thinking by default. Code switches thinking on (with a small
budget) only at the decision points above.

**Data.** A new `OrchestratorDecision` table:

- `ticketId`, `at`
- `legalMoves` (JSON), `chosen`, `reason`
- `fallbackUsed` (boolean)
- `model`, `inputTokens`, `outputTokens`, `costUsd`

Each decision also writes an event, so it shows on the timeline.

**Limits.** At most one orchestrator call per ticket per tick. Its token usage counts toward the usage gate like
any other stage.

## 7. Data model changes (summary)

| Model | Change | Phase |
| --- | --- | --- |
| `WorkerStatus` | add `phase`, `phaseDetail`, `phaseSince`, `startedAt`, `pid`, `version` | 0 |
| `UsageSnapshot` | add `stageRunId`, `model`, `windows` (JSON) | 0 |
| `Project` | `jiraMode` becomes `off \| rest`; add `onboardingStatus`, `onboardingProposal` | 0, 5 |
| `ProjectSettings` (JSON) | remove MCP settings; add `jiraIssueTypeRouting`, `confluence`, `loopLimits`, `securityRiskPatterns` | 0, 5, 6, 7 |
| `StageRun` | add `errorCode`, `errorSource` (phase 1); `startSha`, `endSha`, `supersededAt`, `supersededByTransitionId`, `trigger` (`auto \| user \| orchestrator`) (phase 6) | 1, 6 |
| `Event` | add `level`, `source`, `stageRunId`, `subtaskId`, `errorCode`, `data` | 2 |
| `SupportQuery` → `SupportTicket` | rename; add `kind`, `title`, `body`, `priority`, `projectId`, `defaultAnswer`, `response`, `resolvedBy`, `resolvedAt`, `dedupeKey`; `ticketId` and `stageRunId` become nullable | 3 |
| `AssistantConversation` | new: `supportTicketId`, `sessionId`, `summary`, `messageCount`, `tokens` | 4 |
| `AssistantMessage` | new: `conversationId`, `role`, `text`, `draft` (JSON), `stageRunId`, `at` | 4 |
| `StateTransition` | add `kind`, `note` | 6 |
| `HoldReason` enum | add `loop_limit` | 6 |
| `StageArtifact` | new, including `externalUrl`, `externalId`, `externalVersion` | 6 |
| `Ticket` | add `kind` (`feature \| bug \| chore`) | 7 |
| `OrchestratorDecision` | new | 9 |

Each change is a forward-only Prisma migration. Existing rows get safe defaults:

- `kind = advance` for old transitions
- `onboardingStatus = confirmed` for existing projects
- `Ticket.kind` taken from `TicketType`
- existing support queries become `kind = question` with `priority = blocking`

## 8. Sub-tasks

IDs are `<phase>.<n>`. Each sub-task is one commit.

### Phase 0 — Fixes and Jira REST only

| ID | Sub-task | Done when |
| --- | --- | --- |
| 0.1 | Heartbeat timer independent of the loop; `recordTick` records outcomes only | a test with a stage that runs for 60 s keeps the worker online throughout |
| 0.2 | `WorkerStatus` phase fields; the worker sets the phase around cloning, intake, stages and housekeeping; start event and restart detection | integration test reads each phase; three quick starts write the error event |
| 0.3 | Dashboard worker state: idle, busy (with phase and time), stalled, offline; restart banner | component tests for all four states |
| 0.4 | Docker healthcheck for the `worker` service in both compose files | `docker ps` shows a stopped heartbeat as unhealthy (checked by hand, noted in the PR) |
| 0.5 | Spike: a free way to read the 5-hour and weekly utilisation outside a run. Time-boxed; the result is written into this plan | the plan states the method, or states that none exists |
| 0.6 | Write a usage snapshot after every run, including the failure and container-error paths; add `stageRunId`, `model`, `windows` | integration tests for done, failed, killed and container-error runs |
| 0.7 | Idle sampling timer, only if 0.5 found a free method; retention job (90 days full, then hourly) | tests for sampling and down-sampling |
| 0.8 | Remove the MCP intake, MCP write-back and MCP Jira client (`jira-mcp-client.ts`, `mcp-intake.ts`, `jira-mcp-stages.ts`, `mcp-config.ts`) and their tests | the build and all tests pass; no `mcp` imports remain under `worker/` or `jira/` |
| 0.9 | Remove the `jiraIntake` and `jiraSync` stages, their prompt files and their settings; `JiraMode` becomes `off \| rest` (migration maps `mcp` → `rest`) | `STAGE_NAMES` has no Jira stages; migration applies to a copy of a v0 database |
| 0.10 | Remove the MCP options from the dashboard and the docs | no MCP wording in the dashboard or the README |

### Phase 1 — Error codes and recovery

| ID | Sub-task | Done when |
| --- | --- | --- |
| 1.1 | `error-policy.ts` in `packages/shared`: codes, sources, recovery rules, messages; unit tests | every code in §6.3 has a policy and a message test |
| 1.2 | Migration: `StageRun.errorCode`, `errorSource` | migration applies; old rows are null |
| 1.3 | Classify Claude results in `agent-runner.ts` and `result-parser.ts` into codes (auth, rate, usage, API error, context too long, turn limit, invalid output) | tests with captured result lines for each code |
| 1.4 | Apply recovery policies in the worker: backoff retries, global pause for auth, pause-until-reset for limits, hold or fail after the limits | integration tests for each recovery kind |
| 1.5 | Make Jira writes safe to repeat (marker comments, status check before transition, sub-task lookup by marker) | running the same write twice makes one change |
| 1.6 | Dashboard: source badge, message, suggested action and next retry time on runs and tickets; global Claude banner | component tests for each source |

### Phase 2 — Events, operations and usage analytics

| ID | Sub-task | Done when |
| --- | --- | --- |
| 2.1 | Migration: extend `Event`; typed event helpers in the API | helpers cover every message kind in §6.4 |
| 2.2 | Write events from the worker: stage start and finish, transitions, errors, Jira and GitHub calls | a full test pipeline run produces a readable event list (snapshot of messages) |
| 2.3 | One-line log format with ticket, stage, run and subtask context | log lines in tests carry the context fields |
| 2.4 | Ticket timeline on the ticket page | component test with a mixed event list |
| 2.5 | Operations API: worker state, queue depth, stuck tickets, failure rates, cost and duration by stage | integration test over seeded runs |
| 2.6 | `/operations` page | component test; page linked from the sidebar |
| 2.7 | Usage API by model: tokens by kind, cost, runs, share, split by stage, estimated share of the 5-hour and weekly percentages | integration test over seeded runs and snapshots |
| 2.8 | Usage API for rate of change: series per window, split at resets, gaps kept, projection to the thresholds | unit tests with resets, gaps and a projection |
| 2.9 | Usage page: by-model breakdown and the two rate charts; small rate charts on the overview | component tests |

### Phase 3 — Inbox and support tickets

| ID | Sub-task | Done when |
| --- | --- | --- |
| 3.1 | Migration: `SupportQuery` → `SupportTicket` with the new fields; existing rows kept | migration applies to a copy of a v0 database with open queries |
| 3.2 | Support ticket service: raise (with dedupe), answer, resolve, dismiss; actions per kind (§6.5) | integration tests for each kind's action |
| 3.3 | Raise tickets from every source: gates, `needs_input`, holds, auth failures, `pr_ready` | each source creates exactly one ticket, also when raised twice |
| 3.4 | Blocking tickets notify Jira and the PR (extends `hold-notifier.ts`) | integration test with the fake Jira and GitHub |
| 3.5 | `/inbox` page, overview "Needs you" section, sidebar badge | component tests |

### Phase 4 — Assistant chat

| ID | Sub-task | Done when |
| --- | --- | --- |
| 4.1 | Migration: `AssistantConversation`, `AssistantMessage` | migration applies |
| 4.2 | Context-pack builder per support ticket kind (§6.6) | unit tests: each pack contains only its listed parts |
| 4.3 | `assistant` prompt, structured draft schema, session resume, summary after 10 messages, token cap | fake-Claude tests for a conversation past 10 messages |
| 4.4 | Assistant runner outside the worker loop: one session at a time, excluded from the stage lock, refused when paused | integration test with a stage and a chat running together |
| 4.5 | Apply a draft through the support ticket's own action | applying each draft kind goes through the normal action |
| 4.6 | Chat panel on support tickets and the ticket page | component tests |

### Phase 5 — Project onboarding

| ID | Sub-task | Done when |
| --- | --- | --- |
| 5.1 | Jira REST fact collection: project, issue types, statuses per type, labels in use | tests against `fake-jira.ts` |
| 5.2 | GitHub fact collection: default branch, languages, access check | tests against `fake-github.ts` |
| 5.3 | Confluence fact collection: writable spaces (skipped when unreachable) | tests against a new fake Confluence |
| 5.4 | Migration: `onboardingStatus`, `onboardingProposal`; the worker ignores projects that are not confirmed | worker test with an unconfirmed project |
| 5.5 | `repo-profiler` prompt, `data` schema, and the command check run | schema tests; fake-Claude run end to end |
| 5.6 | `onboarding-advisor` prompt and `data` schema; intake query generation from label and routing | schema tests; query generation unit tests |
| 5.7 | Onboarding API: start, status, proposal, accept or edit per section, dry run, confirm; raises the `onboarding` support ticket | integration tests for the whole flow, with and without Jira and Confluence |
| 5.8 | Dashboard: two-field create form, progress, review cards, dry run, confirm | component tests |
| 5.9 | Move the remaining settings under Advanced; global defaults for stage models and turns | settings form shows only Advanced fields after onboarding |
| 5.10 | Paste form: ticket kind picker (`feature \| bug \| chore`) | pasted tickets carry a kind |

### Phase 6 — Rerun engine

| ID | Sub-task | Done when |
| --- | --- | --- |
| 6.1 | Migration: `StateTransition.kind`, `note`; `StageRun.startSha`, `endSha`, `supersededAt`, `supersededByTransitionId`, `trigger`; `HoldReason.loop_limit`; `StageArtifact` | migration applies; old transitions are `advance` |
| 6.2 | `legalMoves` and `checkTransition` with move kinds in `packages/shared` | table-driven tests for every state |
| 6.3 | Store plan, breakdown, review findings and KB pointer as `StageArtifact` versions; readers use the latest version that is not stale | existing pipeline tests pass unchanged |
| 6.4 | Record `startSha` and `endSha` for code stages | tests read the SHAs back |
| 6.5 | Rerun service: refuse while active, loop guard, mark stale, dismiss stale support tickets, revert commit, human-commit check, transition, Jira status and comment | integration tests for each step, including the human-commit hold |
| 6.6 | Rerun prompt context: note and previous stale output | context-builder tests |
| 6.7 | Per-subtask rerun of tests or implementation (replaces `redo-tests`) | integration test; `redo-tests` endpoint removed |
| 6.8 | Loop limits in settings and enforcement on every back-edge | test reaching each limit raises a `loop_limit` hold ticket |
| 6.9 | Dashboard: "Rerun from here" with a note on each completed stage and on support tickets; stale runs greyed; artifact versions side by side | component tests |

### Phase 7 — Agent split

| ID | Sub-task | Done when |
| --- | --- | --- |
| 7.1 | `feature-mapper` + `documentor` (create mode) replace `kbBuild`; the documentor runs only for new features | a ticket for an existing feature makes no documentor run |
| 7.2 | `documentor` (refresh mode) replaces `kbUpdate` | existing KB update tests pass |
| 7.3 | `Ticket.kind` (migration from `TicketType`); `PLANNING` dispatches to `solution-architect` or `bug-investigator`; open questions become support tickets | both kinds reach the plan gate in tests; one ticket per open question |
| 7.4 | `technical-architect` replaces `breakdown`; default model sonnet | breakdown gate tests pass |
| 7.5 | `coder` without the test-writing fallback; tests-off path goes straight to `coder` | tests-off integration test |
| 7.6 | `pr-reviewer`, `quality-reviewer`, `security-reviewer` (with risk patterns); merge and remove duplicate findings | review tests with overlapping findings |
| 7.7 | `ci-triager`; route `code`, `flaky` and `infra` | CI tests for each kind |
| 7.8 | Generate `.claude/agents/` from the new prompts; remove the old ones | one agent file per row of §4.1 |

### Phase 8 — Confluence document hub

| ID | Sub-task | Done when |
| --- | --- | --- |
| 8.1 | `DocumentHub` interface and `ConfluenceHub` (publish, update with expected version, test); credential test also checks Confluence | tests against the fake Confluence, including a version conflict |
| 8.2 | Markdown → Confluence storage format converter | unit tests for every element in §6.10 |
| 8.3 | Publish the `PLANNING` output; store the page on the `StageArtifact`; update on rerun, approval and answered questions | integration tests for each update reason |
| 8.4 | Jira gets one link comment, updated through its marker; full-text comment only without Confluence or as the fallback | integration tests for both paths and the fallback |
| 8.5 | Dashboard: "Open in Confluence" link on the plan and the ticket | component test |

### Phase 9 — Orchestrator

| ID | Sub-task | Done when |
| --- | --- | --- |
| 9.1 | Migration: `OrchestratorDecision` | migration applies |
| 9.2 | Decision hook in the worker loop: no move → wait, one move → take it, several → call the orchestrator | worker-loop tests for each case |
| 9.3 | `orchestrator` prompt, input builder (§6.11), output validation and fallback to the default move | invalid move uses the fallback and logs a `warn` |
| 9.4 | Thinking only at listed decision points; usage counted by the usage gate | tests check the thinking flag per decision point |
| 9.5 | Decisions on the timeline and the operations page (count, fallback rate, cost) | component tests |

## 9. Testing

The v0 testing approach stays: unit tests for pure code in `packages/shared`, integration tests against a real
Postgres and the fake Jira, GitHub and Claude helpers, and component tests for the dashboard. In addition:

- a fake Confluence helper next to `fake-jira.ts` and `fake-github.ts`
- every error code has a test that produces it from a captured Claude result or a fake integration failure
- the rerun engine has an end-to-end test: run a ticket to `REVIEW`, rerun `PLANNING`, and check the revert commit,
  the stale marks, the new versions, the dismissed support tickets, the updated Confluence page and the Jira comment
- the worker heartbeat has a test with a long-running fake stage
- the orchestrator and the assistant are tested with a fake model that returns valid output, illegal moves and
  malformed output

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Three reviewers cost more tokens than one | quality reviewer on haiku; security reviewer only when triggered; one diff read per reviewer |
| The orchestrator picks badly | it chooses only from legal moves; one move is taken by code; every decision is logged with its reason; fallback default |
| Assistant chats use up the usage window | one session at a time; per-conversation token cap; summary after 10 messages; refused while paused; usage shown by model |
| No free way to read usage while idle (0.5) | record after every run; charts show gaps honestly; no probe calls |
| The model share of usage percentage is only an estimate | labelled as an estimate on the page; token and cost figures by model are exact |
| A revert commit conflicts | the branch is agent-owned and the range is reverted as one; on conflict, a hold support ticket with `GIT_ERROR` and the conflicting files |
| A human pushed to the agent branch | the rerun raises a support ticket instead of reverting their work (§6.8 step 4) |
| Someone edits the Confluence page by hand | updates go on top with a note and a warning; history stays in Confluence's versions |
| The Atlassian credential cannot reach Confluence | the credential test says so; the project works without Confluence (plans go to Jira) |
| Onboarding proposes a wrong status map | the user must accept the map explicitly; a Jira transition that is not available is a warning, never a failure |
| Removing MCP breaks existing projects | migration maps `mcp` → `rest`; the release notes ask for REST credentials |

## 11. After each phase

- Update `CHANGELOG.md`.
- When all phases are done, write `docs/architecture/<next version>/` as a new snapshot (see
  [`docs/architecture/README.md`](../../architecture/README.md)) and add it to the architecture change log.
