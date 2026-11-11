import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS } from '@sdlc/shared';
import { decideGreen, decideRed, firstMatchingPattern } from './verify-decisions';
import type { CmdResult } from './verify.service';

const cmd = (over: Partial<CmdResult> & { output?: string } = {}): CmdResult => {
  const output = over.output ?? '';
  return { ok: false, exitCode: 1, timedOut: false, tail: output, output, ...over };
};
const pass = () => cmd({ ok: true, exitCode: 0, output: 'ok' });
const patterns = DEFAULT_PROJECT_SETTINGS.verify.redInvalidPatterns;
const red = (over: Parameters<typeof decideRed>[0]) => decideRed(over);

describe('decideRed (F9 verify-red)', () => {
  it('is valid when the typecheck passes and the tests fail for a real reason', () => {
    expect(red({ typecheck: pass(), tests: cmd({ output: 'AssertionError: expected 1 to be 2' }), invalidPatterns: patterns })).toEqual({ valid: true });
  });

  it('treats a skipped typecheck (empty command) like a passing one', () => {
    expect(red({ typecheck: null, tests: cmd({ output: 'FAIL src/a.test.ts\nexpected true' }), invalidPatterns: patterns })).toEqual({ valid: true });
  });

  it('is invalid when the typecheck fails', () => {
    const d = red({ typecheck: cmd({ output: 'src/a.test.ts(3,5): error TS2304: Cannot find name foo' }), tests: cmd({ output: 'fails' }), invalidPatterns: patterns });
    expect(d).toMatchObject({ valid: false });
    expect(d.valid === false && d.reason).toContain('the typecheck fails');
    expect(d.valid === false && d.reason).toContain('TS2304');
  });

  it('is invalid when the tests pass', () => {
    const d = red({ typecheck: pass(), tests: pass(), invalidPatterns: patterns });
    expect(d.valid === false && d.reason).toContain('must fail before the implementation exists');
  });

  it('is invalid when the tests time out', () => {
    expect(red({ typecheck: pass(), tests: cmd({ timedOut: true, exitCode: 124 }), invalidPatterns: patterns })).toEqual({ valid: false, reason: 'the targeted tests timed out' });
  });

  describe('redInvalidPatterns (the default three)', () => {
    for (const [name, output] of [['Cannot find module', "Error: Cannot find module './f1' from 'src/f1.test.ts'"], ['SyntaxError', 'SyntaxError: Unexpected token }'], ['error TS', 'src/f1.test.ts:4:9 - error TS2345: Argument of type']] as const) {
      it(`rejects output containing "${name}"`, () => {
        const d = red({ typecheck: pass(), tests: cmd({ output }), invalidPatterns: patterns });
        expect(d.valid).toBe(false);
        expect(d.valid === false && d.reason).toContain('an error in the tests themselves');
      });
    }
    it('uses the patterns it is given: a custom pattern, and an emptied list', () => {
      expect(red({ typecheck: pass(), tests: cmd({ output: 'Boom: fixture exploded' }), invalidPatterns: ['Boom'] }).valid).toBe(false);
      expect(red({ typecheck: pass(), tests: cmd({ output: 'Cannot find module x' }), invalidPatterns: [] })).toEqual({ valid: true });
    });
    it('matches regular expressions over the whole output, not only the tail', () => {
      const d = red({ typecheck: pass(), tests: { ...cmd({ output: 'x' }), tail: 'last line', output: 'first line: error TS9999\nlots\nof\noutput' }, invalidPatterns: patterns });
      expect(d.valid).toBe(false);
    });
  });
});

describe('firstMatchingPattern', () => {
  it('returns the first pattern that matches, or null', () => {
    expect(firstMatchingPattern('error TS2304', ['SyntaxError', 'error TS[0-9]+'])).toBe('error TS[0-9]+');
    expect(firstMatchingPattern('fine', patterns)).toBeNull();
  });
  it('skips an invalid regular expression instead of throwing', () => {
    expect(firstMatchingPattern('abc', ['(', 'abc'])).toBe('abc');
  });
});

describe('decideGreen (F9 verify-green)', () => {
  it('passes when typecheck and tests pass, or are skipped', () => {
    expect(decideGreen({ typecheck: pass(), tests: pass() })).toEqual({ ok: true });
    expect(decideGreen({ typecheck: null, tests: null })).toEqual({ ok: true });
  });
  it('fails on the typecheck first, then on the tests, feeding back that output', () => {
    expect(decideGreen({ typecheck: cmd({ output: 'error TS1' }), tests: cmd({ output: 'tests fail' }) })).toEqual({ ok: false, stage: 'typecheck', output: 'error TS1' });
    expect(decideGreen({ typecheck: pass(), tests: cmd({ output: 'expected 2' }) })).toEqual({ ok: false, stage: 'tests', output: 'expected 2' });
  });
  it('says when the tests timed out', () => {
    expect(decideGreen({ typecheck: null, tests: cmd({ timedOut: true, output: 'partial' }) })).toMatchObject({ ok: false, stage: 'tests', output: 'The tests timed out.\npartial' });
  });
});
