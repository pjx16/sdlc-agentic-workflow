import type { CmdResult } from './verify.service';

export type RedDecision = { valid: true } | { valid: false; reason: string };

const tail = (text: string, lines = 8) => text.split('\n').slice(-lines).join('\n');

/** Does the output match any pattern? An invalid pattern is skipped rather than crashing the pipeline. */
export function firstMatchingPattern(output: string, patterns: readonly string[]): string | null {
  for (const p of patterns) {
    try {
      if (new RegExp(p).test(output)) return p;
    } catch {
      /* ProjectSettings validates patterns; a stale invalid one must not take the worker down */
    }
  }
  return null;
}

/**
 * Verify-red (F9): the typecheck passes AND the targeted tests exit non-zero AND their output matches none of
 * `verify.redInvalidPatterns`. Anything else means the tests are broken rather than failing for the right reason.
 * `typecheck` is null when the project has no typecheck command (skipped).
 */
export function decideRed(args: { typecheck: CmdResult | null; tests: CmdResult; invalidPatterns: readonly string[] }): RedDecision {
  const { typecheck, tests } = args;
  if (typecheck && !typecheck.ok) return { valid: false, reason: `the typecheck fails, so the tests do not compile:\n${tail(typecheck.tail)}` };
  if (tests.timedOut) return { valid: false, reason: 'the targeted tests timed out' };
  if (tests.ok) return { valid: false, reason: 'the targeted tests pass, but they must fail before the implementation exists' };
  const pattern = firstMatchingPattern(tests.output, args.invalidPatterns);
  if (pattern) return { valid: false, reason: `the tests fail because of an error in the tests themselves (output matches "${pattern}"):\n${tail(tests.tail)}` };
  return { valid: true };
}

export type GreenDecision = { ok: true } | { ok: false; stage: 'install' | 'typecheck' | 'tests'; output: string };

/** Verify-green (F9): the typecheck must pass and the targeted tests must pass. The first failure decides what is fed back. */
export function decideGreen(args: { typecheck: CmdResult | null; tests: CmdResult | null }): GreenDecision {
  if (args.typecheck && !args.typecheck.ok) return { ok: false, stage: 'typecheck', output: args.typecheck.tail };
  if (args.tests && !args.tests.ok) return { ok: false, stage: 'tests', output: args.tests.timedOut ? `The tests timed out.\n${args.tests.tail}` : args.tests.tail };
  return { ok: true };
}
