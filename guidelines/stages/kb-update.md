# Stage: kbUpdate

**Purpose.** Keep the feature's knowledge-base doc true after this ticket's change.

**Inputs** (in the prompt): the ticket's diff (base to HEAD), the existing feature doc, and the doc template.

**Steps**
1. Read the diff and the existing doc. Decide whether the change affects anything the doc describes: entry points, flow, data touched, external calls, edge cases, tests.
2. If it does not, change nothing and return `changed: false`.
3. Otherwise edit the doc in place, following the template. Verify each `file:line` pointer you add or keep with `rg -n` and a short read; fix pointers the diff made stale.
4. Return the result.

**Constraints**
- Change only files under the KB directory, and only the feature's own doc. Anything else is reverted. Do not edit `features.json`.
- Stay within the line limit. Condense old text rather than growing the doc.
- Do not copy code into the doc, do not write a changelog, do not speculate: unknowns go under *Open questions*.
- Never change `featureKey` or move the doc.

**Output `data`**
`{ "featureKey": string, "docPath": string, "changed": boolean }`
- `docPath`: the doc's path relative to the repository root.
- `changed`: `true` only if you edited the doc.
