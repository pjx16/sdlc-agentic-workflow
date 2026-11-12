import type { MetadataRoute } from 'next';

/** Served at /manifest.webmanifest. There is deliberately no service worker: it would cache authenticated pages. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'sdlc-agent',
    short_name: 'sdlc-agent',
    description: 'Turns tickets into reviewable pull requests with AI agents.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#060a10',
    theme_color: '#060a10',
    launch_handler: { client_mode: 'focus-existing' },
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
