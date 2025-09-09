'use strict';

// Vercel Serverless Function: Poll Telegram updates, persist simple tasks in Upstash,
// and send a nicely-formatted, RTL-friendly daily/hourly summary.

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // numeric string/number
const CRON_SECRET = process.env.CRON_SECRET; // optional shared secret for /api/cron
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Telegram helpers
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
  getUpdates: (offset) => t.api('getUpdates', {
    offset,
    // include reactions so a 👍 reaction (not reply) can close tasks
    allowed_updates: ['message', 'message_reaction'],
    timeout: 0,
  }),
  sendMessage: (chat_id, text, extra = {}) => t.api('sendMessage', {
    chat_id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  }),
};

// Minimal Upstash Redis REST client
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
  scan: async (cursor, match, count = 200) => {
    const qs = new URLSearchParams();
    if (match) qs.set('match', match);
    if (count) qs.set('count', String(count));
    const url = `${UPSTASH_URL}/scan/${encodeURIComponent(cursor)}${qs.toString() ? `?${qs.toString()}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    if (!res.ok) throw new Error(`Redis SCAN failed: ${res.status}`);
    const data = await res.json();
    // Upstash REST: { result: [nextCursor, [keys...]] }
    if (Array.isArray(data?.result) && data.result.length === 2) {
      const [next, keys] = data.result;
      return { cursor: String(next || '0'), keys: Array.isArray(keys) ? keys : [] };
    }
    return { cursor: '0', keys: [] };
  },
};

