'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS, isActive } from '@/lib/nav-items';

export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-3 py-2">
      <div className="eyebrow px-3 pb-2 pt-1">Navigate</div>
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${
              active ? 'border-border-strong bg-accent-soft text-text' : 'border-transparent text-muted hover:bg-surface-2 hover:text-text'
            }`}
          >
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-accent shadow-[0_0_8px_var(--accent)]' : 'bg-border-strong'}`} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
