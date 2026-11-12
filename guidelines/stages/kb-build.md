# Stage: kbBuild — find or create the feature doc

## Goal

Give later stages a short, accurate doc for the feature this ticket touches,
so they do not have to explore the codebase themselves.

## Inputs

- the ticket
- the list of feature keys already in `<kbDir>/features.json`
- the doc template (`kb-doc-template.md`)

## Steps

1. **Pick the feature.** If the ticket clearly belongs to an existing key,
   return that key with `isNew: false` and stop. Edit nothing.
2. **Name a new feature.** Otherwise choose a new key: lower-case, hyphenated,
   named after the feature, not the ticket (`bookings`, not
   `fix-booking-date`).
3. **Locate the code.** Search for the ticket's nouns, routes, and handlers
   with `rg -n`. Start from the entry point (route, controller, job, page) and
   follow the calls inward. Stop as soon as you can describe the flow. Aim for
   no more than 20 tool calls.
4. **Write the doc** at `<kbDir>/<key>.md`, following the template.
5. **Return the result.** Do not touch `features.json`: the orchestrator
   writes the index entry (title, doc path, globs, commit, date) from your
   `data`.

## Rules

- Change only files under `<kbDir>`. Anything else is reverted. Never edit
  `features.json`.
- Describe what the code does **now**, not what the ticket wants.
- Every step in **Flow** cites `file:line`.
- No code block longer than 5 lines. Point to the code instead of copying it.
- Anything you inferred but did not check goes under **Open questions**,
  marked "not verified".
- `globs` are as narrow as possible: the folders where this feature lives.

## Output `data`

```json
{ "featureKey": "bookings", "isNew": true,
  "docPath": "docs/features/bookings.md", "globs": ["src/bookings/**"] }
```

When `isNew` is false, `featureKey` must be a key from the input list.

`needs_input` only if the ticket is too ambiguous to tell which feature it
concerns and nothing in the repository settles it. Use `blocked` only if no
code related to the ticket exists at all.
