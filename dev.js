'use strict';

// Minimal local runner for Vercel-style API routes without Vercel CLI.
// - Loads .env (simple parser) if present
// - Serves /api/cron and /api/whoami on http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Simple .env loader (no deps)
function loadEnv(file = path.join(process.cwd(), '.env')) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
    console.log('Loaded .env');
  } catch (_) {}
}

loadEnv();

function wrapRes(res) {
  let statusCode = 200;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(obj) {
      const body = JSON.stringify(obj);
      res.statusCode = statusCode;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.end(body);
    },
    send(text) {
      const body = typeof text === 'string' ? text : String(text);
      res.statusCode = statusCode;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.end(body);
    },
    setHeader: (...args) => res.setHeader(...args),
    end: (...args) => res.end(...args),
  };
}

const routes = {
  '/api/cron': require('./api/cron.js'),
  '/api/whoami': require('./api/whoami.js'),
};

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const fn = routes[parsed.pathname];
  if (!fn) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  try {
    await fn(req, wrapRes(res));
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(PORT, () => {
  console.log(`Local server ready at http://localhost:${PORT}`);
});

