import type { ItineraryOffer } from '@/lib/flights/share-offer';
import { SITE_NAME, SITE_EMAIL, SITE_PHONE, SITE_PHONE_HREF, SITE_WEBSITE, SITE_ADDRESS } from '@/lib/site';

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function schedule(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(value);
  if (!match) return { time: escape(value), date: '' };
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return { time: match[4], date: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) };
}

export function itineraryOfferEmail(offer: ItineraryOffer | undefined, message: string) {
  const route = offer?.legs.map((leg) => `${leg.fromCity || leg.from} → ${leg.toCity || leg.to}`).join(' · ') ?? 'Your flight itinerary';
  const price = offer ? `${escape(offer.currency)} ${offer.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '';
  const flights = offer?.legs.map((leg, index) => `
    <tr><td style="padding:24px 24px 10px;font-size:11px;font-weight:bold;letter-spacing:1px;color:#667085">JOURNEY ${index + 1} &nbsp; · &nbsp; ${leg.stops === 0 ? 'NON-STOP' : `${leg.stops} STOP${leg.stops === 1 ? '' : 'S'}`}</td></tr>
    ${leg.segments.map((segment) => {
      const departure = schedule(segment.departure), arrival = schedule(segment.arrival);
      return `<tr><td style="padding:0 24px 14px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e9ef;border-radius:12px">
        <tr><td colspan="3" style="padding:14px 16px;background:#f7f9fc;border-bottom:1px solid #e5e9ef;font-size:12px"><strong>${escape(segment.airline)}</strong> &nbsp; <span style="color:#667085">${escape(segment.flightNumber)} · ${escape(segment.cabinClass || 'Cabin not provided')}${segment.bookingClass ? ` (${escape(segment.bookingClass)})` : ''}</span></td></tr>
        <tr><td width="42%" valign="top" style="padding:20px 12px 16px 16px"><div style="font-size:26px;font-weight:bold">${departure.time}</div><div style="font-size:18px;font-weight:bold;margin-top:6px">${escape(segment.from)}</div><div style="font-size:11px;color:#667085;line-height:1.6;margin-top:6px">${departure.date}<br>${escape(segment.fromAirport)}</div></td>
        <td width="16%" align="center" style="font-size:12px;color:#b45309">&#9992;<br><span style="font-size:10px;color:#667085">${escape(segment.duration || '')}</span></td>
        <td width="42%" align="right" valign="top" style="padding:20px 16px 16px 12px"><div style="font-size:26px;font-weight:bold">${arrival.time}</div><div style="font-size:18px;font-weight:bold;margin-top:6px">${escape(segment.to)}</div><div style="font-size:11px;color:#667085;line-height:1.6;margin-top:6px">${arrival.date}<br>${escape(segment.toAirport)}</div></td></tr>
        <tr><td colspan="3" style="padding:12px 16px;border-top:1px solid #e5e9ef;font-size:11px;line-height:1.8;color:#475467">Checked baggage: <strong>${escape(segment.baggage || 'Not provided')}</strong> &nbsp; · &nbsp; Cabin baggage: <strong>${escape(segment.handBaggage || 'Not provided')}</strong></td></tr>
      </table></td></tr>`;
    }).join('')}`).join('') ?? `<tr><td style="padding:24px;white-space:pre-wrap;line-height:1.8">${escape(message)}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flight offer</title></head>
  <body style="margin:0;padding:0;background:#f2f5f9;font-family:Arial,Helvetica,sans-serif;color:#08264c">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escape(route)}${price ? ` · ${price}` : ''} — Your flight offer from ${escape(SITE_NAME)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f5f9"><tr><td align="center" style="padding:24px 8px">
  <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #e5e9ef;border-radius:16px;overflow:hidden">
    <tr><td style="padding:24px;border-top:4px solid #ff850b"><table role="presentation" width="100%"><tr><td style="font-size:17px;font-weight:bold">${escape(SITE_NAME)}</td><td align="right" style="font-size:10px;letter-spacing:1px;color:#b45309">FLIGHT OFFER</td></tr></table></td></tr>
    <tr><td style="padding:4px 24px 24px"><div style="font-size:12px;color:#667085;margin-bottom:10px">A journey to look forward to</div><h1 style="font-size:28px;line-height:1.3;margin:0">${escape(route)}</h1><p style="font-size:13px;line-height:1.7;color:#667085;margin:12px 0 0">Here are the flight details for your next trip.</p></td></tr>
    ${offer ? `<tr><td style="padding:0 24px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fff5e9;border:1px solid #ffe1b9;border-radius:12px"><tr><td style="padding:18px"><div style="font-size:11px;color:#8a4b0f">TOTAL OFFER PRICE</div><div style="font-size:28px;font-weight:bold;margin-top:6px">${price}</div><div style="font-size:11px;color:#667085;margin-top:6px">For ${offer.travellers} traveller${offer.travellers === 1 ? '' : 's'}</div></td><td align="right" style="padding:18px;font-size:11px;color:#475467">${offer.refundable ? 'Refundable' : 'Non-refundable'}<br><span style="font-size:10px;line-height:2">Airline rules apply</span></td></tr></table></td></tr>` : ''}
    ${flights}
    <tr><td style="padding:6px 24px 24px"><p style="font-size:11px;line-height:1.8;color:#667085;margin:0">All flight times are local to each airport. This is a flight offer, not a confirmed booking or ticket. Fares and seat availability may change before booking.</p></td></tr>
    <tr><td align="center" style="padding:24px;background:#08264c;color:#fff"><h2 style="font-size:18px;margin:0 0 8px">Ready to plan your trip?</h2><p style="font-size:12px;line-height:1.7;color:#d6e2f0;margin:0 0 18px">Contact our team to confirm the fare and arrange your booking.</p><a href="mailto:${escape(SITE_EMAIL)}" style="display:inline-block;background:#ff850b;color:#08264c;padding:13px 24px;border-radius:7px;font-size:13px;font-weight:bold;text-decoration:none">Enquire about this flight</a><p style="font-size:12px;margin:18px 0 0"><a href="${escape(SITE_PHONE_HREF)}" style="color:#fff;text-decoration:none">${escape(SITE_PHONE)}</a></p></td></tr>
    <tr><td align="center" style="padding:20px 24px;font-size:11px;line-height:1.8;color:#667085"><strong>${escape(SITE_NAME)}</strong><br>${escape(SITE_ADDRESS)}<br><a href="${escape(SITE_WEBSITE)}" style="color:#667085">${escape(SITE_WEBSITE.replace('https://', ''))}</a></td></tr>
  </table></td></tr></table></body></html>`;
}
