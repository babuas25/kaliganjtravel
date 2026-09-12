import fs from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Mail, MapPin, Phone, Plane, Receipt, Ticket, Users } from 'lucide-react';
import sharp from 'sharp';

// Render the app's existing Lucide icon family in Kaliganj's orange palette.
// These PNGs are embedded into emails/PDFs, where SVG support is inconsistent.
const icons = { mail: Mail, 'map-pin': MapPin, phone: Phone, plane: Plane,
  receipt: Receipt, ticket: Ticket, users: Users };
await fs.mkdir('public/email-icons', { recursive: true });
for (const [name, Icon] of Object.entries(icons)) {
  const svg = renderToStaticMarkup(createElement(Icon, { color: '#f68712', size: 96, strokeWidth: 1.8 }));
  await sharp(Buffer.from(svg)).png().toFile(`public/email-icons/${name}.png`);
}
console.log('Generated seven Kaliganj email/PDF icons from Lucide SVGs.');
