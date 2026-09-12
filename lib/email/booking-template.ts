import { airlinePnrs as validAirlinePnrs } from '@/lib/flights/airline-pnr';

import type {
  BookingStatus,
} from '@/lib/flights/booking-status';
import type {
  BookingPassengerType,
  BookingTraveller,
  PublicBooking,
} from '@/lib/flights/booking';

export type BookingEmailContent = {
  subject: string;
  html: string;
  text: string;
};

type BookingEmailTone = {
  badgeBackground: string;
  badgeColor: string;
  noticeBackground: string;
  noticeBorder: string;
  noticeColor: string;
};

/**
 * Lifecycle copy is intentionally separate from the booking document.
 * Future statuses provide one small variant object and reuse every section
 * rendered below instead of copying the email HTML.
 */
export type BookingEmailVariant = {
  status: BookingStatus;
  statusLabel: string;
  subjectPrefix: string;
  preheader: string;
  subtitle: string;
  message: string;
  activityLabel: string;
  activityAt: string | null;
  passengerMode: 'identity' | 'ticketing';
  showTicketingDeadline: boolean;
  tone: BookingEmailTone;
};

export type MasterBookingEmailInput = {
  booking: PublicBooking;
  travellers: BookingTraveller[];
  bookingUrl: string;
  variant: BookingEmailVariant;
};

const PASSENGER_LABELS: Record<BookingPassengerType, string> = {
  ADT: 'Adult',
  CHD: 'Child',
  CNN: 'Child',
  INF: 'Infant',
  INS: 'Infant with seat',
};

const PAYMENT_LABELS: Record<PublicBooking['paymentState'], string> = {
  unpaid: 'Unpaid',
  held: 'Held',
  captured: 'Paid',
  released: 'Released',
  reconciliation: 'Reconciliation',
  'partially-refunded': 'Partially refunded',
  refunded: 'Refunded',
};

