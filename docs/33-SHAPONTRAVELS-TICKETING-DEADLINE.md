# Shapontravels ticketing deadline

The existing **Refresh Time Limit** action on a Shapon Hold uses the booking's
saved Shapon UUID and STR reference. Set
`SHAPONTRAVELS_DEADLINE_REFRESH_ENABLED=true` after Shapon grants refresh
to Kaliganj's machine client for the selected suppliers. The action then sends
one server-side POST to `/api/bookings/{bookingId}/ticketing-deadline/refresh`.
The saved GET remains the default when the flag is off.

The independent webhook receives signed
`booking.ticketing_deadline.changed` events at
`POST /api/webhooks/shapon-ticketing-deadline`. It verifies the signature
over the raw body and matches both Shapon references to one native Kaliganj
booking. The database records the event and applies a newer revision together.
The stored supplier deadline still goes through Kaliganj's existing local
deadline authority, including any staff override.

## Enable in one environment

1. Apply the new forward migration from `supabase/fresh-install` to the
   reviewed Kaliganj database for that environment. Deploy the matching
   application with the feature flags off.
2. Confirm the existing Shapon machine-client UUID, the environment and the
   supplier IDs. Ask Shapon to enable refresh only for those pairs, then set
   `SHAPONTRAVELS_DEADLINE_REFRESH_ENABLED=true` for that deployment.
3. Select the Kaliganj deployment's stable public HTTPS callback on port 443.
   Set `SHAPONTRAVELS_DEADLINE_WEBHOOK_SECRET` with the dedicated `whsec_`
   key shared privately with Shapon and enable
   `SHAPONTRAVELS_DEADLINE_WEBHOOK_ENABLED=true`. During key rotation,
   `SHAPONTRAVELS_DEADLINE_WEBHOOK_PREVIOUS_SECRET` can temporarily hold
   the previous key. Keep Development and Production destinations and keys
   separate.
4. Have Shapon bind the exact callback and signing revision to the selected
   client and supplier grants and run the scoped delivery worker. Enabling
   delivery starts with new verified deadline changes.

Run `npm run verify:shapon-deadline` to verify signed synthetic events and
the deadline transaction against a disposable database. Run
`npm run verify:booking-ticketing-time` for the booking-scoped refresh action.
