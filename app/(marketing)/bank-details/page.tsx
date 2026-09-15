import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, Landmark, Mail, Phone } from 'lucide-react';

import Footer from '@/components/layout/Footer';
import Header from '@/components/layout/Header';
import { getSiteLogo } from '@/lib/appearance';
import { hiddenDashboardSegments } from '@/lib/dashboard/features';
import { SITE_EMAIL, SITE_PHONE, SITE_PHONE_HREF } from '@/lib/site';
import type { CompanyBankAccountOption } from '@/lib/wallet/payment-options';
import { listPublicCompanyBankAccounts } from '@/lib/wallet/payment-options.server';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Bank Details | Kaliganj Travels',
  description: 'Bank account details for Kaliganj Tour and Travel, including account numbers, branches, routing numbers and SWIFT codes.',
};

function BankAccountCard({ account }: { account: CompanyBankAccountOption }) {
  const details = [
    ['Branch', account.branchName],
    ['Branch code', account.branchCode],
    ['Routing number', account.routingNumber],
    ['SWIFT code', account.swiftCode],
  ].filter(([, value]) => value);

  return (
    <article className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex items-center gap-4 border-b border-neutral-100 px-6 py-5">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-orange-100 bg-orange-50 p-2.5">
          {account.logoUrl ? (
            <Image src={account.logoUrl} alt={`${account.bankName} logo`} width={40} height={40} className="h-full w-full object-contain" />
          ) : (
            <Landmark className="h-6 w-6 text-brand-orange-dark" aria-hidden="true" />
          )}
        </div>
        <h2 className="min-w-0 break-words text-lg font-bold leading-6 text-navy-950">{account.bankName}</h2>
      </div>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-5 p-6">
        <div className="col-span-2">
          <dt className="text-xs font-medium text-neutral-500">Account name</dt>
          <dd className="mt-1 break-words text-sm font-semibold text-navy-950">{account.accountName}</dd>
        </div>
        <div className="col-span-2 rounded-xl border border-orange-100 bg-orange-50 px-4 py-3">
          <dt className="text-xs font-medium text-neutral-600">Account number</dt>
          <dd className="mt-1 select-all break-all font-mono text-xl font-semibold tracking-wide text-navy-950">{account.accountNumber}</dd>
        </div>
        {details.map(([label, value]) => (
          <div key={label} className={label === 'Branch' ? 'col-span-2' : 'min-w-0'}>
            <dt className="text-xs font-medium text-neutral-500">{label}</dt>
            <dd className="mt-1 select-all break-words text-sm font-semibold text-navy-950">{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

export default async function BankDetailsPage() {
  const [logo, accounts] = await Promise.all([getSiteLogo(), listPublicCompanyBankAccounts()]);

  return (
    <div className="min-h-screen bg-neutral-50 text-navy-950">
      <Header logo={logo} hiddenNavSegments={hiddenDashboardSegments()} />
      <main>
        <header className="border-b border-orange-100 bg-gradient-to-br from-orange-50 via-white to-white">
          <div className="mx-auto max-w-6xl px-6 py-10 sm:py-14">
            <Link href="/" className="inline-flex items-center gap-2 text-sm font-semibold text-neutral-600 transition hover:text-brand-orange-dark">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to home
            </Link>
            <p className="mt-8 text-xs font-bold uppercase tracking-[0.16em] text-brand-orange-dark">Kaliganj Tour and Travel</p>
            <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">Bank Details</h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-neutral-600">
              Find our bank account details below for payments to Kaliganj Tour and Travel.
            </p>
          </div>
        </header>

        <div className="mx-auto max-w-6xl space-y-8 px-6 py-10 sm:py-12">
          {accounts.length > 0 ? (
            <div className="grid items-start gap-6 md:grid-cols-2 lg:grid-cols-3">
              {accounts.map((account) => <BankAccountCard key={account.id} account={account} />)}
            </div>
          ) : (
            <section className="rounded-2xl border border-neutral-200 bg-white p-8 text-center">
              <Landmark className="mx-auto h-8 w-8 text-brand-orange-dark" aria-hidden="true" />
              <h2 className="mt-4 text-lg font-bold">Bank details are currently unavailable</h2>
              <p className="mt-2 text-sm text-neutral-600">Please contact our team for payment assistance.</p>
            </section>
          )}

          <section className="flex flex-col gap-5 rounded-2xl border border-orange-200 bg-orange-50 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-bold">Need help with a payment?</h2>
              <p className="mt-1 text-sm leading-6 text-neutral-600">Contact our team with your booking reference.</p>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm font-semibold">
                <a href={SITE_PHONE_HREF} className="inline-flex items-center gap-2 hover:text-brand-orange-dark"><Phone className="h-4 w-4 shrink-0" aria-hidden="true" />{SITE_PHONE}</a>
                <a href={`mailto:${SITE_EMAIL}`} className="inline-flex min-w-0 items-center gap-2 hover:text-brand-orange-dark"><Mail className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="break-all">{SITE_EMAIL}</span></a>
              </div>
            </div>
            <Link href="/contact-us" className="inline-flex shrink-0 items-center justify-center gap-2 self-start rounded-lg bg-brand-orange px-5 py-3 text-sm font-bold text-black transition hover:bg-brand-orange-dark sm:self-auto">
              Contact us <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}
