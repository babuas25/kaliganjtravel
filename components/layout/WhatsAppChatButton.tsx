import { SITE_WHATSAPP_HREF } from '@/lib/site';

export default function WhatsAppChatButton() {
  return (
    <a
      href={SITE_WHATSAPP_HREF}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat on WhatsApp at 01795-271171"
      title="Chat on WhatsApp"
      className="fixed bottom-5 right-5 z-40 grid h-14 w-14 place-items-center rounded-full bg-[#25D366] text-white shadow-lg ring-1 ring-black/5 transition duration-200 hover:scale-105 hover:bg-[#20bd5a] hover:shadow-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#25D366]/30 sm:bottom-6 sm:right-6"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-7 w-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3a9 9 0 0 0-7.7 13.67L3 21l4.46-1.2A9 9 0 1 0 12 3Z" />
        <path d="M8.35 7.75c.28-.3.72-.24.94.1l1.02 1.55c.18.28.15.63-.08.86l-.7.7a8.25 8.25 0 0 0 3.55 3.55l.7-.7c.23-.23.58-.26.86-.08l1.55 1.02c.34.22.4.66.1.94l-.76.72c-.52.5-1.28.68-1.97.47-3.3-1-5.92-3.62-6.92-6.92-.21-.69-.03-1.45.47-1.97l.72-.76Z" />
      </svg>
    </a>
  );
}