const SUPPORT_FOOTER_TEXT = `Need help? Our Customer Support Team is here to assist you.

Email: support@kaliganjtravel.com
Customer Care: +880 1795-271171

Thank you for choosing Kaliganj Travels. We look forward to serving you and ensuring a smooth travel experience.

Kaliganj Travels
1st Floor, Janata Super Market
Kaligonj, Jhenaidah
Bangladesh

Facebook: https://www.facebook.com/KaligonjTourTravel/
WhatsApp: +880 1795-271171 (https://wa.me/8801795271171)
Website: https://kaliganjtravel.com`;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatMoney(value: number, currency: string): string {
  if (!Number.isFinite(value)) return `${currency} --`;
  return `${currency} ${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value)
    ? value.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : '--';
}

function formatActivity(value: string | null): string {
  if (!value) return '--';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Dhaka',
      }).format(new Date(parsed))
    : '--';
}

function formatDate(value: string | undefined): string {
  if (!value) return '--';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  );
}

function timeOf(value: string): string {
  const match = /\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/.exec(value);
  return match ? `${match[1]}:${match[2]}` : '--:--';
}

function countryName(code: string): string {
  if (!code) return '--';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase())
      ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

function tripSummary(booking: PublicBooking): [string, string] {
  const legs = booking.itinerary?.legs ?? [];
  const scope = booking.passportRequired ? 'International' : 'Domestic';
  if (legs.length === 0) return ['Trip', scope];
  if (legs.length === 1) return ['Trip - One-way', scope];
  const roundTrip =
    legs.length === 2 &&
    legs[0].from === legs[1].to &&
    legs[0].to === legs[1].from;
  return [roundTrip ? 'Trip - Round' : 'Trip - Multi-city', scope];
}

function icon(name: string, alt: string, size = 14): string {
  return `<img src="cid:kaliganj-${name}" width="${size}" height="${size}" alt="${escapeHtml(alt)}" style="display:inline-block;width:${size}px;height:${size}px;vertical-align:-2px;border:0">`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function headerLogo(booking: PublicBooking): string {
  const contact = booking.headerContact;
  const logoUrl = contact.name === 'Kaliganj Travels' &&
    (!contact.logoUrl || contact.logoUrl === '/brand/kaliganj-logo.png')
    ? 'cid:kaliganj-logo' : contact.logoUrl;
  if (logoUrl) {
    return `<img src="${escapeHtml(logoUrl)}" width="48" height="48" alt="${escapeHtml(contact.name)} logo" style="display:block;width:48px;height:48px;object-fit:contain;background:#ffffff;border-radius:6px">`;
  }
  return `<div style="display:table-cell;width:48px;height:48px;border:1px solid #8ab7df;border-radius:6px;text-align:center;vertical-align:middle;background:#ffffff;color:#123a68;font-size:14px;font-weight:800">${escapeHtml(initials(contact.name))}</div>`;
}

function renderHeader(input: MasterBookingEmailInput): string {
  const { booking, variant } = input;
  const contact = booking.headerContact;
  const deadline = variant.showTicketingDeadline
    ? formatActivity(booking.ticketingDeadlineAt)
    : null;
  const deadlineHtml = deadline && deadline !== '--'
    ? `<div style="margin-top:8px;font-size:11px;line-height:1.45;color:#ffffff">Ticketing deadline: <strong>${escapeHtml(deadline)}</strong></div>`
    : '';

  return `<tr><td style="padding:22px;background:#073665;color:#ffffff">
    <table role="presentation" class="booking-header-layout" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td class="booking-header-logo" valign="top" width="62" style="width:62px;padding-right:10px">
          ${headerLogo(booking)}
        </td>
        <td class="booking-header-brand" valign="top" style="padding-right:12px">
          <div style="font-size:20px;font-weight:700;line-height:1.2">${escapeHtml(contact.name)}</div>
          <div style="margin-top:4px;font-size:12px;line-height:1.45;color:#eef7ff">${escapeHtml(variant.subtitle)}</div>
          <div style="margin-top:5px;white-space:nowrap;font-size:9px;font-weight:600;color:#eef7ff">License No: ${escapeHtml(contact.licenseNo || '--')}</div>
          <table role="presentation" class="booking-header-contact" width="100%" cellspacing="0" cellpadding="0" style="width:100%;margin-top:10px;font-size:11px;line-height:1.55;color:#ffffff">
            <tr><td width="20" style="width:20px;padding-right:7px">${icon('phone', 'Phone')}</td><td class="booking-contact-value" style="white-space:nowrap"><a href="tel:${escapeHtml(contact.mobile)}" style="color:#ffffff;text-decoration:none;white-space:nowrap">${escapeHtml(contact.mobile)}</a></td></tr>
            <tr><td width="20" style="width:20px;padding-right:7px;padding-top:3px">${icon('mail', 'Email')}</td><td class="booking-contact-value" style="padding-top:3px;white-space:nowrap;word-break:normal"><a href="mailto:${escapeHtml(contact.email)}" style="color:#ffffff;text-decoration:none;white-space:nowrap;word-break:normal">${escapeHtml(contact.email)}</a></td></tr>
            <tr><td width="20" valign="top" style="width:20px;padding-right:7px;padding-top:3px">${icon('map-pin', 'Address')}</td><td style="padding-top:3px">${escapeHtml(contact.address)}</td></tr>
          </table>
        </td>
        <td class="booking-header-reference" align="right" valign="top" width="190" style="width:190px">
          <div style="font-size:10px;font-weight:600;letter-spacing:.12em;color:#dbeeff">BOOKING REFERENCE</div>
          <div style="margin-top:6px;font-size:15px;font-weight:700;letter-spacing:.03em">${escapeHtml(booking.publicRef)}</div>
          <div style="margin-top:10px"><span style="display:inline-block;border-radius:999px;background:${variant.tone.badgeBackground};color:${variant.tone.badgeColor};padding:6px 11px;font-size:11px;font-weight:700;letter-spacing:.04em">${icon('ticket', '', 13)}&nbsp; ${escapeHtml(variant.statusLabel)}</span></div>
          ${deadlineHtml}
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td style="padding:13px 18px;background:${variant.tone.noticeBackground};border-left:4px solid ${variant.tone.noticeBorder};color:${variant.tone.noticeColor};font-size:12px;line-height:1.6"><strong>${escapeHtml(variant.message)}</strong></td></tr>`;
}

function summaryCell(label: string, value: string, last = false): string {
  return `<td class="booking-summary-cell" valign="top" width="25%" style="width:25%;padding:13px 14px;${last ? '' : 'border-right:1px solid #94bce0;'}"><div style="font-size:9px;font-weight:600;letter-spacing:.06em;color:#476b91">${escapeHtml(label.toUpperCase())}</div><div style="margin-top:4px;font-size:13px;font-weight:700;line-height:1.35;color:#082f5b">${escapeHtml(value)}</div></td>`;
}

function renderSummary(input: MasterBookingEmailInput): string {
  const { booking, variant } = input;
  const pnr = validAirlinePnrs(booking.airlinesPnr).join(', ') || 'Not available';
  const trip = tripSummary(booking);
  return `<tr><td style="background:#c6dcf2;border-top:1px solid #94bce0">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      ${summaryCell('Airline PNR', pnr)}
      ${summaryCell(trip[0], trip[1])}
      ${summaryCell(variant.activityLabel, formatActivity(variant.activityAt))}
      ${summaryCell('Payment', PAYMENT_LABELS[booking.paymentState], true)}
    </tr></table>
  </td></tr>`;
}

function sectionHeading(iconName: string, title: string): string {
  return `<div style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:.08em;color:#082f5b">${icon(iconName, '', 14)}&nbsp; ${escapeHtml(title.toUpperCase())}</div>`;
}

