FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
COPY docker/worker/git-askpass-token /usr/local/bin/git-askpass-token
RUN chmod +x /usr/local/bin/git-askpass-token
# Workspaces are written by the agent user (uid 1000) while the worker runs as root; without this git refuses them as 'dubious ownership'.
# Hooks and fsmonitor are disabled on every git call (git-runner.ts), so a workspace's own config cannot run code here.
RUN git config --system --add safe.directory '*'
ENV GIT_ASKPASS=/usr/local/bin/git-askpass-token GIT_TERMINAL_PROMPT=0

WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @sdlc/shared && npm run build -w @sdlc/api
WORKDIR /app/apps/api
ENV NODE_ENV=production
# Runs as root: the worker uses the Docker socket (BUILD_PLAN 6.1).
CMD ["node", "dist/worker.js"]
