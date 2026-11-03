export type User = {
  id: string;
  email: string;
  name: string;
  email_verified: boolean;
  timezone: string;
  default_reminder_leads: number[];
  notification_channels: NotificationChannel[];
};

export type NotificationChannel = "in_app" | "email" | "push";

export type ProfileUpdate = Pick<
  Partial<User>,
  "name" | "timezone" | "default_reminder_leads" | "notification_channels"
>;

export type EventRecord = {
  id: string;
  title: string;
  start_utc: string;
  end_utc: string | null;
  location: string | null;
  notes: string | null;
  source: "manual" | "screenshot";
  status: "upcoming" | "done" | "cancelled";
  reminder_lead_minutes: number[] | null;
  reminder_channels: NotificationChannel[] | null;
  created_at: string;
  updated_at: string;
};

export type EventDraft = {
  title: string;
  date: string;
  time: string;
  end_time: string | null;
  location: string | null;
  confidence: number;
  notes: string | null;
};

export type ReminderRecord = {
  id: string;
  event_id: string;
  title: string;
  start_utc: string;
  location: string | null;
  remind_at_utc: string;
  channel: NotificationChannel;
  sent_at: string | null;
};

export type ExtractionResponse = {
  events: EventDraft[];
  manual_entry_suggested: boolean;
  message: string | null;
  retained_upload_id: string | null;
};

export type EventPayload = {
  title: string;
  start_at: string;
  end_at?: string | null;
  location?: string | null;
  notes?: string | null;
  source?: "manual" | "screenshot";
  reminder_lead_minutes?: number[] | null;
  reminder_channels?: NotificationChannel[] | null;
};

export type EventUpdate = Partial<
  Pick<
    EventRecord,
    | "title"
    | "location"
    | "notes"
    | "status"
    | "reminder_lead_minutes"
    | "reminder_channels"
  >
> & {
  start_at?: string;
  end_at?: string | null;
};
