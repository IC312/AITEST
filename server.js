/**
 * Hermes API Proxy - Node.js / Express
 * 
 * Chức năng:
 *  - Nhận request từ người dùng (OpenAI-compatible format)
 *  - Forward tới Hermes API (hermes.ai.unturf.com)
 *  - Gửi log về Discord webhook
 * 
 * Cài đặt:
 *   npm install express node-fetch cors
 * 
 * Chạy:
 *   node server.js
 *   # hoặc dùng PM2 để chạy nền:
 *   pm2 start server.js --name hermes-proxy
 */

import express  from 'express';
import cors     from 'cors';
import fetch    from 'node-fetch';

const app  = express();
const PORT = process.env.PORT || 3000;

const HERMES_ENDPOINT = 'https://hermes.ai.unturf.com/v1/chat/completions';
const HERMES_MODEL    = 'adamo1139/Hermes-3-Llama-3.1-8B-FP8-Dynamic';
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1488123370120675479/4_bSQ85iyUqUaM2Gp67-qemvbu5sn-hTj7NmJdzMVVSvuwys1jAfoLZQflGU0L15CZ4E';

// Tuỳ chọn: đặt API key riêng để bảo vệ proxy của bạn
// Nếu để rỗng ("") → cho phép tất cả mọi người gọi
const PROXY_SECRET_KEY = process.env.PROXY_SECRET_KEY || '';

app.use(cors());
app.use(express.json({ limit: '4mb' }));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get(['/', '/health'], (req, res) => {
  res.json({ status: 'ok', model: HERMES_MODEL });
});

app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
  const body      = req.body;
  const userIp    = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  const timestamp = new Date().toISOString();
  const messages  = body.messages || [];
  const isStream  = body.stream === true;

  // Override model
  const hermesBody = { ...body, model: HERMES_MODEL };

  // Gửi Discord log (không await, không block)
  sendDiscordLog({
    timestamp, userIp, userAgent, isStream,
    messageCount: messages.length,
    lastUserMsg:  getLastUserMessage(messages),
    model:        HERMES_MODEL,
  }).catch(() => {});

  try {
    const hermesRes = await fetch(HERMES_ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer dummy-api-key',
      },
      body: JSON.stringify(hermesBody),
    });

    // Streaming
    if (isStream) {
      res.setHeader('Content-Type',  'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Powered-By',  'uncloseai-proxy');
      hermesRes.body.pipe(res);
      return;
    }

    // Non-streaming
    const data = await hermesRes.json();
    res.status(hermesRes.status).json(data);

  } catch (err) {
    res.status(502).json({ error: 'Hermes upstream error', detail: err.message });
  }
});

// ─── Middleware ────────────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  if (!PROXY_SECRET_KEY) return next(); // không cần auth
  const authHeader = req.headers['authorization'] || '';
  const token      = authHeader.replace('Bearer ', '').trim();
  if (token !== PROXY_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const content = messages[i].content;
      if (typeof content === 'string') return content.slice(0, 200);
      if (Array.isArray(content)) {
        const textPart = content.find(c => c.type === 'text');
        return textPart?.text?.slice(0, 200) || '(no text)';
      }
    }
  }
  return '(no user message)';
}

async function sendDiscordLog({ timestamp, userIp, userAgent, isStream, messageCount, lastUserMsg, model }) {
  const embed = {
    title: '📨 New API Request',
    color: 0x7c6cff,
    fields: [
      { name: '🤖 Model',    value: model,                         inline: false },
      { name: '💬 Messages', value: `${messageCount} messages`,    inline: true  },
      { name: '🌊 Stream',   value: isStream ? 'Yes' : 'No',      inline: true  },
      { name: '🌐 IP',       value: userIp,                        inline: true  },
      { name: '📝 Last user message', value: lastUserMsg || '—',  inline: false },
      { name: '🖥 User-Agent', value: userAgent.slice(0, 100),    inline: false },
    ],
    timestamp,
    footer: { text: 'uncloseai proxy · hermes.ai.unturf.com' },
  };

  await fetch(DISCORD_WEBHOOK, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ embeds: [embed] }),
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ Hermes Proxy running on port ${PORT}`);
  console.log(`   Endpoint: POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`   Model:    ${HERMES_MODEL}`);
});
