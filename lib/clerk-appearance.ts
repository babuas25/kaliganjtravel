/**
 * How the Clerk widget is dressed inside the auth card.
 *
 * The card, its border and its header are all stripped out: the surrounding
 * panel already supplies a white surface, a shadow and a title, and leaving
 * Clerk's own would stack two cards and two headings on top of each other.
 * Use style objects here: Clerk's unlayered styles override normal Tailwind v4
 * utilities, which can leave its default card visible after its padding is gone.
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
    rootBox: { width: '100%', minWidth: 0 },
    cardBox: {
      width: '100%',
      maxWidth: '100%',
      border: 'none',
      borderRadius: 0,
      boxShadow: 'none',
      backgroundColor: 'transparent',
      overflow: 'visible',
    },
    card: {
      width: '100%',
      margin: 0,
      padding: 0,
      gap: '1rem',
      border: 'none',
      borderRadius: 0,
      boxShadow: 'none',
      backgroundColor: 'transparent',
    },
    main: { gap: '1rem' },
    form: { gap: '1rem' },
    formFieldRow: { gap: '1rem' },
    formFieldInputGroup: { gap: '0.375rem' },
    formField: { gap: '0.375rem' },
    // Later steps need Clerk's verification and password-reset instructions.
    header: {
      '.cl-signIn-start &, .cl-signUp-start &': { display: 'none' },
    },
    // The floating badge is clipped by the compact auth card. Keep the social
    // button clean instead of rendering a partial label above its border.
    lastAuthenticationStrategyBadge: { display: 'none' },
    formButtonPrimary: {
      minHeight: '44px',
      borderRadius: '12px',
      backgroundColor: '#f68712',
      color: '#171717',
      fontSize: '0.875rem',
      fontWeight: 600,
      textTransform: 'none',
      letterSpacing: 'normal',
      boxShadow: 'none',
      '&:hover:not(:disabled)': { backgroundColor: '#ad4f08', color: '#ffffff' },
    },
    formFieldLabel: { fontWeight: 500, color: '#171717' },
    formFieldInput: {
      minHeight: '44px',
      borderRadius: '12px',
      border: '1px solid #e5e5e5',
      backgroundColor: '#fafafa',
      color: '#171717',
      boxShadow: 'none',
      // Match Clerk's variant selectors so its simulated borders cannot hide
      // the focus ring or the validation state.
      '&[data-variant="default"]': {
        border: '1px solid #e5e5e5',
        boxShadow: 'none',
      },
      '&:focus, &[data-variant="default"]:focus-within': {
        borderColor: '#f68712',
        boxShadow: '0 0 0 3px rgba(246, 135, 18, 0.2)',
      },
      '&[aria-invalid="true"]': { borderColor: '#dc2626' },
      '&[aria-invalid="true"]:focus-within': {
        borderColor: '#dc2626',
        boxShadow: '0 0 0 3px rgba(220, 38, 38, 0.2)',
      },
    },
    // Clerk also tints the footer with a background image.
    footer: {
      backgroundColor: 'transparent',
      backgroundImage: 'none',
      padding: '0.75rem 0 0',
    },
    footerAction: { backgroundColor: 'transparent' },
    footerActionText: { color: '#525252' },
    footerActionLink: {
      fontWeight: 600,
      color: '#ad4f08',
      '&:hover': { color: '#171717' },
    },
    dividerLine: { backgroundColor: '#e5e5e5' },
    dividerText: { color: '#737373' },
    socialButtonsBlockButtonText: { fontSize: '0.875rem', fontWeight: 500 },
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
