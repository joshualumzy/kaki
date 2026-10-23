const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MONTH_NUMBERS = new Map(
  [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ].map((name, index) => [name, index]),
);

function dayParts(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) throw new Error(`Expected an ISO date, got "${value}"`);
  return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
}

/** Format a date-like value as a stable ISO day (YYYY-MM-DD). */
export function isoDay(value: string | Date): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Cannot format an invalid date');
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const { year, month, day } = dayParts(value);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Format a date-like value for a chunk header, for example "10 Nov 2026". */
export function shortDay(value: string | Date): string {
  const iso = isoDay(value);
  const { year, month, day } = dayParts(iso);
  const name = MONTHS[month];
  if (name === undefined) throw new Error(`Invalid month in "${iso}"`);
  return `${day} ${name} ${year}`;
}

/** Turn a "10 November 2026" style date into an ISO day. */
export function parseLongDay(day: string, monthName: string, year: string): string {
  const month = MONTH_NUMBERS.get(monthName.toLowerCase());
  if (month === undefined) throw new Error(`Unknown month "${monthName}"`);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
}
