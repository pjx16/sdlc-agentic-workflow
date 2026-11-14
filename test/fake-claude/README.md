# fake-claude

A stand-in for the `claude` CLI so tests never call a real model (BUILD_PLAN section 11).

- `fake-claude.js` is a dependency-free Node script. `claude` is a small `sh` wrapper around it, mounted over `/usr/local/bin/claude` in the agent image (together with this directory at `/fake-claude`). The wrapper is needed because that path is a symlink to `claude.exe`, which Node will not run as a script.
- `scenarios/<name>/<stage>.json` is a list of attempts; attempt *n* uses entry *n* and the last entry repeats.
  The attempt number comes from `/context/stage.json` (`attempt`), or `FAKE_ATTEMPT`.
- Pick a scenario with `FAKE_SCENARIO` (default `default`); `FAKE_SCENARIOS_DIR` points at the scenarios directory.
- An entry is `{ edits, deletes, result, usage, rateLimit, exitCode, delayMs, subtype, fenced, noResult, leakEnv }`.

| Scenario | What it does |
| --- | --- |
| `ok` / `default` | `solutionDesign`, `implement` and `review` succeed; `solutionDesign` reports a rate-limit event |
| `schema-fail` | `solutionDesign` returns invalid output every time |
| `schema-retry` | `solutionDesign` returns invalid output, then a valid result on attempt 2 |
| `slow` | `solutionDesign` waits 60 s (for timeout and kill tests) |
| `turn-limit` | `solutionDesign` ends with `error_max_turns` |
| `needs-input` | `solutionDesign` asks a question |
| `rate-limit` | `solutionDesign` is rejected by the rate limiter |
| `leak` | `solutionDesign` prints `CLAUDE_CODE_OAUTH_TOKEN` in its output (tests log redaction) |
| `kb-new` | `kbBuild` writes a new doc and also edits a file outside the KB directory |
| `kb-existing` | `kbBuild` selects the existing `bookings` key |
| `kb-bad-key` | `kbBuild` returns `isNew: false` with a key that is not in the index |
| `tdd-ok` | `tests` and `implement` do two subtasks properly (selected per subtask with `promptMatches`) |
| `tdd-bad-impl` | `implement` and `fix` never produce a working implementation |
| `tdd-tamper` | `implement` edits the committed test file to always pass, leaving the implementation broken |
| `tdd-red-invalid` | `tests` writes tests whose run fails with `Cannot find module` (an invalid red) |
| `fenced` | `solutionDesign` returns its result as a fenced JSON block instead of `structured_output` |
