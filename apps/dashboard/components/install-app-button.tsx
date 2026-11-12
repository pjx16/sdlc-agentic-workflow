'use client';

import { useEffect, useState } from 'react';

/** Chromium's install prompt event (not in the DOM typings). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

const standalone = () => typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches;

/** A small "Install app" button, shown only while Chromium offers installation and the app is not already installed. Renders nothing elsewhere. */
export function InstallAppButton({ collapsed = false }: { collapsed?: boolean }) {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as InstallPromptEvent);
    };
    const onInstalled = () => setEvent(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!event || standalone()) return null;
  return (
    <button
      type="button"
      onClick={() => void event.prompt()}
      title="Install sdlc-agent as an app"
      className={`flex w-full items-center border-t border-border py-3 text-muted hover:bg-surface-2 hover:text-text ${collapsed ? 'justify-center' : 'gap-3 px-6 text-sm'}`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
        <path d="M12 4v11" />
        <path d="M7 11l5 5 5-5" />
        <path d="M5 20h14" />
      </svg>
      {collapsed ? <span className="sr-only">Install app</span> : 'Install app'}
    </button>
  );
}
