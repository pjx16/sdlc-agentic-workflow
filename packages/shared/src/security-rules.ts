/**
 * When the security reviewer runs (BUILD_PLAN v1 4.3): a changed path or an added diff line matches the project's risk patterns. Pure
 * code, no AI: auth, sessions, crypto, SQL or raw queries, request parsing, the file system, shell, secrets and dependency manifests.
 * The orchestrator may also add the security review (phase 9); this is only the rule.
 */
export const DEFAULT_SECURITY_PATTERNS: readonly string[] = [
  // paths
  '(^|/)(auth|authn|authz|session|sessions|login|password|oauth|jwt|token|tokens|crypto|security|permission|permissions|acl|rbac)([/._-]|$)',
  '(^|/)(package\\.json|package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|requirements\\.txt|go\\.mod|Cargo\\.toml|Gemfile|pom\\.xml)$',
  '(^|/)\\.env', '(^|/)(secrets?|credentials?)([/._-]|$)', '(^|/)Dockerfile',
  // added lines
  '\\b(createHash|createHmac|createCipher\\w*|randomBytes|pbkdf2|bcrypt|argon2|jsonwebtoken|jwt\\.(sign|verify))\\b',
  '\\b(\\$queryRaw|\\$executeRaw|queryRawUnsafe|executeRawUnsafe|\\.query\\(|knex\\.raw|sequelize\\.query)',
  '\\b(select|insert|update|delete)\\b[^;\\n]{0,80}\\b(from|into|set)\\b[^;\\n]*(\\$\\{|\\+\\s*\\w)',
  '\\b(child_process|execSync|execFile|spawnSync?|exec\\()',
  '\\b(readFile|writeFile|createReadStream|createWriteStream|unlink|rmSync|rm\\()\\w*\\s*\\([^)]*(req\\.|params|query|body)',
  '\\b(req\\.(body|params|query|headers|cookies)|request\\.(body|params|query)|@Body\\(|@Param\\(|@Query\\()',
  '\\b(Authorization|Set-Cookie|cookie|bearer|api[_-]?key|secret|passwd|password)\\b',
  '\\b(eval|new Function|dangerouslySetInnerHTML|innerHTML)\\b',
];

export interface SecurityTrigger {
  triggered: boolean;
  /** The first few things that matched, for the event and the reviewer's prompt. */
  reasons: string[];
}

const compile = (patterns: readonly string[]): RegExp[] => patterns.map((p) => new RegExp(p, 'i'));

/**
 * `paths` are the changed files; `diff` is the unified diff. Only added lines count (`+`, not `+++`): code that was removed cannot
 * introduce a risk. `custom` replaces the built-in list when the project sets its own patterns.
 */
export function securityTriggered(paths: readonly string[], diff: string, custom: readonly string[] = []): SecurityTrigger {
  const patterns = compile(custom.length > 0 ? custom : DEFAULT_SECURITY_PATTERNS);
  const reasons: string[] = [];
  for (const p of paths) {
    const hit = patterns.find((re) => re.test(p));
    if (hit) reasons.push(`path ${p}`);
  }
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const text = line.slice(1);
    const hit = patterns.find((re) => re.test(text));
    if (hit) reasons.push(`added line "${text.trim().slice(0, 80)}"`);
    if (reasons.length >= 6) break;
  }
  return { triggered: reasons.length > 0, reasons: reasons.slice(0, 6) };
}
