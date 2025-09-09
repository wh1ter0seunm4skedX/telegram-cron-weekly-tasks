'use strict';

// Helper endpoint: Lists recent chat IDs seen in pending updates
// Usage: DM your bot or send a message in a group it’s in, then open /api/whoami

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const t = {
  api: (method, params) => {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/${method}`;
    const body = params ? JSON.stringify(params) : undefined;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).then((r) => r.json());
  },
  getUpdates: async () => t.api('getUpdates', {
    allowed_updates: ['message', 'channel_post'],
    timeout: 0,
  }),
  getMe: async () => t.api('getMe'),
};

function extractChats(updates) {
  const seen = new Map();
  for (const u of updates || []) {
    const m = u.message || u.channel_post;
    if (!m || !m.chat) continue;
    const chat = m.chat;
    const id = chat.id;
    if (!seen.has(id)) {
      seen.set(id, {
        id,
        type: chat.type,
        title: chat.title || chat.username || undefined,
      });
    }
  }
  return Array.from(seen.values());
}

module.exports = async (req, res) => {
  try {
    if (!TG_TOKEN) {
      res.status(500).json({ error: 'Missing env var: TELEGRAM_BOT_TOKEN' });
      return;
    }
    const [me, updates] = await Promise.all([t.getMe(), t.getUpdates()]);
    const chats = extractChats((updates && updates.result) || []);
    res.status(200).json({
      ok: true,
      bot: me && me.result ? { id: me.result.id, username: me.result.username } : undefined,
      hint: 'Send a message to the bot or in a group it is in, then refresh to see chat IDs. Use your ID as ADMIN_CHAT_ID.',
      chats,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};

