# Stage: kbUpdate

**Purpose.** Keep the feature's knowledge-base doc true after this ticket's change.

**Inputs** (in the prompt): the ticket's diff (base to HEAD), the existing feature doc, and the doc template.

**Steps**
1. Read the diff and the existing doc. Decide whether the change affects anything the doc describes: entry points, flow, data touched, external calls, edge cases, tests.
2. Look for statements the change made false, not only for new facts. The doc was written before this ticket's code existed, so it may say that files, functions or tests "do not exist yet", "are planned", "are to be added" or "are not implemented", or list as an open question something the diff now answers. Rewrite each such statement to describe the code as it is now, and remove open questions the diff answered.
3. If nothing in the doc is affected or false, change nothing and return `changed: false`.
4. Otherwise edit the doc in place, following the template. Verify each `file:line` pointer you add or keep with `rg -n` and a short read; fix pointers the diff made stale.
5. Return the result.

**Constraints**
- Change only files under the KB directory, and only the feature's own doc. Anything else is reverted. Do not edit `features.json`.
- Stay within the line limit. Condense old text rather than growing the doc.
- Do not copy code into the doc, do not write a changelog, do not speculate: unknowns go under *Open questions*.
- Never change `featureKey` or move the doc.

**Output `data`**
`{ "featureKey": string, "docPath": string, "changed": boolean }`
- `docPath`: the doc's path relative to the repository root.
- `changed`: `true` only if you edited the doc.
