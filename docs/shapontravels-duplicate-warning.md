# Shapontravels duplicate booking warning

The Shapontravels Book adapter accepts the structured
`SUPPLIER_DUPLICATE_REPORTED` warning only with an unresolved HTTP 202 response.
Checkout and local status recovery show the English title, support message,
current STR request reference and **Contact Support** link. The reference comes
from the API's `X-Booking-Reference` header. It is not the old booking's reference.

The observed supplier response does not identify an existing booking. No prior
booking reference or **View Existing Booking** link is inferred from a passenger
name or from arbitrary supplier fields. Raw supplier text stays out of this UI.

The attempt remains unknown, automatic submission stays blocked, and Direct
Issue funds remain protected. A sanitized warning code persists with the existing
attempt error so local status recovery can restore it without another supplier
call. Older attempts saved without the code keep their generic support message.
Resolved attempts show their current booking instead of this warning.

The backend warning contract must be deployed before these clients can display
it. Older API responses safely retain the generic uncertainty message.
No database migration or supplier credential change is required.

Verification: `node scripts/verify-shapontravels-duplicate-warning.mjs` exercises
HTTP responses, privacy, rendering, replay/funds classification and the actual
owner-scoped local recovery route with offline fixtures.
