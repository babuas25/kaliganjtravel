'use client';

import { BarChart3, Building2, WalletCards } from 'lucide-react';

import B2BIssuedTicketReport from '@/components/dashboard/reports/B2BIssuedTicketReport';
import WalletReportDashboard from '@/components/dashboard/wallet/WalletReportDashboard';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AgencyOption } from '@/lib/agency';

export default function AdminReportDashboard({ agencies }: { agencies: AgencyOption[] }) {
  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-5">
      <header className="rounded-2xl bg-brand-orange px-5 py-5 text-black shadow-sm sm:px-6">
        <div className="flex items-center gap-4">
          <span className="rounded-xl bg-white/10 p-3">
            <BarChart3 className="h-6 w-6" aria-hidden />
          </span>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-black">Reports</p>
            <h1 className="mt-1 text-2xl font-bold">Sales and finance</h1>
            <p className="mt-1 text-sm text-black">Review B2B performance and payment activity in one place.</p>
          </div>
        </div>
      </header>

      <Tabs defaultValue="b2b-sales">
        <TabsList className="grid h-auto w-full grid-cols-2 rounded-xl border border-neutral-200 bg-white p-1 shadow-sm sm:w-fit sm:min-w-[420px]">
          <TabsTrigger
            value="b2b-sales"
            className="gap-2 rounded-lg px-3 py-2.5 text-sm text-neutral-600 data-[state=active]:bg-brand-orange data-[state=active]:text-black"
          >
            <Building2 className="h-4 w-4" aria-hidden />
            B2B sales
          </TabsTrigger>
          <TabsTrigger
            value="finance"
            className="gap-2 rounded-lg px-3 py-2.5 text-sm text-neutral-600 data-[state=active]:bg-brand-orange data-[state=active]:text-black"
          >
            <WalletCards className="h-4 w-4" aria-hidden />
            Finance
          </TabsTrigger>
        </TabsList>

        <TabsContent value="b2b-sales" className="mt-5">
          <B2BIssuedTicketReport agencies={agencies} />
        </TabsContent>
        <TabsContent value="finance" className="mt-5">
          <WalletReportDashboard embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
}
