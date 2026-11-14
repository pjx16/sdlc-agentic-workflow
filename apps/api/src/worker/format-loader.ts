import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FORMATS, fillTemplate, formatPath, formatSpec } from '@sdlc/shared';

/**
 * Reads the formats under `guidelines/formats/` (see `packages/shared/src/formats.ts`). A file that is missing, empty or unreadable means the
 * built-in default, so a stage never fails because someone broke a format. Files are read each time, so an edit applies from the next write.
 */
export class FormatLoader {
  constructor(private readonly dir: string = process.env.GUIDELINES_DIR || path.resolve(__dirname, '../../../../guidelines')) {}

  /** The text of a format: the edited file, or the default. */
  async load(name: string): Promise<string> {
    const fallback = formatSpec(name)?.default ?? FORMATS.find((f) => f.name === name)?.default ?? '';
    try {
      const text = await readFile(path.join(this.dir, formatPath(name)), 'utf8');
      return text.trim() === '' ? fallback : text;
    } catch {
      return fallback;
    }
  }

  /** The format with its placeholders filled; no trailing whitespace. */
  async fill(name: string, values: Record<string, string | number>): Promise<string> {
    return fillTemplate(await this.load(name), values);
  }
}
