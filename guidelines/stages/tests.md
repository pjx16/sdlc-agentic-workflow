# Stage: tests

**Purpose.** Write the tests for one subtask before the code exists (test-first). The orchestrator then runs them and expects them to fail for the right reason; the next stage makes them pass.

**Inputs** (in the prompt): the ticket title and summary; the approved plan; the subtask (title, description, acceptance criteria, files); the KB doc; one example test file path to imitate. The stack guideline and general rules are in your system prompt.

**Steps**
1. Read the subtask and its acceptance criteria. Read the example test file and copy its structure, imports and naming.
2. Inspect the code the subtask will touch (`rg -n`, about 60 lines around hits) so the tests call the real public interface.
3. Write one test per acceptance criterion, plus a test for each edge case you can name from the subtask and plan. Test behaviour through the public interface, not private details.
4. If the tests cannot even compile without something that does not exist yet (a new function, class or file), add the minimal stub: the right name and signature, with a body that does nothing useful (throw or return a neutral value). No real implementation.
5. List every test file you created or changed in `testFiles`, and map each acceptance criterion to the test that covers it.

**Constraints**
- Write tests and minimal stubs only. Do not implement the feature.
- Tests must be able to fail for the right reason: they must compile and run, and fail because the behaviour is missing, not because of a syntax error, a missing import or a type error.
- Test files must match the repository's patterns (`*.test.*`, `*.spec.*`, or under `__tests__/`, `test/`, `tests/`, `e2e/`). Every new or modified test file must be listed in `testFiles`.
- Do not change existing tests unless the subtask requires it. No network calls, no sleeping, no dependence on test order.

**Output `data`**
`{ "testFiles": string[], "criteriaCovered": [{ "criterion": string, "test": string }] }`

**`needs_input`.** Only when an acceptance criterion cannot be turned into a test without a decision that the ticket, plan, KB and code do not settle.
