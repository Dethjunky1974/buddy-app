import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/fit.mjs';

const $ = id => document.getElementById(id);
const savedSettings = engine => { try { return JSON.parse(localStorage.getItem(`buddy-${engine}-settings`) || '{}'); } catch { return {}; } };
const claudeModels = [
  { name: 'Fable 5.1', id: 'claude-fable-5-1', description: 'For your toughest challenges' },
  { name: 'Opus 5.5', id: 'claude-opus-5-5', description: 'For complex work and everyday tasks' },
  { name: 'Sonnet 5.5', id: 'claude-sonnet-5-5', description: 'Most efficient for simpler tasks' },
  { name: 'Haiku 4.5', id: 'claude-haiku-4-5-20251001', description: 'Fastest for quick answers' }
];
const codexModels = [
  { name: 'GPT-6.1 Sol', id: 'gpt-6.1-sol', description: 'Latest workhorse for coding and everyday work' },
  { name: 'GPT-6 Astra', id: 'gpt-6-astra', description: 'Frontier intelligence for demanding work' },
  { name: 'GPT-6 Sol', id: 'gpt-6-sol', description: 'Previous generation workhorse model' },
  { name: 'GPT-6 Luna', id: 'gpt-6-luna', description: 'Fast model for simpler tasks' }
];
const tabId = sessionStorage.getItem('buddy-tab-id') || crypto.randomUUID();
sessionStorage.setItem('buddy-tab-id', tabId);
const state = {
  target: 'codex', skillEngine: 'codex', catalog: { codex: [], claude: [] }, selectedSkill: null,
  commands: { codex: [], claude: [] }, sockets: {}, terms: {}, fit: {}, context: '',
  project: localStorage.getItem('buddy-project') || '',
  workspace: localStorage.getItem('buddy-workspace') || '',
  settings: { codex: savedSettings('codex'), claude: savedSettings('claude') }, modelDialogEngine: 'codex',
  vault: { mode: 'none', name: '', path: '', remote: '' }, vaultSyncOk: true,
  running: { codex: false, claude: false }, retries: { codex: 0, claude: 0 }
};
const toast = (message, error = false) => {
  const el = $('toast'); el.textContent = message; el.classList.toggle('error', error); el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 5000);
};
async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function boot() {
  const status = await api('/api/status');
  state.vault = status.vault;
  state.workspace ||= status.defaultWorkspace;
  $('workspace').value = state.workspace;
  renderVault();
  $('retrySaves').hidden = !status.pendingCount;
  if (status.pendingCount) $('retrySaves').textContent = `Retry ${status.pendingCount} queued save${status.pendingCount === 1 ? '' : 's'}`;
  await loadProjects();
  if (!await refreshCatalog() && state.workspace !== status.defaultWorkspace) {
    state.workspace = status.defaultWorkspace;
    localStorage.setItem('buddy-workspace', state.workspace);
    $('workspace').value = state.workspace;
    await refreshCatalog();
  }
  for (const engine of ['codex', 'claude']) createTerminal(engine);
  for (const engine of ['codex', 'claude']) updateModelLabel(engine);
  bind();
}

