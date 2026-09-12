/**
 * How the Clerk widget is dressed inside the auth card.
 *
 * The card, its border and its header are all stripped out: the surrounding
 * panel already supplies a white surface, a shadow and a title, and leaving
 * Clerk's own would stack two cards and two headings on top of each other.
 * Everything else is pulled onto the site's orange/black palette.
 *
 * `colorPrimary` is not set here — `ClerkProvider` in `app/layout.tsx` already
 * sets it to brand orange, which is what every other primary action on the site
 * uses.
 */
export const authAppearance = {
  // `options`, not `layout` — Clerk v7 renamed the block, and a `layout` key is
  // accepted and silently ignored.
  options: {
    // Pinned rather than left on `auto`, which switches to icon-only buttons
    // as soon as a third provider is enabled in the Clerk dashboard.
    socialButtonsVariant: 'blockButton' as const,
  },
  variables: {
    colorText: '#171717',
    colorTextSecondary: '#4b5563',
    colorBackground: '#ffffff',
    colorInputBackground: '#fafafa',
    colorInputText: '#171717',
    colorDanger: '#dc2626',
    borderRadius: '0.75rem',
    fontFamily: 'inherit',
  },
  elements: {
    rootBox: 'w-full',
    cardBox: 'w-full rounded-none border-none shadow-none',
    card: 'w-full bg-transparent !p-0 !gap-4 rounded-none border-none shadow-none',
    main: '!gap-4',
    form: '!gap-4',
    formFieldRow: '!gap-4',
    formFieldInputGroup: '!gap-1.5',
    formField: '!gap-1.5',
    header: 'hidden',
    // The floating badge is clipped by the compact auth card. Keep the social
    // button clean instead of rendering a partial label above its border.
    lastAuthenticationStrategyBadge: { display: 'none' },
    formButtonPrimary:
      '!min-h-11 !rounded-xl !bg-brand-orange !text-navy-950 hover:!bg-brand-orange-dark hover:!text-white text-sm font-semibold normal-case tracking-normal !shadow-none',
    formFieldLabel: 'font-medium text-navy-950',
    formFieldInput: '!min-h-11 !rounded-xl !border-neutral-200 !bg-neutral-50 !shadow-none focus:!border-brand-orange focus:!ring-brand-orange/20',
    // `bg-none` as well as `bg-transparent`: Clerk tints the footer with a
    // background *image* (a near-black linear-gradient), which a colour alone
    // leaves in place as a grey band across the white panel.
    footer: 'bg-transparent bg-none !p-0 !pt-3',
    footerAction: 'bg-transparent',
    footerActionText: 'text-neutral-600',
    footerActionLink: 'font-semibold text-brand-orange hover:text-brand-orange-dark',
    dividerLine: 'bg-neutral-200',
    dividerText: 'text-neutral-500',
    socialButtonsBlockButtonText: 'text-sm font-medium',
    // Clerk lays the buttons out on an auto-fit grid whose minimum column is
    // almost exactly half the panel — so whether the two share a row came down
    // to a sub-pixel difference in font metrics, and they stacked on some
    // machines and not others. This is the same intent stated outright: one
    // row, equal widths, wrapping only when "Continue with Facebook" genuinely
    // cannot fit beside its neighbour (a phone).
    //
    // Style objects rather than class names for these two: Clerk merges an
    // object into the element's own generated CSS, so it wins outright. A
    // Tailwind class would have to out-specify `display: grid` with `!`, and
    // only after the class survives the JIT — two more things to get wrong.
    socialButtons: {
      display: 'flex',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: '0.5rem',
    },
    socialButtonsBlockButton: {
      flex: '1 1 10rem',
      minHeight: '44px',
      borderRadius: '12px',
      boxShadow: 'none',
      border: '1px solid #e5e5e5',
      backgroundColor: '#ffffff',
      color: '#171717',
      '&:hover': { backgroundColor: '#fafafa' },
    },
  },
};

/**
 * Wording for the social buttons.
 *
 * Clerk keeps two labels for these — a full one and a shorter `…ManyInView`
 * variant it swaps in when it reckons several buttons are sharing a row — and
 * that swap is what produced a bare "Google" on some screens and "Continue
 * with Google" on others. Both read the same here, so the wording no longer
 * depends on the guess.
 *
 * Passed to `ClerkProvider`, not to `<SignIn />`: `localization` is a Clerk
 * option rather than a component prop.
 */
export const authLocalization = {
  socialButtonsBlockButton: 'Continue with {{provider|titleize}}',
  socialButtonsBlockButtonManyInView: 'Continue with {{provider|titleize}}',
};
