import { z } from 'zod';

/** Credentials that can be entered in the dashboard (SETUP_WIZARD_PLAN). An env var, when set, always wins over the stored value. */
export const CREDENTIAL_KEYS = [
  { key: 'claude_token', env: 'CLAUDE_CODE_OAUTH_TOKEN', secret: true, required: true, label: 'Claude token' },
  { key: 'github_token', env: 'GITHUB_TOKEN', secret: true, required: true, label: 'GitHub token' },
  { key: 'git_author_name', env: 'GIT_AUTHOR_NAME', secret: false, required: true, label: 'Git author name' },
  { key: 'git_author_email', env: 'GIT_AUTHOR_EMAIL', secret: false, required: true, label: 'Git author email' },
  { key: 'jira_base_url', env: 'JIRA_BASE_URL', secret: false, required: false, label: 'Jira base URL' },
  { key: 'jira_email', env: 'JIRA_EMAIL', secret: false, required: false, label: 'Jira email' },
  { key: 'jira_api_token', env: 'JIRA_API_TOKEN', secret: true, required: false, label: 'Jira API token' },
] as const;

export type CredentialKey = (typeof CREDENTIAL_KEYS)[number]['key'];
export type CredentialDefinition = (typeof CREDENTIAL_KEYS)[number];

export const credentialDefinition = (key: string): CredentialDefinition | undefined => CREDENTIAL_KEYS.find((c) => c.key === key);

export const CredentialValueSchemas: Record<CredentialKey, z.ZodType<string>> = {
  claude_token: z.string().trim().startsWith('sk-ant-', 'must start with sk-ant-'),
  github_token: z.string().trim().regex(/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/, 'must be a GitHub personal access token'),
  git_author_name: z.string().trim().min(1, 'required').max(100, 'must be at most 100 characters'),
  git_author_email: z.string().trim().email('must be an email address'),
  jira_base_url: z.string().trim().regex(/^https:\/\/[a-z0-9-]+\.atlassian\.net\/?$/, 'must be a Jira Cloud URL like https://acme.atlassian.net'),
  jira_email: z.string().trim().email('must be an email address'),
  jira_api_token: z.string().trim().min(20, 'must be at least 20 characters').max(500, 'must be at most 500 characters'),
};

export const CredentialValueBodySchema = z.object({ value: z.string() }).strict();

export interface CredentialView {
  key: CredentialKey;
  source: 'env' | 'db' | 'unset';
  /** Last 4 characters for secrets, the full value for non-secrets. */
  hint: string | null;
  verifiedAt: string | null;
  verifyError: string | null;
  updatedAt: string | null;
}

export interface SetupStatus {
  adminCreated: boolean;
  ready: boolean;
  missing: CredentialKey[];
  encryptionKeyOk: boolean;
}

export const SetupAdminBodySchema = z.object({ setupCode: z.string().min(1), password: z.string().min(12, 'must be at least 12 characters').max(256) }).strict();
export const ChangePasswordBodySchema = z.object({ current: z.string().min(1), next: z.string().min(12, 'must be at least 12 characters').max(256) }).strict();
