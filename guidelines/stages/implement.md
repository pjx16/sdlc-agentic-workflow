# Stage: implement

**Purpose.** Make the tests for one subtask pass with the smallest correct change.

**Inputs** (in the prompt): the ticket title and summary; the plan; the subtask (title, description, acceptance criteria, files); the KB doc; the list of test files that must pass. Without a separate tests stage you are also told to write tests for your change. The stack guideline and general rules are in your system prompt.

**Steps**
1. Read the subtask and the failing tests. Run nothing that changes history; you only edit files.
2. Find the code to change with `rg -n` and read about 60 lines around each hit. Follow the repository's existing patterns.
3. Implement what the subtask asks, replacing any stubs the tests stage left. Do the minimum that satisfies the subtask and its acceptance criteria.
4. List the files you changed in `filesChanged`.

**Constraints**
- Do not edit the given test files. They are restored to their original content before the tests run, so edits to them are discarded.
- Stay inside this subtask. No refactors for taste, no unrelated fixes, no extra features.
- Edit files only: never run `git commit`, `git push`, `git reset` or any command that changes history.
- Add a dependency only if the subtask truly needs it; if you do, update `package.json` and the lockfile together.
- No secrets, no debug output left behind.

**Output `data`**
`{ "filesChanged": string[] }`

**`needs_input`.** Only when the subtask cannot be implemented without a decision that the ticket, plan, KB, tests and code do not settle.
