// Accounts: GitHub OAuth and emailed one-time codes, cookie sessions.
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { loginPage, settingsPage, SITE_NAME } from './views.js';

const SESSION_DAYS = 30;
const CODE_TTL = 10 * 60;
const CODE_MAX_ATTEMPTS = 5;
// Sending limits for sign-in emails
const CODE_RESEND_AFTER = 60;
const CODES_PER_EMAIL_PER_HOUR = 5;
const CODES_PER_IP_PER_HOUR = 20;
const USERNAME_RE = /^[\p{L}\p{N}_-]{2,20}$/u;
const RESERVED_USERNAMES = new Set(['admin', 'root', 'system', 'moderator', 'support', 'api', 'login', 'logout', 'settings', '管理员']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Browsers resize avatars to 160px before upload (see app.js), so real uploads
// are a few KB; the limit covers uploads without JS.
const AVATAR_MAX_BYTES = 300 * 1024;

const now = () => Math.floor(Date.now() / 1000);

function randomToken(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const siteUrl = (c) => c.env.SITE_URL || new URL(c.req.url).origin;

// Only allow redirects back into this site. Browsers treat "/\\host" like
// "//host", and ignore tabs and newlines in URLs, so reject those too.
export function safeNext(next) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) && !/[\\\x00-\x1f\x7f]/.test(next) ? next : '/';
}

// ---------- avatars ----------

// Raster formats only: an SVG served from our origin could run script
function avatarType(bytes) {
  if (bytes.length < 64 || bytes.length > AVATAR_MAX_BYTES) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

async function saveAvatar(db, userId, bytes, contentType) {
  const t = now();
  await db.batch([
    db.prepare(`
      INSERT INTO avatars (user_id, content_type, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, updated_at = excluded.updated_at`)
      .bind(userId, contentType, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), t),
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(`/avatars/${userId}?v=${t}`, userId),
  ]);
}

// Copy a GitHub avatar into our own storage: githubusercontent.com is often
// unreachable from mainland China.
async function importGithubAvatar(db, userId, url) {
  try {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}s=160`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = avatarType(bytes);
    if (type) await saveAvatar(db, userId, bytes, type);
  } catch (err) {
    console.error('import github avatar failed', err.message);
  }
}

// ---------- sessions ----------

// Loads the signed-in user (if any) into c.get('user')
export async function sessionMiddleware(c, next) {
  const token = getCookie(c, 'sid');
  if (token) {
    const user = await c.env.DB.prepare(`
      SELECT u.*, (SELECT COUNT(*) FROM notifications n WHERE n.user_id = u.id AND n.read_at IS NULL) AS unread
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256(token), now()).first();
    if (user && !user.banned) c.set('user', user);
  }
  await next();
}

// Reject cross-site form posts. SameSite=Lax cookies already block most of
// these; checking Origin covers older browsers too.
export async function originCheck(c, next) {
  if (c.req.method === 'POST' && !c.req.path.startsWith('/api/admin')) {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.text('Forbidden', 403);
  }
  await next();
}

async function startSession(c, userId) {
  const token = randomToken();
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, now(), now() + SESSION_DAYS * 86400).run();
  setCookie(c, 'sid', token, {
    path: '/',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: SESSION_DAYS * 86400,
  });
}

// For actions that need an account with a username. Returns a Response to
// send instead when the user can't act yet, or null when they can.
export function requireUser(c, next) {
  const user = c.get('user');
  const wantsJson = c.req.header('Accept')?.includes('application/json');
  if (!user) {
    const login = `/login?next=${encodeURIComponent(safeNext(next))}`;
    return wantsJson ? c.json({ error: '请先登录', login }, 401) : c.redirect(login, 303);
  }
  if (!user.username) {
    const settings = `/settings?next=${encodeURIComponent(safeNext(next))}`;
    return wantsJson ? c.json({ error: '请先设置用户名', login: settings }, 401) : c.redirect(settings, 303);
  }
  return null;
}

// ---------- accounts ----------

// A free username based on `base`, e.g. a GitHub login; adds -2, -3… if taken
async function availableUsername(db, base) {
  let name = base.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 18);
  if (name.length < 2 || RESERVED_USERNAMES.has(name.toLowerCase())) name = `user${name}`;
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? name : `${name.slice(0, 17)}-${i}`;
    if (!(await db.prepare('SELECT 1 FROM users WHERE username = ?').bind(candidate).first())) return candidate;
  }
  return `${name.slice(0, 12)}-${randomToken(4).slice(0, 6)}`;
}

