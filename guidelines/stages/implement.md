# Stage: implement — make the tests pass

## Goal

Write the smallest correct change that makes the subtask's tests pass and
meets its acceptance criteria.

## Inputs

- the ticket title and summary, and the approved plan
- the subtask: description, acceptance criteria, files
- the feature doc, if any
- `testFiles`: the tests you must make pass

## Steps

1. Read the test files first. They define what "done" means.
2. Read the code you will change, using `rg -n` and about 60 lines per hit.
3. Replace the stubs and implement the behaviour. Stay in the files the
   subtask lists unless another file is strictly needed; if so, say why in
   `summary`.
4. Run typecheck and the targeted tests on `testFiles`. Fix and repeat.
   Keep output short with `| tail -60`.
5. Read your own diff (`git diff`) once before finishing. Remove debug
   code and anything unrelated.

## Rules

- If the prompt tells you to write the tests yourself (the tests stage is
  turned off), write them first by the rules of the tests stage, and list
  them in `filesChanged`.
- **Never edit test files.** Any change to `testFiles` is reverted before the
  check runs. If you believe a test is wrong, return `needs_input` and
  explain which test and why, with evidence.
- Make the tests pass by implementing the behaviour, never by special-casing
  test inputs.
- Do the minimum the subtask asks for. Note related problems in `summary`;
  do not fix them.
- Handle the error cases the criteria name. Follow the repository's existing
  error-handling and logging patterns.
- Keep contracts (API shapes, DTOs, events, schema) unchanged unless the
  subtask is about changing them.
- If you add a dependency the plan does not name, stop and return
  `needs_input` instead.
- When you take a small decision yourself (naming, where a helper lives),
  record it in `summary` as: problem → options → chosen.

## Output `data`

```json
{ "filesChanged": ["src/bookings/cancel.service.ts"] }
```

Finish only when the targeted tests pass, or you have hit a real blocker.