async function loadProjects() {
  try {
    const data = await api('/api/projects');
    setVaultStatus(data.sync);
    if (!data.sync?.ok) {
      state.context = '';
      $('contextFiles').textContent = 'Vault sync needs attention. You can still send without project context.';
      return;
    }
    const select = $('project');
    select.replaceChildren(new Option('Select a project', ''));
    for (const p of data.projects) select.add(new Option(p, p));
    if (data.projects.includes(state.project)) select.value = state.project;
    await refreshContext();
  } catch (error) { setVaultStatus({ ok: false, error: error.message }); }
}
function openNewProject() {
  $('projectName').value = '';
  $('projectError').hidden = true;
  $('projectDialog').showModal();
  $('projectName').focus();
}
async function createNewProject() {
  const button = $('createProject');
  if (button.disabled) return;
  $('projectError').hidden = true;
  button.disabled = true;
  try {
    const result = await api('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('projectName').value }) });
    state.project = result.name;
    localStorage.setItem('buddy-project', state.project);
    $('projectDialog').close();
    await loadProjects();
    if (![...$('project').options].some(option => option.value === result.name)) $('project').add(new Option(result.name, result.name));
    $('project').value = result.name;
    await refreshContext();
    toast(result.error ? `Project created locally; GitHub sync needs attention: ${result.error}` : `Project "${result.name}" created`, !!result.error);
  } catch (error) {
    $('projectError').textContent = error.message;
    $('projectError').hidden = false;
  } finally { button.disabled = false; }
}
function setVaultStatus(sync) {
  const el = $('vaultStatus');
  el.classList.toggle('bad', !sync?.ok);
  el.querySelector('span:last-child').textContent = !sync?.ok ? (sync?.error || `Vault: ${sync?.status || 'needs attention'}`)
    : sync.status === 'local_only' ? 'Local sessions on this Mac'
    : sync.status === 'local_vault' ? 'Local vault connected'
    : 'Vault current with GitHub';
}
function renderVault() {
  const vault = state.vault;
  $('vaultLabel').textContent = vault.mode === 'none' ? 'VAULT · OPTIONAL' : `${vault.name.toUpperCase()} · ${vault.mode === 'github' ? 'GITHUB' : 'LOCAL'}`;
  $('vaultPath').textContent = vault.mode === 'none' ? 'Add an Obsidian vault if you want shared project context.' : vault.path;
  $('project').disabled = vault.mode === 'none';
  $('newProject').disabled = vault.mode === 'none';
  $('vaultHelp').textContent = vault.mode === 'none' ? 'Prompts work without a vault. Session records stay on this Mac.' : 'Current project notes are included when you send. Sessions save to this vault.';
}
async function refreshContext() {
  state.project = $('project').value;
  localStorage.setItem('buddy-project', state.project);
  if (!state.project) { state.context = ''; $('contextFiles').textContent = state.vault.mode === 'none' ? 'No vault connected.' : 'Choose a project to load current notes.'; return; }
  const data = await api(`/api/context?project=${encodeURIComponent(state.project)}`);
  setVaultStatus(data.sync);
  state.vaultSyncOk = !!data.sync?.ok;
  state.context = data.context || '';
  $('contextFiles').replaceChildren();
  if (data.paths?.length) for (const file of data.paths) {
    const row = document.createElement('div'); row.className = 'context-file'; row.textContent = `${state.project} / ${file}`; $('contextFiles').append(row);
  } else $('contextFiles').textContent = !data.sync?.ok ? 'Vault sync needs attention. You can still send without project context.' : data.error || 'No hot.md or index.md found.';
}
async function refreshCatalog() {
  try { state.catalog = await api(`/api/catalog?workspace=${encodeURIComponent(state.workspace)}`); renderSkills(); return true; }
  catch (error) { toast(error.message, true); return false; }
}

function createTerminal(engine) {
  const term = new Terminal({ cursorBlink: true, fontFamily: 'SFMono-Regular, Menlo, Monaco, monospace', fontSize: 12.5,
    lineHeight: 1.48, scrollback: 5000, theme: { background: '#151719', foreground: '#dadfdd', cursor: '#d4a875', selectionBackground: '#6d685b88', black: '#24292a', red: '#e88b83', green: '#9bbd9b', yellow: '#d5b985', blue: '#96aec9', magenta: '#c9a8bd', cyan: '#90bdc3', white: '#e4e7e4', brightBlack: '#696f6e', brightWhite: '#ffffff' } });
  const fit = new FitAddon(); term.loadAddon(fit); term.open($(`${engine}Terminal`));
  state.terms[engine] = term; state.fit[engine] = fit;
  term.onData(data => { const ws = state.sockets[engine]; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data })); });
  new ResizeObserver(() => { try { fit.fit(); resize(engine); } catch {} }).observe($(`${engine}Terminal`));
  connect(engine);
}
function connect(engine, retry = false) {
  if (!retry) state.retries[engine] = 0;
  state.sockets[engine]?.close();
  state.running[engine] = false;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const settings = state.settings[engine];
  const ws = new WebSocket(`${scheme}//${location.host}/terminal?client=${encodeURIComponent(tabId)}&engine=${engine}&workspace=${encodeURIComponent(state.workspace)}&model=${encodeURIComponent(settings.model || '')}&effort=${encodeURIComponent(settings.effort || '')}`);
  state.sockets[engine] = ws;
  $(`${engine}State`).textContent = 'Connecting';
  updateConnection();
  ws.onopen = () => { if (state.sockets[engine] === ws) resize(engine); };
  ws.onmessage = event => {
    if (state.sockets[engine] !== ws) return;
    const msg = JSON.parse(event.data);
    if (msg.type === 'data') state.terms[engine].write(msg.data);
    if (msg.type === 'error') toast(`${engine}: ${msg.error}`, true);
    if (msg.type === 'session') { state.running[engine] = !!msg.running; $(`${engine}State`).textContent = msg.running ? 'Ready' : 'Exited'; updateConnection(); }
    if (msg.type === 'exit') {
      state.running[engine] = false;
      if (msg.recoverable && state.retries[engine] < 1) {
        state.retries[engine]++;
        $(`${engine}State`).textContent = 'Retrying startup';
        toast('Codex startup timed out. Retrying once…', true);
        setTimeout(() => { if (state.sockets[engine] === ws) connect(engine, true); }, 1500);
      } else $(`${engine}State`).textContent = `Exited ${msg.exitCode}`;
      updateConnection();
    }
    if (msg.type === 'save') {
      const r = msg.result;
      if (r.queued) $('retrySaves').hidden = false;
      toast(r.error ? `${engine} session: ${r.error}` : `${engine} session saved ${r.published ? 'and synced to GitHub' : r.location === 'vault' ? 'to your vault' : 'locally'}`, !!r.error);
    }
  };
  ws.onclose = () => {
    if (state.sockets[engine] !== ws) return;
    state.running[engine] = false;
    $(`${engine}State`).textContent = 'Reconnecting';
    updateConnection();
    setTimeout(() => { if (state.sockets[engine] === ws) connect(engine); }, 1500);
  };
}
function resize(engine) {
  const ws = state.sockets[engine], term = state.terms[engine];
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}
function updateConnection() {
  for (const engine of ['codex', 'claude']) {
    const indicator = $(`${engine}State`);
    const ready = state.sockets[engine]?.readyState === WebSocket.OPEN && state.running[engine];
    indicator.classList.toggle('offline', !ready);
    indicator.title = `${engine === 'codex' ? 'Codex' : 'Claude Code'}: ${indicator.textContent}`;
    indicator.setAttribute('aria-label', indicator.title);
  }
}

