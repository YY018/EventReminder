import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  Bell,
  CalendarPlus,
  Check,
  Clock3,
  FileImage,
  LoaderCircle,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  changePassword,
  createEvents,
  deleteEvent,
  downloadFile,
  getEvent,
  getEvents,
  getReminders,
  getTodayEvents,
  subscribePush,
  unsubscribePush,
  updateEvent,
  uploadImage,
} from "./api";
import { useAuth } from "./auth";
import {
  Alert,
  EmptyState,
  EventCard,
  FormField,
  PageTitle,
  PrimaryButton,
  SecondaryLink,
  TextInput,
} from "./components";
import { cacheEvents, getCachedEvents } from "./offline";
import {
  classifyEvents,
  displayDate,
  eventInputValue,
  localDateKey,
  localInputToUtc,
} from "./utils";
import type {
  EventDraft,
  EventPayload,
  EventRecord,
  NotificationChannel,
  ReminderRecord,
  User,
} from "./types";

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has expired. Please log in again.";
    if (error.status === 429) return "Too many requests. Please wait a moment and try again.";
    if (error.status === 422) return error.message || "Some details need attention.";
    return error.message;
  }
  return "We couldn’t complete that request. Please try again.";
}

function errorText(error: unknown): string {
  return messageFor(error);
}

function SectionHeading({
  title,
  count,
  action,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold tracking-tight">
        {title}
        {count !== undefined && (
          <span className="ml-2 text-sm font-medium text-slate-400">{count}</span>
        )}
      </h2>
      {action}
    </div>
  );
}

