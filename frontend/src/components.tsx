import { useEffect, useState } from "react";
import {
  ArrowRight,
  Bell,
  CalendarDays,
  CircleUserRound,
  Home,
  LogOut,
  Moon,
  Settings,
  Sun,
  Upload,
} from "lucide-react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "./auth";
import { countdown, displayDate } from "./utils";
import type { EventRecord } from "./types";

const navigation = [
  { to: "/app", label: "Overview", icon: Home, end: true },
  { to: "/upload", label: "Read a poster", icon: Upload },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell() {
  const { user, darkMode, toggleTheme, signOut, offline } = useAuth();
  const navigate = useNavigate();
  async function handleSignOut() {
    await signOut().catch(() => undefined);
    navigate("/", { replace: true });
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-5 px-4 py-3 sm:px-6 lg:px-8">
          <Link to="/app" className="flex shrink-0 items-center gap-3 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-600">
            <img src="/brand.svg" alt="" className="h-10 w-10 rounded-xl" />
            <span className="text-base font-bold tracking-tight">Event Reminder</span>
          </Link>
          <nav aria-label="Main navigation" className="hidden items-center gap-1 md:flex">
            {navigation.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition ${
                    isActive
                      ? "bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200"
                      : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900"
                  }`
                }
              >
                <Icon size={16} aria-hidden="true" />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleTheme}
              className="rounded-xl p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-teal-600 dark:text-slate-300 dark:hover:bg-slate-900"
              aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            >
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <Link
              to="/settings"
              className="hidden items-center gap-2 rounded-xl py-1.5 pl-2 pr-3 text-sm text-slate-600 hover:bg-slate-100 md:flex dark:text-slate-300 dark:hover:bg-slate-900"
              aria-label={`Settings for ${user?.name || user?.email}`}
            >
              <CircleUserRound size={18} aria-hidden="true" />
              <span className="max-w-36 truncate">{user?.name || user?.email}</span>
            </Link>
            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-xl p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-teal-600 dark:text-slate-300 dark:hover:bg-slate-900"
              aria-label="Log out"
              title="Log out"
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
        <nav aria-label="Mobile navigation" className="flex gap-2 overflow-x-auto border-t border-slate-100 px-4 py-2 md:hidden dark:border-slate-800">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold ${
                  isActive
                    ? "bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200"
                    : "text-slate-600 dark:text-slate-300"
                }`
              }
            >
              <Icon size={15} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="mx-auto min-h-[calc(100vh-150px)] max-w-7xl px-4 py-7 sm:px-6 sm:py-10 lg:px-8">
        {offline && (
          <div className="mb-5 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-200" role="status">
            Offline mode: cached events are available for viewing on this device.
          </div>
        )}
        <Outlet />
      </main>
      <footer className="border-t border-slate-200 bg-white px-4 py-5 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p>Made for the dates you don’t want to miss.</p>
          <Link to="/privacy" className="inline-flex items-center gap-1 hover:text-teal-700 dark:hover:text-teal-300">
            Privacy and AI data use <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </footer>
    </div>
  );
}

export function PageTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow && <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">{eyebrow}</p>}
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-400">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function EventCard({ event, timezone, highlight = false }: { event: EventRecord; timezone: string; highlight?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const delta = new Date(event.start_utc).getTime() - now;
  const endTime = event.end_utc ? new Date(event.end_utc).getTime() : null;
  const statusLabel =
    event.status !== "upcoming"
      ? event.status
      : delta > 0
        ? countdown(event.start_utc, now)
        : endTime !== null && endTime > now
          ? "In progress"
          : "Started";
  return (
    <Link
      to={`/events/${event.id}`}
      className={`group block rounded-2xl border p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 sm:p-5 ${
        highlight
          ? "border-teal-200 bg-white dark:border-teal-900 dark:bg-slate-900"
          : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <CalendarDays size={13} aria-hidden="true" />
              {displayDate(event.start_utc, timezone)}
            </span>
            {event.source === "screenshot" && (
              <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                From image
              </span>
            )}
          </div>
          <h3 className="truncate text-lg font-semibold tracking-tight group-hover:text-teal-800 dark:group-hover:text-teal-300">{event.title}</h3>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
            <Bell size={14} aria-hidden="true" />
            {event.location || "Location not added"}
          </p>
          {event.status !== "upcoming" && (
            <p className="mt-2 text-xs font-semibold capitalize text-slate-500 dark:text-slate-400">
              {event.status}
            </p>
          )}
        </div>
        <div className="shrink-0 rounded-xl bg-teal-50 px-3 py-2 text-right dark:bg-teal-950/70">
          <p className="text-xs font-medium text-teal-800 dark:text-teal-200">
            {highlight ? statusLabel : event.status}
          </p>
          <p className="mt-1 text-xs text-teal-700/80 dark:text-teal-300/80">
            {event.end_utc ? "Has an end time" : "Starts soon"}
          </p>
        </div>
      </div>
    </Link>
  );
}

export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-5 py-10 text-center dark:border-slate-700 dark:bg-slate-900/50">
      <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300">
        <CalendarDays size={22} aria-hidden="true" />
      </div>
      <h3 className="font-semibold">{title}</h3>
      <div className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600 dark:text-slate-400">{children}</div>
    </div>
  );
}

export function Alert({ children, tone = "error" }: { children: React.ReactNode; tone?: "error" | "success" | "info" }) {
  const styles = {
    error: "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200",
    info: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-200",
  };
  return <div role={tone === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 text-sm ${styles[tone]}`}>{children}</div>;
}

export function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
      {hint && <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">{hint}</span>}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-teal-600 focus:ring-4 focus:ring-teal-600/10 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 ${props.className ?? ""}`}
    />
  );
}

export function PrimaryButton({
  children,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-teal-600 dark:hover:bg-teal-500 ${className}`}
    >
      {children}
    </button>
  );
}

export function SecondaryLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">
      {children}
    </Link>
  );
}