function renderPassengers(input: MasterBookingEmailInput): string {
  const { booking, travellers, variant } = input;
  const namedTravellers = travellers.filter((traveller) => traveller.lastName.trim() !== '');
  const ticketsAlign =
    booking.ticketNumbers.length > 0 &&
    booking.ticketNumbers.length === namedTravellers.length;
  const pnr = validAirlinePnrs(booking.airlinesPnr).join(', ') || 'Not available';
  const ticketColumn = variant.passengerMode === 'ticketing' || ticketsAlign;
  const columnWidths = variant.passengerMode === 'ticketing'
    ? ['39%', '14%', '20%', '27%']
    : ticketColumn
      ? ['38%', '13%', '13%', '19%', '17%']
      : ['45%', '15%', '15%', '25%'];
  const colgroup = `<colgroup>${columnWidths
    .map((width) => `<col style="width:${width}">`)
    .join('')}</colgroup>`;
  const heading = variant.passengerMode === 'ticketing'
    ? `<tr style="background:#f0f5fb;color:#476b91"><th align="left" style="padding:9px">PASSENGER</th><th align="left" style="padding:9px">TYPE</th><th align="left" style="padding:9px">AIRLINE PNR</th><th align="left" style="padding:9px">TICKET NUMBER</th></tr>`
    : `<tr style="background:#f0f5fb;color:#476b91"><th align="left" style="padding:9px">PASSENGER</th><th align="left" style="padding:9px">TYPE</th><th align="left" style="padding:9px">GENDER</th><th align="left" style="padding:9px">DATE OF BIRTH</th>${ticketColumn ? '<th align="right" style="padding:9px">TICKET NUMBER</th>' : ''}</tr>`;

  const rows = namedTravellers.map((traveller, index) => {
    const name = [traveller.title, traveller.firstName, traveller.lastName]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();
    const nationality = countryName(traveller.nationality).toUpperCase();
    const ticket = ticketsAlign ? booking.ticketNumbers[index] : '--';
    const commonPassenger = `<td valign="top" style="padding:11px;border-top:1px solid #dce7f3;font-weight:700;color:#082f5b">${escapeHtml(name)}<div style="margin-top:4px;font-size:10px;font-weight:400;color:#64748b">NATIONALITY <strong style="color:#082f5b">${escapeHtml(nationality)}</strong></div></td><td valign="top" style="padding:11px;border-top:1px solid #dce7f3">${escapeHtml(PASSENGER_LABELS[traveller.passengerType])}</td>`;
    if (variant.passengerMode === 'ticketing') {
      return `<tr>${commonPassenger}<td valign="top" style="padding:11px;border-top:1px solid #dce7f3">${escapeHtml(pnr)}</td><td valign="top" style="padding:11px;border-top:1px solid #dce7f3;font-weight:700;color:#082f5b">${escapeHtml(ticket)}</td></tr>`;
    }
    return `<tr>${commonPassenger}<td valign="top" style="padding:11px;border-top:1px solid #dce7f3">${escapeHtml(traveller.gender)}</td><td valign="top" style="padding:11px;border-top:1px solid #dce7f3">${escapeHtml(formatDate(traveller.dateOfBirth))}</td>${ticketColumn ? `<td align="right" valign="top" style="padding:11px;border-top:1px solid #dce7f3;font-weight:700;color:#082f5b">${escapeHtml(ticket)}</td>` : ''}</tr>`;
  }).join('');

  const fallback = `<tr><td colspan="${variant.passengerMode === 'ticketing' || ticketColumn ? 4 : 4}" style="padding:12px;border-top:1px solid #dce7f3;color:#64748b">Passenger names are unavailable in the stored booking snapshot.</td></tr>`;
  return `<tr><td style="padding:16px 18px;border-top:1px solid #dce7f3">
    ${sectionHeading('users', 'Passenger & Ticket Details')}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed;border:1px solid #dce7f3;border-radius:7px;overflow:hidden;font-size:11px;line-height:1.4;word-break:break-word">
      ${colgroup}${heading}${rows || fallback}
    </table>
  </td></tr>`;
}