function chooseTarget(target) {
  state.target = target;
  document.querySelectorAll('[data-target]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.target === target)));
  if (target !== 'both') state.skillEngine = target;
  document.querySelectorAll('[data-skill-engine]').forEach(button => button.classList.toggle('active', button.dataset.skillEngine === state.skillEngine));
  renderSkills();
}
function openSkills(engine) {
  state.skillEngine = ['codex', 'claude'].includes(engine) ? engine : state.target === 'both' ? state.skillEngine : state.target;
  state.selectedSkill = null;
  $('skillSearch').value = '';
  document.querySelectorAll('[data-skill-engine]').forEach(button => button.classList.toggle('active', button.dataset.skillEngine === state.skillEngine));
  renderSkills(); $('skillDialog').showModal(); $('skillSearch').focus();
}
function renderSkills() {
  const list = $('skillList'); list.replaceChildren();
  const query = $('skillSearch').value.trim().toLowerCase();
  const items = state.catalog[state.skillEngine].filter(s => `${s.name} ${s.description} ${s.commands.map(c => c.name).join(' ')}`.toLowerCase().includes(query));
  if (!items.some(s => s.id === state.selectedSkill)) state.selectedSkill = items[0]?.id || null;
  $('skillSelect').replaceChildren(...items.map(skill => new Option(skill.name, skill.id)));
  $('skillSelect').disabled = !items.length;
  if (state.selectedSkill) $('skillSelect').value = state.selectedSkill;
  for (const skill of items) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `skill-item ${skill.id === state.selectedSkill ? 'active' : ''}`;
    const name = document.createElement('strong'); name.textContent = skill.name;
    const desc = document.createElement('small'); desc.textContent = skill.description || (skill.kind === 'command' ? 'Standalone command' : 'Installed skill');
    button.append(name, desc); button.onclick = () => { state.selectedSkill = skill.id; renderSkills(); }; list.append(button);
  }
  if (!items.length) list.textContent = 'No matching skills or commands.';
  const skill = items.find(s => s.id === state.selectedSkill);
  $('skillDetail').replaceChildren(); $('commandList').replaceChildren();
  if (!skill) return;
  const title = document.createElement('h3'); title.textContent = skill.name;
  const description = document.createElement('p'); description.textContent = (skill.description || 'Choose a command below to add it to your prompt.').slice(0, 280);
  const source = document.createElement('small'); source.textContent = skill.source;
  $('skillDetail').append(title, description, source);
  for (const command of skill.commands) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'command-item';
    const name = document.createElement('code'); name.textContent = command.invocation;
    const desc = document.createElement('span'); desc.textContent = command.description || 'Use this skill';
    const arrow = document.createElement('b'); arrow.textContent = '+';
    button.append(name, desc, arrow);
    button.onclick = () => {
      if (!state.commands[state.skillEngine].some(c => c.invocation === command.invocation)) state.commands[state.skillEngine].push(command);
      renderChips(); $('skillDialog').close(); $('prompt').focus(); toast(`${command.invocation} added for ${state.skillEngine === 'codex' ? 'Codex' : 'Claude Code'}`);
    };
    $('commandList').append(button);
  }
}
function renderChips() {
  const box = $('commandChips'); box.replaceChildren();
  for (const engine of ['codex', 'claude']) for (const command of state.commands[engine]) {
    const chip = document.createElement('button'); chip.className = 'command-chip'; chip.type = 'button';
    chip.textContent = `${engine === 'codex' ? 'Codex' : 'CC'} · ${command.invocation} ×`;
    chip.title = 'Remove command'; chip.onclick = () => { state.commands[engine] = state.commands[engine].filter(c => c !== command); renderChips(); };
    box.append(chip);
  }
  box.hidden = !box.children.length;
}

