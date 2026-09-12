"use client";

import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { useState } from "react";

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ImpExpAssignableUser } from "@/lib/impexp/types";

type AssignRole = "b2b" | "b2b_sub" | "customer";

function AgencyDetails({ user }: { user: ImpExpAssignableUser }) {
  if (user.role === "customer") return null;
  const agencyName = user.agencyName?.trim() || user.name;
  return (
    <span className="mt-0.5 block truncate text-xs font-medium text-navy-700">
      {agencyName}
      <span className="mx-1 text-neutral-300">•</span>
      Agency ID: {user.agencyId || "—"}
    </span>
  );
}

export default function ImpExpUserPicker({
  users,
  value,
  onValueChange,
  loading,
  role,
}: {
  users: ImpExpAssignableUser[];
  value: string;
  onValueChange: (userId: string) => void;
  loading: boolean;
  role: AssignRole;
}) {
  const [open, setOpen] = useState(false);
  const selected = users.find((user) => user.id === value);
  const isB2b = role === "b2b" || role === "b2b_sub";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label="Select booking owner"
          disabled={loading}
          className="flex min-h-10 w-full items-center justify-between gap-3 rounded-md border border-input bg-white px-3 py-2 text-left text-sm ring-offset-background outline-none transition hover:bg-neutral-50 focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <span className="flex items-center gap-2 text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading users…
            </span>
          ) : selected ? (
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-navy-950">
                {selected.name}
              </span>
              <AgencyDetails user={selected} />
              <span className="block truncate text-xs text-neutral-500">
                {selected.email}
              </span>
            </span>
          ) : (
            <span className="text-neutral-500">Select user</span>
          )}
          <ChevronsUpDown
            className="h-4 w-4 shrink-0 text-neutral-400"
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput
            placeholder={
              isB2b
                ? "Search person, agency name or agency ID…"
                : "Search person or email…"
            }
          />
          <CommandList className="max-h-80">
            <CommandEmpty>No matching user found.</CommandEmpty>
            {users.map((user) => (
              <CommandItem
                key={user.id}
                value={`${user.name} ${user.email} ${user.agencyName ?? ""} ${user.agencyId ?? ""} ${user.id}`}
                onSelect={() => {
                  onValueChange(user.id);
                  setOpen(false);
                }}
                className="items-start gap-2 px-3 py-2.5 data-[selected=true]:!bg-navy-50 data-[selected=true]:!text-navy-950"
              >
                <Check
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    value === user.id ? "opacity-100" : "opacity-0"
                  }`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-navy-950">
                    {user.name}
                  </span>
                  <AgencyDetails user={user} />
                  <span className="block break-all text-xs text-neutral-500">
                    {user.email}
                  </span>
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
