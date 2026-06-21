import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Cloud } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth } from '../App.jsx';

/** Simple debounce hook */
function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function passwordStrength(p) {
  if (!p) return null;
  if (p.length < 8) return { level: 0, label: 'Too short', color: 'var(--error)' };
  if (p.length < 10) return { level: 1, label: 'Weak', color: 'var(--error)' };
  const hasUpper   = /[A-Z]/.test(p);
  const hasDigit   = /[0-9]/.test(p);
  const hasSpecial = /[^a-zA-Z0-9]/.test(p);
  const score = [hasUpper, hasDigit, hasSpecial].filter(Boolean).length;
  if (score === 3 && p.length >= 12) return { level: 3, label: 'Strong',  color: 'var(--success)' };
  if (score >= 2)                    return { level: 2, label: 'Good',    color: 'var(--warning)' };
  return                                     { level: 1, label: 'Fair',   color: 'var(--warning)' };
}

export default function RegisterPage() {
  const { setUser } = useAuth();
  const navigate    = useNavigate();

  const [form, setForm] = useState({
    username: '', email: '', password: '', confirm: '',
  });
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const [usernameStatus, setUsernameStatus] = useState(null);
  // null | 'checking' | 'available' | 'taken' | 'invalid'

  const debouncedUsername = useDebounce(form.username, 420);

  /* Real-time username availability check */
  useEffect(() => {
    if (!debouncedUsername) { setUsernameStatus(null); return; }
    if (!USERNAME_RE.test(debouncedUsername)) { setUsernameStatus('invalid'); return; }
    setUsernameStatus('checking');
    api.get(`/auth/check-username?username=${encodeURIComponent(debouncedUsername)}`)
      .then(d => setUsernameStatus(d.available ? 'available' : 'taken'))
      .catch(() => setUsernameStatus(null));
  }, [debouncedUsername]);

  const handleChange = (e) =>
    setForm(f => ({ ...f, [e.target.name]: e.target.value }));

  const strength = passwordStrength(form.password);
  const pwMatch  = form.confirm && form.password === form.confirm;
  const pwMismatch = form.confirm && form.password !== form.confirm;

  const canSubmit =
    !loading &&
    usernameStatus === 'available' &&
    EMAIL_RE.test(form.email) &&
    (strength?.level ?? 0) >= 1 &&
    form.password === form.confirm &&
    form.confirm.length > 0;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!USERNAME_RE.test(form.username)) {
      setError('Invalid username format');
      return;
    }
    if (!EMAIL_RE.test(form.email)) {
      setError('Please enter a valid email address');
      return;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (form.password !== form.confirm) {
      setError('Passwords do not match');
      return;
    }
    if (usernameStatus === 'taken') {
      setError('Username is already taken');
      return;
    }

    setLoading(true);
    try {
      const data = await api.post('/auth/register', {
        username: form.username,
        email: form.email,
        password: form.password,
      });
      setUser(data.user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  /* Username status hint */
  const usernameHint = () => {
    if (!form.username) return null;
    switch (usernameStatus) {
      case 'checking':  return <span className="form-hint">Checking…</span>;
      case 'available': return <span className="form-hint success">✓ Available</span>;
      case 'taken':     return <span className="form-hint error">✗ Already taken</span>;
      case 'invalid':   return <span className="form-hint error">3–32 chars: letters, numbers, _ or -</span>;
      default:          return null;
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <div className="auth-logo-icon">
            <Cloud size={22} color="white" strokeWidth={2} />
          </div>
          <span className="auth-logo-name">PersonalCloud</span>
        </div>

        <h1 className="auth-title">Create account</h1>
        <p className="auth-subtitle">Set up your private cloud storage</p>

        {error && <div className="alert alert-error" role="alert">{error}</div>}

        <form onSubmit={handleSubmit} noValidate>
          {/* Username */}
          <div className="form-group">
            <label className="form-label" htmlFor="reg-username">Username</label>
            <input
              id="reg-username"
              name="username"
              type="text"
              className={`form-input ${
                usernameStatus === 'taken' || usernameStatus === 'invalid' ? 'error' : ''
              }`}
              placeholder="Choose a username"
              value={form.username}
              onChange={handleChange}
              autoComplete="username"
              autoFocus
              required
            />
            {usernameHint()}
          </div>

          {/* Email */}
          <div className="form-group">
            <label className="form-label" htmlFor="reg-email">Email Address</label>
            <input
              id="reg-email"
              name="email"
              type="email"
              className={`form-input ${form.email && !EMAIL_RE.test(form.email) ? 'error' : ''}`}
              placeholder="you@example.com"
              value={form.email}
              onChange={handleChange}
              autoComplete="email"
              required
            />
            {form.email && !EMAIL_RE.test(form.email) && (
              <span className="form-hint error">Please enter a valid email address</span>
            )}
          </div>

          {/* Password */}
          <div className="form-group">
            <label className="form-label" htmlFor="reg-password">Password</label>
            <input
              id="reg-password"
              name="password"
              type="password"
              className="form-input"
              placeholder="At least 8 characters"
              value={form.password}
              onChange={handleChange}
              autoComplete="new-password"
              required
            />
            {strength && (
              <div style={{ marginTop: 7 }}>
                <div className="progress-bar">
                  <div
                    className="progress-bar-fill"
                    style={{
                      width: `${(strength.level / 3) * 100}%`,
                      background: strength.color,
                      transition: 'width .35s ease, background .35s ease',
                    }}
                  />
                </div>
                <span className="form-hint" style={{ color: strength.color }}>
                  {strength.label}
                </span>
              </div>
            )}
          </div>

          {/* Confirm password */}
          <div className="form-group">
            <label className="form-label" htmlFor="reg-confirm">Confirm Password</label>
            <input
              id="reg-confirm"
              name="confirm"
              type="password"
              className={`form-input ${pwMismatch ? 'error' : ''}`}
              placeholder="Repeat your password"
              value={form.confirm}
              onChange={handleChange}
              autoComplete="new-password"
              required
            />
            {pwMismatch && <span className="form-hint error">Passwords don't match</span>}
            {pwMatch    && <span className="form-hint success">✓ Passwords match</span>}
          </div>

          <button
            id="reg-submit"
            type="submit"
            className="btn btn-primary btn-full"
            disabled={!canSubmit}
          >
            {loading && (
              <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
            )}
            {loading ? 'Creating account…' : 'Create Account'}
          </button>
        </form>

        <p className="auth-footer">
          Already have an account?{' '}
          <Link to="/login">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
