import { SESSION_COOKIE } from '@sdlc/shared';
import { cookies } from 'next/headers';

const API_URL = process.env.API_URL ?? 'http://api:4000';

/** Server-side check that the browser's session cookie is still valid. */
export async function hasValidSession(): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return false;
  try {
    const res = await fetch(`${API_URL}/auth/session`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}
