# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Until `0.1.0`, any release may contain breaking changes (database migrations, configuration, API). Read this file before upgrading.

## [Unreleased]

### Changed
- Jira intake only picks up issues labelled `sdlc-agent` by default. A project with an empty JQL now uses `project = "KEY" AND labels = "sdlc-agent" ORDER BY created ASC` (REST and MCP); a JQL set on the project is used exactly as written, so the query can be changed per project. Before, an empty JQL picked up every issue of the Jira project.

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
