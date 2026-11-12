# Architecture

The architecture is documented once per version, so you can see what the system looked like at each release and how it changed.

| Version | Status | Folder |
| --- | --- | --- |
| **1.0.0** | Current | [`v1.0.0/`](./v1.0.0/README.md): system, trust boundaries, ticket lifecycle, subtask loop, worker loop, stages, data model, design decisions |

Each version folder holds a `README.md` and a `diagrams/` folder with its SVG files.

## How versions work

- A version folder is a snapshot of the architecture at that release. Fix mistakes in it; do not rewrite it for later changes.
- When a release changes the architecture (a new service, image or hop; a change to who holds a secret or what a container can reach; a new ticket state, hold reason, stage or housekeeping job; a changed design decision), copy the latest folder to `vX.Y.Z/`, edit the copy, and add a row to the change log below. Do this in the same pull request as the change, or in the release pull request at the latest.
- Releases that change nothing structural (bug fixes, small refactors, copy changes) get no folder and no row.
- The newest folder is the current architecture. Update the "Current" row in the table above and the diagram links in the root [`README.md`](../../README.md) when you add one.
- The project follows [semantic versioning](https://semver.org/): a new service or a change to the trust boundaries is a minor or major version, never a patch.

## Architecture change log

Newest first. One row per version folder, plus any fix worth recording.

| Date | Version | Change | Why | PR |
| --- | --- | --- | --- | --- |
| 2026-11-12 | 1.0.0 | Agent image creates `/npm-cache` owned by `node`; worker image sets `safe.directory '*'`; worker git calls pass `core.fsmonitor=false` | The first live run failed on cache ownership and on git refusing agent-owned workspaces | #15 |
| 2026-11-12 | 1.0.0 | Ticket creation rejects unknown fields; the `kbUpdate` stage rewrites statements the change made false | A mistyped field silently dropped the ticket body; KB docs kept "does not exist yet" notes | #15 |
| 2026-11-12 | 1.0.0 | First architecture snapshot: milestones 0 to 13 | Initial release | #1 to #16 |
