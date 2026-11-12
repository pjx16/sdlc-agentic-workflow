import type { TicketType } from '@sdlc/shared';

const PREFIX: Record<TicketType, string> = { story: 'feature', bug: 'bugfix', tech: 'tech' };
const MAX_SLUG = 40;

/** Lower-cased title, every run of non-alphanumerics replaced by one `-`, trimmed, at most 40 characters (BUILD_PLAN 6.2). */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop accents: "café" -> "cafe"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, MAX_SLUG).replace(/-+$/g, '');
}

/** `<feature|bugfix|tech>/<KEY>-<slug>`: story is feature, bug is bugfix, tech is tech. */
export function branchName(ticket: { key: string; title: string; type: TicketType }): string {
  const slug = slugify(ticket.title);
  return `${PREFIX[ticket.type]}/${ticket.key}${slug ? `-${slug}` : ''}`;
}

/** Keys become directory names and branch names, so only plain characters are accepted. */
export function assertSafeKey(key: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || key.includes('..')) throw new Error(`Unsafe ticket key "${key}"`);
}
