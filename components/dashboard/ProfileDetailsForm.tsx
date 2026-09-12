'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2,
  FileText,
  Landmark,
  Phone,
  Save,
  Upload,
  User,
  type LucideIcon,
} from 'lucide-react';

import BusinessDocField, {
  type SignedDocLink,
} from '@/components/dashboard/BusinessDocField';
import ProfileHeader from '@/components/dashboard/ProfileHeader';
import ProfileOverview from '@/components/dashboard/ProfileOverview';
import StaffPanel, { type StaffEntry } from '@/components/dashboard/StaffPanel';
import { cn } from '@/lib/utils';
import {
  AGENCY_IDENTITY_FIELDS,
  EMPTY_PROFILE,
  GENDER_OPTIONS,
  isFileField,
  profileTitleFor,
  sectionsFor,
  STAFF_TAB_ID,
  tabsFor,
  type FieldSpec,
  type ProfileField,
  type ProfileValues,
  type SectionId,
} from '@/lib/profile';
import { ROLE_LABELS, type Role } from '@/lib/roles';
import { saveProfileAction } from '@/app/(dashboard)/dashboard/profile/actions';

const SECTION_ICONS: Record<SectionId, LucideIcon> = {
  personal: User,
  passport: FileText,
  contact: Phone,
  business: Building2,
  documents: Upload,
  bank: Landmark,
};

const CONTROL_CLASS =
  'mt-1.5 w-full rounded-md border border-navy-100 bg-white px-3 py-2 text-sm text-navy-950 outline-none transition placeholder:text-navy-700/40 focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/20 disabled:cursor-not-allowed disabled:bg-navy-50 disabled:text-navy-700/70';

const LABEL_CLASS = 'text-sm font-medium text-navy-950';

interface Props {
  role: Role;
  /** Prefill from the signed-in Clerk user; the rest starts blank. */
  defaults?: Partial<ProfileValues>;
  /** Agency code for a B2B partner or sub user; null for everyone else. */
  agencyCode?: string | null;
  /**
   * People shown on the Staff tab: an admin's sub users, or the single entry a
   * sub user owns. Empty for every role without the tab.
   */
  staffEntries?: StaffEntry[];
  /** True for the agency owner, which is what makes the tab a roster. */
  staffIsAdmin?: boolean;
  /** Withholds the staff panel rather than showing it blank. */
  staffReadFailed?: boolean;
  /** Signed links to the business documents already on file, keyed by field. */
  documentLinks?: Record<string, SignedDocLink>;
  /** False when Cloudinary is unconfigured — the pickers say so and disable. */
  documentsConfigured?: boolean;
}

