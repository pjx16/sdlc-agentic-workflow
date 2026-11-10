# sdlc-agent

A self-hosted, Docker-based **shipping engine** for solo developers on a Claude Code Pro subscription.

sdlc-agent takes a ticket from Jira (or one pasted into its dashboard) and turns it into a reviewable pull request:

1. **Plans** the ticket with AI, then waits for your approval.
2. **Breaks it down** into subtasks, then waits for your approval again.
3. **Implements** each subtask test-first, with AI agents running in isolated containers.
4. **Opens one pull request** per ticket.
5. **Reviews** the PR automatically for code quality and security, with a capped number of fix rounds.
6. **Hands you** a PR of "junior-engineer quality" to review, adjust and merge.

## Why

The one problem it solves: turning tickets into reviewable PRs with little hand-holding, while

- spending as little of the limited Pro usage allowance as possible, and
- never giving AI agents access to your machine or your credentials.

Anyone can clone the repository and run it with Docker Compose on macOS or a Linux VM.

## How it works

```
Ticket (Jira / dashboard)
        │
        ▼
   AI plan  ──►  👤 approve plan
        │
        ▼
 AI breakdown ──► 👤 approve breakdown
        │
        ▼
 For each subtask: AI writes tests ─► AI implements ─► orchestrator runs tests
        │
        ▼
 Orchestrator opens one PR per ticket
        │
        ▼
 AI code + security review ─► capped fix rounds
        │
        ▼
     👤 review, adjust, merge
```

## Design principles

Every design decision follows from these:

1. **Code does everything that needs no judgment.** Jira calls, git, GitHub, running tests, state tracking and scheduling are plain deterministic code. AI is used only for planning, breakdown, test writing, implementation, fixing, review and knowledge-base writing.
2. **Agents only edit files.** The orchestrator makes every commit, push, PR and Jira call. Agent containers never hold GitHub credentials (and Jira credentials only in the optional Jira MCP mode).
3. **Every AI stage is a fresh, narrow, capped run:** its own container, its own model, its own step limit, and only the context it needs.
4. **Humans gate three points:** plan approval, breakdown approval, and merge.
5. **One AI stage runs at a time, system-wide,** to protect the shared usage allowance.
6. **Everything is configurable per project** (stored in the database), with defaults shipped as files in the repository.

## Requirements

- Docker and Docker Compose
- macOS or a Linux VM
- A Claude Code Pro subscription
- A GitHub repository to ship into (and optionally a Jira project)

## Getting started

```bash
git clone git@github.com:pjx16/sdlc-agentic-workflow.git
cd sdlc-agentic-workflow
docker compose up
```

> Setup and configuration details will be added as the project is built out.
