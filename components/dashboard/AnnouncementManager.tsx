'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react';

import { saveAnnouncementsAction } from '@/app/(dashboard)/dashboard/media/actions';
import AnnouncementBar from '@/components/layout/AnnouncementBar';
import {
  ANNOUNCEMENT_MESSAGE_LIMIT,
  ANNOUNCEMENT_MESSAGE_MAX_LENGTH,
  ANNOUNCEMENT_SCROLL_DURATION_MAX,
  ANNOUNCEMENT_SCROLL_DURATION_MIN,
  type AnnouncementMessage,
  type AnnouncementSliderState,
} from '@/lib/announcements';

type Props = {
  initialState: AnnouncementSliderState;
};

function copyMessages(messages: readonly AnnouncementMessage[]): AnnouncementMessage[] {
  return messages.map((message) => ({ ...message }));
}

function comparable(messages: readonly AnnouncementMessage[]) {
  return messages.map(({ id, text, active }) => ({ id, text, active }));
}

function formatSavedAt(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function speedLabel(durationSeconds: number) {
  if (durationSeconds <= 20) return 'Fast';
  if (durationSeconds <= 35) return 'Normal';
  if (durationSeconds <= 60) return 'Relaxed';
  return 'Slow';
}

export default function AnnouncementManager({ initialState }: Props) {
  const router = useRouter();
  const [savedVersion, setSavedVersion] = useState(initialState.version);
  const [baseline, setBaseline] = useState(() => copyMessages(initialState.messages));
  const [messages, setMessages] = useState(() => copyMessages(initialState.messages));
  const [savedDuration, setSavedDuration] = useState(
    initialState.scrollDurationSeconds
  );
  const [scrollDurationSeconds, setScrollDurationSeconds] = useState(
    initialState.scrollDurationSeconds
  );
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (initialState.version === savedVersion) return;
    setSavedVersion(initialState.version);
    setBaseline(copyMessages(initialState.messages));
    setMessages(copyMessages(initialState.messages));
    setSavedDuration(initialState.scrollDurationSeconds);
    setScrollDurationSeconds(initialState.scrollDurationSeconds);
    setPendingDeleteId(null);
  }, [initialState, savedVersion]);

  const activeMessages = useMemo(
    () => messages.filter((message) => message.active && message.text.trim()),
    [messages]
  );
  const dirty =
    JSON.stringify(comparable(messages)) !== JSON.stringify(comparable(baseline)) ||
    scrollDurationSeconds !== savedDuration;
  const unavailable = initialState.source !== 'database';
  const savedAt = formatSavedAt(initialState.updatedAt);

  function updateMessage(id: string, patch: Partial<AnnouncementMessage>) {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...patch } : message))
    );
    setNotice(null);
  }

  function move(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= messages.length) return;
    setMessages((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
    setPendingDeleteId(null);
    setNotice(null);
  }

  function addMessage() {
    if (messages.length >= ANNOUNCEMENT_MESSAGE_LIMIT) return;
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), text: '', active: true },
    ]);
    setPendingDeleteId(null);
    setNotice(null);
  }

  function removeMessage(id: string) {
    if (pendingDeleteId !== id) {
      setPendingDeleteId(id);
      return;
    }
    setMessages((current) => current.filter((message) => message.id !== id));
    setPendingDeleteId(null);
    setNotice(null);
  }

  function reset() {
    setMessages(copyMessages(baseline));
    setScrollDurationSeconds(savedDuration);
    setPendingDeleteId(null);
    setNotice(null);
  }

  function save() {
    const normalized = messages.map((message) => ({
      ...message,
      text: message.text.trim(),
    }));
    const invalid = normalized.find(
      (message) =>
        message.text.length === 0 ||
        message.text.length > ANNOUNCEMENT_MESSAGE_MAX_LENGTH
    );
    if (invalid) {
      setNotice({
        ok: false,
        message: `Every message must contain 1–${ANNOUNCEMENT_MESSAGE_MAX_LENGTH} characters.`,
      });
      return;
    }

    startTransition(async () => {
      const result = await saveAnnouncementsAction({
        expectedVersion: savedVersion,
        scrollDurationSeconds,
        messages: normalized,
      });
      setNotice(result);
      if (result.ok && result.version) {
        setMessages(copyMessages(normalized));
        setBaseline(copyMessages(normalized));
        setSavedVersion(result.version);
        setSavedDuration(scrollDurationSeconds);
        setPendingDeleteId(null);
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-navy-100 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-brand-orange/10 p-3 text-brand-orange">
            <ImageIcon className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold text-navy-950">Media &amp; Banners</h1>
            <p className="mt-1 text-sm text-navy-700">
              Manage the scrolling messages shown at the very top of the public website.
            </p>
            {savedAt ? (
              <p className="mt-1 text-xs text-navy-700/70">Last saved {savedAt}</p>
            ) : null}
          </div>
        </div>

        {unavailable ? (
          <div className="mt-5 flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>
              Managed announcements are not available until the latest database migration is
              applied. The public site is continuing to show its existing messages.
            </p>
          </div>
        ) : null}

        <div className="mt-6">
          <div className="mb-5 rounded-xl bg-navy-50 p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <label
                  htmlFor="announcement-speed"
                  className="text-sm font-semibold text-navy-950"
                >
                  Text slider speed
                </label>
                <p className="mt-0.5 text-xs text-navy-700/70">
                  Controls how quickly the messages travel across the top bar.
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-semibold text-navy-950 ring-1 ring-navy-100">
                {speedLabel(scrollDurationSeconds)} · {scrollDurationSeconds}s
              </span>
            </div>
            <input
              id="announcement-speed"
              type="range"
              min={ANNOUNCEMENT_SCROLL_DURATION_MIN}
              max={ANNOUNCEMENT_SCROLL_DURATION_MAX}
              value={
                ANNOUNCEMENT_SCROLL_DURATION_MIN +
                ANNOUNCEMENT_SCROLL_DURATION_MAX -
                scrollDurationSeconds
              }
              onChange={(event) => {
                setScrollDurationSeconds(
                  ANNOUNCEMENT_SCROLL_DURATION_MIN +
                    ANNOUNCEMENT_SCROLL_DURATION_MAX -
                    Number(event.target.value)
                );
                setNotice(null);
              }}
              disabled={unavailable || isPending}
              className="mt-4 w-full accent-brand-orange disabled:opacity-60"
            />
            <div className="mt-1 flex justify-between text-[11px] font-medium text-navy-700/70">
              <span>Slower</span>
              <span>Faster</span>
            </div>
          </div>

          <div className="mb-2 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-navy-950">Live preview</h2>
              <p className="mt-0.5 text-xs text-navy-700/70">
                This keeps the current public design and animation.
              </p>
            </div>
            <span className="text-xs font-medium text-navy-700">
              {activeMessages.length} active
            </span>
          </div>
          <div className="overflow-hidden rounded-lg border border-navy-100">
            {activeMessages.length ? (
              <AnnouncementBar
                key={`${scrollDurationSeconds}:${activeMessages
                  .map((message) => `${message.id}:${message.text}`)
                  .join('|')}`}
                messages={activeMessages.map((message) => message.text)}
                durationSeconds={scrollDurationSeconds}
              />
            ) : (
              <div className="bg-navy-50 px-4 py-5 text-center text-sm text-navy-700">
                The top announcement bar will be hidden when no messages are active.
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-navy-100 bg-white shadow-sm">
        <header className="flex flex-col gap-3 border-b border-navy-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-navy-950">Slider messages</h2>
            <p className="mt-0.5 text-xs text-navy-700/70">
              Reorder messages with the arrows. Inactive messages stay saved but are not shown.
            </p>
          </div>
          <button
            type="button"
            onClick={addMessage}
            disabled={unavailable || isPending || messages.length >= ANNOUNCEMENT_MESSAGE_LIMIT}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-navy-200 px-3 py-2 text-sm font-semibold text-navy-950 transition hover:bg-navy-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Add message
          </button>
        </header>

        <div className="space-y-3 p-5">
          {messages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-navy-200 px-4 py-10 text-center text-sm text-navy-700">
              No messages are saved. Add one, or save this empty list to hide the bar.
            </div>
          ) : null}

          {messages.map((message, index) => (
            <div
              key={message.id}
              className="rounded-xl border border-navy-100 bg-navy-50/40 p-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-xs font-bold text-navy-700 ring-1 ring-navy-100">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <label htmlFor={`announcement-${message.id}`} className="sr-only">
                    Announcement message {index + 1}
                  </label>
                  <input
                    id={`announcement-${message.id}`}
                    value={message.text}
                    maxLength={ANNOUNCEMENT_MESSAGE_MAX_LENGTH}
                    onChange={(event) =>
                      updateMessage(message.id, { text: event.target.value })
                    }
                    disabled={unavailable || isPending}
                    placeholder="Enter an announcement"
                    className="h-10 w-full rounded-lg border border-navy-200 bg-white px-3 text-sm text-navy-950 outline-none transition placeholder:text-navy-700/40 focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/10 disabled:opacity-60"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-navy-700">
                      <input
                        type="checkbox"
                        checked={message.active}
                        onChange={(event) =>
                          updateMessage(message.id, { active: event.target.checked })
                        }
                        disabled={unavailable || isPending}
                        className="h-4 w-4 accent-brand-orange"
                      />
                      Active
                    </label>
                    <span className="text-xs tabular-nums text-navy-700/60">
                      {message.text.length}/{ANNOUNCEMENT_MESSAGE_MAX_LENGTH}
                    </span>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={unavailable || isPending || index === 0}
                    aria-label={`Move message ${index + 1} up`}
                    className="rounded-lg border border-navy-200 bg-white p-2 text-navy-700 transition hover:bg-navy-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={unavailable || isPending || index === messages.length - 1}
                    aria-label={`Move message ${index + 1} down`}
                    className="rounded-lg border border-navy-200 bg-white p-2 text-navy-700 transition hover:bg-navy-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  {pendingDeleteId === message.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => removeMessage(message.id)}
                        disabled={unavailable || isPending}
                        className="rounded-lg bg-brand-orange px-3 py-2 text-xs font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:opacity-50"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteId(null)}
                        aria-label="Cancel deletion"
                        className="rounded-lg border border-navy-200 bg-white p-2 text-navy-700 transition hover:bg-navy-50"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => removeMessage(message.id)}
                      disabled={unavailable || isPending}
                      aria-label={`Delete message ${index + 1}`}
                      className="rounded-lg border border-navy-200 bg-white p-2 text-brand-orange transition hover:bg-brand-orange/5 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <footer className="flex flex-col gap-3 border-t border-navy-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-h-5 text-sm">
            {notice ? (
              <p
                className={`flex items-center gap-2 ${
                  notice.ok ? 'text-emerald-700' : 'text-brand-orange-dark'
                }`}
              >
                {notice.ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                )}
                {notice.message}
              </p>
            ) : dirty ? (
              <p className="text-navy-700">You have unsaved changes.</p>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={unavailable || isPending || !dirty}
              className="inline-flex items-center gap-2 rounded-lg border border-navy-200 px-4 py-2 text-sm font-semibold text-navy-950 transition hover:bg-navy-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" />
              Discard
            </button>
            <button
              type="button"
              onClick={save}
              disabled={unavailable || isPending || !dirty}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-orange px-4 py-2 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
