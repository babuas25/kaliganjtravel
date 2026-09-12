import { hiddenDashboardSegments } from '@/lib/dashboard/features';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { notFound } from 'next/navigation';

import Footer from '@/components/layout/Footer';
import Header from '@/components/layout/Header';
import { getSiteLogo } from '@/lib/appearance';
import {
  FOOTER_PAGE_BY_SLUG,
  FOOTER_PAGES,
  type FooterPageSection,
} from '@/lib/footer-pages';

type PageProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return FOOTER_PAGES.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = FOOTER_PAGE_BY_SLUG.get(slug);
  if (!page) return {};

  return {
    title: `${page.title} | Kaliganj Travels`,
    description: page.summary,
  };
}

function ContentSection({ section }: { section: FooterPageSection }) {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8">
      <h2 className="text-xl font-bold tracking-tight text-navy-950 sm:text-2xl">
        {section.title}
      </h2>

      {section.paragraphs?.length ? (
        <div className="mt-4 space-y-4 text-[15px] leading-7 text-neutral-700">
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      ) : null}

      {section.items?.length ? (
        <ul className="mt-5 grid gap-4 md:grid-cols-2">
          {section.items.map((item) => (
            <li
              key={`${item.label}-${item.text}`}
              className="flex items-start gap-3 rounded-xl bg-navy-50/70 p-4"
            >
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 h-5 w-5 shrink-0 text-brand-orange"
              />
              <div className="min-w-0">
                <h3 className="font-semibold text-navy-950">{item.label}</h3>
                <p className="mt-1 text-sm leading-6 text-neutral-700">
                  {item.text}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default async function FooterContentPage({ params }: PageProps) {
  const { slug } = await params;
  const page = FOOTER_PAGE_BY_SLUG.get(slug);
  if (!page) notFound();

  const logo = await getSiteLogo();

  return (
    <div className="min-h-screen bg-navy-50 text-navy-950">
      <Header logo={logo} hiddenNavSegments={hiddenDashboardSegments()} />
      <main>
        <header className="bg-gradient-to-br from-navy-950 via-navy-900 to-navy-700 text-white">
          <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-sm font-semibold text-navy-100 transition hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to home
            </Link>
            <h1 className="mt-7 max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
              {page.title}
            </h1>
            <p className="mt-5 max-w-3xl text-base leading-7 text-navy-100 sm:text-lg">
              {page.summary}
            </p>
          </div>
        </header>

        <div className="mx-auto max-w-5xl space-y-6 px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
          {page.sections.map((section) => (
            <ContentSection key={section.title} section={section} />
          ))}
        </div>
      </main>
      <Footer />
    </div>
  );
}