function airlineLogo(code: string, name: string): string {
  const url = `https://images.kiwi.com/airlines/64x64/${encodeURIComponent(code)}.png`;
  return `<img src="${escapeHtml(url)}" width="24" height="24" alt="${escapeHtml(name || code)} logo" style="display:block;width:24px;height:24px;object-fit:contain;border:0">`;
}

function renderItinerary(input: MasterBookingEmailInput): string {
  const legs = input.booking.itinerary?.legs ?? [];
  if (legs.length === 0) return '';
  const segmentTotal = legs.reduce((sum, leg) => sum + leg.segments.length, 0);
  let segmentNumber = 0;
  const blocks = legs.map((leg, legIndex) => {
    const stops = Math.max(leg.stops, leg.segments.length - 1);
    const summary = [
      formatDate(leg.departure),
      leg.duration || '',
      stops === 0 ? 'Non-stop' : `${stops} stop${stops === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · ');
    const segments = leg.segments.map((segment) => {
      segmentNumber += 1;
      const flightCount = segmentTotal > 1
        ? `<td align="right" style="font-size:10px;color:#64748b">Flight ${segmentNumber} of ${segmentTotal}</td>`
        : '<td></td>';
      const facts = [
        ['Check-in', segment.baggage || '--'],
        ['Cabin bag', segment.handBaggage || '--'],
        ['Aircraft', segment.aircraft || '--'],
        ['RBD', segment.bookingClass || '--'],
      ].map(([label, value]) => `<span class="booking-itinerary-fact" style="display:inline-block;white-space:nowrap;margin-right:10px">${label} <strong style="color:#082f5b">${escapeHtml(value)}</strong></span>`).join('');
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:7px;border:1px solid #dce7f3;border-radius:7px;overflow:hidden">
        <tr><td colspan="2" style="padding:9px 10px;background:#f0f5fb">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td width="32" style="width:32px">${airlineLogo(segment.airlineCode, segment.airline)}</td>
            <td><div style="font-size:12px;font-weight:700;color:#082f5b">${escapeHtml(segment.airline || segment.airlineCode)}</div><div style="font-size:10px;color:#64748b">Flight ${escapeHtml(`${segment.airlineCode}${segment.flightNumber}`)}${segment.cabinClass ? ` · ${escapeHtml(segment.cabinClass)}` : ''}</div></td>
            ${flightCount}
          </tr></table>
        </td></tr>
        <tr>
          <td valign="top" width="50%" style="width:50%;padding:13px 12px"><div style="font-size:21px;font-weight:700;color:#082f5b">${escapeHtml(timeOf(segment.departure))}</div><div style="margin-top:5px;font-size:13px;font-weight:700;color:#082f5b">${escapeHtml(segment.from)}</div><div style="margin-top:3px;font-size:10px;color:#64748b">${escapeHtml(formatDate(segment.departure))}<br>${escapeHtml(segment.fromAirport || '--')}</div></td>
          <td align="right" valign="top" width="50%" style="width:50%;padding:13px 12px"><div style="font-size:21px;font-weight:700;color:#082f5b">${escapeHtml(timeOf(segment.arrival))}</div><div style="margin-top:5px;font-size:13px;font-weight:700;color:#082f5b">${escapeHtml(segment.to)}</div><div style="margin-top:3px;font-size:10px;color:#64748b">${escapeHtml(formatDate(segment.arrival))}<br>${escapeHtml(segment.toAirport || '--')}</div></td>
        </tr>
        <tr><td colspan="2" style="padding:7px 10px;background:#f8fbfe;border-top:1px solid #dce7f3;font-size:10px;line-height:1.5;color:#64748b">${facts}</td></tr>
      </table>`;
    }).join('');
    return `<div style="${legIndex > 0 ? 'margin-top:14px;' : ''}"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="font-size:12px;font-weight:700;color:#082f5b">${legs.length > 1 ? `<span style="display:inline-block;margin-right:7px;padding:3px 6px;border-radius:3px;background:#082f5b;color:#ffffff;font-size:9px">LEG ${legIndex + 1}</span>` : ''}${escapeHtml(leg.from)} &rarr; ${escapeHtml(leg.to)}</td><td align="right" style="font-size:10px;color:#64748b">${escapeHtml(summary)}</td></tr></table>${segments}</div>`;
  }).join('');
  return `<tr><td class="booking-email-section" style="padding:16px 18px;border-top:1px solid #dce7f3">
    ${sectionHeading('plane', 'Flight Itinerary')}
    ${blocks}
    <div style="margin-top:8px;font-size:10px;color:#94a3b8">Times are local to each airport. Baggage allowance is per passenger, as published by the airline.</div>
  </td></tr>`;
}

