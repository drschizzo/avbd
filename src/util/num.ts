/** Rounds to `digits` decimals (document values stay short and diffable). */
export function round(x: number, digits = 3): number {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
}
