import { useState, useEffect } from 'react';
import { Key, Save, AlertCircle, CheckCircle, Info } from 'lucide-react';
import { api } from '../api/client.js';

export default function SecretsVaultPanel({ showToast }) {
  const [secrets, setSecrets] = useState({
    GMAIL_EMAIL: '',
    GMAIL_APP_PASSWORD: ''
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Fetch configured secrets on mount
  useEffect(() => {
    let active = true;
    const fetchSecrets = async () => {
      try {
        const data = await api.get('/agent/secrets');
        if (!active) return;
        setSecrets({
          GMAIL_EMAIL: data.secrets?.GMAIL_EMAIL?.value || '',
          GMAIL_APP_PASSWORD: data.secrets?.GMAIL_APP_PASSWORD?.value || ''
        });
      } catch (err) {
        showToast('Failed to load secrets config', 'error');
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchSecrets();
    return () => { active = false; };
  }, [showToast]);

  const handleSave = async (e) => {
    if (e) e.preventDefault();
    setSaving(true);
    try {
      await api.post('/agent/secrets', { secrets });
      showToast('Secrets updated successfully', 'success');
      
      // Re-fetch to get masked values
      const data = await api.get('/agent/secrets');
      setSecrets({
        GMAIL_EMAIL: data.secrets?.GMAIL_EMAIL?.value || '',
        GMAIL_APP_PASSWORD: data.secrets?.GMAIL_APP_PASSWORD?.value || ''
      });
    } catch (err) {
      showToast(err.message || 'Failed to save secrets', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="secrets-panel" style={{ padding: '24px', maxWidth: '800px', margin: '0 auto', height: '100%', overflowY: 'auto' }}>
      
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <div style={{ background: 'var(--accent-grad)', borderRadius: 'var(--r-sm)', padding: 8, display: 'flex', alignItems: 'center' }}>
          <Key size={22} color="white" />
        </div>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>Secrets Vault</h2>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>Configure secure credentials for agent tools</p>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'start' }}>
        
        {/* Secrets Form */}
        <form onSubmit={handleSave} style={{ flex: '1 1 320px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 24, boxShadow: 'var(--shadow-sm)' }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginTop: 0, marginBottom: 16, color: 'var(--text-primary)' }}>Credentials</h3>
          
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="gmail-email" style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--text-secondary)' }}>
              Gmail Address (GMAIL_EMAIL)
            </label>
            <input
              id="gmail-email"
              type="email"
              className="form-input"
              placeholder="your.email@gmail.com"
              value={secrets.GMAIL_EMAIL}
              onChange={e => setSecrets(prev => ({ ...prev, GMAIL_EMAIL: e.target.value }))}
              style={{ width: '100%', margin: 0 }}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label htmlFor="gmail-password" style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--text-secondary)' }}>
              Gmail App Password (GMAIL_APP_PASSWORD)
            </label>
            <input
              id="gmail-password"
              type="password"
              className="form-input"
              placeholder={secrets.GMAIL_APP_PASSWORD ? "••••••••••••••••" : "Paste your 16-character app password"}
              value={secrets.GMAIL_APP_PASSWORD}
              onChange={e => setSecrets(prev => ({ ...prev, GMAIL_APP_PASSWORD: e.target.value }))}
              style={{ width: '100%', margin: 0 }}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', justifyContent: 'center', height: '40px' }}
          >
            {saving ? <div className="spinner" style={{ width: 16, height: 16 }} /> : <Save size={16} />}
            {saving ? 'Saving...' : 'Save Credentials'}
          </button>
        </form>

        {/* Info & Setup Guide */}
        <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          
          {/* Note Card */}
          <div style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 18, display: 'flex', gap: 12 }}>
            <AlertCircle size={20} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <h4 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 4px 0', color: 'var(--text-primary)' }}>Important Security Note</h4>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
                Google blocks standard passwords for program access. You must generate a dedicated <strong>App Password</strong>. Your credentials are encrypted and isolated under your specific account.
              </p>
            </div>
          </div>

          {/* Guide Card */}
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Info size={16} style={{ color: 'var(--accent)' }} />
              <h4 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>How to get a Gmail App Password:</h4>
            </div>
            <ol style={{ fontSize: 12, color: 'var(--text-secondary)', paddingLeft: 16, margin: 0, display: 'flex', flexDirection: 'column', gap: 8, lineHeight: 1.4 }}>
              <li>
                Go to your <a href="https://myaccount.google.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Google Account Settings</a>.
              </li>
              <li>
                Navigate to the <strong>Security</strong> tab on the left.
              </li>
              <li>
                Under <i>"How you sign in to Google"</i>, ensure <strong>2-Step Verification</strong> is enabled.
              </li>
              <li>
                Click into <strong>2-Step Verification</strong>, scroll to the bottom, and click <strong>App passwords</strong>.
              </li>
              <li>
                Enter a custom name (e.g., <i>"Personal AI Cloud"</i>) and click <strong>Create</strong>.
              </li>
              <li>
                Copy the generated <strong>16-character code</strong> (ignore spaces) and paste it into the vault fields.
              </li>
            </ol>
          </div>

        </div>

      </div>

    </div>
  );
}
