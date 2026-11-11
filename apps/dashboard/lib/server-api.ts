import { SESSION_COOKIE } from '@sdlc/shared';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const API_URL = process.env.API_URL ?? 'http://api:4000';

/** Server-side GET against the API with the browser's session cookie. Returns null on 404. */
export async function apiGet<T>(path: string): Promise<T | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const res = await fetch(`${API_URL}${path}`, {
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login'); // the session ended; the layout redirects too, but the page may have asked first
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${path} failed with ${res.status}`);
  return (await res.json()) as T;
}
