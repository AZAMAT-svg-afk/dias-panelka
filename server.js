const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 🔐 СЕКРЕТЫ — читаются из переменных окружения Render
//    Никогда не попадают в браузер!
// ============================================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const APPS_SECRET    = process.env.APPS_SECRET;
const APPS_URL       = process.env.APPS_URL;

if (!ADMIN_PASSWORD || !APPS_SECRET || !APPS_URL) {
  console.error('❌ Не заданы переменные окружения: ADMIN_PASSWORD, APPS_SECRET, APPS_URL');
  process.exit(1);
}

// ============================================================
// Сессии в памяти (token → время создания)
// ============================================================
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 минут

function createToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now();
}

function isValidToken(token) {
  if (!token || !sessions.has(token)) return false;
  const created = sessions.get(token);
  if (Date.now() - created > SESSION_TTL) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Чистим протухшие сессии каждые 10 минут
setInterval(() => {
  const now = Date.now();
  for (const [token, created] of sessions.entries()) {
    if (now - created > SESSION_TTL) sessions.delete(token);
  }
}, 10 * 60 * 1000);

// ============================================================
// Middleware — проверка токена
// ============================================================
function auth(req, res, next) {
  const token = req.headers['x-token'];
  if (!isValidToken(token)) {
    return res.status(401).json({ ok: false, error: 'Сессия истекла. Войдите снова.' });
  }
  // Продлеваем сессию при активности
  sessions.set(token, Date.now());
  next();
}

// ============================================================
// POST /api/login — проверяем пароль, выдаём токен
// ============================================================
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ ok: false, error: 'Нет пароля' });

  if (password === ADMIN_PASSWORD) {
    const token = createToken();
    sessions.set(token, Date.now());
    console.log(`[${new Date().toISOString()}] Успешный вход`);
    res.json({ ok: true, token });
  } else {
    console.log(`[${new Date().toISOString()}] Неверный пароль`);
    res.status(401).json({ ok: false, error: 'Неверный пароль' });
  }
});

// ============================================================
// POST /api/logout — удаляем токен
// ============================================================
app.post('/api/logout', (req, res) => {
  const token = req.headers['x-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// ============================================================
// GET /api/leads — получаем заявки из Google Sheets
// ============================================================
app.get('/api/leads', auth, async (req, res) => {
  try {
    const url = `${APPS_URL}?action=list&secret=${encodeURIComponent(APPS_SECRET)}&t=${Date.now()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Apps Script вернул ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error('Ошибка loadLeads:', e.message);
    res.status(502).json({ ok: false, error: 'Нет соединения с Google Sheets' });
  }
});

// ============================================================
// POST /api/action — одобрить / отказать / удалить заявку
// ============================================================
app.post('/api/action', auth, async (req, res) => {
  const { type, row, phone } = req.body || {};

  const allowed = ['approve', 'reject', 'delete'];
  if (!allowed.includes(type)) {
    return res.status(400).json({ ok: false, error: 'Недопустимый тип действия' });
  }
  if (!row) {
    return res.status(400).json({ ok: false, error: 'Нет row' });
  }

  try {
    const payload = { secret: APPS_SECRET, type, row, phone };
    const r = await fetch(APPS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    console.log(`[${new Date().toISOString()}] action=${type} row=${row} ok=${data.ok}`);
    res.json(data);
  } catch (e) {
    console.error('Ошибка action:', e.message);
    res.status(502).json({ ok: false, error: 'Нет соединения с Google Sheets' });
  }
});

// ============================================================
// Запуск
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