function updateModelLabel(engine) {
  const { model, effort } = state.settings[engine];
  const modelName = (engine === 'claude' ? claudeModels : codexModels).find(item => item.id === model)?.name || model;
  $(`${engine}ModelLabel`).textContent = [modelName || 'CLI default', effort].filter(Boolean).join(' · ');
}
function renderModelChoices() {
  const models = state.modelDialogEngine === 'claude' ? claudeModels : codexModels;
  const selected = $('modelInput').value.trim();
  $('modelChoices').replaceChildren();
  for (const model of models) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-choice';
    button.setAttribute('aria-pressed', String(selected === model.id));
    const title = document.createElement('strong'); title.textContent = model.name;
    const description = document.createElement('small'); description.textContent = model.description;
    const check = document.createElement('span'); check.textContent = selected === model.id ? '✓' : '';
    button.append(title, description, check);
    button.onclick = () => { $('modelInput').value = model.id; renderModelChoices(); };
    $('modelChoices').append(button);
  }
}
function openModel(engine) {
  state.modelDialogEngine = engine;
  $('modelDialogTitle').textContent = `${engine === 'codex' ? 'Codex' : 'Claude Code'} model`;
  $('modelHelp').textContent = 'Choose a version below, or enter any full model ID.';
  $('modelInput').placeholder = 'Full model ID or CLI default';
  $('modelInput').removeAttribute('list');
  $('effortInput').replaceChildren(new Option('CLI default', ''));
  for (const level of engine === 'codex' ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : ['low', 'medium', 'high', 'xhigh', 'max']) $('effortInput').add(new Option(level, level));
  $('modelInput').value = state.settings[engine].model || '';
  $('modelChoices').hidden = false;
  renderModelChoices();
  $('effortInput').value = state.settings[engine].effort || '';
  $('modelDialog').showModal();
}
function applyModel() {
  const engine = state.modelDialogEngine;
  const model = $('modelInput').value.trim();
  const effort = $('effortInput').value;
  if (model && !/^[a-zA-Z0-9._:/-]{1,100}$/.test(model)) return toast('Use a valid model ID without spaces.', true);
  state.settings[engine] = { model, effort };
  localStorage.setItem(`buddy-${engine}-settings`, JSON.stringify(state.settings[engine]));
  updateModelLabel(engine);
  $('modelDialog').close();
  state.terms[engine].clear();
  connect(engine);
  toast(`${engine === 'codex' ? 'Codex' : 'Claude Code'} starting a new session with ${model || 'CLI default'}${effort ? ` · ${effort}` : ''}`);
}

