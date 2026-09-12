import 'server-only';

import { airlinePnrs as validAirlinePnrs } from '@/lib/flights/airline-pnr';

import path from 'node:path';
import PDFDocument from 'pdfkit';

import type {
  BookingPassengerType,
  BookingTraveller,
  PublicBooking,
} from '@/lib/flights/booking';

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

const COLORS = {
  blue: '#073665',
  blueBorder: '#94BCE0',
  bluePale: '#C6DCF2',
  navy: '#042551',
  navyMuted: '#656B9D',
  navyPale: '#f3f8fc',
  red: '#f68712',
  neutral: '#666666',
  neutralLight: '#929292',
  line: '#DCE1F3',
  green: '#16A34A',
} as const;

function iconPath(name: 'mail' | 'map-pin' | 'phone' | 'plane' | 'receipt' | 'ticket' | 'users') {
  return path.join(process.cwd(), 'public', 'email-icons', `${name}.png`);
}

async function remoteImage(
  url: string | null,
  allowedHostnames: readonly string[]
): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !allowedHostnames.includes(parsed.hostname)) {
      return null;
    }
    const response = await fetch(parsed, {
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].toLowerCase() ?? '';
    if (contentType !== 'image/png' && contentType !== 'image/jpeg') return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > 0 && bytes.length <= 2_000_000 ? bytes : null;
  } catch {
    return null;
  }
}

