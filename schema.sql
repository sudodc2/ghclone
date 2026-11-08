CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  avatar TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  private INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_id, name)
);
CREATE INDEX IF NOT EXISTS idx_repos_owner ON repos(owner_id);
CREATE INDEX IF NOT EXISTS idx_repos_public ON repos(private, updated_at DESC);

CREATE TABLE IF NOT EXISTS files (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repo_id, path)
);
CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo_id);

CREATE TABLE IF NOT EXISTS commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  message TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits(repo_id, id DESC);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used TEXT
);
CREATE INDEX IF NOT EXISTS idx_keys_user ON api_keys(user_id);
