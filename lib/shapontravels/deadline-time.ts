const CANONICAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d{1,9})?(Z|\+06:00)$/;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Check the wire format without rounding fractional seconds or losing a leap second. */
export function isCanonicalDeadlineTime(value: string, zone: 'Z' | '+06:00'): boolean {
  const match = CANONICAL_TIME.exec(value);
  if (!match || match[4] !== zone) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLength = month === 2 && leap ? 29 : MONTH_LENGTHS[month - 1] ?? 0;
  return year > 0 && day > 0 && day <= monthLength;
}
