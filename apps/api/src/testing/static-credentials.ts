import { CREDENTIAL_KEYS } from '@sdlc/shared';
import type { CredentialsService, ResolvedCredentials } from '../credentials/credentials.service';

/** A CredentialsService stand-in with fixed values, for tests that do not need the database. */
export function staticCredentials(values: Partial<ResolvedCredentials> = {}): CredentialsService {
  const resolved = Object.fromEntries(CREDENTIAL_KEYS.map((d) => [d.key, ''])) as ResolvedCredentials;
  Object.assign(resolved, { git_author_name: 'Dev Bot', git_author_email: 'bot@example.com' }, values);
  const secrets = CREDENTIAL_KEYS.filter((d) => d.secret).map((d) => resolved[d.key]).filter(Boolean);
  return {
    resolve: async () => resolved,
    secretsSnapshot: () => secrets,
    invalidate: () => undefined,
    status: async () => ({ adminCreated: true, ready: true, missing: [], encryptionKeyOk: true }),
  } as unknown as CredentialsService;
}
