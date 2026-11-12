FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
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
ENV NODE_ENV=production PORT=4000
# The API needs no privileges (unlike the worker, which needs the Docker socket and chown).
RUN chown -R node:node /app/apps/api
USER node
EXPOSE 4000
ENTRYPOINT ["sh", "/app/apps/api/docker-entrypoint.sh"]
