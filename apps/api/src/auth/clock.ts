/** Injectable time source so expiry and lockout logic can be tested without waiting. */
export const CLOCK = Symbol('CLOCK');
export type Clock = () => number;
