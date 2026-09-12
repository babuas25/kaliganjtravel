"use client";

import {
  Clock3,
  FileInput,
  History,
  Loader2,
  RefreshCw,
  UserCheck,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import type { ImpExpHistoryItem, ImportProvider } from "@/lib/impexp/types";
import ManualBookingImportForm from "@/components/dashboard/impexp/ManualBookingImportForm";
import SupplierApiImportForm from "@/components/dashboard/impexp/SupplierApiImportForm";
import { BOOKING_STATUS_LABELS } from "@/lib/flights/booking-status";

const PROVIDER_LABELS: Record<ImportProvider, string> = {
  US_BANGLA: "US-Bangla",
  AIR_ASTRA: "Air Astra",
  NOVOAIR: "NOVOAIR",
};

function dateTimeParts(value: string): { date: string; time: string } | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  return {
    date: new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeZone: "Asia/Dhaka",
    }).format(date),
    time: new Intl.DateTimeFormat("en-GB", {
      timeStyle: "short",
      timeZone: "Asia/Dhaka",
    }).format(date),
  };
}

function formatDateTime(value: string): string {
  const formatted = dateTimeParts(value);
  return formatted ? `${formatted.date}, ${formatted.time}` : "—";
}

function providerLabel(value: string): string {
  if (value === "firsttrip") return "FirstTrip";
  if (value === "takeoff") return "TakeOff";
  if (value === "triplover") return "Triplover";
  return PROVIDER_LABELS[value as ImportProvider] ?? value.replace(/_/g, " ");
}

