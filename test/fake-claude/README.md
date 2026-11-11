# fake-claude

A stand-in for the `claude` CLI so tests never call a real model (BUILD_PLAN section 11).

- `fake-claude.js` is a dependency-free Node script. `claude` is a small `sh` wrapper around it, mounted over `/usr/local/bin/claude` in the agent image (together with this directory at `/fake-claude`). The wrapper is needed because that path is a symlink to `claude.exe`, which Node will not run as a script.
- `scenarios/<name>/<stage>.json` is a list of attempts; attempt *n* uses entry *n* and the last entry repeats.
  The attempt number comes from `/context/stage.json` (`attempt`), or `FAKE_ATTEMPT`.
- Pick a scenario with `FAKE_SCENARIO` (default `default`); `FAKE_SCENARIOS_DIR` points at the scenarios directory.
- An entry is `{ edits, deletes, result, usage, rateLimit, exitCode, delayMs, subtype, fenced, noResult, leakEnv }`.

| Scenario | What it does |
| --- | --- |
| `ok` / `default` | `plan`, `implement` and `review` succeed; `plan` reports a rate-limit event |
| `schema-fail` | `plan` returns invalid output every time |
| `schema-retry` | `plan` returns invalid output, then a valid result on attempt 2 |
| `slow` | `plan` waits 60 s (for timeout and kill tests) |
| `turn-limit` | `plan` ends with `error_max_turns` |
| `needs-input` | `plan` asks a question |
| `rate-limit` | `plan` is rejected by the rate limiter |
| `leak` | `plan` prints `CLAUDE_CODE_OAUTH_TOKEN` in its output (tests log redaction) |
| `fenced` | `plan` returns its result as a fenced JSON block instead of `structured_output` |
