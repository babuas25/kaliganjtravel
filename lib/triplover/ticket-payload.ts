/** The supplier contract returns one ticketInfoes entry per passenger. */
export function completeTicketNumbers(
  value: unknown,
  expectedPassengerCount?: number
): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (expectedPassengerCount !== undefined &&
      (!Number.isInteger(expectedPassengerCount) || expectedPassengerCount <= 0 ||
       value.length !== expectedPassengerCount)) return null;
  const numbers: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' ||
        !Array.isArray(entry.ticketNumbers) || entry.ticketNumbers.length === 0) return null;
    for (const number of entry.ticketNumbers) {
      if (typeof number !== 'string' || !number.trim()) return null;
      numbers.push(number.trim());
    }
  }
  return new Set(numbers).size === numbers.length ? numbers : null;
}
