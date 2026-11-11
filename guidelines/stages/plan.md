# Stage: plan

**Purpose.** Produce an implementation plan for the ticket that a developer can approve, and that the breakdown stage can split into subtasks.

**Inputs** (in the prompt): the ticket; the KB doc for the feature (if any); on a retry, the previous plan and the developer's rejection note. The stack guideline and general rules are in your system prompt.

**Steps**
1. Read the ticket and the KB doc. Identify what must change and why.
2. Inspect the code that will change: find it with `rg -n`, read about 60 lines around hits, and check how similar things are already done.
3. Write the plan in markdown with these sections: **Goal**, **Approach** (the main changes, in order, naming files and functions), **Tests** (what will be tested, per behaviour), **Out of scope**.
4. List `risks`: things that could go wrong or need care (migrations, compatibility, performance, security). Keep each to one line.
5. List `openQuestions` only for genuine unknowns that do not block the plan; the developer will see them when approving.
6. If you were given a rejection note, address every point in it and say what changed.

**Constraints**
- The workspace is read-only. Do not edit files.
- Plan only what the ticket asks for. No refactors for taste, no extra features.
- Prefer the repository's existing patterns. Name real files and functions you have looked at.
- Keep it short enough to review in a few minutes.

**Output `data`**
`{ "planMarkdown": string, "risks": string[], "openQuestions": string[] }`

**`needs_input`.** Only when a decision is missing that you cannot make from the ticket, the KB and the code, and a wrong guess would waste the whole plan. Put the question in `question`.
