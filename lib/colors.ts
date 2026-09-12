/**
 * Central colour tokens — import anywhere to reference the design system.
 * All values map directly to the CSS variables and Tailwind palette.
 */

export const colors = {
  /* Neutral ink ramp; navy keys retained for existing consumers */
  navy: {
    950: '#171717',
    900: '#262626',
    800: '#404040',
    700: '#525252',
    600: '#626262',
    500: '#737373',
    400: '#a3a3a3',
    300: '#d4d4d4',
    200: '#e5e5e5',
    100: '#f0f0f0',
    50:  '#fafafa',
  },

  /* Brand orange accent */
  brand: {
    orange:       '#f68712',
    orangeDark:   '#ad4f08',
    orangeLight:  '#fff1e2',
  },

  /* Neutral grey ramp */
  neutral: {
    900: '#111827',
    800: '#1f2937',
    700: '#374151',
    600: '#4b5563',
    500: '#6b7280',
    400: '#9ca3af',
    300: '#d1d5db',
    200: '#e5e7eb',
    100: '#f3f4f6',
    50:  '#f9fafb',
  },

  /* Semantic */
  success: { bg: '#d1fae5', text: '#059669' },
  warning: { bg: '#fef3c7', text: '#f59e0b' },
  error:   { bg: '#fee2e2', text: '#dc2626' },
  info:    { bg: '#dbeafe', text: '#3b82f6' },
} as const;

/** Tailwind utility class groups derived from the palette */
export const tw = {
  /** Legacy neutral ink surface helpers */
  navyBg:         'bg-navy-900',
  navyBgDark:     'bg-navy-950',
  navyText:       'text-navy-900',
  navyBorder:     'border-navy-700',

  /** Accent orange (CTAs) */
  orangeBg:          'bg-brand-orange',
  orangeHover:       'hover:bg-brand-orange-dark',
  orangeText:        'text-brand-orange',

  /** Card surface */
  cardBg:         'bg-white',
  cardShadow:     'shadow-md',

  /** Primary button */
  btnPrimary:     'bg-brand-orange text-black hover:bg-brand-orange/90 transition-colors',
  btnDanger:      'bg-red-600 text-white hover:bg-red-700 transition-colors',
  btnOutline:     'border border-navy-900 text-navy-900 hover:bg-navy-50 transition-colors',
} as const;