async function sendPrompt() {
  const text = $('prompt').value.trim();
  if (!text) return toast('Write a prompt first.', true);
  if (state.sending) return;
  state.sending = true;
  $('sendPrompt').disabled = true;
  try {
  if (state.vault.mode !== 'none' && state.project) {
    try { await refreshContext(); } catch (error) { state.context = ''; toast(`Sending without vault context: ${error.message}`, true); }
    if (!state.vaultSyncOk) { state.context = ''; toast('Sending without vault context while sync needs attention.', true); }
  } else state.context = '';
  const targets = state.target === 'both' ? ['codex', 'claude'] : [state.target];
  if (targets.some(e => state.sockets[e]?.readyState !== WebSocket.OPEN || !state.running[e])) return toast('A selected CLI has exited or is disconnected. Reconnect its pane first.', true);
  const context = state.context ? `\n\n<obsidian-context project="${state.project}">\n${state.context}\n</obsidian-context>\n\nUse this as project reference.` : '';
  for (const engine of targets) {
    const commands = state.commands[engine];
    const prefix = commands.map(c => c.invocation).join('\n');
    state.sockets[engine].send(JSON.stringify({ type: 'prompt', text: `${prefix ? `${prefix}\n\n` : ''}${text}${context}`, project: state.project, commands: commands.map(c => c.invocation) }));
  }
  $('prompt').value = '';
  for (const engine of targets) state.commands[engine] = [];
  renderChips(); toast(`Sent to ${targets.map(e => e === 'codex' ? 'Codex' : 'Claude Code').join(' and ')}${state.project && !state.context ? ' without current vault context' : ''}`);
  } finally { state.sending = false; $('sendPrompt').disabled = false; }
}

