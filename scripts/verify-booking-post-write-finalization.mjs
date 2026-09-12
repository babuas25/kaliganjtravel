import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const book = source('lib', 'triplover', 'book.ts');
assert.doesNotMatch(book, /readPnr\(/);
assert.doesNotMatch(book, /TAKEOFF_PNR_PROPAGATION_RETRY_DELAYS_MS/);
assert.match(
  book,
  /ticketingTimeLimit:\s*raw\.ticketingTimeLimit \?\? null/
);

const checkout = source('components', 'flights', 'BookingCheckout.tsx');
assert.match(checkout, /envelope\.error\.errorCode === 'BOOKING_ALREADY_STARTED'/);
assert.match(checkout, /recovered\.phase === 'processing'/);

const watchdog = source(
  'supabase',
  'migrations',
  '0090_booking_attempt_response_watchdog.sql'
);
assert.match(watchdog, /attempt\.supplier_response_received_at/);
assert.match(watchdog, /book_response_finalization_watchdog_timeout/);
assert.match(
  watchdog,
  /Book received an HTTP response but no booking outcome was finalized/
);
assert.doesNotMatch(watchdog, /bookFlight|issueTicket|cancelBooking/);

console.log(
  JSON.stringify({
    checks: 'passed',
    postWritePnrInCriticalPath: false,
    lockedCheckoutRecovery: true,
    responseWatchdogClassification: 'finalization_timeout',
    automaticSupplierReplay: false,
  })
);
