# Orange and black site theme

Use brand orange (`#f68712`) with black text for prominent page banners, primary actions, selected tabs and dashboard navigation. Content cards stay white, with neutral gray page backgrounds, borders and supporting text. White buttons distinguish secondary actions inside orange panels.

The shared UI primary token is orange with a dark foreground; subtle active/hover surfaces use pale orange. Keep success, warning, error and informational status colors, airline logos, and payment-provider brand colors meaningful.

The legacy `navy-*` Tailwind classes, CSS variables and `colors.navy` exports now represent a neutral ink ramp. Existing consumers therefore receive black/gray text and surfaces without breaking class names. New prominent banners should use `bg-brand-orange text-black` explicitly rather than a dark ink background. Dark photo overlays and promotional hero surfaces use neutral charcoal with white text.

Token definitions: `tailwind.config.ts`, `app/globals.css`, `lib/colors.ts`. Authentication appearance is in `lib/clerk-appearance.ts` and the profile page. Keep loading skeletons on the same surfaces as their loaded pages.

Verification: TypeScript check, Tailwind CSS compilation, local component rendering, and browser checks of the homepage and signed-in dashboard pages. No booking, payment or notification behavior is changed by the theme update.
