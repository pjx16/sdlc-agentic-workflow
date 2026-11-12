/** A small hexagon with an orbiting node: the product mark. */
export function BrandMark() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden>
      <path d="M15 2.5 25.8 8.75v12.5L15 27.5 4.2 21.25V8.75z" stroke="var(--accent)" strokeWidth="1.5" />
      <path d="M15 8.5 20.6 11.75v6.5L15 21.5l-5.6-3.25v-6.5z" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1" />
      <circle cx="15" cy="15" r="2" fill="var(--accent)" />
    </svg>
  );
}
