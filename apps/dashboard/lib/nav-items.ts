export interface NavItem {
  label: string;
  href: string;
  /** Which icon the rail shows (see components/nav-icons.tsx). */
  icon: 'overview' | 'tickets' | 'support' | 'projects' | 'guidelines' | 'usage' | 'settings';
}

/** Left-rail navigation (BUILD_PLAN 6.10). */
export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Overview', href: '/', icon: 'overview' },
  { label: 'Tickets', href: '/tickets', icon: 'tickets' },
  { label: 'Support', href: '/support', icon: 'support' },
  { label: 'Projects', href: '/projects', icon: 'projects' },
  { label: 'Guidelines', href: '/guidelines', icon: 'guidelines' },
  { label: 'Usage', href: '/usage', icon: 'usage' },
  { label: 'Settings', href: '/settings', icon: 'settings' },
];

export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}
