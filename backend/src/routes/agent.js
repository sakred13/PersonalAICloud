const express = require('express');
const { pool } = require('../lib/db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const AGENT_SERVICE_URL = process.env.AGENT_URL || 'http://agent:8000';

// ─── GET /api/agent/chats ──────────────────────────────────────────────────────
// Fetch chat history for the current user
router.get('/chats', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, role, content, file_references, created_at
       FROM agent_chats
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [req.user.id]
    );
    return res.json({ chats: result.rows });
  } catch (err) {
    console.error('[agent/chats]', err.message);
    return res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// ─── POST /api/agent/chat ──────────────────────────────────────────────────────
// Send a prompt to the AI agent and get the response
router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { message, references } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message content is required' });
    }

    const fileRefs = Array.isArray(references) ? references : [];

    // 1. Insert user message into database
    await pool.query(
      `INSERT INTO agent_chats (user_id, role, content, file_references)
       VALUES ($1, 'user', $2, $3)`,
      [req.user.id, message, fileRefs]
    );

    // 2. Fetch full history to send as context to the python agent
    const historyResult = await pool.query(
      `SELECT role, content
       FROM agent_chats
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [req.user.id]
    );

    // Filter history to send only messages after the latest 'system' role '--- New Task ---'
    let rows = historyResult.rows;
    const lastDelimiterIdx = [...rows].reverse().findIndex(
      row => row.role === 'system' && row.content === '--- New Task ---'
    );
    if (lastDelimiterIdx !== -1) {
      const actualIdx = rows.length - 1 - lastDelimiterIdx;
      rows = rows.slice(actualIdx + 1);
    }

    const history = rows.map(row => ({
      role: row.role,
      content: row.content
    }));

    // Fetch user secrets to pass to agent
    const secretsResult = await pool.query(
      `SELECT secret_key, secret_value FROM user_secrets WHERE user_id = $1`,
      [req.user.id]
    );
    const secrets = {};
    secretsResult.rows.forEach(row => {
      secrets[row.secret_key] = row.secret_value;
    });

    // 3. Request agent container for response
    const agentResponse = await fetch(`${AGENT_SERVICE_URL}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: req.user.username,
        user_id: req.user.id,
        message,
        references: fileRefs,
        history,
        secrets
      })
    });

    if (!agentResponse.ok) {
      let errMsg = 'Agent request failed';
      try {
        const errData = await agentResponse.json();
        errMsg = errData.error || errMsg;
      } catch {}
      throw new Error(errMsg);
    }

    const data = await agentResponse.json();
    const reply = data.reply || "Sorry, I couldn't process your request.";

    // 4. Save agent response into database
    await pool.query(
      `INSERT INTO agent_chats (user_id, role, content)
       VALUES ($1, 'assistant', $2)`,
      [req.user.id, reply]
    );

    return res.json({ reply });
  } catch (err) {
    console.error('[agent/chat]', err.message);
    return res.status(500).json({ error: err.message || 'Agent service unavailable' });
  }
});

// ─── POST /api/agent/clear ────────────────────────────────────────────────────
// Clear chat history for the current user
router.post('/clear', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM agent_chats WHERE user_id = $1`,
      [req.user.id]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[agent/clear]', err.message);
    return res.status(500).json({ error: 'Failed to clear chat history' });
  }
});

// ─── POST /api/agent/new-task ──────────────────────────────────────────────────
// Start a new task context by adding a system delimiter
router.post('/new-task', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO agent_chats (user_id, role, content)
       VALUES ($1, 'system', '--- New Task ---')`,
      [req.user.id]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[agent/new-task]', err.message);
    return res.status(500).json({ error: 'Failed to start new task' });
  }
});

// ─── GET /api/agent/secrets ────────────────────────────────────────────────────
// Fetch user secrets configuration (masked)
router.get('/secrets', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT secret_key, secret_value FROM user_secrets WHERE user_id = $1`,
      [req.user.id]
    );
    const secretsMap = {};
    result.rows.forEach(row => {
      secretsMap[row.secret_key] = row.secret_value;
    });
    
    return res.json({
      secrets: {
        GMAIL_EMAIL: {
          isSet: !!secretsMap['GMAIL_EMAIL'],
          value: secretsMap['GMAIL_EMAIL'] ? secretsMap['GMAIL_EMAIL'] : ''
        },
        GMAIL_APP_PASSWORD: {
          isSet: !!secretsMap['GMAIL_APP_PASSWORD'],
          value: secretsMap['GMAIL_APP_PASSWORD'] ? '••••••••••••••••' : ''
        }
      }
    });
  } catch (err) {
    console.error('[agent/secrets/get]', err.message);
    return res.status(500).json({ error: 'Failed to fetch secrets' });
  }
});

// ─── POST /api/agent/secrets ───────────────────────────────────────────────────
// Save user secrets configuration
router.post('/secrets', authMiddleware, async (req, res) => {
  try {
    const { secrets } = req.body || {};
    if (!secrets || typeof secrets !== 'object') {
      return res.status(400).json({ error: 'Secrets object is required' });
    }
    for (const [key, val] of Object.entries(secrets)) {
      if (key !== 'GMAIL_EMAIL' && key !== 'GMAIL_APP_PASSWORD') {
        continue; // Ignore unsupported secrets
      }
      if (key === 'GMAIL_APP_PASSWORD' && val === '••••••••••••••••') {
        continue; // Skip if it's the mask value
      }
      const cleanedVal = (val || '').trim();
      if (!cleanedVal) {
        await pool.query(
          `DELETE FROM user_secrets WHERE user_id = $1 AND secret_key = $2`,
          [req.user.id, key]
        );
      } else {
        await pool.query(
          `INSERT INTO user_secrets (user_id, secret_key, secret_value, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id, secret_key)
           DO UPDATE SET secret_value = EXCLUDED.secret_value, updated_at = NOW()`,
          [req.user.id, key, cleanedVal]
        );
      }
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[agent/secrets/post]', err.message);
    return res.status(500).json({ error: 'Failed to update secrets' });
  }
});

module.exports = router;
