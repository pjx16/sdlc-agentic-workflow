# Issue tracker (Jira) integration

## Overview

The tracker integration connects the pipeline to Jira Cloud over REST v3. It pulls tickets in (intake), reads approval statuses, and writes comments, status moves and sub-tasks back. Jira problems never block the pipeline; only intake pauses. The repository's root `README.md` is the top-level project readme; it has no code behaviour of its own.

## Entry points

- `JiraClient` interface — `apps/api/src/jira/jira-client.ts:40` — what the pipeline may ask of a tracker
- `JiraRestClient` — `apps/api/src/jira/jira-rest-client.ts:34` — the only implementation (Basic auth, plain `fetch`)
- `JiraClients.forRest()` — `apps/api/src/jira/jira-clients.ts:27` — provider that hands out the client
- `IntakePoller.poll()` — `apps/api/src/worker/intake/intake-poller.ts:55` — called from the worker loop (`worker/loop/worker-loop.ts:210`)
- `ApprovalPoller.check()` — `apps/api/src/jira/approval-poller.ts:26` — inbound approvals (injected in `worker-loop.ts:50`)
- `JiraStatusSync.onTransition()` — `apps/api/src/jira/jira-status-sync.ts:23` — outbound status moves after a state transition
- `JiraModule` — `apps/api/src/jira/jira.module.ts:6` — exports `JiraClients` and `JiraStatusSync`

## Flow

1. Credentials (`jira_base_url`, `jira_email`, `jira_api_token`) are resolved; the client is rebuilt when they change; missing ones throw `JiraNotConfiguredError` — `jira-clients.ts:27`
2. Intake skips when intake is paused or in a 10-minute backoff — `intake-poller.ts:58`
3. For each enabled, confirmed project with a ready mirror, `searchTickets` runs the project JQL (default: label `sdlc-agent` in the project key) with pagination — `jira-rest-client.ts:58`
4. Jira sub-tasks are ignored; other issues are stored as NEW tickets once per `(projectId, externalKey)` — `intake-poller.ts:105`, `:110`
5. For tickets awaiting plan or breakdown approval, the poller reads the Jira status and approves if it equals the configured approval status — `approval-poller.ts:36`
6. Plan approval copies the Jira title and description onto the ticket; breakdown approval creates Subtask rows and publishes them to Jira — `approval-poller.ts:41`
7. After any transition, the project's `jiraStatusMap` target is applied via `transition()` if `jiraWriteBack.transitions` is on; the outcome goes on the `StateTransition` row — `jira-status-sync.ts:23`
8. Comments use a hidden marker (`jiraMarker`) so repeated writes are idempotent — `jira-client.ts:56`, `jira-rest-client.ts:86`
9. Every request retries network errors, 429 (honouring Retry-After) and 5xx with backoff, then throws `JiraUnavailableError`; other 4xx throw `JiraHttpError` — `jira-rest-client.ts:182`

## Data touched

- `Ticket` — created by intake with `source`, `externalKey`; title/body updated on plan approval (`intake-poller.ts:116`, `approval-poller.ts:42`)
- `Subtask` — created on breakdown approval (`approval-poller.ts:48`)
- `StateTransition` — `jiraStatusApplied`, `jiraSyncResult`, `jiraSyncError` (`jira-status-sync.ts:33`)
- `Event` — type `jira` row on failed sync (`jira-status-sync.ts:39`)
- `GlobalSettings.intakePaused` — read by intake (`intake-poller.ts:58`)
- `Project` — `jiraMode`, `jiraJql`, `jiraProjectKey`, `settings` (`jiraStatusMap`, `jiraApprovalStatuses`, `jiraWriteBack`)

## External calls

- Jira Cloud REST v3: `/rest/api/3/search/jql`, `/issue/{key}`, `/comment`, `/transitions`, `/issue` (create sub-task), `/project/{key}[/statuses]` — `jira-rest-client.ts:68-152`
- Failure: transitions never throw out of sync; auth failures raise a support item via `SupportRaiser` — `jira-status-sync.ts:35`

## Edge cases and business rules

- Only `jiraMode === 'rest'` is supported; `forMode` ignores its argument — `jira-clients.ts:23`
- `JiraUnavailableError` pauses intake for 10 minutes, not the pipeline — `intake-poller.ts:12`
- A pasted ticket with the same key causes a collision error, not a duplicate — `intake-poller.ts:135`
- A transition to a status with no matching Jira transition throws `JiraStatusNotFoundError` listing available ones — `jira-rest-client.ts:110`
- An invalid proposed breakdown cannot be approved from Jira — `approval-poller.ts:44`
- One bad ticket in the approval poll does not stop the others — `approval-poller.ts:58`

## Open questions

- The ticket asks for a "tracker readme" at the root; the root `README.md` exists and no tracker-specific file was found (`rg -ni tracker` hits only `docs/build-plan`). Whether a separate file is wanted is not verified.
