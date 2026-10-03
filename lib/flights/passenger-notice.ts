/** Shared wording for browser print copies and emailed ticket PDFs. */
export const PASSENGER_NOTICE_TITLE = 'Important Notice For Passengers';

export const PASSENGER_NOTICES = [
  {
    title: 'E-Ticket Notice',
    text: 'Carriage and other services provided by the carrier are subject to conditions of carriage which are hereby incorporated by reference. These conditions may be obtained from the issuing carrier.',
  },
  {
    title: 'Passport/Visa/Health',
    text: 'Ensure you have a valid passport, required visas and all other travel documents for your entire journey. Check destination and transit requirements, including applicable health and vaccination requirements, before travel.',
  },
  {
    title: 'Carry-on Baggage Allowance',
    text: 'Carry-on baggage size, weight and piece limits depend on the airline, route and fare. Follow the cabin baggage allowance shown for each flight on this ticket and confirm any additional restrictions with the airline.',
  },
  {
    title: 'Reporting Time',
    text: "Confirm the airline's airport reporting time and check-in, baggage-drop and boarding deadlines before travel. Allow enough time for security and immigration, and arrive before the airline's required deadlines.",
  },
] as const;
