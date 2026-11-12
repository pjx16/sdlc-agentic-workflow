import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CREDENTIAL_KEYS, CredentialValueSchemas, ErrorCodes, credentialDefinition, type CredentialKey, type CredentialView, type SetupStatus } from '@sdlc/shared';
import { ApiException } from '../common/api-exception';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialDecryptError, decrypt, encrypt, loadKey } from './crypto';

export type ResolvedCredentials = Record<CredentialKey, string>;

const CACHE_MS = 10_000;
export const UNDECRYPTABLE = 'Cannot decrypt with the current ENCRYPTION_KEY; enter it again';

interface Loaded {
  at: number;
  db: Map<CredentialKey, { value: string; error: string | null }>;
}

const envValue = (env: string): string => (process.env[env] ?? '').trim();

/**
 * Where every credential comes from: a non-empty env var wins, then the database (secrets are AES-256-GCM encrypted
 * with ENCRYPTION_KEY), then empty. Used by the API and the worker.
 */
@Injectable()
export class CredentialsService implements OnModuleInit {
  private readonly logger = new Logger(CredentialsService.name);
  private loaded: Loaded | null = null;
  private secrets: string[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.resolve().catch((err) => this.logger.warn(`Could not load credentials: ${err instanceof Error ? err.message : String(err)}`));
  }

  invalidate(): void {
    this.loaded = null;
  }

  private async loadDb(): Promise<Loaded> {
    if (this.loaded && Date.now() - this.loaded.at < CACHE_MS) return this.loaded;
    const rows = await this.prisma.credential.findMany();
    const key = loadKey();
    const db = new Map<CredentialKey, { value: string; error: string | null }>();
    for (const row of rows) {
      if (!credentialDefinition(row.key)) continue;
      if (!row.isSecret) {
        db.set(row.key as CredentialKey, { value: row.value, error: null });
        continue;
      }
      try {
        if (!key) throw new CredentialDecryptError();
        db.set(row.key as CredentialKey, { value: decrypt(key, row.key, row.value), error: null });
      } catch {
        db.set(row.key as CredentialKey, { value: '', error: UNDECRYPTABLE });
      }
    }
    this.loaded = { at: Date.now(), db };
    return this.loaded;
  }

  async resolve(): Promise<ResolvedCredentials> {
    const { db } = await this.loadDb();
    const out = {} as ResolvedCredentials;
    for (const def of CREDENTIAL_KEYS) out[def.key] = envValue(def.env) || db.get(def.key)?.value || '';
    this.secrets = CREDENTIAL_KEYS.filter((d) => d.secret).map((d) => out[d.key]).filter((v) => v.length > 0);
    return out;
  }

  /** Every current secret value (env and database), synchronously, for redaction. Refreshed by each resolve(). */
  secretsSnapshot(): string[] {
    return this.secrets;
  }

  async views(): Promise<CredentialView[]> {
    await this.loadDb();
    const rows = new Map((await this.prisma.credential.findMany()).map((r) => [r.key, r]));
    const { db } = await this.loadDb();
    return CREDENTIAL_KEYS.map((def): CredentialView => {
      const row = rows.get(def.key);
      const fromEnv = envValue(def.env);
      if (fromEnv) return { key: def.key, source: 'env', hint: def.secret ? fromEnv.slice(-4) : fromEnv, verifiedAt: null, verifyError: null, updatedAt: null };
      if (!row) return { key: def.key, source: 'unset', hint: null, verifiedAt: null, verifyError: null, updatedAt: null };
      return {
        key: def.key,
        source: 'db',
        hint: row.hint,
        verifiedAt: row.verifiedAt?.toISOString() ?? null,
        verifyError: db.get(def.key)?.error ?? row.verifyError,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async set(key: CredentialKey, raw: string): Promise<void> {
    const def = credentialDefinition(key);
    if (!def) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Unknown credential');
    if (envValue(def.env)) throw new ApiException(HttpStatus.CONFLICT, ErrorCodes.conflict, `${def.env} is set in .env and overrides the dashboard`);
    const parsed = CredentialValueSchemas[key].safeParse(raw);
    if (!parsed.success) throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'Invalid value', { value: parsed.error.issues[0]?.message ?? 'invalid' });
    const value = parsed.data;
    let stored = value;
    if (def.secret) {
      const encryptionKey = loadKey();
      if (!encryptionKey) throw new ApiException(HttpStatus.BAD_REQUEST, ErrorCodes.validation, 'ENCRYPTION_KEY is not set');
      stored = encrypt(encryptionKey, key, value);
    }
    const hint = def.secret ? value.slice(-4) : value;
    const data = { value: stored, isSecret: def.secret, hint, verifiedAt: null, verifyError: null };
    await this.prisma.credential.upsert({ where: { key }, update: data, create: { key, ...data } });
    this.invalidate();
    await this.resolve();
  }

  async remove(key: CredentialKey): Promise<void> {
    await this.prisma.credential.deleteMany({ where: { key } });
    this.invalidate();
    await this.resolve();
  }

  async markVerified(key: CredentialKey, error: string | null): Promise<void> {
    await this.prisma.credential.updateMany({ where: { key }, data: { verifiedAt: error ? null : new Date(), verifyError: error } });
    this.invalidate();
  }

  async status(): Promise<SetupStatus> {
    const resolved = await this.resolve();
    const missing = CREDENTIAL_KEYS.filter((d) => d.required && !resolved[d.key]).map((d) => d.key);
    const adminCreated = Boolean(process.env.DASHBOARD_PASSWORD?.trim()) || (await this.prisma.adminAccount.count()) > 0;
    let encryptionKeyOk = true;
    try {
      encryptionKeyOk = loadKey() !== null;
    } catch {
      encryptionKeyOk = false;
    }
    return { adminCreated, ready: adminCreated && missing.length === 0, missing, encryptionKeyOk };
  }
}
