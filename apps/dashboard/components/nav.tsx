'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS, isActive } from '@/lib/nav-items';

export function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 p-3">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-2 text-sm ${
              active ? 'bg-accent text-accent-text' : 'text-muted hover:bg-bg hover:text-text'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
