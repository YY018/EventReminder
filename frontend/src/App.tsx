import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./auth";
import { AppShell } from "./components";
import {
  ForgotPasswordPage,
  LoginPage,
  ResetPasswordPage,
  SignupPage,
  VerifyEmailPage,
} from "./AuthPages";
import {
  DashboardPage,
  EventEditorPage,
  LandingPage,
  PrivacyPage,
  SettingsPage,
  UploadPage,
} from "./Screens";

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/app" element={<DashboardPage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/events/new" element={<EventEditorPage />} />
        <Route path="/events/:eventId" element={<EventEditorPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