async function sendLoginCode(env, email, code) {
  const subject = `${code} 是你的 ${SITE_NAME} 登录验证码`;
  const text = `你的登录验证码是 ${code}，10 分钟内有效。\n\n如果不是你本人操作，请忽略这封邮件。`;
  // Local development: print the code instead of sending mail
  if (env.EMAIL_DEV_LOG === '1' || !env.EMAIL) {
    console.log(`[login code] ${email}: ${code}`);
    return;
  }
  await env.EMAIL.send({
    to: email,
    from: { email: env.EMAIL_FROM, name: SITE_NAME },
    subject,
    text,
    html: `<p>你的登录验证码是</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>10 分钟内有效。如果不是你本人操作，请忽略这封邮件。</p>`,
  });
}

export function registerAuthRoutes(app) {
  app.get('/login', (c) => {
    if (c.get('user')) return c.redirect(safeNext(c.req.query('next')));
    return c.html(loginPage({ site: siteUrl(c), next: safeNext(c.req.query('next')), github: Boolean(c.env.GITHUB_CLIENT_ID) }));
  });

  app.post('/logout', async (c) => {
    const token = getCookie(c, 'sid');
    if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    deleteCookie(c, 'sid', { path: '/' });
    return c.redirect('/', 303);
  });

  // ----- GitHub -----

  app.get('/login/github', (c) => {
    if (!c.env.GITHUB_CLIENT_ID) return c.text('GitHub 登录还没有配置', 503);
    const state = randomToken(16);
    setCookie(c, 'oauth_state', `${state}|${safeNext(c.req.query('next'))}`, {
      path: '/auth/github', httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax', maxAge: 600,
    });
    const params = new URLSearchParams({
      client_id: c.env.GITHUB_CLIENT_ID,
      redirect_uri: `${siteUrl(c)}/auth/github/callback`,
      scope: 'read:user user:email',
      state,
    });
    return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  app.get('/auth/github/callback', async (c) => {
    const [state, next] = (getCookie(c, 'oauth_state') ?? '').split('|');
    deleteCookie(c, 'oauth_state', { path: '/auth/github' });
    const site = siteUrl(c);
    const fail = (message) => c.html(loginPage({ site, next: safeNext(next), github: true, error: message }), 400);
    if (!state || state !== c.req.query('state') || !c.req.query('code')) return fail('GitHub 登录失败，请重试。');

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: c.env.GITHUB_CLIENT_ID,
        client_secret: c.env.GITHUB_CLIENT_SECRET,
        code: c.req.query('code'),
        redirect_uri: `${site}/auth/github/callback`,
      }),
    });
    const { access_token: accessToken } = await tokenRes.json();
    if (!accessToken) return fail('GitHub 登录失败，请重试。');
    const gh = (path) => fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': SITE_NAME },
    }).then((r) => (r.ok ? r.json() : null));
    const [profile, emails] = await Promise.all([gh('/user'), gh('/user/emails')]);
    if (!profile?.id) return fail('无法读取 GitHub 账号信息，请重试。');
    const email = emails?.find((e) => e.primary && e.verified)?.email ?? null;

    const db = c.env.DB;
    let user = await db.prepare('SELECT * FROM users WHERE github_id = ?').bind(profile.id).first();
    if (!user && email) {
      // Same verified email as an account made with an emailed code: link them
      user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      if (user) {
        await db.prepare('UPDATE users SET github_id = ?, github_login = ?, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?')
          .bind(profile.id, profile.login, profile.avatar_url, user.id).run();
      }
    }
    if (!user) {
      user = await db.prepare(`
        INSERT INTO users (username, email, github_id, github_login, avatar_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
        .bind(await availableUsername(db, profile.login), email, profile.id, profile.login, profile.avatar_url, now()).first();
    }
    if (user.banned) return fail('这个账号已被封禁。');
    if (!user.avatar_url?.startsWith('/avatars/') && profile.avatar_url) {
      c.executionCtx.waitUntil(importGithubAvatar(db, user.id, profile.avatar_url));
    }
    await startSession(c, user.id);
    return c.redirect(safeNext(next), 303);
  });

  // ----- emailed code -----

  app.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const email = String(form.email ?? '').trim().toLowerCase();
    const next = safeNext(form.next);
    const site = siteUrl(c);
    const wantsJson = c.req.header('Accept')?.includes('application/json');
    const retry = (error) => wantsJson
      ? c.json({ error }, 400)
      : c.html(loginPage({ site, next, github: Boolean(c.env.GITHUB_CLIENT_ID), email, error }), 400);
    if (!EMAIL_RE.test(email) || email.length > 254) return retry('请输入有效的邮箱地址。');

    const db = c.env.DB;
    const t = now();
    const ip = c.req.header('CF-Connecting-IP') ?? '';
    const [last, perEmail, perIp] = await Promise.all([
      db.prepare('SELECT MAX(created_at) AS t FROM email_codes WHERE email = ?').bind(email).first(),
      db.prepare('SELECT COUNT(*) AS n FROM email_codes WHERE email = ? AND created_at > ?').bind(email, t - 3600).first(),
      db.prepare('SELECT COUNT(*) AS n FROM email_codes WHERE ip = ? AND created_at > ?').bind(ip, t - 3600).first(),
    ]);
    if (last?.t && t - last.t < CODE_RESEND_AFTER) return retry('验证码刚刚发过，请 1 分钟后再试。');
    if (perEmail.n >= CODES_PER_EMAIL_PER_HOUR || perIp.n >= CODES_PER_IP_PER_HOUR) return retry('发送次数过多，请稍后再试。');

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
    await db.prepare('INSERT INTO email_codes (email, code_hash, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(email, await sha256(`${email}:${code}`), ip, t, t + CODE_TTL).run();
    try {
      await sendLoginCode(c.env, email, code);
    } catch (err) {
      console.error('send login code failed', err.code, err.message);
      return retry('验证码发送失败，请稍后再试。');
    }
    if (wantsJson) return c.json({ sent: true, email });
    return c.html(loginPage({ site, next, github: Boolean(c.env.GITHUB_CLIENT_ID), email, verifying: true }));
  });

  app.post('/login/verify', async (c) => {
    const form = await c.req.parseBody();
    const email = String(form.email ?? '').trim().toLowerCase();
    const code = String(form.code ?? '').replace(/\D/g, '');
    const next = safeNext(form.next);
    const site = siteUrl(c);
    const db = c.env.DB;

    const row = await db.prepare(`
      SELECT * FROM email_codes WHERE email = ? AND used_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`).bind(email, now()).first();
    if (!row || row.attempts >= CODE_MAX_ATTEMPTS) {
      return c.html(loginPage({ site, next, github: Boolean(c.env.GITHUB_CLIENT_ID), email, verifying: true, error: '验证码已失效，请重新获取。' }), 400);
    }
    if (row.code_hash !== (await sha256(`${email}:${code}`))) {
      await db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
      const left = CODE_MAX_ATTEMPTS - row.attempts - 1;
      return c.html(loginPage({
        site, next, github: Boolean(c.env.GITHUB_CLIENT_ID), email, verifying: true,
        error: left > 0 ? `验证码不正确，还可以再试 ${left} 次。` : '验证码已失效，请重新获取。',
      }), 400);
    }
    await db.prepare('UPDATE email_codes SET used_at = ? WHERE id = ?').bind(now(), row.id).run();

    let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (!user) {
      user = await db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?) RETURNING *').bind(email, now()).first();
    }
    if (user.banned) return c.html(loginPage({ site, next, github: Boolean(c.env.GITHUB_CLIENT_ID), error: '这个账号已被封禁。' }), 403);
    await startSession(c, user.id);
    // New email accounts pick a username before they can take part
    return c.redirect(user.username ? next : `/settings?next=${encodeURIComponent(next)}`, 303);
  });

  // ----- username -----

  app.get('/settings', (c) => {
    const user = c.get('user');
    if (!user) return c.redirect('/login?next=/settings');
    return c.html(settingsPage({ site: siteUrl(c), user, next: safeNext(c.req.query('next')) }));
  });

  app.post('/settings/avatar', async (c) => {
    const user = c.get('user');
    if (!user) return c.redirect('/login?next=/settings', 303);
    const form = await c.req.parseBody();
    const file = form.avatar;
    const fail = (error) => c.html(settingsPage({ site: siteUrl(c), user, next: '/settings', avatarError: error }), 400);
    if (!file || typeof file === 'string' || !file.size) return fail('请选择一张图片。');
    if (file.size > AVATAR_MAX_BYTES) return fail('图片太大了，请换一张小于 300 KB 的图片。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = avatarType(bytes);
    if (!type) return fail('只支持 PNG、JPEG、WebP 和 GIF 图片。');
    await saveAvatar(c.env.DB, user.id, bytes, type);
    return c.redirect('/settings', 303);
  });

  app.post('/settings/avatar/delete', async (c) => {
    const user = c.get('user');
    if (!user) return c.redirect('/login?next=/settings', 303);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM avatars WHERE user_id = ?').bind(user.id),
      c.env.DB.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?').bind(user.id),
    ]);
    return c.redirect('/settings', 303);
  });

  app.post('/settings', async (c) => {
    const user = c.get('user');
    if (!user) return c.redirect('/login?next=/settings', 303);
    const form = await c.req.parseBody();
    const username = String(form.username ?? '').trim();
    const next = safeNext(form.next);
    const retry = (error) => c.html(settingsPage({ site: siteUrl(c), user, next, username, error }), 400);
    if (!USERNAME_RE.test(username)) return retry('用户名需要 2–20 个字符，只能包含文字、数字、下划线和连字符。');
    if (RESERVED_USERNAMES.has(username.toLowerCase())) return retry('这个用户名不能使用。');
    const taken = await c.env.DB.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').bind(username, user.id).first();
    if (taken) return retry('这个用户名已经被占用了。');
    await c.env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(username, user.id).run();
    return c.redirect(next === '/settings' ? '/' : next, 303);
  });
}
