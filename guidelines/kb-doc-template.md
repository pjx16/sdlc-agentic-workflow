# Knowledge-base doc template

One markdown file per feature, named `<featureKey>.md`. At most the number of lines given in the prompt (`kbDocMaxLines`).
Write for a developer who has never seen this code and needs to change it safely.

**Rules.** Describe what exists today. Do not copy code (point to `file:line`). Do not write a changelog. Do not speculate:
if you are not sure, put it under *Open questions*.

---

```markdown
# <Feature title>

## Overview
Two to four sentences: what the feature does, who uses it, and where it lives.

## Entry points
- `path/to/file.ts:42` — what triggers the feature (route, handler, job, event, UI action).

## Flow
1. `path/to/file.ts:42` — what happens first.
2. `path/to/other.ts:17` — what happens next.
3. ...

## Data touched
- Tables, collections, files or caches that are read or written, and by which step.

## External calls
- Other services, APIs or queues this feature calls, and what it sends.

## Edge cases and business rules
- Rules that are easy to break: limits, ordering, idempotency, permissions, validation.

## Open questions
- Things that could not be confirmed from the code.
```
