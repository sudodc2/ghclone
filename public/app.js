// ghclone SPA — hash router, no framework.
const app = document.getElementById('app');
const usernav = document.getElementById('usernav');
const search = document.getElementById('search');
let ME = null;

const api = async (path, opts = {}) => {
  const r = await fetch('/api' + path, { credentials: 'same-origin', ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = (msg) => { const t = document.getElementById('toast'); t.textContent = msg; t.style.display = 'block'; setTimeout(() => t.style.display = 'none', 3500); };

async function boot() {
  try { ME = (await api('/me')).user; } catch { ME = null; }
  renderNav();
  route();
}
function renderNav() {
  if (ME) {
    usernav.innerHTML = `<a href="#/new">+ New</a><a href="#/keys">Keys</a>
      <img src="${esc(ME.avatar || '')}" onerror="this.style.display='none'" alt="">
      <span class="mono">${esc(ME.username)}</span>
      <a href="/api/auth/logout">Logout</a>`;
  } else {
    usernav.innerHTML = `<a class="btn" href="/api/auth/discord">Login with Discord</a>`;
  }
}

function route() {
  const h = location.hash || '#/';
  const parts = h.slice(2).split('/').filter(Boolean);
  app.innerHTML = '<p class="muted">Loading…</p>';
  if (parts.length === 0) return viewRepos('');
  if (parts[0] === 'new') return viewNew();
  if (parts[0] === 'keys') return viewKeys();
  if (parts.length >= 2) return viewRepo(parts[0], parts[1], parts.slice(2).join('/'));
  viewRepos('');
}
window.addEventListener('hashchange', route);
search.addEventListener('input', () => viewRepos(search.value));

async function viewRepos(q) {
  const { repos } = await api('/repos?q=' + encodeURIComponent(q));
  app.innerHTML = `<h2>Repositories</h2>` + (repos.length ? repos.map(r => `
    <div class="card"><h3><a href="#/${esc(r.owner)}/${esc(r.name)}">${esc(r.owner)}/${esc(r.name)}</a>
      ${r.private ? '<span class="badge">private</span>' : ''}</h3>
      <div>${esc(r.description) || '<span class="muted">No description</span>'}</div>
      <div class="meta">${r.file_count} files · updated ${esc((r.updated_at || '').slice(0, 10))}</div></div>`).join('')
    : '<p class="muted">No repositories yet.</p>');
}

async function viewRepo(owner, name, filePath) {
  const { repo, files, commits } = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  const isOwner = ME && ME.username === repo.owner;
  const tree = files.map(f => `<div data-p="${esc(f.path)}">📄 ${esc(f.path)} <span class="muted">${fmtSize(f.size)}</span></div>`).join('');
  app.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <h2 style="margin:0"><span class="muted">${esc(repo.owner)}/</span>${esc(repo.name)}</h2>
      ${repo.private ? '<span class="badge">private</span>' : ''}
      ${isOwner ? `<button class="secondary" id="del">Delete</button>` : ''}
    </div>
    <p class="muted">${esc(repo.description)}</p>
    <div class="loadstring-box">loadstring: <code id="ls">${location.origin}/loadstring/${esc(repo.owner)}/${esc(repo.name)}/README.md</code>
      <button class="secondary" id="copy" style="margin-left:8px;padding:2px 8px">copy</button></div>
    <div class="split">
      <div>
        <h4>Files</h4><div class="tree" id="tree">${tree || '<span class="muted">empty</span>'}</div>
        <h4 style="margin-top:20px">Commits</h4>
        ${commits.map(c => `<div class="commit"><span class="sha">${esc(c.sha)}</span> ${esc(c.message)}<br><span class="muted">${esc(c.author)} · ${esc((c.created_at || '').slice(0, 16))}</span></div>`).join('') || '<span class="muted">none</span>'}
      </div>
      <div>
        <div class="row" style="margin-bottom:8px"><strong id="fname" class="mono">${esc(filePath || 'select a file')}</strong>
          ${isOwner ? `<button class="secondary" id="edit" style="margin-left:auto">Edit</button>` : ''}</div>
        <div class="fileview"><pre id="fcontent">${filePath ? 'loading…' : 'Pick a file on the left.'}</pre></div>
        ${isOwner ? `<div id="editor" style="display:none;margin-top:12px">
          <textarea id="editarea" spellcheck="false"></textarea>
          <div class="row" style="margin-top:8px"><input id="editmsg" type="text" placeholder="commit message" style="flex:1">
          <button id="save">Commit</button><button class="secondary" id="cancel">Cancel</button></div></div>` : ''}
      </div>
    </div>`;

  document.getElementById('copy')?.addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('ls').textContent); toast('loadstring URL copied');
  });
  document.getElementById('del')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${repo.owner}/${repo.name}?`)) return;
    await api(`/repos/${owner}/${name}`, { method: 'DELETE' }); location.hash = '#/';
  });
  const showFile = async (fp) => {
    document.getElementById('fname').textContent = fp;
    document.getElementById('fcontent').textContent = 'loading…';
    try {
      const f = await api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/file/${encodeURIComponent(fp)}`);
      document.getElementById('fcontent').textContent = f.content;
      document.getElementById('ls').textContent = `${location.origin}/loadstring/${repo.owner}/${repo.name}/${fp}`;
      if (document.getElementById('editarea')) document.getElementById('editarea').value = f.content;
    } catch (e) { document.getElementById('fcontent').textContent = 'error: ' + e.message; }
  };
  document.getElementById('tree').addEventListener('click', (e) => {
    const d = e.target.closest('[data-p]'); if (d) { location.hash = `#/${owner}/${name}/${d.dataset.p}`; }
  });
  if (filePath) showFile(filePath);
  else if (files[0]) showFile(files[0].path);

  const editBtn = document.getElementById('edit');
  if (editBtn) editBtn.addEventListener('click', () => {
    const ed = document.getElementById('editor'); ed.style.display = ed.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('cancel')?.addEventListener('click', () => document.getElementById('editor').style.display = 'none');
  document.getElementById('save')?.addEventListener('click', async () => {
    const fp = document.getElementById('fname').textContent;
    const content = document.getElementById('editarea').value;
    const message = document.getElementById('editmsg').value || `update ${fp}`;
    try {
      const r = await api(`/repos/${owner}/${name}/files`, { method: 'PUT',
        body: JSON.stringify({ files: [{ path: fp, content }], message }) });
      toast(`committed ${r.sha}`); route();
    } catch (e) { toast(e.message); }
  });
}

function viewNew() {
  if (!ME) { app.innerHTML = '<p class="muted">Log in with Discord to create repositories. <a href="/api/auth/discord">Login</a></p>'; return; }
  app.innerHTML = `<h2>New repository</h2><div class="card" style="max-width:560px">
    <label>Name</label><input id="rname" type="text" placeholder="my-script">
    <label>Description</label><input id="rdesc" type="text" placeholder="what it does">
    <label class="row"><input type="checkbox" id="rpriv" style="width:auto"> Private repository</label>
    <div style="margin-top:14px"><button id="rcreate">Create</button></div></div>`;
  document.getElementById('rcreate').addEventListener('click', async () => {
    try {
      const { repo } = await api('/repos', { method: 'POST', body: JSON.stringify({
        name: document.getElementById('rname').value, description: document.getElementById('rdesc').value,
        private: document.getElementById('rpriv').checked }) });
      location.hash = `#/${repo.owner}/${repo.name}`;
    } catch (e) { toast(e.message); }
  });
}

async function viewKeys() {
  if (!ME) { app.innerHTML = '<p class="muted">Log in required. <a href="/api/auth/discord">Login</a></p>'; return; }
  const { keys } = await api('/keys');
  app.innerHTML = `<h2>API keys</h2>
    <div class="card" style="max-width:640px">
      <p class="muted">Keys authenticate API requests via <code>Authorization: Bearer ghk_…</code> or <code>X-API-Key</code>. The full key is shown once at creation.</p>
      <div class="row"><input id="kname" type="text" placeholder="key name" style="flex:1"><button id="kcreate">Create key</button></div>
      <div id="newkey"></div>
      <table style="width:100%;margin-top:14px;border-collapse:collapse">
      ${keys.map(k => `<tr><td class="mono">${esc(k.prefix)}…</td><td>${esc(k.name)}</td>
        <td class="muted">${esc((k.last_used || 'never').slice(0, 10))}</td>
        <td><button class="danger" data-id="${k.id}">revoke</button></td></tr>`).join('')}
      </table></div>`;
  document.getElementById('kcreate').addEventListener('click', async () => {
    try {
      const r = await api('/keys', { method: 'POST', body: JSON.stringify({ name: document.getElementById('kname').value || 'default' }) });
      document.getElementById('newkey').innerHTML = `<div class="loadstring-box">store this now — shown once:<br><code>${esc(r.key)}</code></div>`;
      route();
    } catch (e) { toast(e.message); }
  });
  app.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', async () => {
    await api('/keys/' + b.dataset.id, { method: 'DELETE' }); route();
  }));
}

const fmtSize = (n) => n > 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B';
boot();
