# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Until `0.1.0`, any release may contain breaking changes (database migrations, configuration, API). Read this file before upgrading.

## [Unreleased]

### Added
- Build plan for version 1.0.0 in `docs/build-plan/v1.0.0/BUILD_PLAN.md`: one-job agents, an orchestrator, reruns, error recovery, an inbox for support tickets, a scoped assistant, project onboarding, Confluence plans, usage analytics, and fixes for the worker "offline" status and missing usage history.

- Dashboard and formats:
  - The 5-hour and weekly usage rate charts are one chart with a small `5h | W` toggle.
  - Attention: the Inbox entry shows a number for blocking items, approvals and questions, and a quieter one when only FYI items (for example a PR ready for human review) are open; the browser tab title carries the count; "Needs you" on the overview lists everything open, urgent first, with links to the tickets; the tickets list marks the tickets waiting for you (approve the plan, approve the breakdown, review the PR, on hold, failed).
  - Formats: the ticket, the plan, the pull request description, the review comment, the review summary and the Jira comments (plan, Confluence link, needs a person) are read from `guidelines/formats/*.md`, edited in Guidelines, with placeholders such as `{{title}}` and a "Reset to the default" button. A missing or empty file means the built-in default, so nothing breaks. The ticket format starts the "New ticket" description; the plan format is given to the planning agent. `npm run formats` rewrites every file from the defaults.
- Gaps left by phases 7 to 9 are closed:
  - Settings saved under the old stage keys (`plan`, `breakdown`, `review`) are carried over to `solutionDesign`, `technicalDesign` and `prReview` by a migration, in project settings and in the global stage defaults.
  - A quality or security reviewer that fails no longer stops the review round: it is skipped with a warning (and the warning says when the security check did not run). The PR reviewer still has to finish.
  - The PR reviewer's criteria table (met, tested, note) is shown on the Versions tab; the project form has a field for extra security triggers.
  - Confluence: the page follows an approval, a rejection or a rerun at once (on the state change, not the next poll); a rerun marks the page "Superseded by a rerun" until the new plan is written; the Jira link comment is edited in place with the page status; the 3 attempts are spaced out (now, 2 s, 6 s).
  - Orchestrator: five more decision points are wired (review findings, review limit, adding the security reviewer, skipping planning for a chore, a second flaky CI failure), each with a default that applies when the orchestrator is off or fails, and a person already called in is not asked again. A Decisions tab on the ticket shows the question, options, choice and reason; `GET /tickets/:id/decisions`.

### Fixed
- The worker no longer shows as offline while it runs a long stage: the heartbeat is written by its own timer every 5 seconds. The dashboard shows idle, busy (with phase and time), stalled and offline, and a banner when the worker restarts repeatedly. The `worker` service has a Docker healthcheck.
- A usage snapshot is now recorded after every run (done, failed, killed or container error), linked to the run and model, with every window the event carried. Snapshots older than 90 days are reduced to one per hour.

### Added
- Error codes and recovery (`packages/shared/src/error-policy.ts`): every failure gets a code, a source and a recovery rule. Claude API errors retry 3 times (1, 4, 10 minutes), a turn limit retries once with 1.5x turns, invalid output retries once with the validation errors in the prompt, a container error or timeout retries once and then fails the ticket, a rejected Claude credential pauses all Claude stages until a new one is saved, and rate or usage limits pause until the reset time and then resume by themselves.
- The dashboard shows a source badge (Claude, Agent, Workspace, Jira, Confluence, GitHub, Git, User), the message, the suggested action and the next retry time on every failed run, and names Claude in the pause banner.
- Jira writes are safe to repeat: comments carry a hidden marker, a transition reads the status first, sub-tasks are found by a marker label before one is created. Git pushes and draft PRs retry by policy.