export default function ProfileDetailsForm({
  role,
  defaults,
  agencyCode,
  staffEntries = [],
  staffIsAdmin = false,
  staffReadFailed = false,
  documentLinks = {},
  documentsConfigured = false,
}: Props) {
  const router = useRouter();
  const sections = sectionsFor(role);
  const tabs = tabsFor(role);

  const [values, setValues] = useState<ProfileValues>({
    ...EMPTY_PROFILE,
    ...defaults,
  });
  const [activeTab, setActiveTab] = useState(tabs[0].id);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const [pending, startTransition] = useTransition();
  // Held in state rather than read from props: each upload and removal returns
  // a freshly signed map, and re-rendering from that is what keeps the other
  // fields' short-lived links working while one is being replaced.
  const [docLinks, setDocLinks] =
    useState<Record<string, SignedDocLink>>(documentLinks);
  const docsConfigured = documentsConfigured;

  // Documents are still left out of the required check and the completion
  // meter. They are stored now, but they are evidence rather than profile
  // fields, and counting five uploads towards a form about names and passports
  // would misreport how complete the profile actually is.
  const allFields = sections
    .flatMap((section) => [...section.fields])
    .filter((field) => !isFileField(field.name));
  const filled = allFields.filter((field) => values[field.name].trim()).length;
  const total = allFields.length;
  const percent = Math.round((filled / total) * 100);

  const remaining = total - filled;

  const tab = tabs.find((item) => item.id === activeTab) ?? tabs[0];
  const visible = sections.filter((section) =>
    tab.sections.includes(section.id)
  );

  // The Staff tab edits `staff_details`, not this form's row. Its panel renders
  // outside the <form> — it writes other people's records through its own
  // action, and nesting a form inside another is invalid HTML.
  const isStaffTab = tab.id === STAFF_TAB_ID;

  const fullName = [values.givenName, values.surname]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');

  function set(field: ProfileField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setNotice(null);
  }

  /**
   * Nothing is mandatory. Every field can be filled in over time, and a save
   * with a single value is as valid as a complete one — blanks are stored as
   * NULL rather than rejected. The form always submits its whole state, which
   * is seeded from the saved row, so saving from one tab cannot wipe another.
   */
  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    startTransition(async () => {
      const result = await saveProfileAction(values);
      setNotice({ ok: result.ok, text: result.message });
      // Pull the stored row back so what's on screen is what's in the table.
      if (result.ok) router.refresh();
    });
  }

  function renderField(field: FieldSpec) {
    const { name, label, type, autoComplete, placeholder, uppercase } = field;

    // Documents are stored in Cloudinary and written by their own action, one
    // at a time — they are not part of this form's payload. See
    // `BusinessDocField`.
    if (type === 'file') {
      return (
        <BusinessDocField
          key={name}
          field={field}
          link={docLinks[name]}
          disabledReason={
            docsConfigured
              ? undefined
              : 'File uploads are not configured on this environment.'
          }
          onChanged={(result) => {
            if (!result.ok) return;
            setDocLinks(result.docs);
            setNotice({ ok: true, text: result.message });
          }}
        />
      );
    }

    const agencyIdentityLocked =
      (role === 'b2b' || role === 'b2b_sub') &&
      AGENCY_IDENTITY_FIELDS.includes(
        name as (typeof AGENCY_IDENTITY_FIELDS)[number]
      ) &&
      Boolean(defaults?.[name]?.trim());

    const shared = {
      id: name,
      name,
      value: values[name],
      autoComplete,
      placeholder,
      disabled: agencyIdentityLocked,
    };

    return (
      <div key={name} className={cn(field.wide && 'sm:col-span-2')}>
        <label htmlFor={name} className={LABEL_CLASS}>
          {label}
        </label>

        {type === 'select' ? (
          <select
            {...shared}
            onChange={(event) => set(name, event.target.value)}
            className={CONTROL_CLASS}
          >
            <option value="" disabled>
              Select {label.toLowerCase()}
            </option>
            {GENDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : type === 'textarea' ? (
          <textarea
            {...shared}
            rows={3}
            onChange={(event) => set(name, event.target.value)}
            className={cn(CONTROL_CLASS, 'resize-y')}
          />
        ) : (
          <input
            {...shared}
            type={type}
            inputMode={type === 'tel' ? 'tel' : undefined}
            autoCapitalize={uppercase ? 'characters' : undefined}
            onChange={(event) => set(name, event.target.value)}
            className={cn(CONTROL_CLASS, uppercase && 'uppercase')}
          />
        )}
        {agencyIdentityLocked && (
          <p className="mt-1.5 text-xs text-navy-700/60">
            This agency identity field is locked after first submission. Contact
            Admin or Super Admin to change it.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-6">
        <ProfileHeader
          title={profileTitleFor(role)}
          name={fullName}
          email={values.email}
          accountType={ROLE_LABELS[role]}
          mobile={values.mobile}
          percent={percent}
          agencyCode={agencyCode}
          saving={pending}
          // Nothing on the Staff tab belongs to this form, so a Save here would
          // either do nothing or look like it saved the wrong thing.
          showSave={!isStaffTab}
        />

        {/* Tab strip */}
        <div className="overflow-x-auto rounded-lg border border-navy-100 bg-white px-2">
          <div className="flex min-w-max">
            {tabs.map((item) => {
              const current = item.id === tab.id;

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'border-b-2 px-4 py-3.5 text-sm font-medium transition',
                    current
                      ? 'border-brand-orange text-brand-orange'
                      : 'border-transparent text-navy-700/70 hover:text-navy-950'
                  )}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        {!isStaffTab && (
          <>
            <div className="grid gap-6 lg:grid-cols-3">
              <div className="space-y-6 lg:col-span-2">
                {visible.map((section) => {
                  const Icon = SECTION_ICONS[section.id];

                  return (
                    <section
                      key={section.id}
                      className="overflow-hidden rounded-lg border border-navy-100 bg-white"
                    >
                      <header className="flex items-start gap-3 border-b border-navy-100 px-5 py-4">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-orange-light text-brand-orange-dark">
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold text-navy-950">
                            {section.title}
                          </h3>
                          <p className="mt-0.5 text-xs text-navy-700/70">
                            {section.hint}
                          </p>
                        </div>
                      </header>

                      <div className="grid gap-x-4 gap-y-5 px-5 py-5 sm:grid-cols-2">
                        {section.fields.map(renderField)}
                      </div>
                    </section>
                  );
                })}
              </div>

              <aside className="lg:sticky lg:top-6 lg:self-start">
                <ProfileOverview
                  values={values}
                  filled={filled}
                  total={total}
                  percent={percent}
                />
              </aside>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-navy-100 bg-white px-5 py-4">
              <p
                role="status"
                className={cn(
                  'text-xs',
                  notice
                    ? notice.ok
                      ? 'font-medium text-emerald-700'
                      : 'font-medium text-brand-orange-dark'
                    : 'text-navy-700/60'
                )}
              >
                {notice?.text ??
                  (remaining > 0
                    ? `Save any time — ${remaining} of ${total} details still blank.`
                    : 'Every detail is filled in.')}
              </p>
              <button
                type="submit"
                disabled={pending}
                className="inline-flex items-center gap-2 rounded-full bg-brand-orange px-6 py-2.5 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Save className="h-4 w-4" />
                {pending ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </>
        )}
      </form>

      {isStaffTab && (
        <StaffPanel
          entries={staffEntries}
          isAdmin={staffIsAdmin}
          readFailed={staffReadFailed}
        />
      )}
    </div>
  );
}
