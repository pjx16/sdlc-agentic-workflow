#!/usr/bin/env bash
# Sourced by prod.sh and dev.sh: makes sure .env has an ENCRYPTION_KEY (it encrypts the tokens saved in the dashboard).
# Generates one when it is missing or empty, writes it into .env, and says so. Never prints the key.
ensure_encryption_key() {
  local env_file=${1:-.env}
  if grep -Eq '^ENCRYPTION_KEY=.+' "$env_file"; then return 0; fi
  command -v openssl >/dev/null || { echo "openssl is needed to generate ENCRYPTION_KEY; set it in .env (32 random bytes, base64)."; exit 1; }
  local key tmp
  key=$(openssl rand -base64 32)
  tmp=$(mktemp)
  if grep -q '^ENCRYPTION_KEY=' "$env_file"; then
    awk -v k="$key" '/^ENCRYPTION_KEY=/ { print "ENCRYPTION_KEY=" k; next } { print }' "$env_file" > "$tmp"
  else
    { cat "$env_file"; echo "ENCRYPTION_KEY=$key"; } > "$tmp"
  fi
  cat "$tmp" > "$env_file" # keeps the file's mode and owner
  rm -f "$tmp"
  echo "==> Generated ENCRYPTION_KEY and saved it in $env_file. Back that file up: it holds the key that encrypts your tokens."
}
