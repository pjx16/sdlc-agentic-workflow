FROM node:24-bookworm-slim

# Pinned from the milestone-0 spike (SPIKE.md, task 0.1).
ARG CLAUDE_CODE_VERSION=2.1.322

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl bash jq \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# The node base image provides user `node` (uid 1000).
USER node
WORKDIR /workspace