// Emoji helpers
const EMOJI_REGEX = /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/u;
const THUMBS_UP_RE = /\u{1F44D}(?:\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?/u; // 👍 with skin tones

function hasEmoji(text) {
  if (!text) return false;
  return EMOJI_REGEX.test(text);
}

// Directionality + HTML helpers for better RTL (Hebrew) rendering
const RLE = '\u202B'; // Right-to-Left Embedding
const PDF = '\u202C'; // Pop Directional Formatting
const LRM = '\u200E'; // Left-to-Right Mark

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function snippet(s, max = 140) {
  if (!s) return '';
  const clean = String(s).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function formatDate(ts) {
  try { return new Date(ts).toISOString().slice(0, 10); } catch { return ''; }
}

function ageDays(fromTs, nowTs = Date.now()) {
  if (!fromTs || fromTs > nowTs) return 0;
  return Math.floor((nowTs - fromTs) / (24 * 60 * 60 * 1000));
}

function taskTitle(text) {
  const first = String(text || '').split(/\r?\n/)[0].trim();
  return snippet(first, 200);
}

function formatTaskLine(t, nowTs) {
  const days = ageDays(t.createdAt, nowTs);
  const title = taskTitle(t.text);
  return `• ${htmlEscape(title)} <b>${LRM}[${days}d]</b>`;
}

// (No done section formatter needed)

function chunkMessages(lines, maxLen = 3800) {
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const add = (line ? line : '') + '\n';
    if ((cur + add).length > maxLen) {
      if (cur) chunks.push(cur);
      cur = '';
    }
    cur += add;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function extractReactionEmojis(r) {
  if (!r) return [];
  let arr = r.new_reaction || r.new_reactions || r.reaction || r.reactions || [];
  if (!Array.isArray(arr)) arr = [arr];
  const out = [];
  for (const it of arr) {
    if (!it) continue;
    if (typeof it === 'string') out.push(it);
    else if (typeof it.emoji === 'string') out.push(it.emoji);
    else if (typeof it.value === 'string') out.push(it.value);
  }
  return out;
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
    if (all.length > 2000) break; // safety cap
  }
  return { updates: all, nextOffset: offset };
}

module.exports = async (req, res) => {
  try {
    // Optional auth for external schedulers (GitHub Actions)
    if (CRON_SECRET) {
      let provided = '';
      try {
        const u = new URL(req.url || '', 'http://localhost');
        provided = u.searchParams.get('key') || '';
      } catch {}
      if (provided !== CRON_SECRET) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    if (!TG_TOKEN || !ADMIN_CHAT_ID) {
      res.status(500).json({ error: 'Missing env vars: TELEGRAM_BOT_TOKEN, ADMIN_CHAT_ID' });
      return;
    }

    const { updates } = await fetchAllUpdates(undefined);

    const haveKV = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
    if (haveKV) {
      // Apply updates to task store
      for (const u of updates) {
        // 1) Reactions (no reply needed)
        const mr = u.message_reaction || u.messageReaction;
        if (mr) {
          try {
            const chat = mr.chat;
            const actorId = mr.user?.id || mr.from?.id || u.user?.id || u.from?.id;
            if (chat && chat.type === 'private' && String(actorId) === String(ADMIN_CHAT_ID)) {
              const emojis = extractReactionEmojis(mr);
              const hasThumb = emojis.some((e) => typeof e === 'string' && THUMBS_UP_RE.test(e));
              const targetMsgId = mr.message_id || mr.message?.message_id || mr.msg_id;
              if (hasThumb && targetMsgId) {
                const taskKey = `task:${chat.id}:${targetMsgId}`;
                const val = await kv.get(taskKey);
                if (val) {
                  const obj = JSON.parse(val);
                  obj.done = true;
                  obj.doneAt = Date.now();
                  await kv.set(taskKey, JSON.stringify(obj));
                }
              }
            }
          } catch {}
          continue;
        }

        // 2) Messages (create tasks, support reply-with-👍 as fallback)
        const m = u.message;
        if (!m) continue;
        const chat = m.chat;
        if (!chat || chat.type !== 'private') continue; // DM only
        if (String(m.from?.id) !== String(ADMIN_CHAT_ID)) continue; // only your messages

        const text = m.text || m.caption || '';
        const isThumb = text ? THUMBS_UP_RE.test(text) : false;
        const keyBase = `task:${chat.id}:${m.message_id}`;

        if (m.reply_to_message) {
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
            } catch {}
          }
        } else {
          if (text && !isThumb) {
            const task = {
              id: `${chat.id}:${m.message_id}`,
              chat_id: chat.id,
              message_id: m.message_id,
              createdAt: (m.date || 0) * 1000,
              text: snippet(text, 400),
              done: false,
            };
            try { await kv.set(keyBase, JSON.stringify(task)); } catch {}
          }
        }
      }
    }

    const now = Date.now();
    const since = now - 24 * 60 * 60 * 1000;

    let lines = [];
    let header = '';
    // no done section

    if (haveKV) {
      // Build report from stored tasks
      const keys = [];
      try {
        let cursor = '0';
        const match = `task:${ADMIN_CHAT_ID}:*`;
        do {
          const out = await kv.scan(cursor, match, 200);
          cursor = out.cursor || '0';
          for (const k of out.keys || []) keys.push(k);
        } while (cursor !== '0' && keys.length < 5000);
      } catch {}

      const tasks = [];
      for (const k of keys) {
        try {
          const v = await kv.get(k);
          if (!v) continue;
          const obj = JSON.parse(v);
          if (!obj.done) tasks.push(obj);
        } catch {}
      }
      tasks.sort((a, b) => a.createdAt - b.createdAt);
      lines = tasks.map((t) => formatTaskLine(t, now));
      header = `<b>🟢 Open tasks: ${lines.length}</b>`;
    } else {
      // Fallback: no Upstash → report recent non-emoji messages (last 24h)
      const candidates = updates.filter((u) => {
        const m = u.message || u.channel_post;
        const ts = m?.date ? m.date * 1000 : 0;
        if (!ts || ts < since) return false;
        const text = m?.text || m?.caption || '';
        if (!text) return false;
        return !hasEmoji(text);
      });
      lines = candidates.map((u) => {
        const m = u.message || u.channel_post;
        const ts = m?.date ? m.date * 1000 : Date.now();
        const label = (m?.chat?.title || m?.chat?.username || `chat:${m?.chat?.id}`);
        const txt = snippet(m?.text || m?.caption || '');
        return `• <b>${htmlEscape(label)}</b> <i>${LRM}[${formatDate(ts)}]</i>: ${htmlEscape(txt)}`;
      });
      header = `<b>No-emoji messages in last 24h: ${lines.length}</b>`;
    }

    const payload = [];
    if (header) payload.push(header);
    if (lines.length) payload.push('', ...lines);
    const chunks = chunkMessages(payload.length ? payload : ['No data']);

    for (const chunk of chunks) {
      await t.sendMessage(ADMIN_CHAT_ID, `${RLE}${chunk}${PDF}`);
    }

    res.status(200).json({ ok: true, checked: updates.length, reported: lines.length });
  } catch (err) {
    console.error(err);
    try {
      if (TG_TOKEN && ADMIN_CHAT_ID) {
        await t.sendMessage(ADMIN_CHAT_ID, `Cron error: ${htmlEscape(err.message || String(err))}`);
      }
    } catch {}
    res.status(500).json({ error: String(err) });
  }
};