function openVaultSettings() {
  $('vaultNameInput').value = state.vault.name || '';
  $('vaultModeInput').value = state.vault.mode;
  $('vaultPathInput').value = state.vault.path || '';
  $('vaultRemoteInput').value = state.vault.remote || '';
  updateVaultFields();
  $('vaultDialog').showModal();
}
function updateVaultFields() {
  const mode = $('vaultModeInput').value;
  $('vaultNameField').hidden = mode === 'none';
  $('vaultPathField').hidden = mode === 'none';
  $('vaultRemoteField').hidden = mode !== 'github';
  $('vaultModeHelp').textContent = mode === 'github'
    ? 'Use an existing GitHub checkout, or give a new folder and repository URL to clone. Buddy only commits its own session files.'
    : mode === 'local' ? 'Buddy creates the folder if needed. Your notes remain on this Mac.'
    : 'Buddy works without Obsidian and saves sessions locally.';
}
async function saveVaultSettings() {
  const input = { mode: $('vaultModeInput').value, name: $('vaultNameInput').value, path: $('vaultPathInput').value, remote: $('vaultRemoteInput').value };
  $('saveVault').disabled = true;
  try {
    state.vault = await api('/api/vault/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    $('vaultDialog').close();
    renderVault();
    await loadProjects();
    toast(state.vault.mode === 'none' ? 'Buddy is using local sessions.' : `${state.vault.name} connected.`);
  } catch (error) { toast(error.message, true); }
  finally { $('saveVault').disabled = false; }
}

let draftBeforeImprove;
async function improve() {
  const input = $('prompt');
  const original = input.value;
  const selection = original.trim();
  if (!selection) return toast('Write a prompt first.', true);
  if (selection.length > 6000) return toast('Keep the prompt under 6,000 characters to improve it.', true);
  const engine = $('improveEngine')?.value || 'codex';
  $('improvePrompt').disabled = true; $('improvePrompt').textContent = 'Improving…';
  try {
    const data = await api('/api/improve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selection, engine, workspace: state.workspace }) });
    draftBeforeImprove = original;
    $('originalText').textContent = original; $('improvedText').value = data.improved;
    $('improveDialog').showModal();
  } catch (error) { toast(`Could not improve prompt: ${error.message}`, true); }
  finally { $('improvePrompt').disabled = false; $('improvePrompt').innerHTML = '<span class="tool-icon">✦</span> Improve prompt'; }
}
function acceptImprovement() {
  const input = $('prompt');
  if (draftBeforeImprove === undefined || input.value !== draftBeforeImprove) return toast('Prompt changed while improving. Try again.', true);
  input.value = $('improvedText').value;
  draftBeforeImprove = undefined;
  $('improveDialog').close(); input.focus();
}

function bind() {
  document.querySelectorAll('[data-target]').forEach(button => button.onclick = () => chooseTarget(button.dataset.target));
  document.querySelectorAll('[data-skill-engine]').forEach(button => button.onclick = () => { state.skillEngine = button.dataset.skillEngine; state.selectedSkill = null; document.querySelectorAll('[data-skill-engine]').forEach(b => b.classList.toggle('active', b === button)); renderSkills(); });
  $('applyWorkspace').onclick = async () => { state.workspace = $('workspace').value.trim(); localStorage.setItem('buddy-workspace', state.workspace); await refreshCatalog(); for (const engine of ['codex', 'claude']) { state.terms[engine].clear(); connect(engine); } };
  $('project').onchange = refreshContext; $('refreshContext').onclick = loadProjects;
  $('newProject').onclick = openNewProject;
  $('closeProject').onclick = $('cancelProject').onclick = () => $('projectDialog').close();
  $('createProject').onclick = createNewProject;
  $('projectName').onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); createNewProject(); } };
  $('configureVault').onclick = openVaultSettings;
  $('vaultModeInput').onchange = updateVaultFields;
  $('closeVault').onclick = $('cancelVault').onclick = () => $('vaultDialog').close();
  $('saveVault').onclick = saveVaultSettings;
  $('retrySaves').onclick = async () => { const result = await api('/api/retry-saves', { method: 'POST' }); $('retrySaves').hidden = !result.remaining; toast(result.remaining ? `${result.remaining} saves still queued: ${result.error}` : `${result.published} queued saves published`, !!result.remaining); };
  $('selectSkill').onclick = () => openSkills();
  document.querySelectorAll('[data-open-skills]').forEach(button => button.onclick = () => openSkills(button.dataset.openSkills));
  $('skillSearch').oninput = renderSkills;
  $('skillSelect').onchange = () => { state.selectedSkill = $('skillSelect').value; renderSkills(); };
  $('sendPrompt').onclick = sendPrompt;
  $('prompt').onkeydown = event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault(); event.stopPropagation(); sendPrompt();
  };
  $('improvePrompt').onclick = improve;
  $('closeImprove').onclick = $('cancelImprove').onclick = () => $('improveDialog').close();
  $('acceptImprove').onclick = acceptImprovement;
  document.querySelectorAll('[data-model]').forEach(button => button.onclick = () => openModel(button.dataset.model));
  $('closeModel').onclick = $('cancelModel').onclick = () => $('modelDialog').close();
  $('applyModel').onclick = applyModel;
  $('modelInput').oninput = renderModelChoices;
  document.querySelectorAll('[data-restart]').forEach(button => button.onclick = () => connect(button.dataset.restart));
  document.addEventListener('keydown', event => {
    if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); sendPrompt(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSkills(); }
  });
}

boot().catch(error => toast(error.message, true));
