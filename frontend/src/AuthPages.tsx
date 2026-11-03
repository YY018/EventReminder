import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, CalendarCheck2, Eye, EyeOff } from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, requestPasswordReset, resetPassword, resendVerification, signup, verifyEmail } from "./api";
import { useAuth } from "./auth";
import { Alert, FormField, PrimaryButton, TextInput } from "./components";

function AuthFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-teal-700 dark:text-slate-300 dark:hover:text-teal-300">
          <ArrowLeft size={16} aria-hidden="true" />
          Event Reminder
        </Link>
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/5 sm:p-8 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-300">
            <CalendarCheck2 size={24} aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </section>
      </div>
    </main>
  );
}

function PasswordInput({ label = "Password", ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <FormField label={label}>
      <div className="relative">
        <TextInput {...props} type={visible ? "text" : "password"} className="pr-11" />
        <button
          type="button"
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? "Hide password" : "Show password"}
          className="absolute inset-y-0 right-0 grid w-11 place-items-center text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </div>
    </FormField>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Email or password is incorrect.";
    if (error.status === 429) return "Too many attempts. Please wait a little before trying again.";
    if (error.status === 422) return "Check the details and try again.";
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signIn(email, password);
      navigate("/app", { replace: true });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title="Welcome back" subtitle="Log in to see what’s coming up.">
      <form className="space-y-4" onSubmit={submit}>
        {location.state?.notice && <Alert tone="success">{location.state.notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <FormField label="Email">
          <TextInput
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </FormField>
        <PasswordInput
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <div className="text-right">
          <Link className="text-sm font-semibold text-teal-800 hover:underline dark:text-teal-300" to="/forgot-password">
            Forgot password?
          </Link>
        </div>
        <PrimaryButton className="w-full" disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
          {!busy && <ArrowRight size={16} aria-hidden="true" />}
        </PrimaryButton>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600 dark:text-slate-400">
        New here? <Link to="/signup" className="font-semibold text-teal-800 hover:underline dark:text-teal-300">Create an account</Link>
      </p>
    </AuthFrame>
  );
}

export function SignupPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signup(email, password, name);
      navigate(`/verify-email?email=${encodeURIComponent(email)}`, { replace: true });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title="Make room for what matters" subtitle="Create a private account for your events and reminders.">
      <form className="space-y-4" onSubmit={submit}>
        {error && <Alert>{error}</Alert>}
        <FormField label="Your name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={120} />
        </FormField>
        <FormField label="Email">
          <TextInput type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
        </FormField>
        <PasswordInput
          label="Create password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          minLength={10}
          maxLength={128}
          required
        />
        <p className="-mt-2 text-xs text-slate-500 dark:text-slate-400">Use at least 10 characters and avoid common passwords.</p>
        <PrimaryButton className="w-full" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
          {!busy && <ArrowRight size={16} aria-hidden="true" />}
        </PrimaryButton>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600 dark:text-slate-400">
        Already have an account? <Link to="/login" className="font-semibold text-teal-800 hover:underline dark:text-teal-300">Log in</Link>
      </p>
    </AuthFrame>
  );
}

export function VerifyEmailPage() {
  const [search] = useSearchParams();
  const token = search.get("token");
  const email = search.get("email") ?? "";
  const [message, setMessage] = useState(token ? "Checking your verification link…" : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!token) return;
    verifyEmail(token)
      .then(() => setMessage("Your email is verified. You can now log in."))
      .catch(() => {
        setMessage("");
        setError("This verification link is invalid or expired. You can request a new one.");
      });
  }, [token]);
  async function resend() {
    setBusy(true);
    setError("");
    try {
      const response = await resendVerification(email);
      setMessage(response.message);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title="Verify your email" subtitle="We sent a one-time link to the address you used to sign up.">
      {message && <Alert tone="success">{message}</Alert>}
      {error && <Alert>{error}</Alert>}
      <div className="mt-5 flex flex-col gap-3">
        {email && (
          <PrimaryButton onClick={resend} disabled={busy}>
            {busy ? "Sending…" : "Send a new verification email"}
          </PrimaryButton>
        )}
        <Link to="/login" className="text-center text-sm font-semibold text-teal-800 hover:underline dark:text-teal-300">Go to log in</Link>
      </div>
    </AuthFrame>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await requestPasswordReset(email);
      setMessage(response.message);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title="Reset your password" subtitle="If an account exists for the email, we’ll send a one-time reset link.">
      <form className="space-y-4" onSubmit={submit}>
        {message && <Alert tone="success">{message}</Alert>}
        {error && <Alert>{error}</Alert>}
        <FormField label="Email">
          <TextInput type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
        </FormField>
        <PrimaryButton className="w-full" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</PrimaryButton>
      </form>
      <Link to="/login" className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-teal-800 hover:underline dark:text-teal-300">
        <ArrowLeft size={14} aria-hidden="true" /> Back to log in
      </Link>
    </AuthFrame>
  );
}

export function ResetPasswordPage() {
  const [search] = useSearchParams();
  const token = search.get("token") ?? "";
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await resetPassword(token, password);
      navigate("/login", { replace: true, state: { notice: "Password updated. Log in with your new password." } });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title="Choose a new password" subtitle="Use at least 10 characters. Your other sessions will be signed out.">
      <form className="space-y-4" onSubmit={submit}>
        {error && <Alert>{error}</Alert>}
        {!token && <Alert>The reset link is missing or invalid.</Alert>}
        <PasswordInput
          label="New password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={10}
          autoComplete="new-password"
          required
          disabled={!token}
        />
        <PrimaryButton className="w-full" disabled={busy || !token}>{busy ? "Updating…" : "Update password"}</PrimaryButton>
      </form>
    </AuthFrame>
  );
}
