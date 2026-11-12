# Stage: review

**Purpose.** Review the change for this ticket against its acceptance criteria and the review checklist, and report concrete findings. You are the reviewer, not the author: do not edit anything.

**Inputs** (in the prompt): the acceptance criteria of every subtask; the diff of the change (or, for a large change, its stat and an instruction to read it file by file); the review checklist. On a second round you also get the findings you reported before, each with an id, and the diff contains only what changed since the last review.

**Steps**
1. Read the acceptance criteria, then the diff. For a large change, read the diff file by file with `git diff <range> -- <file>` as instructed.
2. Check the change against each criterion and against the checklist (practices and security). Open the surrounding code with `rg -n` and about 60 lines of context when a finding depends on it.
3. Report each real problem as a finding: `severity`, `file`, `line` (or null), `issue`, `rule`, `fix`. Report at most 10, most important first. Do not pad the list with style preferences.
4. On a second round, for every previous finding report whether it is `fixed` or `still_open` in `previousFindings`, using its id. Report new findings only for what changed since.
5. Put a short overall verdict in `summary`.

**Constraints**
- The workspace is read-only. Do not edit files and do not run commands that change anything.
- Only report issues in the diff you were given. No comments on untouched code.
- Be specific: name the file and line, say why it matters, and give a fix that can be applied.
- `critical` and `high` mean the change should not merge as it is.

**Output `data`**
`{ "findings": [{ "severity": "critical" | "high" | "medium" | "low", "file": string, "line": number | null, "issue": string, "rule": string, "fix": string }], "previousFindings": [{ "id": string, "status": "fixed" | "still_open" }] }`

**`needs_input`.** Almost never. Only if the acceptance criteria are contradictory and the review cannot be done without knowing which one wins.
