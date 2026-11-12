# sdlc-agent

Install and run **sdlc-agent**, a self-hosted, Docker-based engine that turns tickets (Jira or pasted) into reviewable pull requests with AI agents.

> [!WARNING]
> **Status: under development.** This is a `0.0.x` pre-release. It is published so I can use it on my own projects and find what breaks. It is not production-ready, and it is not supported for anyone else.
>
> **Known limits**
> - Only TypeScript/JavaScript stacks (Node.js, NestJS, Next.js) for now.
> - Single user, password login.
> - Agents run with full permissions inside their Docker containers. Don't point it at repositories you can't afford to lose, and don't run it on a machine that holds credentials you don't want exposed.
> - The Claude usage pause is a guard, not a guarantee. Check your plan's limits yourself.
>
> Feedback and bug reports are welcome, but expect breaking changes until `0.1.0`.

This package is only a launcher. The application is the Docker images published to GHCR, at the same version as the CLI.

## Requirements

- Docker with Compose v2.20 or newer, on macOS or Linux (on Windows, use WSL2)
- Node.js 20 or newer
- A Claude token (`claude setup-token`) and a GitHub token, which you enter in the browser

## Quick start

```bash
npx sdlc-agent init
```

`init` checks Docker, creates `~/.sdlc-agent`, generates the infrastructure secrets, starts the stack from the published images, and opens the dashboard. There you enter the setup code that `init` printed, create your admin password, and add your tokens. `init` asks no questions about tokens.

## Commands

| Command | What it does |
| --- | --- |
| `sdlc-agent init` | First install (`--bind <addr>`, `--no-start`, `--no-open`, `--force`) |
| `sdlc-agent up` | Pull the images and start the stack |
| `sdlc-agent down` | Stop the stack; your data is kept |
| `sdlc-agent status` | Version, containers and setup state |
| `sdlc-agent logs [service] [-f]` | Show logs |
| `sdlc-agent upgrade` | Move to this CLI's version (`--yes`, `--skip-backup`) |
| `sdlc-agent doctor` | Check Docker, the socket, port 3000, the data folder and disk space |
| `sdlc-agent reset-admin` | Forgot the password |
| `sdlc-agent uninstall` | Stop the stack and delete its database (`--purge` also removes the folder) |

All commands accept `--dir <path>`; the default folder is `$SDLC_AGENT_HOME` or `~/.sdlc-agent`.

## Where things live

```text
~/.sdlc-agent/
  docker-compose.yml   the release compose file
  .env                 secrets and settings (mode 0600)
  guidelines/          agent instructions; edit them here or in the dashboard
  data/                mirrors, workspaces, run folders and logs
  backups/             database dumps made by `upgrade`
```

**Back up `.env` separately from the database.** It holds `ENCRYPTION_KEY`, which encrypts the tokens you enter in the dashboard. If you lose it, the saved tokens cannot be read and must be entered again.

## Upgrading

Install the new CLI and run `upgrade`:

```bash
npx sdlc-agent@latest upgrade        # or: npm i -g sdlc-agent@latest && sdlc-agent upgrade
```

It prints the changelog between your version and the new one, asks for confirmation if the change may break things, writes a database backup to `backups/`, replaces the compose file, updates your guidelines, and restarts the stack. A guideline you edited is never overwritten: the new version is written beside it as `<file>.new` for you to review. Downgrades are not supported. Until `0.1.0`, read the changelog before upgrading.

## Forgot the password

```bash
sdlc-agent reset-admin
```

It removes the admin account, signs everyone out and prints a new setup code. Open the dashboard and create a new password. Your tokens and data are untouched.

## Uninstall

```bash
sdlc-agent uninstall            # stops the stack and deletes the database; keeps the folder (.env, backups)
sdlc-agent uninstall --purge    # also removes the folder
```

## Environment variables

- `SDLC_AGENT_HOME`: the install folder.
- `SDLC_AGENT_DEBUG=1`: print stack traces.
- `SDLC_AGENT_SKIP_DOCTOR=1`: skips the Docker checks. It exists only for this project's own tests (a CI runner without Docker); do not use it.

## Security

The package has no install scripts and no runtime dependencies, and is published from CI with provenance. See [SECURITY.md](https://github.com/pjx16/sdlc-agentic-workflow/blob/main/SECURITY.md) for the threat model and how to report a vulnerability.

License: MIT.
