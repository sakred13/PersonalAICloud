import { useState, useEffect, useRef } from 'react';
import { Send, Bot, Paperclip, X, Trash2, Folder, File, Home, ChevronRight, Plus } from 'lucide-react';
import { api } from '../api/client.js';

export default function AgentPanel({ showToast }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [attachedPaths, setAttachedPaths] = useState([]);
  const [loading, setLoading] = useState(false);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [showPicker, setShowPicker] = useState(false);

  const chatEndRef = useRef(null);

  // 1. Fetch chat history
  const fetchHistory = async () => {
    try {
      const data = await api.get('/agent/chats');
      setMessages(data.chats || []);
    } catch (err) {
      showToast('Failed to load chat history', 'error');
    } finally {
      setChatsLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  // Scroll to bottom on new message
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // 2. Send prompt to agent
  const handleSend = async (e) => {
    if (e) e.preventDefault();
    const text = input.trim();
    if (!text && attachedPaths.length === 0) return;

    // Optimistically add user message
    const userMsg = {
      id: Date.now(),
      role: 'user',
      content: text,
      file_references: [...attachedPaths]
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setAttachedPaths([]);
    setLoading(true);

    try {
      const res = await api.post('/agent/chat', {
        message: text || `Process attached files: ${userMsg.file_references.join(', ')}`,
        references: userMsg.file_references
      });
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'assistant',
        content: res.reply
      }]);
    } catch (err) {
      showToast(err.message || 'Failed to get agent response', 'error');
      // Remove optimistic message on failure
      setMessages(prev => prev.filter(m => m.id !== userMsg.id));
    } finally {
      setLoading(false);
    }
  };

  // 3. Clear chat logs
  const handleClearChat = async () => {
    if (!window.confirm('Clear all conversation history?')) return;
    try {
      await api.post('/agent/clear');
      setMessages([]);
      showToast('Chat history cleared', 'success');
    } catch (err) {
      showToast('Failed to clear chat', 'error');
    }
  };

  const handleNewTask = async () => {
    try {
      await api.post('/agent/new-task');
      showToast('New task context started', 'success');
      fetchHistory();
    } catch (err) {
      showToast('Failed to start new task', 'error');
    }
  };

  const handleRecommend = () => {
    setInput('What formats can I convert the files in my attached references to?');
  };

  return (
    <div className="agent-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>

      {/* Panel Header */}
      <header className="agent-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 18px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ background: 'var(--accent-grad)', borderRadius: 'var(--r-sm)', padding: 6, display: 'flex', alignItems: 'center' }}>
            <Bot size={18} color="white" />
          </div>
          <div>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>AI Cloud Assistant</h2>
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0 }}>Advanced file, media, and document assistant</p>
          </div>
        </div>
        {messages.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={handleNewTask} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 12, height: '32px' }} title="Start a new task context">
              <Plus size={14} /> New Task
            </button>
            <button className="btn btn-ghost btn-icon" onClick={handleClearChat} title="Clear Conversation" style={{ width: '32px', height: '32px' }}>
              <Trash2 size={16} style={{ color: 'var(--text-secondary)' }} />
            </button>
          </div>
        )}
      </header>

      {/* Chat Messages Feed */}
      <div className="agent-messages" style={{ flex: 1, overflowY: 'auto', padding: '20px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {chatsLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><div className="spinner" /></div>
        ) : messages.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 24, color: 'var(--text-secondary)' }}>
            <Bot size={48} style={{ opacity: 0.2, marginBottom: 12 }} />
            <p style={{ fontWeight: 500, marginBottom: 6, color: 'var(--text-primary)' }}>Welcome to AI Cloud Assistant!</p>
            <p style={{ fontSize: 13, maxWidth: 300, margin: '0 auto 16px auto' }}>Attach files/folders or ask me to analyze photos/videos, transcribe audio, convert formats, or stitch PDFs.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setInput('Describe the photo in my reference attachments')}>Describe Photo</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setInput('What happens in the video in my reference attachments?')}>Summarize Video</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setInput('Convert images to WebP')}>Convert to WebP</button>
            </div>
          </div>
        ) : (
          messages.map(msg => {
            if (msg.role === 'system') {
              return (
                <div key={msg.id} style={{ display: 'flex', alignItems: 'center', margin: '8px 0', width: '100%' }}>
                  <div style={{ flex: 1, height: '1px', background: 'linear-gradient(to right, transparent, var(--border), transparent)' }}></div>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 12px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                    {msg.content === '--- New Task ---' ? 'New Task Started' : msg.content}
                  </span>
                  <div style={{ flex: 1, height: '1px', background: 'linear-gradient(to left, transparent, var(--border), transparent)' }}></div>
                </div>
              );
            }
            return (
              <div key={msg.id} style={{ display: 'flex', gap: 12, justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                {msg.role === 'assistant' && (
                  <div style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 6, height: 'fit-content', flexShrink: 0 }}>
                    <Bot size={16} style={{ color: 'var(--accent)' }} />
                  </div>
                )}
                <div style={{
                  maxWidth: '75%',
                  background: msg.role === 'user' ? 'var(--accent-grad)' : 'var(--bg-card)',
                  border: msg.role === 'user' ? 'none' : '1px solid var(--border)',
                  borderRadius: 'var(--r-lg)',
                  padding: '10px 14px',
                  color: 'var(--text-primary)',
                  fontSize: 14,
                  boxShadow: msg.role === 'user' ? 'var(--accent-shadow)' : 'var(--shadow-sm)',
                  whiteSpace: 'pre-wrap'
                }}>
                  {msg.content}

                  {msg.file_references && msg.file_references.length > 0 && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.1)', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4, opacity: 0.85 }}>
                      <span style={{ fontWeight: 600 }}>References attached:</span>
                      {msg.file_references.map((p, idx) => (
                        <span key={idx} style={{ background: 'rgba(0,0,0,0.15)', padding: '2px 6px', borderRadius: 4, width: 'fit-content' }}>
                          {p.split('/').pop() || p}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {/* Thinking Bubble */}
        {loading && (
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-start' }}>
            <div style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 6, height: 'fit-content', flexShrink: 0 }}>
              <Bot size={16} className="spinner" style={{ color: 'var(--accent)' }} />
            </div>
            <div style={{ maxWidth: '75%', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '10px 14px', color: 'var(--text-secondary)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>Working on it...</span>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Attachments & Suggestions Bar */}
      <div style={{ padding: '0 18px', flexShrink: 0 }}>
        {attachedPaths.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, padding: 8, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
            {attachedPaths.map(p => (
              <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-card)', border: '1px solid var(--border)', padding: '4px 8px', borderRadius: 4, fontSize: 12 }}>
                <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: 180 }}>{p.split('/').pop() || p}</span>
                <button style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0 }} onClick={() => setAttachedPaths(prev => prev.filter(x => x !== p))}>
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}

        {attachedPaths.length > 0 && !loading && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={handleRecommend} style={{ fontSize: 11, padding: '4px 8px' }}>
              💡 What can I convert these to?
            </button>
          </div>
        )}
      </div>

      {/* Message Input Form */}
      <form onSubmit={handleSend} style={{ padding: '12px 18px 18px 18px', borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
        <button
          type="button"
          className="btn btn-secondary btn-icon"
          onClick={() => setShowPicker(true)}
          title="Attach references"
          style={{ borderRadius: 'var(--r-full)', width: 38, height: 38, flexShrink: 0 }}
        >
          <Paperclip size={16} />
        </button>
        <input
          type="text"
          className="form-input"
          placeholder={attachedPaths.length > 0 ? "Ask agent to convert/stitch files..." : "Ask the agent anything..."}
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={loading}
          style={{ margin: 0, borderRadius: 'var(--r-full)', height: 38 }}
        />
        <button
          type="submit"
          className="btn btn-primary btn-icon"
          disabled={loading || (!input.trim() && attachedPaths.length === 0)}
          style={{ borderRadius: 'var(--r-full)', width: 38, height: 38, flexShrink: 0 }}
        >
          <Send size={16} color="white" />
        </button>
      </form>

      {/* Directory Reference Picker Modal */}
      {showPicker && (
        <ReferencePicker
          onClose={() => setShowPicker(false)}
          onAttach={(paths) => {
            setAttachedPaths(prev => Array.from(new Set([...prev, ...paths])));
            setShowPicker(false);
          }}
        />
      )}
    </div>
  );
}

// ── Reference Picker Modal Component ───────────────────────────────────────────
function ReferencePicker({ onClose, onAttach }) {
  const [currentPath, setCurrentPath] = useState('');
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.get(`/files?path=${encodeURIComponent(currentPath)}`)
      .then(res => {
        if (!active) return;
        setItems(res.files || []);
      })
      .catch(() => { })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });
    return () => { active = false; };
  }, [currentPath]);

  const handleToggleSelect = (path) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const getBreadcrumbs = () => {
    const segments = currentPath.split('/').filter(Boolean);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setCurrentPath('')} style={{ padding: '4px 6px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Home size={14} /> Root
        </button>
        {segments.map((seg, idx) => {
          const pathUpTo = segments.slice(0, idx + 1).join('/');
          return (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <ChevronRight size={12} style={{ opacity: 0.5 }} />
              <button className="btn btn-ghost btn-sm" onClick={() => setCurrentPath(pathUpTo)} style={{ padding: '4px 6px' }}>{seg}</button>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="dialog" onClick={e => e.stopPropagation()} style={{ width: '460px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 className="dialog-title" style={{ margin: 0 }}>Attach References</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {getBreadcrumbs()}

        <div style={{ flex: 1, overflowY: 'auto', minHeight: '220px', maxHeight: '350px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--r)', padding: 8, marginBottom: 16 }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><div className="spinner" /></div>
          ) : items.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>Folder is empty.</div>
          ) : (
            items.map(item => {
              const isDir = item.type === 'directory';
              const isSel = selected.has(item.path);
              return (
                <div
                  key={item.path}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 'var(--r-sm)', color: 'var(--text-primary)', transition: 'background var(--t)' }}
                  className="picker-item-row"
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={() => handleToggleSelect(item.path)}
                    style={{ width: 15, height: 15, cursor: 'pointer', accentColor: 'var(--accent)' }}
                  />
                  {isDir ? (
                    <button
                      className="btn btn-ghost"
                      onClick={() => setCurrentPath(item.path)}
                      style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', justifyContent: 'flex-start', color: 'var(--text-primary)' }}
                    >
                      <Folder size={16} style={{ color: 'var(--accent)' }} />
                      <span>{item.name}/</span>
                    </button>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px' }}>
                      <File size={16} style={{ color: 'var(--text-secondary)' }} />
                      <span>{item.name}</span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="dialog-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onAttach(Array.from(selected))} disabled={selected.size === 0}>
            Attach ({selected.size})
          </button>
        </div>
      </div>
    </div>
  );
}