- Events carry a level, a source, the run, the subtask and an error code, and every message is one plain-English sentence from typed helpers (`packages/shared/src/event-messages.ts`). The ticket page has a Timeline tab: state changes, stage runs with duration, turns and cost, errors and decisions, with a "problems only" filter.
- Operations page (`/operations`): worker state, uptime, restarts and queue depth; stuck tickets (30 minutes ready with nothing running, 24 hours waiting for a person); failure rate by stage and error code for 24 hours and 7 days; loops, retries and average duration, tokens and cost by stage; error rates for Claude, Jira, Confluence and GitHub; the 20 newest errors.
- Usage by model (exact tokens, cost and runs, split by stage and day, plus an estimated share of the 5-hour and weekly percentage) and two charts of how fast the 5-hour (points per hour) and weekly (points per day) usage is rising, split at resets, with gaps kept and a projection to the thresholds. Small versions on the overview.
- Log lines carry `[ticket=... stage=... run=... subtask=...]` where known.

- Inbox and support tickets: everything that needs a person becomes exactly one support ticket (`approval`, `question`, `open_question`, `hold`, `ci_infra`, `onboarding`, `credential`, `pr_ready`). The old support queries are migrated to question tickets. Tickets are raised from the plan and breakdown gates, `needs_input`, holds and failures, rejected Claude, Jira and GitHub credentials, human review and plan open questions, and never twice for the same problem. A ticket closes itself when its state ends (an approval when the ticket leaves the gate, a hold when it resumes, "PR ready" when the PR is merged, a credential when its test passes).
- `/inbox` replaces the Support page: Blocking, Approvals, Questions and FYI groups, one-click actions per kind (approve, reject with a note, answer, rerun with answers, resume, retry, mark failed, fixed, dismiss), a History tab, a "Needs you" section on the overview and a count badge on the sidebar.
- Blocking tickets also get a Jira comment (once) and, when there is a PR, a PR comment.

- Assistant chat: "Ask the assistant" on every inbox item and on the ticket page. The assistant gets only that item's context (a fixed set of parts per kind of ticket, built by code), can read the project's repository read-only with a small turn limit, and drafts an answer, an edited plan (shown as a diff) or a rerun note that you apply with one click through the normal action. It never changes anything itself. One conversation per ticket with CLI session resume; after 10 messages older turns are replaced by a short summary; a per-conversation token cap in Settings; at most one chat session at a time, running outside the worker loop's one-stage rule, refused while the pipeline is paused for limits, and counted by the usage gate.

- Project onboarding replaces the long project form: give a repo URL and, optionally, a Jira project key. Code collects the facts (GitHub default branch and languages, Jira issue types, statuses per type and labels in use, writable Confluence spaces); `repo-profiler` proposes the stack, commands, KB folder and test pattern, and the commands are run once to see if they pass; `onboarding-advisor` proposes the Jira status map, approval statuses, issue-type routing, intake label and Confluence space. Code drops any name the advisor invented. The proposal is reviewed card by card (accept or edit), with a dry run of the intake query ("N tickets currently match") and an explicit accept for the status map and the label, and nothing is used until it is confirmed. A project that is not confirmed is ignored by the worker. Re-running onboarding makes a new proposal and changes nothing until confirmed again.
- Jira intake follows the project's issue-type routing (feature, bug, chore or ignore); tickets carry a `kind`, and the paste form has a Kind picker. Defaults for each stage's model and turn limit are set in Settings and applied to new projects; the rest of a project's settings sit under Advanced.

- Rerun engine: a person can send a ticket back to any stage that already finished ("Rerun from here" on the ticket page and on inbox items), with a note. Everything after that stage becomes stale, always: its runs and outputs stay on record, greyed out and marked. The code the stale stages wrote is removed with one revert commit and pushed normally; history is append-only and nothing is force-pushed. If a person committed to the branch, nothing is reverted and the ticket is held with their commits named. Every move has a kind (advance, rerun, hold, resume, fail, retry, approve, reject) and a note, and one pure function lists every legal move. The plan, breakdown, review rounds and KB pointer are stored as versions (Versions tab, compare with the current one). Code stages record the commit range they covered, and the stage that runs again sees the note and its previous output. A back-edge that goes round too often (test fixes, CI fix, the same stage rerun) holds the ticket with the new reason `loop_limit`.
- A subtask's tests or implementation can be rerun on their own (`POST /tickets/:id/subtasks/:seq/rerun`); it replaces `redo-tests`, which is gone.

