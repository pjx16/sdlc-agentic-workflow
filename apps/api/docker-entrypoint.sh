#!/bin/sh
# Applies database migrations when any exist, then starts the API.
set -e
if [ -d prisma/migrations ] && [ -n "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  npx prisma migrate deploy
fi
exec node dist/main.js
