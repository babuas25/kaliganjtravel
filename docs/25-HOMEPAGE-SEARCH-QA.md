# Homepage and search QA — 11 September 2026

Verified locally at localhost:3000 after the homepage redesign.

- Inspected the homepage, airline grid and destination cards at 390px; no horizontal page overflow detected.
- Checked the mobile navigation, traveller count, preferred airline lookup/selection, return calendar, and multi-city add/remove.
- At 320px the trip selector clipped the last option. Reduced small-screen button spacing and font size; visually verified all three options fit afterward.
- Fixed stale search-validation messages: changing trip type, airports, dates, travellers or segments clears the previous message. Reproduced missing-return validation and verified switching to One Way clears it.
- Submitted one live DAC–SIN search for 12 September 2026, one adult, Economy. Received 101 results. This is a point-in-time result, not a guaranteed fare or availability.
- Verified Modify search retains submitted fields, Biman airline filtering returns one result, and itinerary details open/close.
- Book Now for an unsigned visitor opens Clerk sign-in with search and itinerary references in the resume URL. No login, passenger entry, booking confirmation, payment or ticket issuance was performed.
- Follow-up: the Biman option was labelled Business K despite an Economy search. Supplier data/mapping needs investigation before treating cabin filtering as verified; no speculative cabin change was made.

Validation: ESLint on the changed files, production build (before final small-screen spacing adjustment), subsequent TypeScript check, and verify:flight-search-reference-safety passed. The reference-safety test uses isolated test doubles; it did not create a live booking.

Remaining: authenticated repricing, passenger/checkout flow and admin/agency QA need a signed-in test account. Booking and ticketing controls were not enabled or changed. Live search may populate search usage/history/cache records. No deployment was performed.
