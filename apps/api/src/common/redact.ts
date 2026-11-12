export const REDACTED = '[REDACTED]';

/** Shapes of secrets we know about, so a leaked value is hidden even if it was never configured. */
const PATTERNS: readonly [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, REDACTED], // Anthropic / Claude OAuth tokens
  [/ATATT[A-Za-z0-9_=-]{20,}/g, REDACTED], // Atlassian API tokens
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, REDACTED], // GitHub tokens
  [/github_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/(\bBasic\s+)[A-Za-z0-9+/=]{12,}/g, `$1${REDACTED}`], // Authorization: Basic ...
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, `$1${REDACTED}`],
];

const MIN_SECRET_LENGTH = 8; // shorter values would redact ordinary words

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Returns a function that replaces every known secret value, and every token-shaped string,
 * with `[REDACTED]`. Secrets are matched literally and also inside JSON-escaped text.
 */
export function createRedactor(secrets: readonly (string | undefined)[]): (text: string) => string {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    variants.add(secret);
    variants.add(JSON.stringify(secret).slice(1, -1)); // as it appears inside a JSON string
  }
  // Longest first, so a secret that contains another is replaced whole.
  const literal = [...variants].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const literalRe = literal.length > 0 ? new RegExp(literal.join('|'), 'g') : null;
  return (text) => {
    let out = literalRe ? text.replace(literalRe, REDACTED) : text;
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  };
}
