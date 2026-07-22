import { NavLink } from "react-router-dom";
import type { ComponentType, SVGProps } from "react";
import {
  CalendarIcon,
  ChatIcon,
  ClockIcon,
  FolderIcon,
  PlanIcon,
} from "./icons";
import logoUrl from "../assets/logo.svg";
import { useMode } from "../lib/mode";

type NavItem = {
  to: string;
  label: string;
  shortLabel?: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const mybroItems: NavItem[] = [
  { to: "/chat", label: "Chat", Icon: ChatIcon },
  { to: "/kalender", label: "Kalender", Icon: CalendarIcon },
  { to: "/plan", label: "Plan", Icon: PlanIcon },
];

const smalltalkItems: NavItem[] = [
  { to: "/chat", label: "Chat", Icon: ChatIcon },
  {
    to: "/smalltalk/zuletzt",
    label: "Zuletzt verwendet",
    shortLabel: "Zuletzt",
    Icon: ClockIcon,
  },
  { to: "/smalltalk/projekte", label: "Projekte", Icon: FolderIcon },
];

type Props = {
  variant: "sidebar" | "bottom";
};

export default function Navigation({ variant }: Props) {
  const { mode } = useMode();
  const items = mode === "smalltalk" ? smalltalkItems : mybroItems;

  if (variant === "sidebar") {
    return (
      <aside className="hidden md:flex md:sticky md:top-0 md:h-dvh md:w-64 md:flex-col md:border-r md:border-border md:bg-bg-elevated">
        <div className="px-6 py-8">
          <img
            src={logoUrl}
            alt="MyBro"
            className="h-12 w-auto"
          />
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {items.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                [
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-surface text-accent"
                    : "text-text-muted hover:bg-surface hover:text-text",
                ].join(" ")
              }
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
    );
  }

  return (
    <nav
      className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-50 border-t border-border bg-bg-elevated/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      aria-label="Hauptnavigation"
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-around">
        {items.map(({ to, label, shortLabel, Icon }) => (
          <li key={to} className="flex-1">
            <NavLink
              to={to}
              className={({ isActive }) =>
                [
                  "flex min-h-14 flex-col items-center justify-center gap-1 py-2 text-xs transition-colors",
                  isActive ? "text-accent" : "text-text-muted",
                ].join(" ")
              }
            >
              <Icon className="h-6 w-6" aria-hidden="true" />
              <span>{shortLabel ?? label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
