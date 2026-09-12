'use client';

import { useState } from 'react';
import {
  Plane,
  Compass,
  Tag,
  HelpCircle,
  Globe,
  ChevronDown,
  User,
} from 'lucide-react';

const navItems = [
  { icon: Plane,      label: 'Flights',     active: true },
  { icon: Compass,    label: 'Experiences' },
  { icon: Tag,        label: 'Deals' },
  { icon: HelpCircle, label: 'Support' },
];

interface Props {
  expanded: boolean;
}

export default function Sidebar({ expanded }: Props) {
  const [langOpen, setLangOpen] = useState(false);

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex flex-col bg-navy-900 text-white transition-all duration-300 ease-in-out ${
        expanded ? 'w-64' : 'w-16'
      }`}
    >
      {/* Logo */}
      <div className="flex h-16 items-center border-b border-white/10 px-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-orange">
          <Plane className="h-4 w-4 text-white" />
        </div>
        <div
          className={`ml-3 overflow-hidden transition-all duration-300 ${
            expanded ? 'w-auto opacity-100' : 'w-0 opacity-0'
          }`}
        >
          <p className="whitespace-nowrap text-base font-bold leading-none">SkyWays</p>
          <p className="whitespace-nowrap text-xs text-navy-200">Travel smarter</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 overflow-hidden py-4 px-2">
        {navItems.map(({ icon: Icon, label, active }) => (
          <a
            key={label}
            href="#"
            title={!expanded ? label : undefined}
            className={`group flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-colors ${
              active
                ? 'bg-white/10 text-white'
                : 'text-navy-200 hover:bg-white/5 hover:text-white'
            }`}
          >
            <Icon className="h-5 w-5 shrink-0" />
            <span
              className={`whitespace-nowrap overflow-hidden transition-all duration-300 ${
                expanded ? 'w-auto opacity-100' : 'w-0 opacity-0'
              }`}
            >
              {label}
            </span>
            {active && expanded && (
              <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-brand-orange" />
            )}
            {active && !expanded && (
              <span className="absolute left-12 h-2 w-2 rounded-full bg-brand-orange" />
            )}
          </a>
        ))}
      </nav>

      {/* Bottom */}
      <div className="space-y-2 border-t border-white/10 px-2 py-4">
        {/* Language */}
        <button
          onClick={() => expanded && setLangOpen((p) => !p)}
          title={!expanded ? 'English' : undefined}
          className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-navy-200 hover:bg-white/5 hover:text-white"
        >
          <Globe className="h-5 w-5 shrink-0" />
          <span
            className={`flex flex-1 items-center justify-between overflow-hidden whitespace-nowrap transition-all duration-300 ${
              expanded ? 'w-auto opacity-100' : 'w-0 opacity-0'
            }`}
          >
            English
            <ChevronDown className="h-4 w-4" />
          </span>
        </button>

        {/* Sign in */}
        <button
          title={!expanded ? 'Sign In' : undefined}
          className={`flex w-full items-center gap-3 rounded-lg bg-brand-orange px-2.5 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-brand-orange/90 ${
            expanded ? '' : 'justify-center'
          }`}
        >
          <User className="h-4 w-4 shrink-0" />
          <span
            className={`overflow-hidden whitespace-nowrap transition-all duration-300 ${
              expanded ? 'w-auto opacity-100' : 'w-0 opacity-0'
            }`}
          >
            Sign In
          </span>
        </button>
      </div>
    </aside>
  );
}
