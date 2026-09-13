/** A failed storage read is not evidence that a booking does not exist. */
export class BookingReadUnavailableError extends Error {
  constructor() {
    super('Booking storage is temporarily unavailable.');
    this.name = 'BookingReadUnavailableError';
  }
}

export const BOOKING_READ_ERROR_CODE = 'BOOKING_STORAGE_UNAVAILABLE';
export const BOOKING_READ_ERROR_MESSAGE =
  'Booking details could not be checked just now. Refresh this page shortly. Do not create another booking.';
