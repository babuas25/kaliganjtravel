// Recent airport picks, kept in localStorage so the dropdown can open on the
// visitor's own routes before they type anything.

export interface AirportHistoryItem {
  iata: string;
  name: string;
  city: string;
  country: string;
  timestamp: number;
}

const STORAGE_KEY = 'airport_selection_history';
const MAX_HISTORY_ITEMS = 5;

export function getRecentAirports(): AirportHistoryItem[] {
  if (typeof window === 'undefined') return [];

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];

    const history = JSON.parse(stored) as AirportHistoryItem[];
    return history.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_HISTORY_ITEMS);
  } catch (error) {
    console.error('Error reading airport history:', error);
    return [];
  }
}

export function addToAirportHistory(airport: {
  iata: string;
  name: string;
  city: string;
  country: string;
}) {
  if (typeof window === 'undefined') return;

  try {
    // Re-picking an airport moves it back to the top rather than duplicating it.
    const filtered = getRecentAirports().filter((item) => item.iata !== airport.iata);
    const updated: AirportHistoryItem[] = [
      { ...airport, timestamp: Date.now() },
      ...filtered,
    ].slice(0, MAX_HISTORY_ITEMS);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('Error saving airport history:', error);
  }
}

export function clearAirportHistory() {
  if (typeof window === 'undefined') return;

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Error clearing airport history:', error);
  }
}