### Removed
- Jira MCP mode, the `jiraIntake` and `jiraSync` stages and their prompts, the MCP proxy port, and the MCP settings. Jira is REST only; existing MCP projects are migrated to REST (they need REST credentials in Settings → Connections).

### Changed
- The v0 build plan moved from `BUILD_PLAN.md` to `docs/build-plan/v0.0.0/BUILD_PLAN.md`.
- Jira intake only picks up issues labelled `sdlc-agent` by default. A project with an empty JQL now uses `project = "KEY" AND labels = "sdlc-agent" ORDER BY created ASC`; a JQL set on the project is used exactly as written, so the query can be changed per project. Before, an empty JQL picked up every issue of the Jira project.

- Agent split: one agent, one job. Fifteen agents (`packages/shared/src/agents.ts`), each with a prompt in `guidelines/stages/<agent>.md` and a generated `.claude/agents/sdlc-<agent>.md` (`npm run agents`; a test fails when they drift). Stage keys changed: `plan` is `solutionDesign` (features) or `bugInvestigation` (bugs), `breakdown` is `technicalDesign`, `review` is `prReview`, and there are new `featureMap`, `qualityReview`, `securityReview` and `ciTriage` stages. Existing project settings and global stage defaults under the old keys are ignored and take the new defaults.
- The KB step maps the ticket to a feature first (`featureMap`); only a new feature runs the documentor. The bug investigator puts the root cause (file, line, explanation) in the plan. The technical architect keeps the files in order of change. The pull-request reviewer checks every acceptance criterion is met and tested.
- Three reviewers run one after another: PR review, quality review (findings capped at medium) and security review (only when the diff touches risky paths or lines; project `securityRiskPatterns` add to the defaults). Findings are merged and de-duplicated, each stores its reviewer, and only critical and high ones start the fixer.
- CI failures are triaged: `code` goes to the fixer, `flaky` runs the failed checks again once, and `infra` (or a second flaky failure) becomes a `ci_infra` support ticket instead of a duplicate hold.
- The coder no longer writes tests when the test-writer stage is off; the existing tests run instead.

