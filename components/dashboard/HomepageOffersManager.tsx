'use client';

import Image from 'next/image';
import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';

import {
  removeHomepageOfferImageAction,
  saveHomepageOfferTextAction,
  uploadHomepageOfferImageAction,
  type HomepageOfferActionResult,
} from '@/app/(dashboard)/dashboard/media/actions';
import {
  HOMEPAGE_OFFER_DESCRIPTION_MAX_LENGTH,
  HOMEPAGE_OFFER_EYEBROW_MAX_LENGTH,
  HOMEPAGE_OFFER_HEADING_MAX_LENGTH,
  HOMEPAGE_OFFER_SUBHEADING_MAX_LENGTH,
  HOMEPAGE_OFFER_TITLE_MAX_LENGTH,
  type HomepageOffer,
  type HomepageOffersState,
} from '@/lib/homepage-offers';
import {
  HOMEPAGE_OFFER_IMAGE_ACCEPT,
  HOMEPAGE_OFFER_IMAGE_EXTENSIONS,
  HOMEPAGE_OFFER_IMAGE_HINT,
  HOMEPAGE_OFFER_IMAGE_MAX_BYTES,
  homepageOfferImageDimensionError,
} from '@/lib/upload-verify';

type Props = {
  initialState: HomepageOffersState;
  configured: boolean;
};

type TextSnapshot = {
  heading: string;
  subheading: string;
  offers: Array<Pick<HomepageOffer, 'id' | 'eyebrow' | 'title' | 'description' | 'active'>>;
};

function textSnapshot(
  heading: string,
  subheading: string,
  offers: HomepageOffer[]
): TextSnapshot {
  return {
    heading,
    subheading,
    offers: offers.map(({ id, eyebrow, title, description, active }) => ({
      id,
      eyebrow,
      title,
      description,
      active,
    })),
  };
}

function cloneOffers(offers: readonly HomepageOffer[]): HomepageOffer[] {
  return offers.map((offer) => ({
    ...offer,
    image: offer.image ? { ...offer.image } : null,
  }));
}

