import { useState, useEffect } from 'react';
import { UserCheck, Check, X, ShieldAlert, Mail, Clock } from 'lucide-react';
import { adminApi } from '../api/client.js';

export default function UserApprovalsPanel({ showToast, onRefreshCount }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actioningId, setActioningId] = useState(null);

  const fetchPending = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi.getPendingUsers();
      setUsers(data);
      if (onRefreshCount) onRefreshCount(data.length);
    } catch (err) {
      setError(err.message || 'Failed to fetch pending approvals');
      showToast(err.message || 'Failed to fetch pending approvals', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPending();
  }, []);

  const handleApprove = async (userId, username) => {
    if (actioningId) return;
    setActioningId(userId);
    try {
      await adminApi.approveUser(userId);
      showToast(`User "${username}" approved successfully`, 'success');
      const nextUsers = users.filter(u => u.id !== userId);
      setUsers(nextUsers);
      if (onRefreshCount) onRefreshCount(nextUsers.length);
    } catch (err) {
      showToast(err.message || 'Failed to approve user', 'error');
    } finally {
      setActioningId(null);
    }
  };

  const handleReject = async (userId, username) => {
    if (actioningId) return;
    if (!window.confirm(`Reject and delete registration for "${username}"? This will delete their database record and any created disk storage.`)) {
      return;
    }
    setActioningId(userId);
    try {
      await adminApi.rejectUser(userId);
      showToast(`User "${username}" rejected and deleted`, 'success');
      const nextUsers = users.filter(u => u.id !== userId);
      setUsers(nextUsers);
      if (onRefreshCount) onRefreshCount(nextUsers.length);
    } catch (err) {
      showToast(err.message || 'Failed to reject user', 'error');
    } finally {
      setActioningId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <header className="agent-header" style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 18px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ background: 'rgba(245, 158, 11, 0.15)', borderRadius: 'var(--r-sm)', padding: 6, display: 'flex', alignItems: 'center', color: 'var(--warning)', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
            <UserCheck size={18} />
          </div>
          <div>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Pending Registrations</h2>
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0 }}>Approve or reject new account requests</p>
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={fetchPending} disabled={loading}>
          Refresh
        </button>
      </header>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
            <div className="spinner" />
          </div>
        ) : error ? (
          <div className="files-empty">
            <ShieldAlert size={48} style={{ color: 'var(--error)', opacity: 0.8 }} />
            <div>
              <p className="files-empty-title">Error Loading Approvals</p>
              <p className="files-empty-text">{error}</p>
              <button className="btn btn-secondary btn-sm" style={{ marginTop: '12px' }} onClick={fetchPending}>
                Try Again
              </button>
            </div>
          </div>
        ) : users.length === 0 ? (
          <div className="files-empty">
            <UserCheck size={72} style={{ opacity: .15 }} />
            <div>
              <p className="files-empty-title">All Caught Up!</p>
              <p className="files-empty-text">There are no pending user registrations waiting for approval.</p>
            </div>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: '16px',
            animation: 'fadeIn .25s ease'
          }}>
            {users.map(u => (
              <div
                key={u.id}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-lg)',
                  padding: '18px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '14px',
                  transition: 'all var(--t)',
                  position: 'relative'
                }}
                className="user-approval-card"
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '50%',
                    background: 'var(--accent-grad)',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 600,
                    fontSize: '16px'
                  }}>
                    {u.username[0].toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', margin: 0, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                      {u.username}
                    </h3>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      <Mail size={12} style={{ flexShrink: 0 }} />
                      <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{u.email}</span>
                    </div>
                  </div>
                </div>

                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '11px',
                  color: 'var(--text-muted)',
                  borderTop: '1px solid var(--border)',
                  paddingTop: '10px'
                }}>
                  <Clock size={12} />
                  <span>Registered: {new Date(u.created_at).toLocaleString()}</span>
                </div>

                <div style={{
                  display: 'flex',
                  gap: '10px',
                  marginTop: '4px'
                }}>
                  <button
                    className="btn btn-primary"
                    style={{
                      flex: 1,
                      background: 'var(--success-bg)',
                      border: '1px solid rgba(16, 185, 129, 0.2)',
                      color: 'var(--success)',
                      boxShadow: 'none',
                      padding: '8px 12px'
                    }}
                    onClick={() => handleApprove(u.id, u.username)}
                    disabled={actioningId !== null}
                  >
                    <Check size={14} /> Approve
                  </button>
                  <button
                    className="btn btn-secondary danger"
                    style={{
                      flex: 1,
                      background: 'var(--error-bg)',
                      border: '1px solid rgba(239, 68, 68, 0.2)',
                      color: 'var(--error)',
                      padding: '8px 12px'
                    }}
                    onClick={() => handleReject(u.id, u.username)}
                    disabled={actioningId !== null}
                  >
                    <X size={14} /> Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
