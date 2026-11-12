# Stage: kbUpdate — keep the feature doc true

## Goal

Update the feature doc so it matches the code after this ticket. A stale or
bloated doc is worse than none, because every later stage trusts it.

## Inputs

- the ticket's full diff (base branch to HEAD)
- the existing feature doc
- the doc template (`kb-doc-template.md`)

## Steps

1. Read the diff. List what changed in behaviour: new entry points, changed
   flow steps, new data touched, new external calls, new edge cases or rules.
2. If none of that changed and nothing in the doc became false (for example a
   pure refactor, or only tests), return `changed: false` and edit nothing.
3. Otherwise edit the sections that are affected or now false. Update
   `file:line` references that moved.
4. Look for statements the change made false, not only for new facts. The
   doc was written before this ticket's code existed, so it may say that
   files, functions, or tests "do not exist yet", "are planned", "are to be
   added", or "are not implemented", or list as an open question something
   the diff now answers. Rewrite each such statement to describe the code as
   it is now, and remove the open questions the diff answered.
5. Verify each `file:line` pointer you add or keep with `rg -n` and a short
   read; fix pointers the diff made stale.

## Rules

- Change only files under `<kbDir>`, and only the feature's own doc. Never
  edit `features.json`: the orchestrator maintains the index.
- Describe the code as it is now. No history ("previously…"), no changelog,
  no ticket numbers.
- Keep the template's sections and order. Stay under the line limit given in
  the prompt; if you are over it, shorten older detail rather than dropping
  the new behaviour.
- No code blocks longer than 5 lines.
- Do not rewrite sections the diff did not affect, even if you would phrase
  them differently.
- Resolve an **Open questions** entry only if the diff answers it.
- You cannot ask questions: never use `needs_input`. Anything you cannot
  confirm goes under **Open questions**, marked "not verified".

## Output `data`

```json
{ "featureKey": "bookings", "docPath": "docs/features/bookings.md",
  "changed": true }
```