export default function HomepageOffersManager({
  initialState,
  configured,
}: Props) {
  const [savedVersion, setSavedVersion] = useState(initialState.version);
  const [heading, setHeading] = useState(initialState.heading);
  const [subheading, setSubheading] = useState(initialState.subheading);
  const [offers, setOffers] = useState(() => cloneOffers(initialState.offers));
  const [baseline, setBaseline] = useState(() =>
    textSnapshot(initialState.heading, initialState.subheading, cloneOffers(initialState.offers))
  );
  const [notice, setNotice] = useState<HomepageOfferActionResult | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

  useEffect(() => {
    if (initialState.version === savedVersion) return;
    const nextOffers = cloneOffers(initialState.offers);
    setSavedVersion(initialState.version);
    setHeading(initialState.heading);
    setSubheading(initialState.subheading);
    setOffers(nextOffers);
    setBaseline(textSnapshot(initialState.heading, initialState.subheading, nextOffers));
    setRemoveConfirmId(null);
  }, [initialState, savedVersion]);

  const currentSnapshot = useMemo(
    () => textSnapshot(heading, subheading, offers),
    [heading, subheading, offers]
  );
  const dirty = JSON.stringify(currentSnapshot) !== JSON.stringify(baseline);
  const databaseReady = initialState.source === 'database';
  const busy = isSaving || uploadingId !== null;

  function updateOffer(id: string, patch: Partial<HomepageOffer>) {
    setOffers((current) =>
      current.map((offer) => (offer.id === id ? { ...offer, ...patch } : offer))
    );
    setNotice(null);
  }

  function resetText() {
    setHeading(baseline.heading);
    setSubheading(baseline.subheading);
    setOffers((current) =>
      current.map((offer) => {
        const saved = baseline.offers.find((candidate) => candidate.id === offer.id);
        return saved ? { ...offer, ...saved } : offer;
      })
    );
    setNotice(null);
  }

  function saveText() {
    const normalized = textSnapshot(
      heading.trim(),
      subheading.trim(),
      offers.map((offer) => ({
        ...offer,
        eyebrow: offer.eyebrow.trim(),
        title: offer.title.trim(),
        description: offer.description.trim(),
      }))
    );
    if (
      !normalized.heading ||
      normalized.heading.length > HOMEPAGE_OFFER_HEADING_MAX_LENGTH ||
      !normalized.subheading ||
      normalized.subheading.length > HOMEPAGE_OFFER_SUBHEADING_MAX_LENGTH ||
      normalized.offers.some(
        (offer) =>
          !offer.eyebrow ||
          offer.eyebrow.length > HOMEPAGE_OFFER_EYEBROW_MAX_LENGTH ||
          !offer.title ||
          offer.title.length > HOMEPAGE_OFFER_TITLE_MAX_LENGTH ||
          !offer.description ||
          offer.description.length > HOMEPAGE_OFFER_DESCRIPTION_MAX_LENGTH
      )
    ) {
      setNotice({
        ok: false,
        message: 'Complete every field and keep the text within its character limit.',
      });
      return;
    }

    startSaving(async () => {
      const result = await saveHomepageOfferTextAction({
        expectedVersion: savedVersion,
        ...normalized,
      });
      setNotice(result);
      if (result.ok && result.version) {
        setHeading(normalized.heading);
        setSubheading(normalized.subheading);
        setOffers((current) =>
          current.map((offer) => {
            const saved = normalized.offers.find((candidate) => candidate.id === offer.id);
            return saved ? { ...offer, ...saved } : offer;
          })
        );
        setBaseline(normalized);
        setSavedVersion(result.version);
      }
    });
  }

  async function chooseImage(offer: HomepageOffer, file: File | undefined) {
    if (!file) return;
    if (!HOMEPAGE_OFFER_IMAGE_EXTENSIONS[file.type]) {
      setNotice({ ok: false, message: 'Use a JPEG, PNG or WebP image.' });
      return;
    }
    if (file.size > HOMEPAGE_OFFER_IMAGE_MAX_BYTES) {
      setNotice({ ok: false, message: 'That image is over the 2 MB limit.' });
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const dimensionError = homepageOfferImageDimensionError(
        bitmap.width,
        bitmap.height
      );
      bitmap.close();
      if (dimensionError) {
        setNotice({ ok: false, message: dimensionError });
        return;
      }
    } catch {
      setNotice({ ok: false, message: 'That image could not be read.' });
      return;
    }

    const formData = new FormData();
    formData.append('offerId', offer.id);
    formData.append('image', file);
    setUploadingId(offer.id);
    setRemoveConfirmId(null);
    setNotice(null);
    const result = await uploadHomepageOfferImageAction(formData);
    setNotice(result);
    if (result.ok && result.version && result.image) {
      setOffers((current) =>
        current.map((candidate) =>
          candidate.id === offer.id ? { ...candidate, image: result.image ?? null } : candidate
        )
      );
      setSavedVersion(result.version);
    }
    setUploadingId(null);
  }

  async function removeImage(offer: HomepageOffer) {
    if (!offer.image) return;
    if (removeConfirmId !== offer.id) {
      setRemoveConfirmId(offer.id);
      return;
    }
    setUploadingId(offer.id);
    setNotice(null);
    const result = await removeHomepageOfferImageAction({
      offerId: offer.id,
    });
    setNotice(result);
    if (result.ok && result.version) {
      setOffers((current) =>
        current.map((candidate) =>
          candidate.id === offer.id ? { ...candidate, image: null } : candidate
        )
      );
      setSavedVersion(result.version);
    }
    setUploadingId(null);
    setRemoveConfirmId(null);
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-navy-100 bg-white shadow-sm">
      <header className="flex items-start gap-3 border-b border-navy-100 px-5 py-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-orange/10 text-brand-orange">
          <ImageIcon className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-navy-950">
            Homepage limited-time travel offers
          </h2>
          <p className="mt-0.5 text-xs leading-5 text-navy-700/70">
            Change the section heading and each card’s label, title, description,
            visibility, and background image.
          </p>
        </div>
      </header>

      <div className="space-y-6 p-5">
        {!databaseReady ? (
          <p className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            Travel-offer controls are unavailable until the database update is applied.
          </p>
        ) : null}
        {!configured ? (
          <p className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            Cloudinary is not configured, so text can be edited but image uploads are
            unavailable.
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm font-medium text-navy-950 sm:col-span-2">
            Section heading
            <input
              value={heading}
              maxLength={HOMEPAGE_OFFER_HEADING_MAX_LENGTH}
              disabled={!databaseReady || busy}
              onChange={(event) => {
                setHeading(event.target.value);
                setNotice(null);
              }}
              className="w-full rounded-lg border border-navy-200 px-3 py-2.5 font-normal outline-none transition focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/10 disabled:bg-neutral-50"
            />
          </label>
          <label className="space-y-1.5 text-sm font-medium text-navy-950 sm:col-span-2">
            Section description
            <input
              value={subheading}
              maxLength={HOMEPAGE_OFFER_SUBHEADING_MAX_LENGTH}
              disabled={!databaseReady || busy}
              onChange={(event) => {
                setSubheading(event.target.value);
                setNotice(null);
              }}
              className="w-full rounded-lg border border-navy-200 px-3 py-2.5 font-normal outline-none transition focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/10 disabled:bg-neutral-50"
            />
          </label>
        </div>

        <div className="space-y-5">
          {offers.map((offer, index) => {
            const imageBusy = uploadingId === offer.id;
            return (
              <article
                key={offer.id}
                className="overflow-hidden rounded-xl border border-navy-100 bg-navy-50"
              >
                <div className="grid lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                  <div className="relative min-h-56 overflow-hidden bg-gradient-to-br from-navy-950 via-navy-900 to-brand-orange p-5 text-white">
                    {offer.image ? (
                      <>
                        <Image
                          src={offer.image.url}
                          alt=""
                          fill
                          sizes="(min-width: 1024px) 380px, 100vw"
                          className="object-cover"
                        />
                        <div className="absolute inset-0 bg-gradient-to-br from-navy-950/40 via-navy-900/20 to-brand-orange/25" />
                      </>
                    ) : null}
                    <div className="relative flex h-full min-h-44 flex-col justify-end">
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/80">
                        {offer.eyebrow || 'Offer label'}
                      </p>
                      <h3 className="mt-3 text-xl font-semibold">
                        {offer.title || `Offer ${index + 1}`}
                      </h3>
                      <p className="mt-3 text-sm leading-6 text-white/80">
                        {offer.description || 'Offer description'}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-4 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-navy-950">
                        Offer card {index + 1}
                      </p>
                      <label className="flex items-center gap-2 text-xs font-medium text-navy-700">
                        <input
                          type="checkbox"
                          checked={offer.active}
                          disabled={!databaseReady || busy}
                          onChange={(event) =>
                            updateOffer(offer.id, { active: event.target.checked })
                          }
                          className="h-4 w-4 rounded border-navy-300 text-brand-orange focus:ring-brand-orange"
                        />
                        Show on homepage
                      </label>
                    </div>

                    <div className="grid gap-3">
                      <label className="space-y-1 text-xs font-medium text-navy-700">
                        Label
                        <input
                          value={offer.eyebrow}
                          maxLength={HOMEPAGE_OFFER_EYEBROW_MAX_LENGTH}
                          disabled={!databaseReady || busy}
                          onChange={(event) =>
                            updateOffer(offer.id, { eyebrow: event.target.value })
                          }
                          className="w-full rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm font-normal text-navy-950 outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/10 disabled:bg-neutral-50"
                        />
                      </label>
                      <label className="space-y-1 text-xs font-medium text-navy-700">
                        Title
                        <input
                          value={offer.title}
                          maxLength={HOMEPAGE_OFFER_TITLE_MAX_LENGTH}
                          disabled={!databaseReady || busy}
                          onChange={(event) =>
                            updateOffer(offer.id, { title: event.target.value })
                          }
                          className="w-full rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm font-normal text-navy-950 outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/10 disabled:bg-neutral-50"
                        />
                      </label>
                      <label className="space-y-1 text-xs font-medium text-navy-700">
                        Description
                        <textarea
                          value={offer.description}
                          maxLength={HOMEPAGE_OFFER_DESCRIPTION_MAX_LENGTH}
                          rows={3}
                          disabled={!databaseReady || busy}
                          onChange={(event) =>
                            updateOffer(offer.id, { description: event.target.value })
                          }
                          className="w-full resize-y rounded-lg border border-navy-200 bg-white px-3 py-2 text-sm font-normal text-navy-950 outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/10 disabled:bg-neutral-50"
                        />
                      </label>
                    </div>

                    <div className="rounded-lg border border-dashed border-navy-200 bg-white p-3">
                      <p className="text-xs text-navy-700/70">{HOMEPAGE_OFFER_IMAGE_HINT}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <label
                          className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border border-navy-200 px-3 py-2 text-xs font-semibold text-navy-950 transition hover:bg-navy-50 ${
                            !databaseReady || !configured || busy
                              ? 'pointer-events-none opacity-50'
                              : ''
                          }`}
                        >
                          {imageBusy ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Upload className="h-4 w-4" />
                          )}
                          {offer.image ? 'Replace image' : 'Upload image'}
                          <input
                            type="file"
                            accept={HOMEPAGE_OFFER_IMAGE_ACCEPT}
                            disabled={!databaseReady || !configured || busy}
                            onChange={(event) => {
                              void chooseImage(offer, event.target.files?.[0]);
                              event.currentTarget.value = '';
                            }}
                            className="sr-only"
                          />
                        </label>
                        {offer.image ? (
                          <button
                            type="button"
                            disabled={!databaseReady || busy}
                            onClick={() => void removeImage(offer)}
                            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition disabled:opacity-50 ${
                              removeConfirmId === offer.id
                                ? 'bg-brand-orange text-navy-950'
                                : 'border border-navy-200 text-brand-orange hover:bg-brand-orange/5'
                            }`}
                          >
                            <Trash2 className="h-4 w-4" />
                            {removeConfirmId === offer.id
                              ? 'Confirm removal'
                              : 'Remove image'}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        {notice ? (
          <p
            className={`flex items-start gap-2 text-sm ${
              notice.ok ? 'text-emerald-700' : 'text-brand-orange-dark'
            }`}
          >
            {notice.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            {notice.message}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 border-t border-navy-100 pt-5">
          <button
            type="button"
            onClick={resetText}
            disabled={!dirty || busy}
            className="inline-flex items-center gap-2 rounded-lg border border-navy-200 px-4 py-2 text-sm font-semibold text-navy-950 hover:bg-navy-50 disabled:opacity-50"
          >
            <RotateCcw className="h-4 w-4" />
            Reset text
          </button>
          <button
            type="button"
            onClick={saveText}
            disabled={!databaseReady || !dirty || busy}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-orange px-4 py-2 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:opacity-50"
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {isSaving ? 'Saving…' : 'Save text changes'}
          </button>
        </div>
      </div>
    </section>
  );
}
