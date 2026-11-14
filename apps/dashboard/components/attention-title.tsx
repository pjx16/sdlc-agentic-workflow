'use client';

import { useEffect } from 'react';

const PREFIX = /^\(\d+\) /;

/** Puts the number of open inbox items in the browser tab title, "(3) Overview", so a background tab shows that something waits. */
export function AttentionTitle({ count }: { count: number }) {
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(PREFIX, '');
      const next = count > 0 ? `(${count}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    apply();
    // Navigation sets a new title; put the number back in front of it.
    const el = document.querySelector('title');
    if (!el) return;
    const observer = new MutationObserver(apply);
    observer.observe(el, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [count]);
  return null;
}