function renderFare(input: MasterBookingEmailInput): string {
  const { booking } = input;
  const hasMargin = booking.fares.some((fare) => fare.serviceMargin > 0);
  const totalAit = booking.fares.reduce((sum, fare) => sum + fare.ait, 0);
  const carrier = booking.itinerary
    ? booking.itinerary.carrierName && booking.itinerary.carrierCode
      ? `${booking.itinerary.carrierName} (${booking.itinerary.carrierCode})`
      : booking.itinerary.carrierName || booking.itinerary.carrierCode
    : '--';
  const columnWidths = hasMargin
    ? ['17%', '7%', '14%', '14%', '15%', '11%', '22%']
    : ['20%', '9%', '16%', '16%', '14%', '25%'];
  const colgroup = `<colgroup>${columnWidths
    .map((width) => `<col style="width:${width}">`)
    .join('')}</colgroup>`;
  const rows = booking.fares.map((fare) => `<tr>
    <td style="padding:9px;border-top:1px solid #dce7f3;font-weight:700;color:#082f5b">${escapeHtml(PASSENGER_LABELS[fare.passengerType])}</td>
    <td align="right" style="padding:9px;border-top:1px solid #dce7f3">${fare.count}</td>
    <td align="right" style="padding:9px;border-top:1px solid #dce7f3">${escapeHtml(formatNumber(fare.basePrice))}</td>
    <td align="right" style="padding:9px;border-top:1px solid #dce7f3">${escapeHtml(formatNumber(fare.taxes))}</td>
    ${hasMargin ? `<td align="right" style="padding:9px;border-top:1px solid #dce7f3">${escapeHtml(formatNumber(fare.serviceMargin))}</td>` : ''}
    <td align="right" style="padding:9px;border-top:1px solid #dce7f3">${escapeHtml(formatNumber(fare.ait))}</td>
    <td class="booking-fare-money" align="right" style="padding:9px;border-top:1px solid #dce7f3;font-weight:700;color:#082f5b;white-space:nowrap;word-break:normal">${escapeHtml(formatMoney(fare.totalPrice, booking.currency))}</td>
  </tr>`).join('');
  const columnCount = hasMargin ? 7 : 6;
  const empty = `<tr><td colspan="${columnCount}" style="padding:11px;border-top:1px solid #dce7f3;color:#64748b">A per-passenger breakdown is not available for this fare.</td></tr>`;
  const marginHeader = hasMargin ? '<th align="right" style="padding:8px">SERVICE MARGIN</th>' : '';
  return `<tr><td class="booking-email-section" style="padding:16px 18px;border-top:1px solid #dce7f3">
    ${sectionHeading('receipt', 'Fare Breakdown')}
    <table role="presentation" class="booking-fare-table" width="100%" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed;border:1px solid #dce7f3;border-radius:7px;overflow:hidden;font-size:10px;line-height:1.4;word-break:break-word">
      ${colgroup}
      <tr style="background:#f0f5fb;color:#476b91"><th align="left" style="padding:8px">PASSENGER TYPE</th><th align="right" style="padding:8px">PAX</th><th align="right" style="padding:8px">BASE FARE</th><th align="right" style="padding:8px">TAX &amp; OTHER</th>${marginHeader}<th align="right" style="padding:8px">AIT / VAT</th><th align="right" style="padding:8px">AMOUNT</th></tr>
      ${rows || empty}
      <tr style="background:#073665;color:#ffffff"><td colspan="${columnCount - 1}" style="padding:11px;font-size:11px;font-weight:700">Total price${totalAit > 0 ? ' (incl. AIT / VAT)' : ''}</td><td class="booking-fare-money booking-fare-total" align="right" style="padding:11px;font-size:13px;font-weight:700;white-space:nowrap;word-break:normal">${escapeHtml(formatMoney(booking.totalPrice, booking.currency))}</td></tr>
    </table>
    <div style="margin-top:12px;font-size:11px;font-weight:700;letter-spacing:.07em;color:#082f5b">FARE CONDITIONS</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed;margin-top:6px;background:#f8fbfe;border:1px solid #dce7f3;font-size:10px;color:#64748b;word-break:break-word"><tr>
      <td style="padding:9px">Fare type<br><strong style="color:#082f5b">${booking.directTicketing ? 'Instant ticketing' : 'Hold'}</strong></td>
      <td style="padding:9px">Refundable<br><strong style="color:#082f5b">${booking.itinerary?.refundable ? 'Yes' : 'No'}</strong></td>
      <td style="padding:9px">Validating carrier<br><strong style="color:#082f5b">${escapeHtml(carrier)}</strong></td>
      <td style="padding:9px">Payment status<br><strong style="color:#082f5b">${escapeHtml(PAYMENT_LABELS[booking.paymentState])}</strong></td>
    </tr></table>
  </td></tr>`;
}

