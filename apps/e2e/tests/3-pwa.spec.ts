import { expect, test } from '@playwright/test';

// The browser fetches the manifest and icons without cookies, so these must be public. No login in this spec.
test('the manifest is public and describes an installable app', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  const manifest = await res.json();
  expect(manifest).toMatchObject({ name: 'sdlc-agent', display: 'standalone', start_url: '/' });
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
});

test('the icons are public', async ({ request }) => {
  for (const [path, type] of [['/icons/icon-512.png', 'image/png'], ['/icons/icon-192.png', 'image/png'], ['/icons/icon-maskable-512.png', 'image/png'], ['/icon.svg', 'image/svg+xml']] as const) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()['content-type'], path).toContain(type);
  }
});

test('the login page links the manifest', async ({ request }) => {
  const html = await (await request.get('/login')).text();
  expect(html).toContain('<link rel="manifest"');
});
