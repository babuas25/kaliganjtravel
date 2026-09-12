import { BadgeCheck, Phone, Save, UserRound } from 'lucide-react';

interface Props {
  title: string;
  name: string;
  email: string;
  /** Role label shown as the account type, e.g. "B2B Partner". */
  accountType: string;
  mobile: string;
  percent: number;
  /**
   * The agency code (`ST-B2B######`) for a partner or their sub user, shown so
   * it can be read out to support. Absent for everyone outside an agency.
   */
  agencyCode?: string | null;
  /** Disables the button and swaps its label while the save is in flight. */
  saving?: boolean;
  /**
   * Hidden on tabs that do not belong to this form — the button submits the
   * profile, so leaving it there would claim to save what is on screen.
   */
  showSave?: boolean;
}

/**
 * Page banner: identity on top, a strip of at-a-glance stats underneath. The
 * Save button submits the surrounding form, so it works from the top of a long
 * page without scrolling to the footer.
 */
export default function ProfileHeader({
  title,
  name,
  email,
  accountType,
  mobile,
  percent,
  agencyCode,
  saving = false,
  showSave = true,
}: Props) {
  const stats = [
    { icon: UserRound, label: 'Account type', value: accountType },
    { icon: Phone, label: 'Contact number', value: mobile || 'Not set' },
    { icon: BadgeCheck, label: 'Profile status', value: `${percent}% complete` },
  ];

  return (
    <section className="overflow-hidden rounded-lg bg-brand-orange text-black">
      <div className="flex flex-wrap items-center gap-4 p-6 sm:p-8">
        <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-white/10">
          <UserRound className="h-7 w-7" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm text-black/75">{title}</p>
          <h2 className="mt-0.5 truncate text-2xl font-bold sm:text-3xl">
            {name || 'Your details'}
          </h2>
          {email && (
            <p className="mt-1 truncate text-sm text-black/75">{email}</p>
          )}
          {agencyCode && (
            // Monospaced and letter-spaced: this gets read aloud to support and
            // typed into a search box, so the digits have to be unambiguous.
            <p className="mt-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs text-black/75">
                Agency Code
                <span className="font-mono font-semibold tracking-wider text-black">
                  {agencyCode}
                </span>
              </span>
            </p>
          )}
        </div>

        {showSave && (
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-navy-950 transition hover:bg-white/80 hover:text-black disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        )}
      </div>

      <div className="grid border-t border-black/10 bg-white/30 sm:grid-cols-3">
        {stats.map(({ icon: Icon, label, value }) => (
          <div
            key={label}
            className="flex items-center gap-3 border-t border-black/10 px-6 py-4 first:border-t-0 sm:border-l sm:border-t-0 sm:first:border-l-0"
          >
            <Icon className="h-4 w-4 shrink-0 text-black/75" />
            <div className="min-w-0">
              <p className="text-xs text-black/75">{label}</p>
              <p className="truncate text-sm font-semibold">{value}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
