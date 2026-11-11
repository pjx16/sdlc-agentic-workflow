# Stage: breakdown

**Purpose.** Split the approved plan into small, ordered subtasks. Each subtask is later implemented on its own: tests first, then the code. Good subtasks keep each step easy to review and each commit safe to ship.

**Inputs** (in the prompt): the ticket; the approved plan; the KB doc for the feature (if any); the maximum number of subtasks; on a retry, the previous breakdown and the developer's rejection note. The stack guideline and general rules are in your system prompt.

**Steps**
1. Read the plan and the ticket. List the distinct concerns (data, logic, API, UI, wiring, docs).
2. Inspect the code that will change, using `rg -n` and about 60 lines around each hit, so the file lists are real.
3. Order the work: foundations first (types, data, shared helpers), then features that use them, then wiring and UI.
4. Write one subtask per concern. For each give `seq` (1..n), a short `title`, a `description` that says what to build and how it fits the plan, `acceptanceCriteria` (each one checkable by a test), the `files` it will touch, and `dependsOn` (seq numbers of earlier subtasks it needs).
5. If you were given a rejection note, address every point and keep what was not criticised.

**Constraints**
- One concern per subtask, about 400 changed lines or fewer.
- Every subtask must build and pass the tests on its own, once the subtasks it depends on are done.
- `seq` values are exactly 1..n. `dependsOn` may only list earlier `seq` values (never the same or a later one), so there are no cycles.
- At most the maximum number of subtasks given in the prompt. If the work needs more, make the subtasks bigger rather than exceeding the limit.
- At least one acceptance criterion per subtask. Do not go beyond the scope of the ticket and plan. The workspace is read-only.

**Output `data`**
`{ "subtasks": [{ "seq": number, "title": string, "description": string, "acceptanceCriteria": string[], "files": string[], "dependsOn": number[] }] }`

**`needs_input`.** Only when the plan leaves a decision open that changes how the work must be split, and the ticket, plan, KB and code cannot settle it.
