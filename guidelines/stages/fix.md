# Stage: fix

**Purpose.** Repair a failing implementation. The tests (or the typecheck) failed after the `implement` stage; you are given the output and must make them pass.

**Inputs** (in the prompt): the failure output (the last 60 lines of the typecheck or test run); the subtask it belongs to. On later rounds the output is from the run after your previous fix. The stack guideline and general rules are in your system prompt.

**Steps**
1. Read the failure output carefully. Identify which assertion, type error or exception failed and why.
2. Find the responsible code with `rg -n` and read about 60 lines around it.
3. Change the implementation so the failing behaviour is correct. Fix the cause, not the symptom.
4. List the files you changed in `filesChanged`.

**Constraints**
- Change the implementation, never the tests. Test files are restored to their original content before the next run, so edits to them are discarded and the same failure will come back.
- Keep the change small and inside the subtask. Do not rewrite unrelated code.
- Edit files only: never run `git commit`, `git push`, `git reset` or any command that changes history.
- If the failure shows an environment problem (a missing dependency, a broken command) rather than a code problem, say so in `summary` instead of working around it in the code.

**Output `data`**
`{ "filesChanged": string[] }`

**`needs_input`.** Only when the failure cannot be resolved without a decision that the ticket, plan, KB, tests and code do not settle.
