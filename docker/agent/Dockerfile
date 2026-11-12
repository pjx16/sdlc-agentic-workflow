FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# Pinned from the milestone-0 spike (SPIKE.md, task 0.1).
ARG CLAUDE_CODE_VERSION=2.1.322

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl bash jq \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

COPY --chmod=755 run-stage run-cmd /usr/local/bin/

# The shared npm cache volume is mounted here; creating it owned by `node` makes a new volume writable by the agent user.
RUN mkdir /npm-cache && chown node:node /npm-cache

# The node base image provides user `node` (uid 1000).
USER node
WORKDIR /workspace
