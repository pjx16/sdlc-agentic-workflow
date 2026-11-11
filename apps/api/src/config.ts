/** Environment configuration read once at startup. Fails fast on missing required values. */
export class AppConfig {
  readonly dashboardPassword: string;
  readonly sessionSecret: string;
  readonly cookieSecure: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const missing = ['DASHBOARD_PASSWORD', 'SESSION_SECRET'].filter((k) => !env[k]);
    if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    this.dashboardPassword = env.DASHBOARD_PASSWORD as string;
    this.sessionSecret = env.SESSION_SECRET as string;
    this.cookieSecure = env.COOKIE_SECURE === 'true';
  }
}
