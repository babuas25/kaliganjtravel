'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, Trash2 } from 'lucide-react';
import { savePromotionAction, uploadPromotionAction } from '@/app/(dashboard)/dashboard/media/promotion-actions';
import { PromotionDialog } from '@/components/dashboard/PromotionalPopup';
import { PROMOTION_AUTO_CLOSE_OPTIONS, PROMOTION_PAGES, PROMOTION_REPEAT_OPTIONS, type PromotionSlide, type PromotionState } from '@/lib/promotional-popup';

const field = 'w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-navy-950';
export default function PromotionalPopupManager({ initialState, configured }: { initialState: PromotionState; configured: boolean }) {
  const [state, setState] = useState(initialState);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadError, setUploadError] = useState(false);
  const hasActiveSlide = state.slides.some((slide) => slide.active);
  const [preview, setPreview] = useState(false);
  const edit = (id: string, patch: Partial<PromotionSlide>) => setState((current) => ({ ...current, slides: current.slides.map((slide) => slide.id === id ? { ...slide, ...patch } : slide) }));
  const move = (index: number, direction: number) => setState((current) => {
    const slides = [...current.slides];
    [slides[index], slides[index + direction]] = [slides[index + direction], slides[index]];
    return { ...current, slides };
  });
  async function upload(file?: File) {
    if (!file) return;
    setUploadError(false);
    setUploadStatus('');
    if (file.size === 0 || file.size > 2 * 1024 * 1024) {
      setUploadError(true);
      setUploadStatus(`${file.name}: choose a non-empty image up to 2 MB.`);
      return;
    }
    setBusy(true); setUploadStatus(`Uploading ${file.name}…`);
    try {
      const data = new FormData(); data.set('file', file);
      const result = await uploadPromotionAction(data);
      if (result.ok && result.url) {
        setState((current) => ({ ...current, slides: [...current.slides, { id: crypto.randomUUID(), title: file.name.replace(/\.[^.]+$/, '').slice(0, 120), imageUrl: result.url!, link: '', active: true }] }));
        setUploadStatus(`${file.name} uploaded. Click Save popup to publish it.`);
        setMessage('');
        if (inputRef.current) inputRef.current.value = '';
      } else {
        setUploadError(true);
        setUploadStatus(`${file.name}: ${result.message}`);
      }
    } catch {
      setUploadError(true);
      setUploadStatus(`${file.name}: upload failed. Please choose the image again to retry.`);
    } finally { setBusy(false); }
  }
  async function save() {
    if (state.enabled && !hasActiveSlide) return;
    setBusy(true);
    try {
      const result = await savePromotionAction({ enabled: state.enabled, display: state.display, autoCloseSeconds: state.autoCloseSeconds, slides: state.slides }, state.version);
      setMessage(result.message);
      if (result.ok && result.version) setState((current) => ({ ...current, version: result.version! }));
    } catch { setMessage('Changes could not be saved. Please try again.'); }
    finally { setBusy(false); }
  }
  return <section className="rounded-2xl border border-navy-100 bg-white shadow-sm">
    <header className="border-b border-navy-100 px-5 py-4"><h2 className="text-lg font-bold text-navy-950">Promotional popup</h2><p className="mt-1 text-sm text-neutral-500">Choose who sees your offers, where they appear and how often they repeat.</p></header>
    {!state.available && <p role="alert" className="m-5 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Promotional popup storage is not ready. Apply the database migration to enable these controls.</p>}
    {!configured && <p className="px-5 pt-4 text-sm text-amber-800">Image uploads require Cloudinary configuration.</p>}
    <fieldset disabled={busy || !state.available} className="space-y-5 p-5 disabled:opacity-60">
      <label className="flex items-center gap-3 text-sm font-semibold text-navy-950"><input type="checkbox" checked={state.enabled} onChange={(e) => setState({ ...state, enabled: e.target.checked })} className="h-4 w-4 accent-red-600" />Enable promotional popup</label>
      <div className="grid gap-5 rounded-xl border border-navy-100 bg-navy-50/50 p-4 sm:grid-cols-2">
        <label className="block text-sm font-semibold text-navy-950">Show to
          <select className={`${field} mt-2`} value={state.display.audience} onChange={(e) => setState({ ...state, display: { ...state.display, audience: e.target.value as 'b2b' | 'all' } })}>
            <option value="b2b">B2B partners and sub-users</option><option value="all">All signed-in users</option>
          </select>
        </label>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-semibold text-navy-950">Where to show</legend>
          {PROMOTION_PAGES.map((page) => <label key={page.path} className="flex items-center gap-2 text-sm text-neutral-600"><input type="checkbox" checked={state.display.pages.includes(page.path)} onChange={(e) => setState({ ...state, display: { ...state.display, pages: e.target.checked ? [...state.display.pages, page.path] : state.display.pages.filter((path) => path !== page.path) } })} className="accent-red-600" />{page.label}</label>)}
        </fieldset>
        <label className="block text-sm font-semibold text-navy-950">Session / new tab behavior
          <select className={`${field} mt-2`} value={state.display.frequencyScope} onChange={(e) => setState({ ...state, display: { ...state.display, frequencyScope: e.target.value as 'browser' | 'tab' } })}>
            <option value="tab">Show in every new tab</option>
            <option value="browser">Share timing across all tabs</option>
          </select>
          <span className="mt-1 block text-xs font-normal leading-5 text-neutral-500">New-tab mode starts a separate popup session in each tab. Refreshing or navigating within that tab keeps its timing.</span>
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold text-navy-950"><input type="checkbox" checked={state.display.showOnLogin} onChange={(e) => setState({ ...state, display: { ...state.display, showOnLogin: e.target.checked } })} className="accent-red-600" />Show again after a new login</label>
        <label className="block text-sm font-semibold text-navy-950">Wait before opening (seconds)
          <input className={`${field} mt-2`} type="number" min={0} max={300} step={1} value={state.display.delaySeconds} onChange={(e) => setState({ ...state, display: { ...state.display, delaySeconds: Number(e.target.value) } })} />
          <span className="mt-1 block text-xs font-normal text-neutral-500">0 opens immediately. Up to 300 seconds on the selected page.</span>
        </label>
        <label className="block text-sm font-semibold text-navy-950">Show again
          <select className={`${field} mt-2`} value={state.display.repeatMinutes} onChange={(e) => setState({ ...state, display: { ...state.display, repeatMinutes: Number(e.target.value) } })}>
            {PROMOTION_REPEAT_OPTIONS.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
          </select>
        </label>
        <p className="self-center text-xs leading-5 text-neutral-500">Repeat timing is remembered per user, either separately in each tab or across all tabs, based on your session setting. Popups wait while the tab is hidden or another dialog is open. Checkout and booking forms are excluded.</p>
      </div>
      <label className="block max-w-xs text-sm font-semibold text-navy-950">Automatically close after
        <select className={`${field} mt-2`} value={state.autoCloseSeconds} onChange={(event) => setState({ ...state, autoCloseSeconds: Number(event.target.value) as PromotionState['autoCloseSeconds'] })}>
          {PROMOTION_AUTO_CLOSE_OPTIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
        </select>
      </label>
      <p className="text-xs text-neutral-500">Images are stored in Cloudinary. The popup closes after the selected duration, or users can close it immediately.</p>
      <p className="text-xs text-neutral-500">Up to 6 images · JPG, PNG or WebP · Max 2 MB each. Landscape artwork around 1400 × 900 works well. Images are shown without cropping.</p>
      {state.slides.map((slide, index) => <div key={slide.id} className="grid gap-4 rounded-xl border border-neutral-200 p-4 sm:grid-cols-[140px_1fr]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={slide.imageUrl} alt={slide.title} className="h-28 w-full rounded-lg bg-neutral-50 object-contain" />
        <div className="space-y-3">
          <label className="block text-xs font-medium text-neutral-600">Title / image description<input className={`${field} mt-1`} value={slide.title} maxLength={120} onChange={(e) => edit(slide.id, { title: e.target.value })} /></label>
          <label className="block text-xs font-medium text-neutral-600">Booking / destination link (optional)<input className={`${field} mt-1`} value={slide.link} placeholder="https://… or /dashboard/flight-search" onChange={(e) => edit(slide.id, { link: e.target.value })} /></label>
          <label className="block text-xs font-medium text-neutral-600">Offer details<textarea className={`${field} mt-1`} rows={6} maxLength={12000} value={slide.details ?? ''} placeholder="Describe the offer, eligible routes, travel dates and how to book. Separate paragraphs with a blank line." onChange={(e) => edit(slide.id, { details: e.target.value })} /></label>
          <label className="block text-xs font-medium text-neutral-600">Terms & conditions (optional)<textarea className={`${field} mt-1`} rows={4} maxLength={6000} value={slide.terms ?? ''} placeholder="Add booking deadlines, exclusions and any restrictions." onChange={(e) => edit(slide.id, { terms: e.target.value })} /></label>
          <p className="text-xs text-neutral-500">Active posts appear on the Announcements page, even when the popup is disabled. Save your changes before viewing the post.</p>
          <Link href={`/dashboard/announcements/${slide.id}`} className="inline-block text-sm font-semibold text-brand-orange hover:underline">View saved announcement →</Link>
          <div className="flex items-center gap-3 text-sm"><label className="mr-auto flex items-center gap-2"><input type="checkbox" checked={slide.active} onChange={(e) => edit(slide.id, { active: e.target.checked })} />Active</label>
            <button type="button" aria-label={`Move promotion ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)} className="rounded border p-2 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
            <button type="button" aria-label={`Move promotion ${index + 1} down`} disabled={index === state.slides.length - 1} onClick={() => move(index, 1)} className="rounded border p-2 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
            <button type="button" aria-label={`Remove promotion ${index + 1}`} onClick={() => setState({ ...state, slides: state.slides.filter((item) => item.id !== slide.id) })} className="rounded border p-2 text-red-600"><Trash2 className="h-4 w-4" /></button>
          </div>
        </div>
      </div>)}
      {state.slides.length < 6 && <div className="rounded-xl border border-dashed border-navy-200 p-4 text-sm text-navy-700">
        <input ref={inputRef} type="file" aria-label="Add promotional image" accept="image/jpeg,image/png,image/webp" disabled={!configured} onChange={(event) => { void upload(event.target.files?.[0]); }} className="hidden" />
        <button type="button" disabled={!configured} onClick={() => { if (inputRef.current) { inputRef.current.value = ''; inputRef.current.click(); } }} className="flex items-center gap-3 rounded-lg px-2 py-1 font-semibold disabled:opacity-40"><ImagePlus className="h-5 w-5" />{busy ? 'Uploading image…' : 'Add promotional image'}</button>
        <p className="mt-2 text-xs text-neutral-500">Choose an image and wait for its preview to appear below your settings before saving.</p>
      </div>}
      {uploadStatus && <p role={uploadError ? 'alert' : 'status'} className={`rounded-lg p-3 text-sm ${uploadError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>{uploadStatus}</p>}
      {state.enabled && !hasActiveSlide && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Upload at least one image and keep it active before saving an enabled popup.</p>}
      <div className="flex gap-3"><button type="button" disabled={state.enabled && !hasActiveSlide} onClick={() => void save()} className="rounded-lg bg-brand-orange px-5 py-2.5 text-sm font-semibold text-black disabled:opacity-40">{busy ? 'Working…' : 'Save popup'}</button><button type="button" disabled={!hasActiveSlide} onClick={() => setPreview(true)} className="rounded-lg border px-5 py-2.5 text-sm font-semibold text-navy-950 disabled:opacity-40">Preview</button></div>
    </fieldset>
    {message && <p role="status" className="border-t px-5 py-3 text-sm text-navy-700">{message}</p>}
    <PromotionDialog autoCloseSeconds={state.autoCloseSeconds} key={preview ? 'open' : 'closed'} slides={state.slides.filter((slide) => slide.active)} open={preview} onOpenChange={setPreview} />
  </section>;
}
