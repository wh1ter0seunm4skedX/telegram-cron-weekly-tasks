

'use strict';

// Vercel Serverless Function: Daily cron to poll Telegram updates,
// track last update_id in Upstash Redis, filter messages without emoji
// from the last 24 hours, and send a concise summary to ADMIN_CHAT_ID.

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // your user or chat ID (number)
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL; // optional but required for tasks persistence
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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
  getUpdates: async (offset) => {
    return t.api('getUpdates', {
      offset,
      allowed_updates: ['message'],
      timeout: 0,
    });
  },
  sendMessage: async (chat_id, text, extra = {}) => {
    return t.api('sendMessage', { chat_id, text, disable_web_page_preview: true, ...extra });
  },
};

// Minimal Upstash Redis client for tasks persistence
const kv = {
  get: async (key) => {
    const url = `${UPSTASH_URL}/get/${encodeURIComponent(key)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    if (!res.ok) throw new Error(`Redis GET failed: ${res.status}`);
    const data = await res.json();
    return data.result ?? null;
  },
  set: async (key, value) => {
    const url = `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(String(value))}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    if (!res.ok) throw new Error(`Redis SET failed: ${res.status}`);
    const data = await res.json();
    return data.result === 'OK';
  },
  scan: async (cursor, match, count = 100) => {
    const qs = new URLSearchParams();
    if (match) qs.set('match', match);
    if (count) qs.set('count', String(count));
    const url = `${UPSTASH_URL}/scan/${encodeURIComponent(cursor)}${qs.toString() ? `?${qs.toString()}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    if (!res.ok) throw new Error(`Redis SCAN failed: ${res.status}`);
    const data = await res.json();
    return data; // { cursor: '0'|'next', results: [keys] }
  },
};

// Reasonable emoji detection without external deps.
// Covers common emoji blocks; not perfect but practical for filtering.
const EMOJI_REGEX = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/u;

function hasEmoji(text) {
  if (!text) return false;
  return EMOJI_REGEX.test(text);
}

