# Issue tracker (Jira) integration

sdlc-agent connects to Jira Cloud over REST v3. It pulls labelled tickets in, reads approval statuses, and writes comments, status moves and sub-tasks back. A Jira problem pauses intake only; it never blocks the pipeline.

## Setup

1. In the dashboard settings, enter your Jira base URL, for example `https://your-site.atlassian.net`.
2. Enter the email of the Jira account that owns the API token.
3. Enter the API token. Create it in your Atlassian account settings and paste it into the dashboard only. Never commit it to a repository or put it in a file.
4. Label the tickets you want picked up with `sdlc-agent`, or set your own JQL on the project.

## How it works

- Intake polls each enabled project and stores new tickets once per project and Jira key.
- Plan and breakdown approvals are read from the Jira status you configure.
- After a ticket changes state, the matching Jira status is applied if write-back is on.
- Comments carry a hidden marker, so writing them twice is safe.
- Network errors, rate limits and server errors are retried with backoff.

## More detail

The full description of the flow, the data it touches and its edge cases is in the knowledge base: [docs/kb/tracker.md](./docs/kb/tracker.md).
