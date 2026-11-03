import type {
  EventPayload,
  EventRecord,
  EventUpdate,
  ExtractionResponse,
  ProfileUpdate,
  ReminderRecord,
  User,
} from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? "http://localhost:8000" : "/api")).replace(
  /\/$/,
  "",
);
let csrfToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type ErrorBody = {
  error?: {
    code?: string;
    message?: string;
    duplicates?: Array<{ event_id: string; title: string }>;
  };
};

async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  const response = await fetch(`${API_BASE}/auth/csrf`, {
    credentials: "include",
  });
  if (!response.ok) throw new ApiError(response.status, "csrf_unavailable", "Please try again.");
  const body = (await response.json()) as { csrf_token: string };
  csrfToken = body.csrf_token;
  return csrfToken;
}

function isMutation(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

async function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const token = await getCsrfToken();
        const response = await fetch(`${API_BASE}/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers: { "X-CSRF-Token": token },
        });
        if (!response.ok) csrfToken = null;
        return response.ok;
      } catch {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

async function parseError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => ({}))) as ErrorBody;
  return new ApiError(
    response.status,
    body.error?.code ?? "request_failed",
    body.error?.message ?? "The request could not be completed.",
    body.error?.duplicates,
  );
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (isMutation(method)) headers.set("X-CSRF-Token", await getCsrfToken());
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    method,
    headers,
    credentials: "include",
  });
  if (
    response.status === 401 &&
    retry &&
    !path.startsWith("/auth/") &&
    (await refreshSession())
  ) {
    return apiRequest<T>(path, init, false);
  }
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  if (response.headers.get("content-type")?.includes("application/json")) {
    return (await response.json()) as T;
  }
  return (await response.blob()) as T;
}

export function getCurrentUser(): Promise<User> {
  return apiRequest<User>("/me");
}

export async function login(email: string, password: string): Promise<User> {
  const response = await apiRequest<{ user: User }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return response.user;
}

export function signup(email: string, password: string, name: string) {
  return apiRequest<{ message: string }>("/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
}

export function logout() {
  return apiRequest<{ message: string }>("/auth/logout", { method: "POST" }).finally(() => {
    csrfToken = null;
  });
}

export function logoutAll() {
  return apiRequest<{ message: string }>("/auth/logout-all", { method: "POST" }).finally(() => {
    csrfToken = null;
  });
}

export function verifyEmail(token: string) {
  return apiRequest<{ message: string }>("/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function resendVerification(email: string) {
  return apiRequest<{ message: string }>("/auth/resend-verification", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function requestPasswordReset(email: string) {
  return apiRequest<{ message: string }>("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(token: string, new_password: string) {
  return apiRequest<{ message: string }>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, new_password }),
  }).finally(() => {
    csrfToken = null;
  });
}

export function changePassword(current_password: string, new_password: string) {
  return apiRequest<{ message: string }>("/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ current_password, new_password }),
  }).finally(() => {
    csrfToken = null;
  });
}

export function deleteAccount() {
  return apiRequest<void>("/me", { method: "DELETE" }).finally(() => {
    csrfToken = null;
  });
}

export function updateProfile(payload: ProfileUpdate) {
  return apiRequest<User>("/me", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function createEvents(events: EventPayload[], confirm_duplicates = false) {
  return apiRequest<EventRecord[]>("/events", {
    method: "POST",
    body: JSON.stringify({ events, confirm_duplicates }),
  });
}

export function getEvents(query = ""): Promise<EventRecord[]> {
  return apiRequest<EventRecord[]>(`/events${query ? `?${query}` : ""}`);
}

export function getTodayEvents(): Promise<EventRecord[]> {
  return apiRequest<EventRecord[]>("/events/today");
}

export function getEvent(eventId: string): Promise<EventRecord> {
  return apiRequest<EventRecord>(`/events/${encodeURIComponent(eventId)}`);
}

export function getReminders(after: string): Promise<ReminderRecord[]> {
  return apiRequest<ReminderRecord[]>(
    `/reminders?after=${encodeURIComponent(after)}&limit=100`,
  );
}

export function updateEvent(eventId: string, changes: EventUpdate): Promise<EventRecord> {
  return apiRequest<EventRecord>(`/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}

export function deleteEvent(eventId: string): Promise<void> {
  return apiRequest<void>(`/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
}

export function subscribePush(endpoint: string, keys: PushSubscriptionJSON["keys"]) {
  return apiRequest<{ message: string }>("/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint, keys }),
  });
}

export function unsubscribePush(endpoint: string) {
  return apiRequest<void>("/push/subscribe", {
    method: "DELETE",
    body: JSON.stringify({ endpoint }),
  });
}

export function uploadImage(file: File, keepOriginal: boolean) {
  const form = new FormData();
  form.append("file", file);
  form.append("keep_original", String(keepOriginal));
  return apiRequest<ExtractionResponse>("/events/extract", { method: "POST", body: form });
}

export async function downloadFile(
  path: string,
  filename: string,
  retry = true,
): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  if (response.status === 401 && retry && (await refreshSession())) {
    return downloadFile(path, filename, false);
  }
  if (!response.ok) throw await parseError(response);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