function supportFooter(): string {
  return `<tr><td style="padding:22px 24px;border-top:1px solid #dce7f3;color:#475569;font-size:12px;line-height:1.65">
    <div style="margin:0 0 11px"><strong style="color:#082f5b">Need help?</strong> Our Customer Support Team is here to assist you.</div>
    <div style="margin:0 0 14px"><strong>Email:</strong> <a href="mailto:support@kaliganjtravel.com" style="color:#155a9c;text-decoration:none">support@kaliganjtravel.com</a><br><strong>Customer Care:</strong> <a href="tel:+8801795271171" style="color:#155a9c;text-decoration:none">+880 1795-271171</a></div>
    <div style="margin:0 0 14px">Thank you for choosing <strong style="color:#082f5b">Kaliganj Travels</strong>. We look forward to serving you and ensuring a smooth travel experience.</div>
    <div style="margin:0 0 14px"><strong style="color:#082f5b">Kaliganj Travels</strong><br>1st Floor, Janata Super Market<br>Kaligonj, Jhenaidah<br>Bangladesh</div>
    <div><a href="https://www.facebook.com/KaligonjTourTravel/" style="color:#155a9c;text-decoration:none">Facebook</a> &nbsp;·&nbsp; <a href="https://wa.me/8801795271171" style="color:#155a9c;text-decoration:none">WhatsApp +880 1795-271171</a> &nbsp;·&nbsp; <a href="https://kaliganjtravel.com" style="color:#155a9c;text-decoration:none">kaliganjtravel.com</a></div>
  </td></tr>`;
}

function renderBottom(input: MasterBookingEmailInput): string {
  const url = escapeHtml(input.bookingUrl);
  return `<tr><td style="padding:12px 18px;background:#f0f5fb;border-top:1px solid #dce7f3">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td style="font-size:10px;line-height:1.5;color:#64748b">System generated document — quote the booking reference in any correspondence.</td>
      <td align="right" width="125"><a href="${url}" style="display:inline-block;border-radius:5px;background:#f68712;padding:9px 14px;color:#ffffff;text-decoration:none;font-size:11px;font-weight:700">View Booking</a></td>
    </tr></table>
  </td></tr>${supportFooter()}`;
}

function plainText(input: MasterBookingEmailInput): string {
  const { booking, travellers, variant } = input;
  const pnr = validAirlinePnrs(booking.airlinesPnr).join(', ') || 'Not available';
  const trip = tripSummary(booking);
  const passengers = travellers.map((traveller, index) => {
    const ticket = booking.ticketNumbers.length === travellers.length
      ? booking.ticketNumbers[index]
      : null;
    return `- ${traveller.title} ${traveller.firstName} ${traveller.lastName} | ${PASSENGER_LABELS[traveller.passengerType]} | ${traveller.gender} | DOB ${formatDate(traveller.dateOfBirth)} | Nationality ${countryName(traveller.nationality)}${ticket ? ` | Ticket ${ticket}` : ''}`;
  }).join('\n');
  const itinerary = (booking.itinerary?.legs ?? []).flatMap((leg) =>
    leg.segments.map((segment) =>
      `- ${segment.from} to ${segment.to} | ${formatDate(segment.departure)} ${timeOf(segment.departure)}–${timeOf(segment.arrival)} | ${segment.airline} ${segment.airlineCode}${segment.flightNumber} | ${segment.cabinClass || '--'} | Baggage ${segment.baggage || '--'} | Cabin ${segment.handBaggage || '--'} | Aircraft ${segment.aircraft || '--'} | RBD ${segment.bookingClass || '--'}`
    )
  ).join('\n');
  const deadline = variant.showTicketingDeadline && booking.ticketingDeadlineAt
    ? `\nTicketing deadline: ${formatActivity(booking.ticketingDeadlineAt)}`
    : '';
  return `${variant.subjectPrefix} — ${booking.publicRef}

${variant.message}

Booking reference: ${booking.publicRef}
Status: ${variant.statusLabel}
Airline PNR: ${pnr}
${trip[0]}: ${trip[1]}
${variant.activityLabel}: ${formatActivity(variant.activityAt)}${deadline}
Payment status: ${PAYMENT_LABELS[booking.paymentState]}

Passenger & Ticket Details
${passengers || '- Passenger details unavailable'}

Flight Itinerary
${itinerary || '- Itinerary unavailable'}

Fare Breakdown
Total price: ${formatMoney(booking.totalPrice, booking.currency)}
Fare type: ${booking.directTicketing ? 'Instant ticketing' : 'Hold'}
Refundable: ${booking.itinerary?.refundable ? 'Yes' : 'No'}

View Booking: ${input.bookingUrl}

System generated document — quote the booking reference in any correspondence.

${SUPPORT_FOOTER_TEXT}`;
}

