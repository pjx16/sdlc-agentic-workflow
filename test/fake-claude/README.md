# fake-claude

A stand-in for the `claude` CLI so tests never call a real model (BUILD_PLAN section 11).

- `claude` is a dependency-free Node script. In the agent image it is mounted over `/usr/local/bin/claude`.
- `scenarios/<name>/<stage>.json` is a list of attempts; attempt *n* uses entry *n* and the last entry repeats.
  The attempt number comes from `/context/stage.json` (`attempt`), or `FAKE_ATTEMPT`.
- Pick a scenario with `FAKE_SCENARIO` (default `default`); `FAKE_SCENARIOS_DIR` points at the scenarios directory.
- An entry is `{ edits, deletes, result, usage, rateLimit, exitCode, delayMs, subtype, fenced, noResult }`.

| Scenario | What it does |
| --- | --- |
| `ok` / `default` | `plan`, `implement` and `review` succeed; `plan` reports a rate-limit event |
| `schema-fail` | `plan` returns invalid output every time |
| `schema-retry` | `plan` returns invalid output, then a valid result on attempt 2 |
| `slow` | `plan` waits 60 s (for timeout and kill tests) |
| `turn-limit` | `plan` ends with `error_max_turns` |
| `needs-input` | `plan` asks a question |
| `rate-limit` | `plan` is rejected by the rate limiter |
| `fenced` | `plan` returns its result as a fenced JSON block instead of `structured_output` |
