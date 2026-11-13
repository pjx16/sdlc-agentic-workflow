'use client';

import Link from 'next/link';
import { InstallAppButton } from './install-app-button';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NAV_ITEMS, isActive } from '@/lib/nav-items';
import { BrandMark } from './brand-mark';
import { NavIcon } from './nav-icons';

const KEY = 'sdlc.sidebar.collapsed';
const DOT = { green: 'text-green', grey: 'text-grey', amber: 'text-amber' } as const;

interface Props {
  pipeline: { text: string; tone: keyof typeof DOT };
  /** Open blocking and approval items; shown on the Inbox entry. */
  inboxBadge?: number;
}

/** The left rail: brand, navigation with icons, and the pipeline state. It collapses to icons only, and remembers the choice in this browser. */
export function Sidebar({ pipeline, inboxBadge = 0 }: Props) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(KEY) === '1');
    } catch {
      /* storage unavailable: stay expanded */
    }
  }, []);

  function toggle() {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(KEY, c ? '0' : '1');
      } catch {
        /* the choice just is not remembered */
      }
      return !c;
    });
  }

  return (
    <aside data-collapsed={collapsed} className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-surface/80 backdrop-blur transition-[width] duration-200 ${collapsed ? 'w-16' : 'w-60'}`}>
      <div className={`flex items-center py-5 ${collapsed ? 'justify-center px-0' : 'gap-3 px-5'}`}>
        <BrandMark />
        {!collapsed && (
          <div className="leading-tight">
            <div className="font-display text-sm font-semibold tracking-wide">SDLC AGENT</div>
            <div className="eyebrow">Control deck</div>
          </div>
        )}
      </div>

      <nav aria-label="Main" className="flex flex-col gap-0.5 px-3 py-2">
        {!collapsed && <div className="eyebrow px-3 pb-2 pt-1">Navigate</div>}
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              aria-label={collapsed ? item.label : undefined}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center rounded-md border py-2 text-sm ${collapsed ? 'justify-center px-0' : 'gap-3 px-3'} ${
                active ? 'border-border-strong bg-accent-soft text-text' : 'border-transparent text-muted hover:bg-surface-2 hover:text-text'
              }`}
            >
              <span className={active ? 'text-accent' : ''}>
                <NavIcon name={item.icon} />
              </span>
              {!collapsed && item.label}
              {item.href === '/inbox' && inboxBadge > 0 && (
                <span data-testid="inbox-badge" className={`rounded-full bg-accent px-1.5 text-xs font-medium text-accent-text ${collapsed ? 'absolute -mr-6 -mt-5' : 'ml-auto'}`}>
                  <span className="sr-only">{inboxBadge} waiting for you: </span>
                  {inboxBadge > 99 ? '99+' : inboxBadge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-border">
        <div className={`flex items-center py-4 ${collapsed ? 'justify-center px-0' : 'gap-2 px-5'}`} title={collapsed ? `Pipeline: ${pipeline.text}` : undefined}>
          <span aria-hidden className={`dot ${DOT[pipeline.tone]} ${pipeline.tone === 'green' ? 'pulse' : ''}`} />
          {collapsed ? <span className="sr-only">Pipeline: {pipeline.text}</span> : (
            <div>
              <div className="eyebrow">Pipeline</div>
              <div className="font-mono text-xs">{pipeline.text}</div>
            </div>
          )}
        </div>
        <InstallAppButton collapsed={collapsed} />
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`flex w-full items-center border-t border-border py-3 text-muted hover:bg-surface-2 hover:text-text ${collapsed ? 'justify-center' : 'gap-3 px-6 text-sm'}`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`shrink-0 transition-transform ${collapsed ? 'rotate-180' : ''}`}>
            <path d="M15 6l-6 6 6 6" />
            <path d="M20 5v14" />
          </svg>
          {!collapsed && 'Collapse'}
        </button>
      </div>
    </aside>
  );
}
