/** Words that end up inside the video (stat cards, hole info). The app UI has its own i18n. */
export type Locale = 'da' | 'en';

const da = {
  carry: 'Carry',
  apex: 'Apex',
  ballSpeed: 'Boldfart',
  launch: 'Launch',
  flightTime: 'Flyvetid',
  curve: 'Kurve',
  left: 'venstre',
  right: 'højre',
  estimate: 'Estimat – angiv carry for præcise tal',
  fromCarry: 'Ud fra angivet carry',
  noShot: 'Vælg et slag',
  hole: 'Hul',
  par: 'Par',
  kmh: 'km/t',
};

const en: typeof da = {
  carry: 'Carry',
  apex: 'Apex',
  ballSpeed: 'Ball speed',
  launch: 'Launch',
  flightTime: 'Flight time',
  curve: 'Curve',
  left: 'left',
  right: 'right',
  estimate: 'Estimate – enter carry for exact numbers',
  fromCarry: 'Based on entered carry',
  noShot: 'Pick a shot',
  hole: 'Hole',
  par: 'Par',
  kmh: 'km/h',
};

export function labels(locale: Locale) {
  return locale === 'da' ? da : en;
}
