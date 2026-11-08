// ghclone — lightweight GitHub-style code host on Cloudflare Workers + D1.
// Discord OAuth login, private/public repos, file tree, API keys, loadstring endpoint.

const enc = new TextEncoder();
const dec = new TextDecoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
}
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, enc.encode(msg));
}
const rand = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));

function cookies(req) {
  const out = {};
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

async function currentUser(env, req) {
  // 1) session cookie  2) Authorization: Bearer <api key>
  const sess = cookies(req).gh_session;
  if (sess) {
    const h = await sha256hex(sess);
    const row = await env.DB.prepare(
      `SELECT u.id, u.discord_id, u.username, u.avatar FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
    ).bind(h).first();
    if (row) return row;
  }
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (m) {
    const h = await sha256hex(m[1]);
    const row = await env.DB.prepare(
      `SELECT u.id, u.discord_id, u.username, u.avatar FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ?`
    ).bind(h).first();
    if (row) {
      env.DB.prepare(`UPDATE api_keys SET last_used = datetime('now') WHERE key_hash = ?`).bind(h).run().catch(() => {});
      return row;
    }
  }
  const xk = req.headers.get('x-api-key');
  if (xk) {
    const h = await sha256hex(xk);
    const row = await env.DB.prepare(
      `SELECT u.id, u.discord_id, u.avatar, u.username FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?`
    ).bind(h).first();
    if (row) return row;
  }
  return null;
}

async function repoByName(env, ownerName, repoName) {
  return env.DB.prepare(
    `SELECT r.*, u.username AS owner FROM repos r JOIN users u ON u.id = r.owner_id
     WHERE u.username = ? AND r.name = ?`
  ).bind(ownerName, repoName).first();
}

async function fileList(env, repoId) {
  const { results } = await env.DB.prepare(
    `SELECT path, size, updated_at FROM files WHERE repo_id = ? ORDER BY path`
  ).bind(repoId).all();
  return results || [];
}

// ---------- Discord OAuth ----------
function discordAuthorizeUrl(env, req) {
  const url = new URL(req.url);
  const redirect = `${url.origin}/api/auth/callback`;
  const state = rand(16);
  const q = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://discord.com/oauth2/authorize?${q}`,
      'set-cookie': setCookie('gh_oauth_state', state, 600),
    },
  });
}

