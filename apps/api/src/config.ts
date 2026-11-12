import { loadKey } from './credentials/crypto';

const MIN_PASSWORD_LENGTH = 12;

/** Environment configuration read once at startup. */
export class AppConfig {
  /** Empty when the password is created in the setup wizard instead. */
  readonly dashboardPassword: string;
  readonly encryptionKey: Buffer | null;
  readonly cookieSecure: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const password = env.DASHBOARD_PASSWORD ?? '';
    if (password && password.length < MIN_PASSWORD_LENGTH) throw new Error(`DASHBOARD_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
    this.dashboardPassword = password;
    this.encryptionKey = loadKey(env); // throws only when ENCRYPTION_KEY is set but malformed
    this.cookieSecure = env.COOKIE_SECURE === 'true';
  }
}
