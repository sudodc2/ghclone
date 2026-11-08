# ghclone

Lightweight GitHub-style code host on Cloudflare Workers + D1, with Discord login,
private/public repositories, a file tree, API keys, and a `loadstring()` endpoint
for serving Lua/Luau sources to Roblox executors.

Live: https://ghclone.pvpn-exit.workers.dev

## Features

- Discord OAuth2 login (identify scope) → HttpOnly session cookie (30 days)
- Repositories: public/private, description, file tree, commit log, raw/file views
- File writes via `PUT /api/repos/:owner/:repo/files` (owner only, ≤2 MB payload, ≤50 files/call)
- API keys (`ghk_…`): shown once, stored SHA-256 hashed; `Authorization: Bearer` or `X-API-Key`
- `GET /loadstring/<owner>/<repo>/<path>` → `text/plain` for Roblox `loadstring()` (public repos only)

## One-time Discord setup (required for login)

1. https://discord.com/developers/applications → **New Application**
2. **OAuth2 → General**: copy Client ID + Client Secret
3. **OAuth2 → Redirects**: add `https://ghclone.pvpn-exit.workers.dev/api/auth/callback`
4. Set secrets:

```powershell
npx wrangler secret put DISCORD_CLIENT_ID   # paste client id
npx wrangler secret put DISCORD_CLIENT_SECRET
```

Until secrets are set, browsing public repos works; login returns an error.

## Deploy / schema changes

```powershell
npx wrangler deploy                          # worker + public/ assets
npx wrangler d1 execute ghclone --remote --file=schema.sql   # first-time schema
```

D1 database `ghclone` (id `be032b09-514b-48e0-b484-562079d7a86a`, WNAM).

## API sketch

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/repos?q=` | optional | list/search repos |
| POST | `/api/repos` | session/key | create repo `{name, description, private}` |
| GET | `/api/repos/:owner/:repo` | owner for private | metadata + file list + commits |
| PUT | `/api/repos/:owner/:repo/files` | owner | write files `{files:[{path,content}], message}` |
| DELETE | `/api/repos/:owner/:repo` | owner | delete repo |
| GET | `/api/repos/:owner/:repo/raw/<path>` | repo visibility | raw file |
| GET | `/loadstring/:owner/:repo/<path>` | public only | Roblox loadstring source |
| POST/GET/DELETE | `/api/keys[/:id]` | session/key | manage API keys |

## Limits / honest scope

- File storage lives in D1 rows (≤512 KB/file, ≤2 MB/write call) — fine for scripts,
  not a real git object store. No git protocol (clone/push) support.
- Commit history is a message log, not a DAG.
- Rate limiting is Cloudflare's edge defaults; no app-level quotas yet.