function snippet(s, max = 140) {
  if (!s) return '';
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function chatLabel(update) {
  const m = update.message || update.channel_post;
  if (!m) return 'unknown';
  const chat = m.chat || {};
  return chat.title || chat.username || `chat:${chat.id}`;
}

function messageDate(update) {
  const m = update.message || update.channel_post;
  if (!m) return 0;
  return (m.date || 0) * 1000; // seconds -> ms
}

function messageText(update) {
  const m = update.message || update.channel_post;
  if (!m) return '';
  return m.text || m.caption || '';
}

function formatTime(ts) {
  const d = new Date(ts);
  // ISO without seconds for compactness, in UTC
  return d.toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');
}

function chunkMessages(lines, maxLen = 3800) {
  // Telegram max is ~4096; keep margin
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    if ((cur + line + '\n').length > maxLen) {
      if (cur) chunks.push(cur);
      cur = '';
    }
    cur += line + '\n';
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function fetchAllUpdates(startOffset) {
  let offset = startOffset;
  const all = [];
  while (true) {
    const resp = await t.getUpdates(offset);
    if (!resp.ok) throw new Error(`getUpdates error: ${JSON.stringify(resp)}`);
    const updates = resp.result || [];
    if (updates.length === 0) break;
    all.push(...updates);
    offset = updates[updates.length - 1].update_id + 1;
    // Safety: cap batch loops to avoid long cold starts
    if (all.length > 2000) break;
  }
  return { updates: all, nextOffset: offset };
}

module.exports = async (req, res) => {
  try {
    if (!TG_TOKEN || !ADMIN_CHAT_ID) {
      res.status(500).json({ error: 'Missing env vars: TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID' });
      return;
    }

    // Drain all pending updates for this bot in this run.
    // Telegram will consider older updates acknowledged as we advance the offset in the loop above.
    const { updates } = await fetchAllUpdates(undefined);

    // Process updates into a simple task list stored in Redis.
    // Rules (simple, explicit):
    // - Any private chat message FROM ADMIN_CHAT_ID that is not just '👍' and not a reply => new task
    // - Any private chat message that REPLIES to a task and contains a '👍' => mark that task done

    const haveKV = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
    if (!haveKV) {
      // If no storage configured, we can still send a daily summary for last 24h, but not a persistent task list
      // Fall through to the previous behavior below
    } else {
      for (const u of updates) {
        const m = u.message;
        if (!m) continue;
        const chat = m.chat;
        if (!chat || chat.type !== 'private') continue; // restrict to DM with you
        if (String(m.from?.id) !== String(ADMIN_CHAT_ID)) continue; // only your messages

        const text = m.text || m.caption || '';
        const isThumb = text && text.includes('👍');
        const keyBase = `task:${chat.id}:${m.message_id}`;

        if (m.reply_to_message) {
          // If you reply with 👍 to a prior message, mark that prior message as done
          if (isThumb) {
            const replied = m.reply_to_message;
            const taskKey = `task:${chat.id}:${replied.message_id}`;
            try {
              const val = await kv.get(taskKey);
              if (val) {
                const obj = JSON.parse(val);
                obj.done = true;
                obj.doneAt = Date.now();
                await kv.set(taskKey, JSON.stringify(obj));
              }
            } catch (_) {}
          }
        } else {
          // New task, if not just a thumbs up
          if (text && !isThumb) {
            const task = {
              id: `${chat.id}:${m.message_id}`,
              chat_id: chat.id,
              message_id: m.message_id,
              createdAt: (m.date || 0) * 1000,
              text: snippet(text, 400),
              done: false,
            };
            try {
              await kv.set(keyBase, JSON.stringify(task));
            } catch (_) {}
          }
        }
      }
    }

    const now = Date.now();
    const since = now - 24 * 60 * 60 * 1000; // last 24h

    let lines = [];
    let header = '';
    if (haveKV) {
      // Build report from stored tasks that are not done
      const keys = [];
      try {
        let cursor = '0';
        const match = `task:${ADMIN_CHAT_ID}:*`;
        do {
          const out = await kv.scan(cursor, match, 200);
          cursor = out.cursor || '0';
          for (const k of out.result || out.results || []) keys.push(k);
        } while (cursor !== '0' && keys.length < 5000);
      } catch (e) {
        // ignore scan errors, fallback below
      }
      const tasks = [];
      for (const k of keys) {
        try {
          const v = await kv.get(k);
          if (!v) continue;
          const obj = JSON.parse(v);
          if (!obj.done) tasks.push(obj);
        } catch (_) {}
      }
      tasks.sort((a, b) => a.createdAt - b.createdAt);
      lines = tasks.map((t) => `- [${formatTime(t.createdAt)}] ${snippet(t.text)}`);
      header = `Open tasks: ${lines.length}`;
    } else {
      // Fallback to previous no-emoji-in-24h behavior (no persistence)
      const candidates = updates.filter((u) => {
        const ts = messageDate(u);
        if (!ts || ts < since) return false;
        const text = messageText(u);
        if (!text) return false;
        return !hasEmoji(text);
      });
      lines = candidates.map((u) => {
        const ts = formatTime(messageDate(u));
        const label = chatLabel(u);
        const text = snippet(messageText(u));
        return `- [${ts}] ${label}: ${text}`;
      });
      header = `No-emoji messages in last 24h: ${lines.length}`;
    }

    const chunks = chunkMessages(lines.length ? [header, '', ...lines] : [header]);

    // Always notify to confirm cron ran, even if none found
    for (const chunk of chunks) {
      await t.sendMessage(ADMIN_CHAT_ID, chunk);
    }

    res.status(200).json({ ok: true, checked: updates.length, reported: lines.length });
  } catch (err) {
    console.error(err);
    try {
      if (TG_TOKEN && ADMIN_CHAT_ID) {
        await t.sendMessage(ADMIN_CHAT_ID, `Cron error: ${err.message || String(err)}`);
      }
    } catch (_) {}
    res.status(500).json({ error: String(err) });
  }
};
