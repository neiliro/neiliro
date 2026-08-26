import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { AuthProvider, useAuth } from './lib/auth';
import { DialogProvider } from './components/Dialog';
import { ChangePassword, Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Tasks } from './pages/Tasks';
import { Notes } from './pages/Notes';
import { Calendar } from './pages/Calendar';
import { Settings } from './pages/Settings';
import { Money } from './pages/Money';
import { Mail } from './pages/Mail';
import { Lists } from './pages/Lists';
import { Family } from './pages/Family';
import { PublicWishlist } from './pages/PublicWishlist';
import { VerifyEmail } from './pages/VerifyEmail';

function Gate() {
  const { user, loading, mustChangePassword } = useAuth();

  if (loading) {
    return <div className="min-h-dvh bg-surface-2" />;
  }
  if (!user) return <Login />;
  if (mustChangePassword) return <ChangePassword />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="notes" element={<Notes />} />
        <Route path="money" element={<Money />} />
        <Route path="lists" element={<Lists />} />
        <Route path="mail" element={<Mail />} />
        <Route path="family" element={<Family />} />
        <Route path="family/:userId" element={<Family />} />
        <Route path="settings" element={<Settings />} />
        {/* People management moved into Settings; old bookmarks land there */}
        <Route path="users" element={<Navigate to="/settings" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <DialogProvider>
          <Routes>
            {/* The guest wishlist lives OUTSIDE the auth gate: it is the
                hub's only page for people without an account (#68) */}
            <Route path="/wish/:token" element={<PublicWishlist />} />
            {/* Same reason: the confirmation link is opened from a mail
                client, often in a browser with no session (#156) */}
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route path="*" element={<Gate />} />
          </Routes>
        </DialogProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
