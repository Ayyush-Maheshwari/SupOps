import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import { api } from './lib/api';
import { useApp } from './lib/store';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Console } from './pages/Console';
import { Investigate } from './pages/Investigate';
import { Runs } from './pages/Runs';
import { RunDetail } from './pages/RunDetail';
import { Approvals } from './pages/Approvals';
import { Alerts } from './pages/Alerts';
import { Health } from './pages/Health';
import { Users } from './pages/Users';
import { Targets } from './pages/Targets';
import { Agents } from './pages/Agents';
import { Settings } from './pages/Settings';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token, user, setUser, signOut } = useApp();
  const location = useLocation();

  // Restore the session on a hard refresh: the token is in localStorage but the
  // profile is not, so confirm it with the server rather than trusting the JWT body.
  useEffect(() => {
    if (!token || user) return;
    api<{ user: NonNullable<typeof user> }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => signOut());
  }, [token, user, setUser, signOut]);

  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/investigate" element={<Investigate />} />
            <Route path="/console" element={<Console />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/approvals" element={<Approvals />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/health" element={<Health />} />
            <Route path="/targets" element={<Targets />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/users" element={<Users />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