async function discordCallback(env, req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const saved = cookies(req).gh_oauth_state;
  if (!code || !state || state !== saved) return json({ error: 'bad oauth state' }, 400);
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${url.origin}/api/auth/callback`,
    }),
  });
  if (!tokenRes.ok) return json({ error: 'discord token exchange failed' }, 502);
  const tok = await tokenRes.json();
  const meRes = await fetch('https://discord.com/api/users/@me', {
    headers: { authorization: `Bearer ${tok.access_token}` },
  });
  if (!meRes.ok) return json({ error: 'discord profile fetch failed' }, 502);
  const me = await meRes.json();

  let user = await env.DB.prepare(`SELECT * FROM users WHERE discord_id = ?`).bind(me.id).first();
  if (!user) {
    const avatar = me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` : null;
    await env.DB.prepare(`INSERT INTO users (discord_id, username, avatar) VALUES (?, ?, ?)`).bind(me.id, me.username, avatar).run();
    user = await env.DB.prepare(`SELECT * FROM users WHERE discord_id = ?`).bind(me.id).first();
  }
  const sess = rand(32);
  await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))`)
    .bind(await sha256hex(sess), user.id).run();
  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      'set-cookie': `${setCookie('gh_session', sess, 2592000)}, gh_oauth_state=; Path=/; Max-Age=0`,
    },
  });
}

async function logout(env, req) {
  const sess = cookies(req).gh_session;
  if (sess) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256hex(sess)).run();
  return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': 'gh_session=; Path=/; Max-Age=0' } });
}

// ---------- API ----------
async function api(env, req, url, user) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/health') return json({ ok: true, service: 'ghclone' });
  if (p === '/api/me') return user ? json(user) : json({ user: null });

  // public repo list
  if (p === '/api/repos' && m === 'GET') {
    const q = url.searchParams.get('q') || '';
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.name, r.description, r.private, r.created_at, r.updated_at, u.username AS owner,
              (SELECT COUNT(*) FROM files f WHERE f.repo_id = r.id) AS file_count
       FROM repos r JOIN users u ON u.id = r.owner_id
       WHERE (r.private = 0 OR r.owner_id = ?) AND (r.name LIKE ? OR u.username LIKE ?)
       ORDER BY r.updated_at DESC LIMIT 100`
    ).bind(user?.id ?? -1, `%${q}%`, `%${q}%`).all();
    return json({ repos: results || [] });
  }

  // create repo (auth)
  if (p === '/api/repos' && m === 'POST') {
    if (!user) return json({ error: 'login required' }, 401);
    const body = await req.json().catch(() => null);
    const name = String(body?.name || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return json({ error: 'invalid repo name' }, 400);
    const desc = String(body?.description || '').slice(0, 500);
    const priv = body?.private ? 1 : 0;
    try {
      await env.DB.prepare(`INSERT INTO repos (owner_id, name, description, private) VALUES (?, ?, ?, ?)`)
        .bind(user.id, name, desc, priv).run();
    } catch {
      return json({ error: 'repo already exists' }, 409);
    }
    // seed README
    await env.DB.prepare(`INSERT INTO files (repo_id, path, content, size)
      SELECT id, 'README.md', ?, ? FROM repos WHERE owner_id = ? AND name = ?`)
      .bind(`# ${name}\n\n${desc}\n`, 0, user.id, name).run();
    const repo = await repoByName(env, user.username, name);
    return json({ repo: { ...repo, owner: user.username } }, 201);
  }

  // repo detail + tree
  const rm = /^\/api\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
  if (rm) {
    const [, owner, name, rest = ''] = rm;
    const repo = await repoByName(env, owner, name);
    if (!repo) return json({ error: 'not found' }, 404);
    const isOwner = user && user.id === repo.owner_id;
    if (repo.private && !isOwner) return json({ error: 'not found' }, 404);

    if (!rest && m === 'GET') {
      const files = await fileList(env, repo.id);
      const { results: commits } = await env.DB.prepare(
        `SELECT c.sha, c.message, c.created_at, u.username AS author FROM commits c JOIN users u ON u.id = c.author_id
         WHERE c.repo_id = ? ORDER BY c.id DESC LIMIT 20`
      ).bind(repo.id).all();
      return json({ repo: { ...repo, owner: repo.owner }, files, commits: commits || [] });
    }

    // write files (owner only)
    if (rest === '/files' && m === 'PUT') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      const body = await req.json().catch(() => null);
      const writes = Array.isArray(body?.files) ? body.files : body?.path != null ? [{ path: body.path, content: body.content }] : null;
      if (!writes || !writes.length) return json({ error: 'files[] required' }, 400);
      const stmts = [];
      let total = 0;
      for (const f of writes.slice(0, 50)) {
        const fp = String(f.path || '').replace(/^\/+|\/+$/g, '');
        if (!fp || fp.length > 400 || fp.includes('..')) return json({ error: `bad path: ${fp}` }, 400);
        const content = String(f.content ?? '');
        if (content.length > 512 * 1024) return json({ error: `file too large: ${fp}` }, 413);
        total += content.length;
        if (total > 2 * 1024 * 1024) return json({ error: 'payload too large' }, 413);
        stmts.push(env.DB.prepare(
          `INSERT INTO files (repo_id, path, content, size, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(repo_id, path) DO UPDATE SET content = excluded.content, size = excluded.size, updated_at = datetime('now')`
        ).bind(repo.id, fp, content, content.length));
      }
      const message = String(body?.message || `update ${writes.length} file(s)`).slice(0, 200);
      const sha = (await sha256hex(`${repo.id}:${Date.now()}:${rand(8)}`)).slice(0, 12);
      stmts.push(env.DB.prepare(`INSERT INTO commits (repo_id, sha, message, author_id) VALUES (?, ?, ?, ?)`)
        .bind(repo.id, sha, message, user.id));
      stmts.push(env.DB.prepare(`UPDATE repos SET updated_at = datetime('now') WHERE id = ?`).bind(repo.id));
      await env.DB.batch(stmts);
      return json({ ok: true, sha, files: writes.length });
    }

    // raw file
    const fr = /^\/raw\/(.+)$/.exec(rest);
    if (fr && m === 'GET') {
      const fp = decodeURIComponent(fr[1]);
      const row = await env.DB.prepare(`SELECT content FROM files WHERE repo_id = ? AND path = ?`).bind(repo.id, fp).first();
      if (!row) return json({ error: 'not found' }, 404);
      return text(row.content, 200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=60',
      });
    }

    // file content JSON
    const ff = /^\/file\/(.+)$/.exec(rest);
    if (ff && m === 'GET') {
      const fp = decodeURIComponent(ff[1]);
      const row = await env.DB.prepare(`SELECT path, content, size, updated_at FROM files WHERE repo_id = ? AND path = ?`).bind(repo.id, fp).first();
      if (!row) return json({ error: 'not found' }, 404);
      return json(row);
    }

    // delete repo (owner)
    if (!rest && m === 'DELETE') {
      if (!isOwner) return json({ error: 'forbidden' }, 403);
      await env.DB.prepare(`DELETE FROM repos WHERE id = ?`).bind(repo.id).run();
      return json({ ok: true });
    }
  }

  // API keys
  if (p === '/api/keys' && m === 'GET') {
    if (!user) return json({ error: 'login required' }, 401);
    const { results } = await env.DB.prepare(
      `SELECT id, name, prefix, created_at, last_used FROM api_keys WHERE user_id = ? ORDER BY id DESC`
    ).bind(user.id).all();
    return json({ keys: results || [] });
  }
  if (p === '/api/keys' && m === 'POST') {
    if (!user) return json({ error: 'login required' }, 401);
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || 'default').slice(0, 60);
    const key = `ghk_${rand(24)}`;
    const hash = await sha256hex(key);
    const prefix = key.slice(0, 12);
    await env.DB.prepare(`INSERT INTO api_keys (user_id, name, key_hash, prefix) VALUES (?, ?, ?, ?)`)
      .bind(user.id, name, hash, prefix).run();
    return json({ key, prefix, name }, 201); // full key shown once
  }
  const km = /^\/api\/keys\/(\d+)$/.exec(p);
  if (km && m === 'DELETE') {
    if (!user) return json({ error: 'login required' }, 401);
    await env.DB.prepare(`DELETE FROM api_keys WHERE id = ? AND user_id = ?`).bind(Number(km[1]), user.id).run();
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

// ---------- loadstring ----------
// GET /loadstring/<owner>/<repo>/<path...> — serves a repo file for Roblox loadstring().
async function loadstring(env, req, url) {
  const m = /^\/loadstring\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!m) return json({ error: 'usage: /loadstring/<owner>/<repo>/<path>' }, 404);
  const [, owner, name, fp] = m;
  const repo = await repoByName(env, owner, name);
  if (!repo || repo.private) return json({ error: 'not found' }, 404);
  const row = await env.DB.prepare(`SELECT content FROM files WHERE repo_id = ? AND path = ?`).bind(repo.id, decodeURIComponent(fp)).first();
  if (!row) return json({ error: 'not found' }, 404);
  return text(row.content, 200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'public, max-age=300',
    'access-control-allow-origin': '*',
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/auth/discord')) return discordAuthorizeUrl(env, req);
      if (url.pathname === '/api/auth/callback') return discordCallback(env, req);
      if (url.pathname === '/api/auth/logout') return logout(env, req);
      if (url.pathname.startsWith('/loadstring/')) return loadstring(env, req, url);
      if (url.pathname.startsWith('/api/')) {
        const user = await currentUser(env, req);
        return api(env, req, url, user);
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      return json({ error: 'internal', detail: String(e?.message || e) }, 500);
    }
  },
};
