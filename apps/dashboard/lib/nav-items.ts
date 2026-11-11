export interface NavItem {
  label: string;
  href: string;
}

/** Left-rail navigation (BUILD_PLAN 6.10). */
export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Overview', href: '/' },
  { label: 'Tickets', href: '/tickets' },
  { label: 'Support', href: '/support' },
  { label: 'Projects', href: '/projects' },
  { label: 'Guidelines', href: '/guidelines' },
  { label: 'Usage', href: '/usage' },
  { label: 'Settings', href: '/settings' },
];

export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
