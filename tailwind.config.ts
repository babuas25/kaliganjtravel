import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    // Class names live here too — `lib/clerk-appearance.ts` dresses the Clerk
    // widget and `lib/colors.ts` exports a `tw` map. Without this glob those
    // are silently dropped from the stylesheet.
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      spacing: {
        '4.5': '1.125rem',
      },
      colors: {
        /* ── Neutral ink palette (legacy navy utility names) ───────────────────────────── */
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
        /* ── Orange accent ──────────────────────────────────── */
        brand: {
          orange:      '#f68712',
          'orange-dark': '#ad4f08',
          'orange-light': '#fff1e2',
        },
        /* ── shadcn/ui semantic tokens ───────────────────── */
        background:  'hsl(var(--background))',
        foreground:  'hsl(var(--foreground))',
        card: {
          DEFAULT:    'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT:    'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT:    'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT:    'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT:    'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT:    'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT:    'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        border: 'hsl(var(--border))',
        input:  'hsl(var(--input))',
        ring:   'hsl(var(--ring))',
        chart: {
          '1': 'hsl(var(--chart-1))',
          '2': 'hsl(var(--chart-2))',
          '3': 'hsl(var(--chart-3))',
          '4': 'hsl(var(--chart-4))',
          '5': 'hsl(var(--chart-5))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      backgroundImage: {
        'navy-gradient': 'linear-gradient(135deg, #262626 0%, #404040 100%)',
        'hero-gradient': 'linear-gradient(135deg, #171717 0%, #404040 100%)',
        /* Warm brand backdrop behind the flight search form. */
        'search-gradient':
          'linear-gradient(135deg, #fff1e2 0%, #f68712 100%)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to:   { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to:   { height: '0' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(-8px)' },
          to:   { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up':   'accordion-up 0.2s ease-out',
        'slide-in':       'slide-in 0.3s ease both',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
export default config;