/** Email-safe presentation of the same PublicBooking snapshot used by the page. */
export function masterBookingEmail(input: MasterBookingEmailInput): BookingEmailContent {
  const subject = `${input.variant.subjectPrefix} — ${input.booking.publicRef}`;
  return {
    subject,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><style>
@media only screen and (max-width:600px) {
  .booking-email-outer { padding:8px 0 !important; }
  .booking-email-shell { width:100% !important; max-width:100% !important; }
  .booking-header-layout, .booking-header-layout > tbody, .booking-header-layout > tbody > tr { display:block !important; width:100% !important; }
  .booking-header-logo { display:block !important; float:left !important; width:62px !important; }
  .booking-header-brand { display:block !important; margin-left:72px !important; padding-right:0 !important; }
  .booking-header-reference { display:block !important; clear:both !important; width:auto !important; padding-top:15px !important; text-align:left !important; }
  .booking-header-contact { width:100% !important; }
  .booking-contact-value, .booking-contact-value a { white-space:nowrap !important; word-break:normal !important; }
  .booking-summary-cell { padding:10px 7px !important; }
  .booking-email-section { padding-left:10px !important; padding-right:10px !important; }
  .booking-itinerary-fact { margin-right:8px !important; }
  .booking-fare-table th, .booking-fare-table td { padding-left:4px !important; padding-right:4px !important; }
  .booking-fare-money { white-space:nowrap !important; word-break:normal !important; font-size:9px !important; letter-spacing:-.01em !important; }
  .booking-fare-total { font-size:11px !important; }
}
</style></head>
<body style="margin:0;background:#f3f8fc;color:#111827;font-family:Arial,Helvetica,sans-serif"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(input.variant.preheader)}</div>
<table role="presentation" class="booking-email-outer" width="100%" cellspacing="0" cellpadding="0" style="width:100%;padding:20px 8px;background:#f3f8fc"><tr><td align="center">
<table role="presentation" class="booking-email-shell" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:840px;background:#ffffff;border:1px solid #dce7f3;overflow:hidden">
${renderHeader(input)}
${renderSummary(input)}
${renderPassengers(input)}
${renderItinerary(input)}
${renderFare(input)}
${renderBottom(input)}
</table></td></tr></table></body></html>`,
    text: plainText(input),
  };
}

const ON_HOLD_TONE: BookingEmailTone = {
  badgeBackground: '#fff3cd',
  badgeColor: '#8a5700',
  noticeBackground: '#fffbeb',
  noticeBorder: '#f59e0b',
  noticeColor: '#78450a',
};

const CONFIRMED_TONE: BookingEmailTone = {
  badgeBackground: '#dcfce7',
  badgeColor: '#166534',
  noticeBackground: '#f0fdf4',
  noticeBorder: '#16a34a',
  noticeColor: '#166534',
};

export function bookingConfirmationEmail(input: Omit<MasterBookingEmailInput, 'variant'>): BookingEmailContent {
  return masterBookingEmail({
    ...input,
    variant: {
      status: 'on-hold',
      statusLabel: 'ON HOLD',
      subjectPrefix: 'Booking on hold',
      preheader: 'Your seats are held with the airline. Review the booking details and ticketing deadline.',
      subtitle: 'Booking confirmation — seats held with the airline.',
      message: 'Booking confirmation — seats held with the airline.',
      activityLabel: 'Booked At',
      activityAt: input.booking.bookedAt,
      passengerMode: 'identity',
      showTicketingDeadline: true,
      tone: ON_HOLD_TONE,
    },
  });
}

/** Existing confirmed delivery preserved on the same master document. */
export function confirmedBookingEmail(input: Omit<MasterBookingEmailInput, 'variant'>): BookingEmailContent {
  return masterBookingEmail({
    ...input,
    variant: {
      status: 'confirmed',
      statusLabel: 'CONFIRMED',
      subjectPrefix: 'Booking confirmed',
      preheader: 'Your booking is confirmed and the tickets have been issued.',
      subtitle: 'Booking confirmed — your tickets have been successfully issued.',
      message: 'Booking confirmed — your tickets have been successfully issued. Please review all passenger, ticket, itinerary and baggage details before travel.',
      activityLabel: 'Issued At',
      activityAt: input.booking.issuedAt,
      passengerMode: 'ticketing',
      showTicketingDeadline: false,
      tone: CONFIRMED_TONE,
    },
  });
}

const PENDING_TONE: BookingEmailTone = {
  badgeBackground: '#e0f2fe',
  badgeColor: '#075985',
  noticeBackground: '#f0f9ff',
  noticeBorder: '#0284c7',
  noticeColor: '#075985',
};

const IN_PROGRESS_TONE: BookingEmailTone = {
  badgeBackground: '#ede9fe',
  badgeColor: '#5b21b6',
  noticeBackground: '#f5f3ff',
  noticeBorder: '#7c3aed',
  noticeColor: '#5b21b6',
};

const ATTENTION_TONE: BookingEmailTone = {
  badgeBackground: '#fee2e2',
  badgeColor: '#991b1b',
  noticeBackground: '#fef2f2',
  noticeBorder: '#dc2626',
  noticeColor: '#991b1b',
};

const CANCELLED_TONE: BookingEmailTone = {
  badgeBackground: '#e5e7eb',
  badgeColor: '#374151',
  noticeBackground: '#f9fafb',
  noticeBorder: '#6b7280',
  noticeColor: '#374151',
};

function statusActivityAt(booking: PublicBooking, status: BookingStatus): string | null {
  if (status === 'confirmed') return booking.issuedAt;
  if (status === 'cancelled') return booking.cancelledAt;
  if (status === 'expired') return booking.ticketingDeadlineAt;
  if (status === 'in-progress') return booking.processingSince ?? null;
  return booking.bookedAt;
}

/** Complete customer-facing lifecycle document for all seven public statuses. */
export function bookingStatusEmail(
  input: Omit<MasterBookingEmailInput, 'variant'>,
  status: BookingStatus
): BookingEmailContent {
  if (status === 'on-hold') return bookingConfirmationEmail(input);
  if (status === 'confirmed') return confirmedBookingEmail(input);

  const variants: Record<
    Exclude<BookingStatus, 'on-hold' | 'confirmed'>,
    Omit<BookingEmailVariant, 'status' | 'activityAt'>
  > = {
    pending: {
      statusLabel: 'PENDING',
      subjectPrefix: 'Booking pending',
      preheader: 'Your booking is pending review or ticket issuance.',
      subtitle: 'Booking update - pending review or ticket issuance.',
      message: 'Your booking is pending review or ticket issuance. We will send another update when its status changes.',
      activityLabel: 'Booked At',
      passengerMode: 'identity',
      showTicketingDeadline: true,
      tone: PENDING_TONE,
    },
    'in-progress': {
      statusLabel: 'IN PROGRESS',
      subjectPrefix: 'Booking in progress',
      preheader:
        input.booking.statusMessage ??
        'A booking operation is currently being processed.',
      subtitle: 'Booking update - an operation is being processed.',
      message:
        input.booking.statusMessage ??
        'We are processing this booking with the airline. Please do not submit the same request again while processing is in progress.',
      activityLabel: 'Processing Since',
      passengerMode: 'identity',
      showTicketingDeadline: false,
      tone: IN_PROGRESS_TONE,
    },
    expired: {
      statusLabel: 'EXPIRED',
      subjectPrefix: 'Booking expired',
      preheader: 'The airline ticketing deadline for this held booking has passed.',
      subtitle: 'Booking update - the ticketing deadline has passed.',
      message: 'The airline ticketing deadline has passed and the held seats are no longer guaranteed. Please contact us before making further travel arrangements.',
      activityLabel: 'Expired At',
      passengerMode: 'identity',
      showTicketingDeadline: true,
      tone: ATTENTION_TONE,
    },
    unconfirmed: {
      statusLabel: 'UNCONFIRMED',
      subjectPrefix: 'Booking unconfirmed',
      preheader: 'The airline confirmation could not be verified.',
      subtitle: 'Booking update - airline confirmation requires attention.',
      message: 'The airline confirmation could not be verified. Please contact Kaliganj Travels before payment or travel.',
      activityLabel: 'Booked At',
      passengerMode: 'identity',
      showTicketingDeadline: false,
      tone: ATTENTION_TONE,
    },
    cancelled: {
      statusLabel: 'CANCELLED',
      subjectPrefix: 'Booking cancelled',
      preheader: 'Your booking has been cancelled.',
      subtitle: 'Booking update - the booking has been cancelled.',
      message: 'This booking has been cancelled. Any applicable payment release or refund is shown in the payment status below.',
      activityLabel: 'Cancelled At',
      passengerMode: 'identity',
      showTicketingDeadline: false,
      tone: CANCELLED_TONE,
    },
  };
  const variant = variants[status];
  return masterBookingEmail({
    ...input,
    variant: {
      ...variant,
      status,
      activityAt: statusActivityAt(input.booking, status),
    },
  });
}
