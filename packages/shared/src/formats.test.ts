import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORMATS, fillTemplate, formatPath, missingPlaceholders, placeholdersOf } from './formats';

describe('fillTemplate', () => {
  it('fills known placeholders, leaves unknown ones as written, and closes the gap an empty value leaves', () => {
    expect(fillTemplate('# {{ a }}\n\n{{b}}\n\n{{c}}\n\nend\n', { a: 'A', b: '', c: 'C' })).toBe('# A\n\nC\n\nend');
    expect(fillTemplate('{{a}} {{typo}}', { a: 1 })).toBe('1 {{typo}}');
  });
  it('does not treat a value that looks like a placeholder as one', () => {
    expect(fillTemplate('{{a}} {{b}}', { a: '{{b}}', b: 'B' })).toBe('{{b}} B');
  });
});

describe('FORMATS', () => {
  it('names are unique and every default uses only its own placeholders and all the required ones', () => {
    expect(new Set(FORMATS.map((f) => f.name)).size).toBe(FORMATS.length);
    for (const f of FORMATS) {
      const known = f.placeholders.map((p) => p.name);
      expect(placeholdersOf(f.default).filter((p) => !known.includes(p)), f.name).toEqual([]);
      expect(missingPlaceholders(f.name, f.default), f.name).toEqual([]);
    }
  });
  it('reports a required placeholder that was edited away', () => {
    expect(missingPlaceholders('review-comment', '## Review\n{{summary}}')).toEqual(['findings']);
    expect(missingPlaceholders('nope', 'x')).toEqual([]);
  });
  it('the files in guidelines/formats/ match the defaults (run `npm run formats` after changing a default)', () => {
    for (const f of FORMATS) {
      const file = readFileSync(path.resolve(__dirname, '../../../guidelines', formatPath(f.name)), 'utf8');
      expect(file, f.name).toBe(f.default);
    }
  });
});