function EventList({
  items,
  timezone,
}: {
  items: EventRecord[];
  timezone: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((event) => (
        <Link
          key={event.id}
          to={`/events/${event.id}`}
          className="rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-teal-300 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-teal-800"
        >
          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            {displayDate(event.start_utc, timezone)}
          </p>
          <h3 className="mt-1 truncate font-semibold">{event.title}</h3>
          <p className="mt-1 truncate text-sm text-slate-600 dark:text-slate-400">
            {event.location || "Location not added"}
          </p>
          {event.status !== "upcoming" && (
            <p className="mt-2 text-xs font-semibold capitalize text-slate-500 dark:text-slate-400">{event.status}</p>
          )}
        </Link>
      ))}
    </div>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [recentReminders, setRecentReminders] = useState<ReminderRecord[]>([]);
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      if (!user) return;
      try {
        const now = new Date();
        const params = new URLSearchParams({ limit: "200" });
        if (query.trim()) params.set("q", query.trim());
        if (dateFrom) {
          params.set("from", localInputToUtc(`${dateFrom}T00:00`, user.timezone));
        }
        if (dateTo) {
          const nextDate = new Date(`${dateTo}T00:00:00Z`);
          nextDate.setUTCDate(nextDate.getUTCDate() + 1);
          const nextDateKey = nextDate.toISOString().slice(0, 10);
          const exclusiveEnd = localInputToUtc(`${nextDateKey}T00:00`, user.timezone);
          const endPriorMillisecond = new Date(new Date(exclusiveEnd).getTime() - 1).toISOString();
          params.set(
            "to",
            endPriorMillisecond.replace(
              /\.(\d{3})Z$/,
              (_, milliseconds: string) => `.${milliseconds}999Z`,
            ),
          );
        }
        let freshEvents: EventRecord[];
        let recentRemindersPromise: Promise<ReminderRecord[]> | undefined;
        if (query.trim() || dateFrom || dateTo) {
          freshEvents = await getEvents(params.toString());
        } else {
          const [todayEvents, upcomingEvents, recentPastEvents] = await Promise.all([
            getTodayEvents(),
            getEvents(new URLSearchParams({ from: now.toISOString(), limit: "200" }).toString()),
            getEvents(
              new URLSearchParams({
                from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
                to: now.toISOString(),
                limit: "200",
              }).toString(),
            ),
          ]);
          const eventsById = new Map(
            [...todayEvents, ...upcomingEvents, ...recentPastEvents].map((event) => [event.id, event]),
          );
          freshEvents = [...eventsById.values()].sort((a, b) => a.start_utc.localeCompare(b.start_utc));
          recentRemindersPromise = getReminders(
            new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          );
        }
        if (!active) return;
        setOffline(false);
        setEvents(freshEvents);
        await cacheEvents(user.id, freshEvents).catch(() => {
          console.warn("Offline event cache could not be updated.");
        });
        if (recentRemindersPromise) {
          try {
            const reminders = await recentRemindersPromise;
            if (active) {
              setRecentReminders(
                reminders.filter((reminder) => reminder.channel === "in_app" && reminder.sent_at),
              );
            }
          } catch {
            if (active) setError("Your events loaded, but in-app reminders could not be refreshed.");
          }
        }
      } catch (reason) {
        try {
          const cached = await getCachedEvents(user.id);
          if (!active) return;
          if (cached.length) {
            setEvents(cached);
            setOffline(true);
            setError("You’re offline. Showing events saved on this device.");
          } else {
            setError(messageFor(reason));
          }
        } catch {
          if (active) setError(messageFor(reason));
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => void load(), query || dateFrom || dateTo ? 250 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [user, query, dateFrom, dateTo]);

  const visibleEvents = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return events.filter((event) => {
      const eventDay = localDateKey(event.start_utc, user?.timezone ?? "UTC");
      const matchesTerm = !term || [event.title, event.location ?? "", event.notes ?? ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(term);
      return matchesTerm && (!dateFrom || eventDay >= dateFrom) && (!dateTo || eventDay <= dateTo);
    });
  }, [events, query, dateFrom, dateTo, user?.timezone]);
  const groups = user
    ? classifyEvents(visibleEvents, user.timezone)
    : { todayEvents: [], upcomingWeek: [], later: [], past: [] };
  const closeEvents = groups.todayEvents.filter((event) => {
    const startsIn = new Date(event.start_utc).getTime() - Date.now();
    return startsIn >= 0 && startsIn < 3 * 60 * 60 * 1000;
  });
  const pastEvents = [...groups.past]
    .filter((event) => event.status !== "cancelled")
    .sort((a, b) => b.start_utc.localeCompare(a.start_utc))
    .slice(0, 6);

  return (
    <>
      <PageTitle
        eyebrow={new Intl.DateTimeFormat(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
          timeZone: user?.timezone,
        }).format(new Date())}
        title={`Good ${new Date().getHours() < 12 ? "morning" : "day"}${user?.name ? `, ${user.name.split(" ")[0]}` : ""}.`}
        description="A clear view of what’s ahead, in your time zone."
        action={
          <div className="flex flex-wrap gap-2">
            <SecondaryLink to="/upload">
              <Upload size={16} aria-hidden="true" /> Read an image
            </SecondaryLink>
            <Link
              to="/events/new"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
            >
              <Plus size={16} aria-hidden="true" /> Add event
            </Link>
          </div>
        }
      />
      {error && <div className="mb-5"><Alert tone={offline ? "info" : "error"}>{error}</Alert></div>}
      {recentReminders.length > 0 && (
        <div className="mb-5 space-y-2" aria-label="Recent in-app reminders">
          {recentReminders.map((reminder) => (
            <Link
              key={reminder.id}
              to={`/events/${reminder.event_id}`}
              className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200 dark:hover:bg-amber-950"
            >
              <Bell size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span><strong>Reminder:</strong> {reminder.title} is coming up. {reminder.location ? `Location: ${reminder.location}` : ""}</span>
            </Link>
          ))}
        </div>
      )}
      <div className="mb-6 grid max-w-4xl gap-3 sm:grid-cols-[minmax(16rem,1fr)_minmax(9rem,0.5fr)_minmax(9rem,0.5fr)]">
        <label className="relative block">
          <span className="sr-only">Search events</span>
          <Search size={17} aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <TextInput className="pl-10" placeholder="Search title, location, or notes" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="space-y-1 text-xs font-medium text-slate-600 dark:text-slate-400">
          <span className="block">From date</span>
          <TextInput aria-label="Filter from date" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </label>
        <label className="space-y-1 text-xs font-medium text-slate-600 dark:text-slate-400">
          <span className="block">To date</span>
          <TextInput aria-label="Filter to date" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </label>
      </div>
      {dateFrom && dateTo && dateFrom > dateTo && (
        <div className="mb-5"><Alert tone="info">The start date is after the end date; no events match this range.</Alert></div>
      )}

      {loading ? (
        <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300" role="status">
          <LoaderCircle size={18} className="animate-spin text-teal-700" />
          Loading your events…
        </div>
      ) : (
        <div className="space-y-9">
          <section aria-labelledby="today-heading" className="rounded-3xl border border-teal-200 bg-teal-50/70 p-4 sm:p-6 dark:border-teal-950 dark:bg-teal-950/30">
            <SectionHeading
              title="Today"
              count={groups.todayEvents.length}
              action={<span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-teal-800 dark:bg-slate-900 dark:text-teal-200">Your local day</span>}
            />
            {closeEvents.length > 0 && (
              <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
                <Bell size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
                <p>
                  Coming up in under 3 hours:{" "}
                  <strong>{closeEvents.map((event) => event.title).join(", ")}</strong>
                </p>
              </div>
            )}
            {groups.todayEvents.length ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {groups.todayEvents.map((event) => (
                  <EventCard key={event.id} event={event} timezone={user?.timezone ?? "UTC"} highlight />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-teal-300 bg-white/70 px-4 py-7 text-center dark:border-teal-900 dark:bg-slate-900/60">
                <p className="font-medium">Nothing on the calendar today.</p>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Enjoy the breathing room, or add something you don’t want to forget.</p>
              </div>
            )}
          </section>

          <section>
            <SectionHeading title="Next 7 days" count={groups.upcomingWeek.length} />
            {groups.upcomingWeek.length ? (
              <EventList items={groups.upcomingWeek} timezone={user?.timezone ?? "UTC"} />
            ) : (
              <EmptyState title="A little space ahead">
                No upcoming events in the next week. <Link className="font-semibold text-teal-800 underline dark:text-teal-300" to="/events/new">Add one</Link> or <Link className="font-semibold text-teal-800 underline dark:text-teal-300" to="/upload">read an event image</Link>.
              </EmptyState>
            )}
          </section>

          {groups.later.length > 0 && (
            <section>
              <SectionHeading title="Coming later" count={groups.later.length} />
              <EventList items={groups.later} timezone={user?.timezone ?? "UTC"} />
            </section>
          )}

          {pastEvents.length > 0 && (
            <section>
              <SectionHeading title="Past events" count={groups.past.length} />
              <EventList items={pastEvents} timezone={user?.timezone ?? "UTC"} />
            </section>
          )}
        </div>
      )}
    </>
  );
}

type EventFormValues = {
  title: string;
  start: string;
  end: string;
  location: string;
  notes: string;
  leads: number[];
  channels: NotificationChannel[];
  status: EventRecord["status"];
};

function initialValues(user: User): EventFormValues {
  return {
    title: "",
    start: "",
    end: "",
    location: "",
    notes: "",
    leads: user.default_reminder_leads,
    channels: user.notification_channels as NotificationChannel[],
    status: "upcoming",
  };
}

export function EventEditorPage() {
  const { eventId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [values, setValues] = useState<EventFormValues | null>(null);
  const [loading, setLoading] = useState(Boolean(eventId));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loadedEvent, setLoadedEvent] = useState<EventRecord | null>(null);

  useEffect(() => {
    if (!user) return;
    if (!eventId) {
      setValues(initialValues(user));
      return;
    }
    let active = true;
    getEvent(eventId)
      .then((event) => {
        if (!active) return;
        setLoadedEvent(event);
        setValues({
          title: event.title,
          start: eventInputValue(event.start_utc, user.timezone),
          end: event.end_utc ? eventInputValue(event.end_utc, user.timezone) : "",
          location: event.location ?? "",
          notes: event.notes ?? "",
          leads: event.reminder_lead_minutes ?? user.default_reminder_leads,
          channels: (event.reminder_channels ?? user.notification_channels) as NotificationChannel[],
          status: event.status,
        });
      })
      .catch((reason) => setError(messageFor(reason)))
      .finally(() => setLoading(false));
    return () => {
      active = false;
    };
  }, [eventId, user]);

  function setField<K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) {
    setValues((current) => current ? { ...current, [key]: value } : current);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!values || !user) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const startAt = localInputToUtc(values.start, user.timezone);
      const endAt = values.end ? localInputToUtc(values.end, user.timezone) : null;
      if (endAt && new Date(endAt) <= new Date(startAt)) {
        throw new Error("The end time must be after the start time.");
      }
      const changes = {
        title: values.title.trim(),
        start_at: startAt,
        end_at: endAt,
        location: values.location.trim() || null,
        notes: values.notes.trim() || null,
        reminder_lead_minutes: values.leads,
        reminder_channels: values.channels,
        status: values.status,
      };
      if (eventId) {
        await updateEvent(eventId, changes);
        setMessage("Event updated.");
      } else {
        const [created] = await createEvents([{
          title: changes.title,
          start_at: changes.start_at,
          end_at: changes.end_at,
          location: changes.location,
          notes: changes.notes,
          reminder_lead_minutes: changes.reminder_lead_minutes,
          reminder_channels: changes.reminder_channels,
          source: "manual",
        }]);
        navigate(`/events/${created.id}`, { replace: true });
      }
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!eventId || !window.confirm("Delete this event and its reminders? This can’t be undone.")) return;
    setDeleting(true);
    setError("");
    try {
      await deleteEvent(eventId);
      navigate("/app", { replace: true });
    } catch (reason) {
      setError(messageFor(reason));
      setDeleting(false);
    }
  }
  function toggleLead(minutes: number) {
    if (!values) return;
    setField(
      "leads",
      values.leads.includes(minutes)
        ? values.leads.filter((lead) => lead !== minutes)
        : [...values.leads, minutes].sort((a, b) => b - a),
    );
  }
  function toggleChannel(channel: NotificationChannel) {
    if (!values) return;
    setField(
      "channels",
      values.channels.includes(channel)
        ? values.channels.filter((item) => item !== channel)
        : [...values.channels, channel],
    );
  }

  if (loading) {
    return <p role="status" className="py-12 text-center text-slate-500">Loading event…</p>;
  }
  if (!values) {
    return (
      <div className="mx-auto max-w-xl space-y-4 py-10">
        <Alert>{error || "This event could not be loaded."}</Alert>
        <SecondaryLink to="/app">Back to events</SecondaryLink>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle
        eyebrow={loadedEvent ? "Event details" : "Your calendar"}
        title={loadedEvent ? "Edit event" : "Add an event"}
        description={`Times are entered in ${user?.timezone ?? "your time zone"}.`}
      />
      <form className="space-y-6 rounded-3xl border border-slate-200 bg-white p-5 sm:p-7 dark:border-slate-800 dark:bg-slate-900" onSubmit={submit}>
        {error && <Alert>{error}</Alert>}
        {message && <Alert tone="success">{message}</Alert>}
        <FormField label="Event title">
          <TextInput value={values.title} onChange={(event) => setField("title", event.target.value)} maxLength={200} required autoFocus />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Starts">
            <TextInput type="datetime-local" value={values.start} onChange={(event) => setField("start", event.target.value)} required />
          </FormField>
          <FormField label="Ends (optional)">
            <TextInput type="datetime-local" value={values.end} onChange={(event) => setField("end", event.target.value)} />
          </FormField>
        </div>
        <FormField label="Location" hint="A venue, address, or video call link.">
          <TextInput value={values.location} onChange={(event) => setField("location", event.target.value)} maxLength={1000} />
        </FormField>
        <FormField label="Notes">
          <textarea
            className="min-h-28 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-slate-900 shadow-sm outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-600/10 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            value={values.notes}
            onChange={(event) => setField("notes", event.target.value)}
            maxLength={10000}
          />
        </FormField>
        <fieldset>
          <legend className="text-sm font-semibold">Remind me</legend>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Choose one or more lead times. Clear all to disable reminders.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[15, 60, 180, 1440].map((minutes) => (
              <label key={minutes} className={`cursor-pointer rounded-xl border px-3 py-2 text-sm ${values.leads.includes(minutes) ? "border-teal-600 bg-teal-50 text-teal-900 dark:bg-teal-950 dark:text-teal-200" : "border-slate-300 dark:border-slate-700"}`}>
                <input className="sr-only" type="checkbox" checked={values.leads.includes(minutes)} onChange={() => toggleLead(minutes)} />
                {minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${minutes / 60} hr` : "1 day"}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-semibold">Reminder channels</legend>
          <div className="mt-3 flex flex-wrap gap-3">
            {(["in_app", "email", "push"] as const).map((channel) => (
              <label key={channel} className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={values.channels.includes(channel)} onChange={() => toggleChannel(channel)} className="h-4 w-4 accent-teal-700" />
                {channel === "in_app" ? "In app" : channel === "email" ? "Email" : "Web push"}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Enable delivery channels in Settings before relying on them.</p>
        </fieldset>
        {eventId && (
          <FormField label="Status">
            <select className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 dark:border-slate-700 dark:bg-slate-900" value={values.status} onChange={(event) => setField("status", event.target.value as EventRecord["status"])}>
              <option value="upcoming">Upcoming</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </FormField>
        )}
        <div className="flex flex-col-reverse justify-between gap-3 border-t border-slate-100 pt-5 sm:flex-row dark:border-slate-800">
          {eventId ? (
            <button type="button" onClick={remove} disabled={deleting} className="inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-60 dark:text-rose-300 dark:hover:bg-rose-950/50">
              <Trash2 size={16} aria-hidden="true" /> {deleting ? "Deleting…" : "Delete event"}
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <SecondaryLink to="/app">Cancel</SecondaryLink>
            <PrimaryButton disabled={saving}>{saving ? "Saving…" : loadedEvent ? "Save changes" : "Save event"}</PrimaryButton>
          </div>
        </div>
      </form>
    </div>
  );
}

export function UploadPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [drafts, setDrafts] = useState<EventDraft[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDuplicates, setConfirmDuplicates] = useState(false);

  function updateDraft(index: number, patch: Partial<EventDraft>) {
    setDrafts((current) => current.map((draft, itemIndex) => itemIndex === index ? { ...draft, ...patch } : draft));
  }
  async function extract(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    setNotice("");
    setDrafts([]);
    try {
      const result = await uploadImage(file, keepOriginal);
      setDrafts(result.events);
      if (result.message) setNotice(result.message);
      if (result.manual_entry_suggested || result.events.length === 0) {
        if (result.retained_upload_id) {
          setNotice(`${result.message ?? "No events were found."} The sanitized image was retained privately as you requested.`);
        }
      } else {
        const foundMessage = `Found ${result.events.length} possible event${result.events.length === 1 ? "" : "s"}. Review every detail before saving.`;
        setNotice(
          result.retained_upload_id
            ? `${foundMessage} A sanitized copy is retained privately with your account.`
            : foundMessage,
        );
      }
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  }
  function buildPayload(draft: EventDraft): EventPayload {
    if (!user) throw new Error("Please log in again.");
    const start_at = localInputToUtc(`${draft.date}T${draft.time}`, user.timezone);
    const end_at = draft.end_time
      ? localInputToUtc(`${draft.date}T${draft.end_time}`, user.timezone)
      : null;
    if (end_at && new Date(end_at) <= new Date(start_at)) {
      throw new Error("The end time must be after the start time. Update or clear the end time.");
    }
    return {
      title: draft.title.trim(),
      start_at,
      end_at,
      location: draft.location?.trim() || null,
      notes: draft.notes?.trim() || null,
      source: "screenshot",
    };
  }
  async function saveDrafts(force = false) {
    setBusy(true);
    setError("");
    try {
      const saved = await createEvents(drafts.map(buildPayload), force);
      navigate(`/events/${saved[0]?.id ?? ""}`, { replace: true });
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "duplicate_events") {
        setConfirmDuplicates(true);
      } else {
        setError(messageFor(reason));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageTitle
        eyebrow="Image to event"
        title="Bring the details along."
        description="Choose a poster, ticket, email, or chat screenshot. Nothing is saved to your calendar until you review and confirm it."
      />
      <form onSubmit={extract} className="rounded-3xl border border-slate-200 bg-white p-5 sm:p-7 dark:border-slate-800 dark:bg-slate-900">
        {error && <div className="mb-4"><Alert>{error}</Alert></div>}
        {notice && <div className="mb-4"><Alert tone="info">{notice}</Alert></div>}
        <label className="flex min-h-52 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-center transition hover:border-teal-500 hover:bg-teal-50/50 dark:border-slate-700 dark:bg-slate-950 dark:hover:border-teal-800 dark:hover:bg-teal-950/20">
          <span className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-white text-teal-800 shadow-sm dark:bg-slate-900 dark:text-teal-300">
            <FileImage size={23} aria-hidden="true" />
          </span>
          <span className="font-semibold">{file ? file.name : "Choose an image to read"}</span>
          <span className="mt-1 text-sm text-slate-500 dark:text-slate-400">JPEG, PNG, or WebP · up to 5 MB</span>
          <input
            className="sr-only"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              setFile(selected);
              setDrafts([]);
              setNotice("");
              setError("");
            }}
          />
        </label>
        <label className="mt-5 flex items-start gap-3 rounded-xl bg-slate-50 p-3.5 text-sm dark:bg-slate-950">
          <input className="mt-0.5 h-4 w-4 accent-teal-700" type="checkbox" checked={keepOriginal} onChange={(event) => setKeepOriginal(event.target.checked)} />
          <span>
            <strong>Keep a private copy of this image.</strong>
            <span className="mt-1 block text-xs leading-5 text-slate-500 dark:text-slate-400">
              By default, the image is processed in memory and discarded. If selected, a sanitized copy is stored privately with your account and removed when you delete it.
            </span>
          </span>
        </label>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-lg text-xs leading-5 text-slate-500 dark:text-slate-400">
            For extraction, image content is sent from our backend to Anthropic’s Claude API. Text in the image is treated only as event data.
          </p>
          <PrimaryButton disabled={!file || busy}>
            {busy ? <><LoaderCircle size={16} className="animate-spin" /> Reading…</> : <><Upload size={16} /> Extract event details</>}
          </PrimaryButton>
        </div>
      </form>

      {drafts.length > 0 && (
        <section className="mt-8" aria-labelledby="review-events">
          <div className="mb-4">
            <h2 id="review-events" className="text-xl font-semibold">Review extracted events</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">AI extraction can be wrong. Check dates, times, and locations before saving.</p>
          </div>
          {confirmDuplicates && (
            <div className="mb-4 space-y-3">
              <Alert tone="info">One or more events look like duplicates in your calendar. Review them carefully before choosing to save anyway.</Alert>
              <PrimaryButton disabled={busy} onClick={() => void saveDrafts(true)}>Save anyway</PrimaryButton>
            </div>
          )}
          <div className="space-y-4">
            {drafts.map((draft, index) => (
              <article key={`${index}-${draft.title}`} className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <h3 className="font-semibold">Event {index + 1}</h3>
                  {draft.confidence < 0.75 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                      <AlertTriangle size={13} aria-hidden="true" /> Please double-check
                    </span>
                  )}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField label="Title">
                    <TextInput value={draft.title} maxLength={200} onChange={(event) => updateDraft(index, { title: event.target.value })} required />
                  </FormField>
                  <FormField label="Location">
                    <TextInput value={draft.location ?? ""} maxLength={1000} onChange={(event) => updateDraft(index, { location: event.target.value || null })} />
                  </FormField>
                  <FormField label="Date">
                    <TextInput type="date" value={draft.date} onChange={(event) => updateDraft(index, { date: event.target.value })} required />
                  </FormField>
                  <FormField label="Start time">
                    <TextInput type="time" value={draft.time} onChange={(event) => updateDraft(index, { time: event.target.value })} required />
                  </FormField>
                  <FormField label="End time (optional)">
                    <TextInput type="time" value={draft.end_time ?? ""} onChange={(event) => updateDraft(index, { end_time: event.target.value || null })} />
                  </FormField>
                  <FormField label="Notes">
                    <TextInput value={draft.notes ?? ""} maxLength={10000} onChange={(event) => updateDraft(index, { notes: event.target.value || null })} />
                  </FormField>
                </div>
                {draft.confidence < 0.75 && (
                  <p className="mt-3 text-xs text-amber-800 dark:text-amber-300">Extraction confidence: {Math.round(draft.confidence * 100)}%. Confirm these details against the original image.</p>
                )}
              </article>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-3">
            <SecondaryLink to="/events/new">Enter an event manually</SecondaryLink>
            <PrimaryButton onClick={() => void saveDrafts()} disabled={busy || drafts.some((draft) => !draft.title.trim() || !draft.date || !draft.time)}>
              <Check size={16} aria-hidden="true" /> {busy ? "Saving…" : `Confirm and save ${drafts.length} event${drafts.length === 1 ? "" : "s"}`}
            </PrimaryButton>
          </div>
        </section>
      )}
      {notice && drafts.length === 0 && (
        <p className="mt-5 text-center text-sm">
          <Link to="/events/new" className="font-semibold text-teal-800 underline dark:text-teal-300">Add event manually instead</Link>
        </p>
      )}
    </div>
  );
}

function decodeVapidKey(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = window.atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function ChannelCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-3.5 text-sm dark:border-slate-800">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-teal-700" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

export function SettingsPage() {
  const { user, saveUser, signOut, removeAccount } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState(user?.name ?? "");
  const [timezone, setTimezone] = useState(user?.timezone ?? "UTC");
  const [leads, setLeads] = useState<number[]>(user?.default_reminder_leads ?? [180, 60, 15]);
  const [channels, setChannels] = useState<NotificationChannel[]>(
    (user?.notification_channels as NotificationChannel[] | undefined) ?? ["in_app"],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  useEffect(() => {
    if (!user) return;
    setName(user.name);
    setTimezone(user.timezone);
    setLeads(user.default_reminder_leads);
    setChannels(user.notification_channels as NotificationChannel[]);
  }, [user]);

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveUser({
        name: name.trim(),
        timezone: timezone.trim(),
        default_reminder_leads: leads,
        notification_channels: channels,
      });
      setNotice("Your settings have been saved.");
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setSaving(false);
    }
  }
  async function savePassword(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      await signOut().catch(() => undefined);
      navigate("/login", {
        replace: true,
        state: { notice: "Password updated. Log in again with your new password." },
      });
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setSaving(false);
    }
  }
  function toggleNumber(value: number) {
    setLeads((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value].sort((a, b) => b - a));
  }
  function toggleChannel(value: NotificationChannel) {
    setChannels((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }
  async function enablePush() {
    setPushBusy(true);
    setError("");
    try {
      const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!vapidKey) throw new Error("Web push is not configured for this installation.");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("This browser does not support web push.");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted.");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(vapidKey) as BufferSource,
      });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
        await subscription.unsubscribe();
        throw new Error("The browser returned an incomplete push subscription.");
      }
      await subscribePush(json.endpoint, {
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      });
      if (!channels.includes("push")) {
        const updated: NotificationChannel[] = [...channels, "push"];
        setChannels(updated);
        await saveUser({ notification_channels: updated });
      }
      setNotice("Web push is enabled on this device.");
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setPushBusy(false);
    }
  }
  async function disablePush() {
    setPushBusy(true);
    setError("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await unsubscribePush(subscription.endpoint);
        await subscription.unsubscribe();
      }
      const updated = channels.filter((channel) => channel !== "push");
      setChannels(updated);
      await saveUser({ notification_channels: updated });
      setNotice("Web push is disabled on this device.");
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setPushBusy(false);
    }
  }
  async function deleteAccount() {
    if (deleteConfirm !== "DELETE") return;
    setSaving(true);
    setError("");
    try {
      await removeAccount();
      navigate("/", { replace: true });
    } catch (reason) {
      setError(messageFor(reason));
      setSaving(false);
    }
  }

  const [pushSupported, setPushSupported] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  useEffect(() => {
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    setPushSupported(supported);
    if (supported) {
      navigator.serviceWorker.ready
        .then((registration) => registration.pushManager.getSubscription())
        .then((subscription) => setPushSubscribed(Boolean(subscription)))
        .catch(() => setPushSubscribed(false));
    }
  }, []);

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle eyebrow="Your account" title="Settings" description="Manage your name, time zone, reminders, and account data." />
      {(error || notice) && <div className="mb-5">{error ? <Alert>{error}</Alert> : <Alert tone="success">{notice}</Alert>}</div>}
      <form onSubmit={saveSettings} className="space-y-6 rounded-3xl border border-slate-200 bg-white p-5 sm:p-7 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Profile and time zone</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Name">
            <TextInput value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </FormField>
          <FormField label="Email">
            <TextInput value={user?.email ?? ""} disabled />
          </FormField>
        </div>
        <FormField label="Time zone" hint="Use an IANA zone such as America/Los_Angeles. This determines your Today view and reminder times.">
          <TextInput value={timezone} onChange={(event) => setTimezone(event.target.value)} maxLength={64} required />
        </FormField>
        <fieldset>
          <legend className="text-sm font-semibold">Default reminder lead times</legend>
          <div className="mt-3 flex flex-wrap gap-2">
            {[15, 60, 180, 1440].map((minutes) => (
              <label key={minutes} className={`cursor-pointer rounded-xl border px-3 py-2 text-sm ${leads.includes(minutes) ? "border-teal-600 bg-teal-50 text-teal-900 dark:bg-teal-950 dark:text-teal-200" : "border-slate-300 dark:border-slate-700"}`}>
                <input className="sr-only" type="checkbox" checked={leads.includes(minutes)} onChange={() => toggleNumber(minutes)} />
                {minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${minutes / 60} hr` : "1 day"}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-semibold">Default notification channels</legend>
          <ChannelCheckbox label="In-app reminders" checked={channels.includes("in_app")} onChange={() => toggleChannel("in_app")} />
          <ChannelCheckbox label="Email reminders (requires SMTP configured by the administrator)" checked={channels.includes("email")} onChange={() => toggleChannel("email")} />
          <ChannelCheckbox label="Web push reminders" checked={channels.includes("push")} onChange={() => toggleChannel("push")} />
          {pushSupported && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <PrimaryButton type="button" onClick={pushSubscribed ? disablePush : enablePush} disabled={pushBusy}>
                <Bell size={16} aria-hidden="true" /> {pushBusy ? "Updating…" : pushSubscribed ? "Disable push on this device" : "Enable push on this device"}
              </PrimaryButton>
              {!import.meta.env.VITE_VAPID_PUBLIC_KEY && <span className="text-xs text-slate-500">Push provider setup is required.</span>}
            </div>
          )}
        </fieldset>
        <div className="flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
          <p className="text-xs text-slate-500">Signed in as {user?.email}</p>
          <PrimaryButton disabled={saving}>{saving ? "Saving…" : "Save profile settings"}</PrimaryButton>
        </div>
      </form>

      <form onSubmit={savePassword} className="mt-6 space-y-4 rounded-3xl border border-slate-200 bg-white p-5 sm:p-7 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Change password</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Current password"><TextInput type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></FormField>
          <FormField label="New password" hint="At least 10 characters; common passwords are rejected."><TextInput type="password" autoComplete="new-password" minLength={10} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></FormField>
        </div>
        <PrimaryButton disabled={saving || !currentPassword || !newPassword}>Update password</PrimaryButton>
      </form>

      <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 sm:p-7 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Your data</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Export your information or permanently delete your account and its events, reminders, and retained uploads.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <PrimaryButton type="button" onClick={() => void downloadFile("/export/ics", "my-events.ics").catch((reason) => setError(errorText(reason)))}>
            <CalendarPlus size={16} aria-hidden="true" /> Download calendar (.ics)
          </PrimaryButton>
          <SecondaryLink to="/privacy"><ShieldCheck size={16} aria-hidden="true" /> Privacy details</SecondaryLink>
          <button type="button" onClick={() => void downloadFile("/export/json", "event-reminder-data.json").catch((reason) => setError(errorText(reason)))} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">
            <ArrowDownToLine size={16} aria-hidden="true" /> Export all data (.json)
          </button>
        </div>
      </section>

      <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 sm:p-7 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Active sessions</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Sign out from every device, including this one.</p>
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Sign out of all devices? You will need to log in again.")) {
              void signOut(true).catch(() => undefined).finally(() => navigate("/login", { replace: true }));
            }
          }}
          className="mt-4 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Log out of all devices
        </button>
      </section>

      <section className="mt-6 rounded-3xl border border-rose-200 bg-rose-50/60 p-5 sm:p-7 dark:border-rose-950 dark:bg-rose-950/20">
        <h2 className="font-semibold text-rose-900 dark:text-rose-200">Delete account</h2>
        <p className="mt-1 text-sm text-rose-900/80 dark:text-rose-200/80">This permanently deletes your account and associated data. This action cannot be undone.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <TextInput aria-label='Type DELETE to confirm account deletion' placeholder="Type DELETE to confirm" value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} />
          <button type="button" disabled={deleteConfirm !== "DELETE" || saving} onClick={() => void deleteAccount()} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-rose-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-50">
            <Trash2 size={16} aria-hidden="true" /> Delete my account
          </button>
        </div>
      </section>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10 sm:px-6">
      <Link to="/app" className="inline-flex items-center gap-2 text-sm font-semibold text-teal-800 hover:underline dark:text-teal-300"><ArrowRight className="rotate-180" size={16} aria-hidden="true" /> Back to Event Reminder</Link>
      <p className="mt-8 text-xs font-bold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">Privacy</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Your events are yours.</h1>
      <div className="mt-6 space-y-5 text-sm leading-7 text-slate-700 dark:text-slate-300">
        <p>Event Reminder stores your account details, events, and reminder preferences to provide the service. Events are scoped to your account. You can export your data or permanently delete your account from Settings.</p>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">AI extraction</h2>
        <p>When you request extraction, the selected image is processed by the backend and sent to Anthropic’s Claude API along with your current local date and time zone so relative dates can be interpreted. Text in the image is treated as untrusted event data, not as instructions. By default, the image is not retained after processing. If you explicitly opt in, a sanitized copy is stored privately with your account and removed on account deletion.</p>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Device storage and notifications</h2>
        <p>The app stores a theme preference in browser storage and your profile metadata plus recently loaded events in this browser’s IndexedDB for offline display. No authentication tokens are stored there. Sign-out clears that account’s cached profile and events. Browser push notifications require your permission and a push subscription. Email delivery depends on the service operator’s mail configuration.</p>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Your choices</h2>
        <p>You may export events as an iCalendar file or download all account data as JSON. You can change notification settings, sign out of all devices, or delete your account from Settings. For privacy questions, contact the service operator.</p>
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">This starter policy describes current app behavior; the operator should replace it with a jurisdiction-specific policy, data-retention periods, and contact details before public launch.</p>
      </div>
      <Link to="/settings" className="mt-8 inline-flex items-center gap-2 font-semibold text-teal-800 hover:underline dark:text-teal-300">Manage your data <ArrowRight size={16} aria-hidden="true" /></Link>
    </main>
  );
}

