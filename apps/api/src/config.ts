const MIN_PASSWORD_LENGTH = 12;

/** Environment configuration read once at startup. Fails fast on missing required values. */
export class AppConfig {
  readonly dashboardPassword: string;
  readonly cookieSecure: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const missing = ['DASHBOARD_PASSWORD'].filter((k) => !env[k]);
    if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    if ((env.DASHBOARD_PASSWORD as string).length < MIN_PASSWORD_LENGTH) throw new Error(`DASHBOARD_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
    this.dashboardPassword = env.DASHBOARD_PASSWORD as string;
    this.cookieSecure = env.COOKIE_SECURE === 'true';
  }
}
