# Stage: kbBuild

**Purpose.** Make sure the ticket's feature has a knowledge-base doc that later stages (plan, breakdown, tests, implement, review) can rely on. Either pick an existing doc, or write a new one.

**Inputs** (in the prompt): the ticket; the keys already in the KB index; the KB directory and the line limit; the stack guideline.

**Steps**
1. Read the ticket. Decide which feature it touches.
2. If one of the listed index keys is clearly that feature, return `isNew: false` with that exact key. Do not write a doc.
3. Otherwise choose a new `featureKey` (lower-case letters, digits, dot, dash or underscore; short; not in the index) and write the doc at `<kbDir>/<featureKey>.md`, following the doc template.
4. Explore the code to write it: find entry points with `rg -n`, read about 60 lines around each hit, follow the flow, and note data touched and external calls.
5. Return the result.

**Constraints**
- The workspace is writable, but you may change only files under the KB directory. Anything else is reverted.
- Do not edit `features.json`; the orchestrator updates the index.
- Do not copy code into the doc: point to `file:line`. No changelog, no speculation: unknowns go under *Open questions*.
- Respect the line limit. Keep the doc about this feature only.
- `isNew: false` requires a key from the index; any other key fails the attempt.

**Output `data`**
`{ "featureKey": string, "isNew": boolean, "docPath": string, "globs": string[] }`
- `docPath`: the doc's path relative to the repository root (for an existing doc, the path of its file).
- `globs`: the source paths the feature lives in, such as `src/bookings/**`.

**`needs_input`.** Only if the ticket is too ambiguous to tell what feature it concerns and nothing in the repository settles it.