export default function ImpExpPage() {
  const [activeWorkflow, setActiveWorkflow] = useState<
    | "imported-history"
    | "supplier-api"
    | "manual-import"
  >("imported-history");
  const [history, setHistory] = useState<ImpExpHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await fetch("/api/impexp/history", {
        cache: "no-store",
      });
      const body = (await response.json()) as {
        history?: ImpExpHistoryItem[];
        error?: string;
      };
      if (!response.ok)
        throw new Error(body.error || "Import history could not be loaded.");
      setHistory(Array.isArray(body.history) ? body.history : []);
    } catch (error) {
      setHistory([]);
      setHistoryError(
        error instanceof Error
          ? error.message
          : "Import history could not be loaded.",
      );
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const summary = useMemo(() => {
    const totalValue = history.reduce(
      (sum, item) => sum + Number(item.userPayable || 0),
      0,
    );
    return {
      total: history.length,
      totalValue,
      latest: history[0]?.importedOn
        ? formatDateTime(history[0].importedOn)
        : "No imports yet",
    };
  }, [history]);

  return (
    <div className="mx-auto w-full max-w-[1116px] space-y-5">
      <section className="overflow-hidden rounded-lg bg-brand-orange text-black shadow-lg">
        <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-white/10">
              <FileInput className="h-6 w-6" aria-hidden />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-black">
                Export / Import (IMP/EXP)
              </p>
              <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
                Booking import
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-black">
                Retrieve a supplier booking or enter a verified manual booking,
                then assign its owner and add it to the booking workflow.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadHistory()}
            disabled={historyLoading}
            className="border-black/10 bg-white/10 text-black hover:bg-white/20 hover:text-black"
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${historyLoading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
        <div className="grid border-t border-black/10 sm:grid-cols-3">
          <Summary
            icon={History}
            label="Imported records"
            value={summary.total.toLocaleString()}
          />
          <Summary
            icon={UserCheck}
            label="Selected workflow"
            value={
              activeWorkflow === "imported-history"
                ? "Imported History"
                : activeWorkflow === "supplier-api"
                  ? "Supplier API"
                  : "Manual Import"
            }
          />
          <Summary icon={Clock3} label="Latest import" value={summary.latest} />
        </div>
      </section>

      <Tabs
        value={activeWorkflow}
        onValueChange={(value) =>
          setActiveWorkflow(
            value as
              | "imported-history"
              | "supplier-api"
              | "manual-import",
          )
        }
        className="space-y-4"
      >
        <div className="overflow-x-auto pb-1">
          <TabsList
            aria-label="Booking import workflow"
            className="h-auto min-w-max justify-start gap-1 rounded-lg border border-neutral-200 bg-white p-1 shadow-sm"
          >
            <TabsTrigger
              value="imported-history"
              className="gap-2 px-4 py-2 data-[state=active]:bg-brand-orange data-[state=active]:text-black"
            >
              <History className="h-4 w-4" aria-hidden />
              Imported History
            </TabsTrigger>
            <TabsTrigger
              value="supplier-api"
              className="gap-2 px-4 py-2 data-[state=active]:bg-brand-orange data-[state=active]:text-black"
            >
              <FileInput className="h-4 w-4" aria-hidden />
              Supplier API
            </TabsTrigger>
            <TabsTrigger
              value="manual-import"
              className="gap-2 px-4 py-2 data-[state=active]:bg-brand-orange data-[state=active]:text-black"
            >
              <FileInput className="h-4 w-4" aria-hidden />
              Manual Import
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="supplier-api"
          forceMount
          className="mt-0 data-[state=inactive]:hidden"
        >
          <SupplierApiImportForm onImported={loadHistory} />
        </TabsContent>

        <TabsContent
          value="manual-import"
          forceMount
          className="mt-0 data-[state=inactive]:hidden"
        >
          <ManualBookingImportForm onImported={loadHistory} />
        </TabsContent>

        <TabsContent
          value="imported-history"
          forceMount
          className="mt-0 data-[state=inactive]:hidden"
        >
      <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
        <div className="flex flex-col gap-1 border-b border-neutral-200 px-5 py-4 sm:px-6">
          <h2 className="text-lg font-bold text-navy-950">Imported history</h2>
          <p className="text-sm text-neutral-500">
            Total imported User Payable {history[0]?.currency || "BDT"}{" "}
            {summary.totalValue.toLocaleString()}
          </p>
        </div>
        <div className="hidden grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,0.85fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,0.95fr)] gap-3 bg-navy-50 px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wide text-neutral-500 lg:grid">
          <span>Imported</span>
          <span>Reference</span>
          <span>Provider / source</span>
          <span>Status / payment</span>
          <span>Passenger / assigned</span>
          <span className="text-right">Amounts</span>
        </div>
        {historyLoading ? (
          <div className="px-4 py-12 text-center text-neutral-500">
            <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
            Loading history…
          </div>
        ) : historyError ? (
          <div role="alert" className="px-4 py-12 text-center text-red-600">
            {historyError}
          </div>
        ) : history.length === 0 ? (
          <div className="px-4 py-12 text-center text-neutral-500">
            No imported bookings found.
          </div>
        ) : (
          <div className="divide-y divide-neutral-100">
            {history.map((row) => {
              const importedAt = dateTimeParts(row.importedOn);

              return (
                <article
                  key={row.id}
                  className="grid gap-x-3 gap-y-4 px-4 py-4 transition-colors hover:bg-neutral-50 sm:grid-cols-2 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,0.85fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,0.95fr)] lg:items-start"
                >
                  <div className="min-w-0 text-sm text-neutral-600">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 lg:hidden">
                      Imported
                    </p>
                    <p className="whitespace-nowrap">{importedAt?.date ?? "—"}{importedAt ? "," : ""}</p>
                    {importedAt && (
                      <p className="text-xs text-neutral-500">{importedAt.time}</p>
                    )}
                  </div>

                  <div className="min-w-0">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 lg:hidden">
                      Reference
                    </p>
                    <Link
                      href={`/dashboard/bookings/${encodeURIComponent(row.referenceNo)}`}
                      className="block break-all text-sm font-semibold text-navy-950 hover:text-brand-orange"
                    >
                      {row.referenceNo}
                    </Link>
                    <p className="break-all text-xs text-neutral-500">
                      {row.supplierReference}
                    </p>
                  </div>

                  <div className="min-w-0">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 lg:hidden">
                      Provider / source
                    </p>
                    <p className="break-words text-sm font-medium text-navy-950">
                      {providerLabel(row.provider)}
                    </p>
                    <p className="mt-0.5 text-xs font-semibold text-neutral-500">
                      {row.source === "MANUAL"
                        ? "Manual"
                        : row.source === "SUPPLIER_API"
                          ? "Supplier API"
                          : "Supplier"}
                    </p>
                  </div>

                  <div className="min-w-0">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 lg:hidden">
                      Status / payment
                    </p>
                    <span className="inline-flex rounded-full bg-navy-50 px-2 py-1 text-xs font-semibold text-navy-800">
                      {BOOKING_STATUS_LABELS[row.status]}
                    </span>
                    <p className="mt-1 break-words text-xs capitalize text-neutral-500">
                      {row.paymentState.replace(/-/g, " ")}
                    </p>
                  </div>

                  <div className="min-w-0">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 lg:hidden">
                      Passenger / assigned
                    </p>
                    <p className="break-words text-sm text-neutral-700">{row.paxName}</p>
                    <p className="mt-1 break-all text-xs text-neutral-500">
                      {row.assigned}
                    </p>
                  </div>

                  <div className="min-w-0 lg:text-right">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 lg:hidden">
                      Amounts
                    </p>
                    <p className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                      Supplier gross
                    </p>
                    <p className="whitespace-nowrap text-sm font-semibold text-navy-950">
                      {row.currency} {Number(row.supplierGross || 0).toLocaleString()}
                    </p>
                    <p className="mt-1 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                      User payable
                    </p>
                    <p className="whitespace-nowrap text-sm font-semibold text-brand-orange">
                      {row.currency} {Number(row.userPayable || 0).toLocaleString()}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Summary({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof History;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-black/10 px-6 py-4 first:border-t-0 sm:border-l sm:border-t-0 sm:first:border-l-0">
      <Icon className="h-4 w-4 shrink-0 text-black" aria-hidden />
      <div className="min-w-0">
        <p className="text-xs text-black">{label}</p>
        <p className="truncate text-sm font-bold">{value}</p>
      </div>
    </div>
  );
}