- Confluence document hub: plans are published as one Confluence page per ticket (`{KEY} — {title}`, under the project's parent page), with a status line ("Draft, waiting for approval", "Approved on …"), the plan, risks, open questions and, once given, their answers. A rerun, an approval and an answered question update the same page, sending the expected version; a hand edit is kept in Confluence history, noted on the page and recorded as a warning. Jira gets one link comment; the full plan goes to Jira only for projects without Confluence, or after Confluence failed 3 times (`CONFLUENCE_ERROR`). `DocumentHub` / `ConfluenceHub`, a Markdown to Confluence storage converter (`packages/shared/src/confluence-storage.ts`), "Open in Confluence" on the plan tab, and the Jira credential test now also checks Confluence.

- Orchestrator: where a ticket has several legal automatic moves and a decision point is defined (after review: update the knowledge base or skip it), code asks the `orchestrator` agent (haiku, no tools) to choose one; with no or one legal move code decides alone. The answer must be a legal move, otherwise the default move is used and a `warn` event is written. Extended thinking (a 2000-token budget, `MAX_THINKING_TOKENS`) is switched on only at decision points. Every decision is stored (`OrchestratorDecision`: legal moves, choice, reason, fallback flag, model, tokens, cost), written as an event on the ticket timeline, and summarised on the operations page (decisions, fallback rate, cost). The orchestrator is the sixteenth agent (`guidelines/stages/orchestrator.md`).

## [0.0.1] - 2026-11-13

First public pre-release. Published so the author can use sdlc-agent on their own projects (including sdlc-agent itself) and find what breaks. Not production-ready and not supported for other users.

### Added
- A held or failed ticket now explains what happened and lists the steps to keep it moving, with the actions that apply: Resume, Retry, and **Redo tests** (discards a subtask's tests and code and writes the tests again, with the failure and an optional note as context), so a wrong or over-strict test no longer leaves a ticket stuck.
- The Overview shows what the worker is doing: whether it is online, what the pipeline is doing, the result of the last Jira intake poll per mode (found, new, error, nothing to poll and why), and recent events. It refreshes every few seconds.
- Pause and resume the pipeline, and pause and resume Jira intake, from the top bar.
- Permanently delete a project from its page, with a warning dialog that shows what is removed and asks for the project name.
- The dashboard can be installed as a desktop app (PWA).
- The `sdlc-agent` npm CLI (`npx sdlc-agent init`): installs and runs the stack from the published images, with `up`, `down`, `status`, `logs`, `upgrade` (with a database backup), `doctor`, `reset-admin` and `uninstall`.
- First-run setup wizard: create the admin password with a one-time setup code, then enter the Claude token, GitHub token and git identity (Jira optional) in the dashboard, each with a Test button. The pipeline stays blocked, with a banner, until the required credentials are set.
- Credentials are stored in the database, encrypted with AES-256-GCM using `ENCRYPTION_KEY`. Environment variables still override stored values.
- Ticket pipeline: Jira (REST or MCP) or pasted tickets → AI plan → approval → AI breakdown → approval → test-first implementation per subtask → AI review (max 2 fix rounds) → knowledge-base update → CI wait (one fix round) → PR ready for human merge.
- Isolated agent containers (no capabilities, no Docker socket, egress only through an allowlisting proxy) and an orchestrator that does every commit, push and PR itself.
- Usage gate on the 5-hour and 7-day Claude windows, with Resume and Ignore actions.
- Dashboard: single-user login, queue, approvals, support queries, live logs, settings, guideline editing, charts.
- Per-repository knowledge base with a deterministic index.
- CI (lint, typecheck, unit, integration, e2e, Docker builds, audit), security scanning (CodeQL, gitleaks, dependency review, Scorecard) and Dependabot.
- Release pipeline: multi-arch images on GHCR with SBOM and provenance attestations, plus an install bundle on GitHub Releases.

### Changed
- `DASHBOARD_PASSWORD` and the token variables are optional; `ENCRYPTION_KEY` is required.

### Fixed
- Review comment tables escape backslashes before pipes, and settings updates ignore `__proto__`, `constructor` and `prototype` keys (CodeQL findings).
- Files the agent creates are open to the worker's user (`umask 000`), and a non-root worker only changes permissions on files it owns, so the integration tests and a non-root worker work on Linux.
- Jira intake no longer takes sub-tasks as tickets, including the sub-tasks the pipeline publishes for its own subtasks (it was picking those up and starting a new ticket for each).

### Security
- Agent containers mount the workspace `.git` read-only; worker git calls disable credential helpers and non-HTTPS protocols, and push to the stored repository URL only.
- Repository URLs are restricted to `https://github.com/…`, and the GitHub token is only handed to github.com.
- The worker no longer follows symlinks when reading or writing files in agent-written workspaces.
- The session cookie is redacted from request logs.
- The API container runs as a non-root user; all base images are pinned by digest.
- Dashboard security headers (frame-ancestors, nosniff, referrer policy); cross-site state-changing requests are refused.
- The egress proxy only allows HTTPS CONNECT.
- `DASHBOARD_PASSWORD` must be at least 12 characters.

### Removed
- `SESSION_SECRET` is no longer required (it was never used for signing).

### Changed (release tooling)
- The release workflow skips the macOS smoke test on tags and fills in an existing GitHub release instead of failing; Dependabot no longer proposes major updates of Node, Postgres and TypeScript.

### Known limits
- Only TypeScript/JavaScript stacks (Node.js, NestJS, Next.js).
- Single user, password login.
- Agents run with full permissions inside their containers; the worker runs as root with the Docker socket.
- The Claude usage pause is a guard, not a guarantee.
- No `script-src` Content-Security-Policy on the dashboard yet.

[Unreleased]: https://github.com/pjx16/sdlc-agentic-workflow/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/pjx16/sdlc-agentic-workflow/compare/v0.0.0...v0.0.1
[0.0.0]: https://github.com/pjx16/sdlc-agentic-workflow/releases/tag/v0.0.0
