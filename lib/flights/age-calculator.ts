export type ExactPassengerAge = {
  years: number;
  months: number;
  days: number;
  category: string;
  categoryHint: string;
};

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function addUtcMonthsClamped(date: Date, months: number): Date {
  const totalMonths = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths % 12;
  const day = Math.min(date.getUTCDate(), daysInUtcMonth(year, month));
  return new Date(Date.UTC(year, month, day));
}

function addUtcYearsClamped(date: Date, years: number): Date {
  const year = date.getUTCFullYear() + years;
  const month = date.getUTCMonth();
  const day = Math.min(date.getUTCDate(), daysInUtcMonth(year, month));
  return new Date(Date.UTC(year, month, day));
}

/** Exact calendar age and booking category on the date the passenger travels. */
export function calculateAgeAtTravel(
  dateOfBirth: string,
  travelDate: string
): ExactPassengerAge | null {
  const birth = parseIsoDate(dateOfBirth);
  const travel = parseIsoDate(travelDate);
  if (!birth || !travel || birth.getTime() > travel.getTime()) return null;

  let years = travel.getUTCFullYear() - birth.getUTCFullYear();
  let yearAnchor = addUtcYearsClamped(birth, years);
  if (yearAnchor.getTime() > travel.getTime()) {
    years -= 1;
    yearAnchor = addUtcYearsClamped(birth, years);
  }

  let months =
    (travel.getUTCFullYear() - yearAnchor.getUTCFullYear()) * 12 +
    travel.getUTCMonth() -
    yearAnchor.getUTCMonth();
  let monthAnchor = addUtcMonthsClamped(yearAnchor, months);
  if (monthAnchor.getTime() > travel.getTime()) {
    months -= 1;
    monthAnchor = addUtcMonthsClamped(yearAnchor, months);
  }

  const days = Math.floor(
    (travel.getTime() - monthAnchor.getTime()) / (24 * 60 * 60 * 1000)
  );

  if (years < 2) {
    return {
      years,
      months,
      days,
      category: 'Infant (INF / INS)',
      categoryHint: 'Under 2 years on the travel date',
    };
  }
  if (years < 5) {
    return {
      years,
      months,
      days,
      category: 'Child (CNN)',
      categoryHint: '2–4 years on the travel date',
    };
  }
  if (years < 12) {
    return {
      years,
      months,
      days,
      category: 'Child (CHD)',
      categoryHint: '5–11 years on the travel date',
    };
  }
  return {
    years,
    months,
    days,
    category: 'Adult (ADT)',
    categoryHint: '12 years or older on the travel date',
  };
}
