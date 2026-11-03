import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, deleteAccount } from "./api";
import { cacheProfile, clearCachedUser, getCachedProfile } from "./offline";
import type { ProfileUpdate } from "./types";
import {
  getCurrentUser,
  login,
  logout,
  logoutAll,
  updateProfile,
} from "./api";
import type { User } from "./types";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  offline: boolean;
  darkMode: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(allDevices?: boolean): Promise<void>;
  refreshUser(): Promise<User>;
  saveUser(changes: ProfileUpdate): Promise<User>;
  removeAccount(): Promise<void>;
  toggleTheme(): void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [darkMode, setDarkMode] = useState(
    () => window.localStorage.getItem("event-theme") === "dark",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    window.localStorage.setItem("event-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    let active = true;
    getCurrentUser()
      .then((currentUser) => {
        if (active) {
          setUser(currentUser);
          setOffline(false);
          window.localStorage.setItem("event-reminder-profile-id", currentUser.id);
          void cacheProfile(currentUser).catch(() => {
            console.warn("Offline profile cache could not be updated.");
          });
        }
      })
      .catch(async (error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError) {
          setUser(null);
          if (error.status === 401) {
            const userId = window.localStorage.getItem("event-reminder-profile-id");
            if (userId) await clearCachedUser(userId).catch(() => undefined);
            window.localStorage.removeItem("event-reminder-profile-id");
          }
          return;
        }
        const cached = await getLastCachedProfile().catch(() => undefined);
        if (active && cached) {
          setUser(cached);
          setOffline(true);
        } else if (active) {
          setUser(null);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function getLastCachedProfile(): Promise<User | undefined> {
    const storedId = window.localStorage.getItem("event-reminder-profile-id");
    return storedId ? getCachedProfile(storedId) : undefined;
  }

  async function signIn(email: string, password: string) {
    const currentUser = await login(email, password);
    setUser(currentUser);
    setOffline(false);
    window.localStorage.setItem("event-reminder-profile-id", currentUser.id);
    await cacheProfile(currentUser).catch(() => {
      console.warn("Offline profile cache could not be updated.");
    });
  }

  async function signOut(allDevices = false) {
    const userId = user?.id;
    try {
      if (allDevices) await logoutAll();
      else await logout();
    } finally {
      if (userId) await clearCachedUser(userId).catch(() => undefined);
      window.localStorage.removeItem("event-reminder-profile-id");
      setUser(null);
      setOffline(false);
    }
  }

  async function refreshUser() {
    const currentUser = await getCurrentUser();
    setUser(currentUser);
    setOffline(false);
    window.localStorage.setItem("event-reminder-profile-id", currentUser.id);
    await cacheProfile(currentUser);
    return currentUser;
  }

  async function saveUser(changes: ProfileUpdate) {
    const updated = await updateProfile(changes);
    setUser(updated);
    window.localStorage.setItem("event-reminder-profile-id", updated.id);
    await cacheProfile(updated).catch(() => {
      console.warn("Offline profile cache could not be updated.");
    });
    return updated;
  }

  async function removeAccount() {
    const userId = user?.id;
    await deleteAccount();
    if (userId) await clearCachedUser(userId).catch(() => undefined);
    window.localStorage.removeItem("event-reminder-profile-id");
    setUser(null);
    setOffline(false);
  }

  const value = useMemo(
    () => ({
      user,
      loading,
      offline,
      darkMode,
      signIn,
      signOut,
      refreshUser,
      saveUser,
      removeAccount,
      toggleTheme: () => setDarkMode((value) => !value),
    }),
    [user, loading, offline, darkMode],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider.");
  return value;
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && !user) navigate("/login", { replace: true });
  }, [loading, user, navigate]);
  if (loading) return <LoadingPage />;
  if (!user) return null;
  return children;
}

export function LoadingPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 text-slate-600 dark:bg-slate-950 dark:text-slate-300">
      <div role="status" className="flex items-center gap-3">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
        <span>Loading your events…</span>
      </div>
    </main>
  );
}
