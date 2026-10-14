export const M_TO_YD = 1.0936133;
export const MPS_TO_MPH = 2.2369363;
export const MPS_TO_KMH = 3.6;

export function distance(m: number, units: 'm' | 'yd'): number {
  return units === 'yd' ? m * M_TO_YD : m;
}
export function toMetres(v: number, units: 'm' | 'yd'): number {
  return units === 'yd' ? v / M_TO_YD : v;
}