function formatMoney(value: number, currency: string): string {
  const hasMinorUnits = Math.abs(value - Math.round(value)) > 0.0001;
  return `${currency} ${value.toLocaleString('en-US', {
    minimumFractionDigits: hasMinorUnits ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
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
  if (!match) return value || '--';
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

function countryLabel(value: string | undefined): string {
  if (!value) return '--';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(value.toUpperCase()) ?? value;
  } catch {
    return value;
  }
}

function tripLabel(booking: PublicBooking): string {
  const legs = booking.itinerary?.legs ?? [];
  const scope = booking.passportRequired ? 'International' : 'Domestic';
  if (legs.length === 1) return `${scope} - One-way`;
  const roundTrip =
    legs.length === 2 &&
    legs[0].from === legs[1].to &&
    legs[0].to === legs[1].from;
  return `${scope} - ${roundTrip ? 'Round' : legs.length > 1 ? 'Multi-city' : 'Trip'}`;
}

/** Generates the customer ticket copy from the same stored snapshot as the page/email. */
export async function confirmedBookingTicketPdf(input: {
  booking: PublicBooking;
  travellers: BookingTraveller[];
}): Promise<Buffer> {
  const contact = input.booking.headerContact;
  const headerLogo = contact.name === 'Kaliganj Travels' &&
    (!contact.logoUrl || contact.logoUrl === '/brand/kaliganj-logo.png')
    ? path.join(process.cwd(), 'public', 'brand', 'kaliganj-logo.png')
    : await remoteImage(contact.logoUrl, ['res.cloudinary.com']);
  const airlineCodes = Array.from(new Set(
    (input.booking.itinerary?.legs ?? []).flatMap((leg) =>
      leg.segments.map((segment) => segment.airlineCode.trim().toUpperCase())
    )
  )).filter(Boolean);
  const airlineLogos = new Map(
    await Promise.all(airlineCodes.map(async (code) => [
      code,
      await remoteImage(
        `https://images.kiwi.com/airlines/64x64/${encodeURIComponent(code)}.png`,
        ['images.kiwi.com']
      ),
    ] as const))
  );
  return new Promise((resolve, reject) => {
    const { booking } = input;
    const travellers = input.travellers.filter(
      (traveller) => traveller.lastName.trim() !== ''
    );
    const ticketsAlign =
      booking.ticketNumbers.length > 0 &&
      booking.ticketNumbers.length === travellers.length;
    const pnr = validAirlinePnrs(booking.airlinesPnr).join(', ') || 'Not available';
    const document = new PDFDocument({
      size: 'A4',
      margin: 29,
      bufferPages: true,
      info: {
        Title: `Ticket ${booking.publicRef}`,
        Author: booking.headerContact.name,
        Subject: 'Confirmed flight booking ticket copy',
      },
    });
    const chunks: Buffer[] = [];
    document.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);

    const bottomRoundedRect = (
      x: number,
      pathY: number,
      pathWidth: number,
      height: number,
      radius: number
    ) => document
      .moveTo(x, pathY)
      .lineTo(x + pathWidth, pathY)
      .lineTo(x + pathWidth, pathY + height - radius)
      .quadraticCurveTo(
        x + pathWidth,
        pathY + height,
        x + pathWidth - radius,
        pathY + height
      )
      .lineTo(x + radius, pathY + height)
      .quadraticCurveTo(x, pathY + height, x, pathY + height - radius)
      .lineTo(x, pathY)
      .closePath();

    const left = document.page.margins.left;
    const right = document.page.width - document.page.margins.right;
    const width = right - left;
    let y = document.page.margins.top;
    const pageBottom = () => document.page.height - document.page.margins.bottom;

    const ensureSpace = (height: number) => {
      if (y + height <= pageBottom()) return;
      document.addPage();
      y = document.page.margins.top;
      document.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.blue)
        .text(`${booking.headerContact.name}  |  ${booking.publicRef}`, left, y, { width });
      y += 18;
    };

    const sectionTitle = (
      title: string,
      icon: 'plane' | 'receipt' | 'users',
      withRule = true
    ) => {
      ensureSpace(27);
      if (withRule) {
        document.moveTo(left, y).lineTo(right, y).strokeColor(COLORS.line).stroke();
        y += 10;
      }
      document.image(iconPath(icon), left, y - 1, { fit: [11, 11] });
      document.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.navy)
        .text(title.toUpperCase(), left + 17, y, { width: width - 17, characterSpacing: 0.7 });
      y += 18;
    };

    const headerY = y;
    document.rect(left, headerY, width, 123).fill(COLORS.blue);
    document.roundedRect(left + 12, headerY + 13, 34, 34, 4).fill('#ffffff');
    if (headerLogo) {
      try {
        document.image(headerLogo, left + 15, headerY + 16, { fit: [28, 28], align: 'center', valign: 'center' });
      } catch {
        document.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.navy)
          .text(booking.headerContact.name.split(/\s+/).slice(0, 2).map((word) => word[0]).join(''), left + 15, headerY + 27, { width: 28, align: 'center' });
      }
    } else {
      document.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.navy)
        .text(booking.headerContact.name.split(/\s+/).slice(0, 2).map((word) => word[0]).join(''), left + 15, headerY + 27, { width: 28, align: 'center' });
    }
    document.font('Helvetica-Bold').fontSize(6.2).fillColor('#ffffff')
      .text(`License No: ${booking.headerContact.licenseNo || '--'}`, left + 12, headerY + 51, { width: 150 });
    document.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff')
      .text(booking.headerContact.name, left + 53, headerY + 15, { width: width - 250, height: 19, ellipsis: true });
    document.font('Helvetica').fontSize(7.5).fillColor('#ffffff')
      .text('Electronic ticket - carry a copy while travelling.', left + 53, headerY + 34, { width: width - 250 });

    document.roundedRect(left + 12, headerY + 65, 300, 47, 5).fill('#155a8e');
    document.image(iconPath('phone'), left + 20, headerY + 73, { fit: [10, 10] });
    document.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff')
      .text(booking.headerContact.mobile, left + 36, headerY + 74, { width: 104, height: 10, ellipsis: true });
    document.image(iconPath('mail'), left + 150, headerY + 73, { fit: [10, 10] });
    document.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff')
      .text(booking.headerContact.email, left + 166, headerY + 74, { width: 135, height: 10, ellipsis: true });
    document.image(iconPath('map-pin'), left + 20, headerY + 91, { fit: [10, 10] });
    document.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff')
      .text(booking.headerContact.address, left + 36, headerY + 91, { width: 264, height: 18, ellipsis: true });

    document.font('Helvetica-Bold').fontSize(7).fillColor('#DDEEFF')
      .text('BOOKING REFERENCE', right - 185, headerY + 17, { width: 173, align: 'right', characterSpacing: 1 });
    document.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff')
      .text(booking.publicRef, right - 190, headerY + 34, { width: 178, align: 'right' });
    document.roundedRect(right - 101, headerY + 59, 89, 21, 11).fill(COLORS.green);
    document.image(iconPath('ticket'), right - 92, headerY + 65, { fit: [9, 9] });
    document.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff')
      .text('CONFIRMED', right - 78, headerY + 66, { width: 62, align: 'center' });
    y += 123;

    const summaries = [
      ['Airline PNR', pnr],
      ['Trip', tripLabel(booking)],
      ['Issued At', formatActivity(booking.issuedAt)],
      ['Payment', PAYMENT_LABELS[booking.paymentState]],
    ];
    const cellWidth = width / summaries.length;
    summaries.forEach(([label, value], index) => {
      const x = left + index * cellWidth;
      document.rect(x, y, cellWidth, 44).fillAndStroke(COLORS.bluePale, COLORS.blueBorder);
      document.font('Helvetica-Bold').fontSize(6.5).fillColor(COLORS.navyMuted)
        .text(label.toUpperCase(), x + 9, y + 9, { width: cellWidth - 18 });
      document.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.navy)
        .text(value, x + 9, y + 23, { width: cellWidth - 18, height: 15, ellipsis: true });
    });
    y += 57;

    sectionTitle('Passenger & Ticket Details', 'users', false);
    const passengerWidths = [width * 0.45, width * 0.11, width * 0.1, width * 0.16, width * 0.18];
    const passengerHeaders = ['Passenger', 'Type', 'Gender', 'Date of Birth', 'Ticket Number'];
    let x = left;
    document.roundedRect(left, y, width, 23, 4).fill(COLORS.navyPale);
    passengerHeaders.forEach((header, index) => {
      document.font('Helvetica-Bold').fontSize(6.5).fillColor(COLORS.navyMuted)
        .text(header.toUpperCase(), x + 7, y + 8, { width: passengerWidths[index] - 14 });
      x += passengerWidths[index];
    });
    y += 23;
    if (travellers.length === 0) {
      document.rect(left, y, width, 30).stroke(COLORS.line);
      document.font('Helvetica').fontSize(8).fillColor(COLORS.neutral)
        .text('Passenger details are unavailable in the stored booking snapshot.', left + 7, y + 10);
      y += 30;
    } else {
      travellers.forEach((traveller, index) => {
        ensureSpace(54);
        const name = [traveller.title, traveller.firstName, traveller.lastName]
          .filter(Boolean).join(' ').toUpperCase();
        const ticket = ticketsAlign ? booking.ticketNumbers[index] : 'Not available';
        const values = [
          name,
          PASSENGER_LABELS[traveller.passengerType],
          traveller.gender,
          formatDate(traveller.dateOfBirth),
          ticket,
        ];
        x = left;
        document.rect(left, y, width, 51).stroke(COLORS.line);
        values.forEach((value, valueIndex) => {
          const emphasized = valueIndex === 0 || valueIndex === 1 || valueIndex === 4;
          document.font(emphasized ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(valueIndex === 0 ? 8.5 : 7.8)
            .fillColor(emphasized ? COLORS.navy : COLORS.neutral)
            .text(value, x + 7, y + 9, {
              width: passengerWidths[valueIndex] - 14,
              height: 16,
              ellipsis: true,
              align: valueIndex === 4 ? 'right' : 'left',
            });
          x += passengerWidths[valueIndex];
        });
        const identityParts = [
          `NATIONALITY ${countryLabel(traveller.nationality).toUpperCase()}`,
          ...(booking.passportRequired
            ? [
                `PASSPORT ${(traveller.passportNumber || '--').toUpperCase()}`,
                `ISSUED BY ${countryLabel(traveller.issuingCountry).toUpperCase()}`,
                `EXPIRY ${formatDate(traveller.passportExpiry).toUpperCase()}`,
              ]
            : []),
        ];
        document.font('Helvetica').fontSize(6.6).fillColor(COLORS.neutral)
          .text(identityParts.join('    '), left + 7, y + 28, {
            width: passengerWidths[0] - 14,
            height: 18,
            ellipsis: true,
          });
        y += 51;
      });
    }
    y += 11;

    sectionTitle('Flight Itinerary', 'plane');
    const legs = booking.itinerary?.legs ?? [];
    if (legs.length === 0) {
      document.font('Helvetica').fontSize(8).fillColor(COLORS.neutral)
        .text('Itinerary is unavailable in the stored booking snapshot.', left, y);
      y += 20;
    } else {
      legs.forEach((leg, legIndex) => {
        ensureSpace(34);
        const stops = Math.max(leg.stops, leg.segments.length - 1);
        document.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.navy)
          .text(`${legs.length > 1 ? `LEG ${legIndex + 1}  ` : ''}${leg.from} -> ${leg.to}`, left, y);
        document.font('Helvetica').fontSize(7).fillColor(COLORS.neutral)
          .text(`${formatDate(leg.departure)}  |  ${leg.duration || '--'}  |  ${stops === 0 ? 'Non-stop' : `${stops} stop${stops === 1 ? '' : 's'}`}`, left, y, {
            width,
            align: 'right',
          });
        y += 17;
        leg.segments.forEach((segment) => {
          ensureSpace(138);
          const cardY = y;
          document.roundedRect(left, cardY, width, 132, 5).stroke(COLORS.line);
          document.rect(left, cardY, width, 31).fill(COLORS.navyPale);
          const airlineLogo = airlineLogos.get(segment.airlineCode.trim().toUpperCase());
          if (airlineLogo) {
            try {
              document.image(airlineLogo, left + 9, cardY + 5, {
                fit: [22, 22],
                align: 'center',
                valign: 'center',
              });
            } catch {
              document.roundedRect(left + 10, cardY + 7, 18, 18, 4).fill(COLORS.red);
              document.image(iconPath('plane'), left + 14, cardY + 11, { fit: [10, 10] });
            }
          } else {
            document.roundedRect(left + 10, cardY + 7, 18, 18, 4).fill(COLORS.red);
            document.image(iconPath('plane'), left + 14, cardY + 11, { fit: [10, 10] });
          }
          document.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.navy)
            .text(segment.airline || segment.airlineCode, left + 34, cardY + 8, { width: width / 2 - 34, height: 12, ellipsis: true });
          document.font('Helvetica').fontSize(6.8).fillColor(COLORS.neutral)
            .text(`Flight ${segment.airlineCode}${segment.flightNumber} - ${segment.cabinClass || '--'}`, left + 34, cardY + 19, { width: width / 2 - 34 });
          document.font('Helvetica-Bold').fontSize(16).fillColor(COLORS.navy)
            .text(timeOf(segment.departure), left + 10, cardY + 42, { width: 84 })
            .text(timeOf(segment.arrival), right - 94, cardY + 42, { width: 84, align: 'right' });
          document.font('Helvetica-Bold').fontSize(8.5).fillColor(COLORS.navy)
            .text(segment.from, left + 10, cardY + 63, { width: 84 })
            .text(segment.to, right - 94, cardY + 63, { width: 84, align: 'right' });
          const departureTerminal = segment.departureTerminal ? `Terminal ${segment.departureTerminal}` : '';
          const arrivalTerminal = segment.arrivalTerminal ? `Terminal ${segment.arrivalTerminal}` : '';
          document.font('Helvetica').fontSize(6.7).fillColor(COLORS.neutral)
            .text(departureTerminal, left + 10, cardY + 75, { width: 100 })
            .text(arrivalTerminal, right - 110, cardY + 75, { width: 100, align: 'right' })
            .text(formatDate(segment.departure), left + 10, cardY + 85, { width: 100 })
            .text(formatDate(segment.arrival), right - 110, cardY + 85, { width: 100, align: 'right' });
          document.font('Helvetica').fontSize(6.2).fillColor(COLORS.neutralLight)
            .text(segment.fromAirport || '--', left + 10, cardY + 96, { width: width * 0.38, height: 12, ellipsis: true })
            .text(segment.toAirport || '--', right - width * 0.38 - 10, cardY + 96, { width: width * 0.38, height: 12, ellipsis: true, align: 'right' });

          document.font('Helvetica').fontSize(6.8).fillColor(COLORS.neutral)
            .text(segment.duration || '', left + width * 0.4, cardY + 49, { width: width * 0.2, align: 'center' });
          const lineY = cardY + 66;
          document.moveTo(left + width * 0.38, lineY).lineTo(left + width * 0.62, lineY).strokeColor('#B9BDD8').stroke();
          document.image(iconPath('plane'), left + width / 2 - 5, lineY - 5, { fit: [10, 10] });

          document.rect(left, cardY + 112, width, 20).fill(COLORS.navyPale);
          document.font('Helvetica').fontSize(6.8).fillColor(COLORS.neutral)
            .text(`Check-in ${segment.baggage || '--'}    Cabin bag ${segment.handBaggage || '--'}    Aircraft ${segment.aircraft || '--'}    RBD ${segment.bookingClass || '--'}`, left + 10, cardY + 119, { width: width - 20 });
          y += 132;
        });
      });
      document.font('Helvetica').fontSize(6.5).fillColor(COLORS.neutralLight)
        .text('Times are local to each airport. Baggage allowance is per passenger, as published by the airline.', left, y, { width });
      y += 17;
    }

    sectionTitle('Fare Breakdown', 'receipt');
    const hasMargin = booking.fares.some((fare) => fare.serviceMargin > 0);
    const totalAit = booking.fares.reduce((sum, fare) => sum + fare.ait, 0);
    const fareWidthRatios = hasMargin
      ? [0.21, 0.07, 0.13, 0.14, 0.13, 0.12, 0.2]
      : [0.25, 0.09, 0.16, 0.17, 0.14, 0.19];
    const fareWidths = fareWidthRatios.map((ratio) => width * ratio);
    const fareHeaders = [
      'Passenger Type',
      'Pax',
      'Base Fare',
      'Tax & Other',
      ...(hasMargin ? ['Service Margin'] : []),
      'AIT / VAT',
      'Amount',
    ];
    document.roundedRect(left, y, width, 23, 4).fill(COLORS.navyPale);
    x = left;
    fareHeaders.forEach((header, index) => {
      document.font('Helvetica-Bold').fontSize(6.1).fillColor(COLORS.navyMuted)
        .text(header.toUpperCase(), x + 5, y + 8, {
          width: fareWidths[index] - 10,
          align: index === 0 ? 'left' : 'right',
        });
      x += fareWidths[index];
    });
    y += 23;
    booking.fares.forEach((fare) => {
      ensureSpace(28);
      const values = [
        PASSENGER_LABELS[fare.passengerType],
        String(fare.count),
        fare.basePrice.toLocaleString('en-US'),
        fare.taxes.toLocaleString('en-US'),
        ...(hasMargin ? [fare.serviceMargin.toLocaleString('en-US')] : []),
        fare.ait.toLocaleString('en-US'),
        formatMoney(fare.totalPrice, booking.currency),
      ];
      x = left;
      document.rect(left, y, width, 27).stroke(COLORS.line);
      values.forEach((value, index) => {
        document.font(index === 0 || index === values.length - 1 ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(7.2).fillColor(index === 0 || index === values.length - 1 ? COLORS.navy : COLORS.neutral)
          .text(value, x + 5, y + 9, {
            width: fareWidths[index] - 10,
            align: index === 0 ? 'left' : 'right',
          });
        x += fareWidths[index];
      });
      y += 27;
    });
    bottomRoundedRect(left, y, width, 32, 4).fill(COLORS.blue);
    document.font('Helvetica-Bold').fontSize(8.5).fillColor('#ffffff')
      .text(`Total price${totalAit > 0 ? ' (incl. AIT / VAT)' : ''}`, left + 9, y + 11)
      .text(formatMoney(booking.totalPrice, booking.currency), left, y + 10, {
        width: width - 9,
        align: 'right',
      });
    y += 39;

    const carrier = booking.itinerary
      ? booking.itinerary.carrierName && booking.itinerary.carrierCode
        ? `${booking.itinerary.carrierName} (${booking.itinerary.carrierCode})`
        : booking.itinerary.carrierName || booking.itinerary.carrierCode
      : '';
    const fareNotes = [
      `Fare type ${booking.directTicketing ? 'Instant ticketing' : 'Hold'}`,
      `Refundable ${booking.itinerary?.refundable ? 'Yes' : 'No'}`,
      ...(carrier ? [`Validating carrier ${carrier}`] : []),
    ];
    document.font('Helvetica').fontSize(6.8).fillColor(COLORS.neutral)
      .text(fareNotes.join('     '), left, y, { width, height: 18, ellipsis: true });
    y += 21;

    ensureSpace(34);
    document.rect(left, y, width, 30).fill(COLORS.navyPale);
    document.font('Helvetica').fontSize(7).fillColor(COLORS.neutral)
      .text('System generated document - quote the booking reference in any correspondence.', left + 9, y + 11, { width: width - 210 });
    document.image(iconPath('mail'), right - 170, y + 10, { fit: [9, 9] });
    document.font('Helvetica-Bold').fontSize(7).fillColor(COLORS.navy)
      .text(booking.headerContact.email, right - 155, y + 11, { width: 146, align: 'right', height: 10, ellipsis: true });

    document.end();
  });
}
