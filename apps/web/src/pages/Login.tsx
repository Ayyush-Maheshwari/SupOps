import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lockup } from '../components/Logo';
import { post } from '../lib/api';
import { useApp } from '../lib/store';
import { Field, Spinner } from '../components/ui';

export function Login() {
  const navigate = useNavigate();
  const signIn = useApp((s) => s.signIn);
  const [email, setEmail] = useState('admin@supops.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ token: string; user: Parameters<typeof signIn>[1] }>('/auth/login', {
        email,
        password,
      });
      signIn(res.token, res.user);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center px-4">
      <form onSubmit={submit} className="tile w-full max-w-sm p-7">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <Lockup size={52} />
          <p className="text-xs text-muted">Sign in to continue</p>
        </div>

        <div className="space-y-4">
          <Field label="Email">
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </Field>
          <Field label="Password">
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </Field>
        </div>

        {error && (
          <p className="mt-4 rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
            {error}
          </p>
        )}

        <button type="submit" className="btn-primary mt-6 w-full justify-center" disabled={busy}>
          {busy ? <Spinner /> : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
