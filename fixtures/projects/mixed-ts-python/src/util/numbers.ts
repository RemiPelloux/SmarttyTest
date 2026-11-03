export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Not used by any test: a change to it reaches tests only through module evaluation. */
export const PRECISION = 2;