export function LandingPage() {
  return (
    <main className="min-h-screen overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-4 py-5 sm:px-6 lg:px-8">
        <Link to="/" className="flex items-center gap-3 font-bold tracking-tight">
          <img src="/brand.svg" alt="" className="h-10 w-10 rounded-xl" />
          Event Reminder
        </Link>
        <div className="flex items-center gap-2">
          <Link to="/login" className="rounded-xl px-4 py-2 text-sm font-semibold hover:bg-slate-100 dark:hover:bg-slate-900">Log in</Link>
          <Link to="/signup" className="rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800">Create account</Link>
        </div>
      </header>
      <section className="mx-auto grid max-w-7xl items-center gap-12 px-4 pb-20 pt-10 sm:px-6 md:grid-cols-[1.05fr_0.95fr] md:py-24 lg:px-8">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-900 dark:border-teal-950 dark:bg-teal-950 dark:text-teal-200">
            <Clock3 size={14} aria-hidden="true" /> Your day, at a glance
          </p>
          <h1 className="mt-6 max-w-2xl text-5xl font-semibold leading-[1.06] tracking-tight sm:text-6xl">
            Keep the moments you care about <span className="text-teal-700 dark:text-teal-300">in sight.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600 dark:text-slate-400">
            Turn a poster, ticket, or message into a reminder. Review the details, save it privately, and know exactly how long until it begins.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/signup" className="inline-flex items-center gap-2 rounded-xl bg-teal-700 px-5 py-3 font-semibold text-white shadow-sm hover:bg-teal-800">Get started <ArrowRight size={17} aria-hidden="true" /></Link>
            <Link to="/privacy" className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-3 font-semibold hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"><ShieldCheck size={17} aria-hidden="true" /> Privacy first</Link>
          </div>
          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600 dark:text-slate-400">
            <li className="flex items-center gap-2"><Check size={15} className="text-teal-700" aria-hidden="true" /> Private account</li>
            <li className="flex items-center gap-2"><Check size={15} className="text-teal-700" aria-hidden="true" /> Your local time zone</li>
            <li className="flex items-center gap-2"><Check size={15} className="text-teal-700" aria-hidden="true" /> Edit before saving</li>
          </ul>
        </div>
        <div className="relative mx-auto w-full max-w-lg">
          <div className="absolute -inset-8 rounded-[3rem] bg-gradient-to-br from-teal-200/60 to-sky-100/20 blur-2xl dark:from-teal-950/70 dark:to-slate-900/20" aria-hidden="true" />
          <div className="relative rounded-[2rem] border border-slate-200 bg-white p-5 shadow-2xl shadow-slate-900/10 sm:p-7 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between">
              <div><p className="text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-300">Today · Friday</p><p className="mt-1 text-xl font-semibold">A day worth showing up for</p></div>
              <span className="grid h-11 w-11 place-items-center rounded-2xl bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-300"><Bell size={20} aria-hidden="true" /></span>
            </div>
            <div className="mt-6 rounded-2xl border border-teal-200 bg-teal-50/60 p-4 dark:border-teal-950 dark:bg-teal-950/40">
              <div className="flex items-start justify-between gap-3">
                <div><p className="text-xs font-semibold text-teal-800 dark:text-teal-300">5:30 PM · TONIGHT</p><h2 className="mt-2 text-lg font-semibold">Rooftop movie night</h2><p className="mt-1 text-sm text-slate-600 dark:text-slate-400">The Observatory · Downtown</p></div>
                <span className="rounded-xl bg-white px-3 py-2 text-right text-xs font-bold text-teal-900 dark:bg-slate-900 dark:text-teal-200">in 2 hrs<br />18 min</span>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800"><p className="text-xs text-slate-500">UP NEXT</p><p className="mt-2 font-semibold">Dentist check-up</p><p className="mt-1 text-xs text-slate-500">Tomorrow · 9:00 AM</p></div>
              <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800"><p className="text-xs text-slate-500">NEXT WEEK</p><p className="mt-2 font-semibold">Maya’s birthday</p><p className="mt-1 text-xs text-slate-500">Sat · 7:00 PM</p></div>
            </div>
            <div className="mt-4 flex items-center gap-3 rounded-2xl bg-slate-50 p-4 dark:bg-slate-950">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-white text-teal-800 dark:bg-slate-900 dark:text-teal-300"><Upload size={18} aria-hidden="true" /></span>
              <div><p className="text-sm font-semibold">Got an event poster?</p><p className="text-xs text-slate-500 dark:text-slate-400">Extract details, then review and confirm.</p></div>
            </div>
          </div>
        </div>
      </section>
      <footer className="border-t border-slate-200 px-4 py-5 text-center text-sm text-slate-500 dark:border-slate-800">
        <Link to="/privacy" className="hover:text-teal-700 dark:hover:text-teal-300">Privacy, AI data use, and your choices</Link>
      </footer>
    </main>
  );
}
