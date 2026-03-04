const weekdayLabels = ['Dl', 'Dt', 'Dc', 'Dj', 'Dv', 'Ds', 'Dg'];

function toDayKey(dateMs) {
  const d = new Date(dateMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function monthStartTs(dateMs) {
  const d = new Date(dateMs);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function addMonths(dateMs, delta) {
  const d = new Date(dateMs);
  return new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime();
}

function parseLocalDatetimeInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function toLocalDatetimeInputValue(dateMs) {
  const d = new Date(dateMs);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function formatDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('ca-ES');
}

function formatTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit' });
}

const statusLabelMap = {
  draft: 'esborrany',
  scheduled: 'programat',
  publishing: 'en publicació',
  published: 'publicat',
  failed: 'error'
};

const state = {
  user: null,
  posts: [],
  lastGenerated: '',
  lastGeneratedQuoteIds: [],
  lastGeneratedRefs: [],
  allowedChannels: ['facebook', 'instagram', 'meta'],
  currentTopic: '',
  currentChannel: 'facebook',
  calendarMonthTs: monthStartTs(Date.now()),
  calendarSelectedDayKey: toDayKey(Date.now()),
  editingPostStatus: '',
  createMediaUrls: [],
  editMediaUrls: [],
  integrations: {
    meta: null
  }
};

const els = {
  loginSection: document.getElementById('loginSection'),
  appSection: document.getElementById('appSection'),
  loginForm: document.getElementById('loginForm'),
  loginEmail: document.getElementById('loginEmail'),
  loginPassword: document.getElementById('loginPassword'),
  loginError: document.getElementById('loginError'),
  signupForm: document.getElementById('signupForm'),
  signupOrgName: document.getElementById('signupOrgName'),
  signupEmail: document.getElementById('signupEmail'),
  signupPassword: document.getElementById('signupPassword'),
  signupError: document.getElementById('signupError'),
  topbarTitle: document.getElementById('topbarTitle'),
  topbarSubtitle: document.getElementById('topbarSubtitle'),
  logoutBtn: document.getElementById('logoutBtn'),
  refreshIntegrationsBtn: document.getElementById('refreshIntegrationsBtn'),
  integrationsStatus: document.getElementById('integrationsStatus'),
  connectMetaBtn: document.getElementById('connectMetaBtn'),
  disconnectMetaBtn: document.getElementById('disconnectMetaBtn'),
  integrationsInfo: document.getElementById('integrationsInfo'),
  integrationsError: document.getElementById('integrationsError'),

  generateForm: document.getElementById('generateForm'),
  channelInput: document.getElementById('channelInput'),
  topicInput: document.getElementById('topicInput'),
  contentInput: document.getElementById('contentInput'),
  scheduledAtInput: document.getElementById('scheduledAtInput'),
  mediaFileInput: document.getElementById('mediaFileInput'),
  uploadMediaBtn: document.getElementById('uploadMediaBtn'),
  uploadMediaInfo: document.getElementById('uploadMediaInfo'),
  mediaUrlInput: document.getElementById('mediaUrlInput'),
  addMediaUrlBtn: document.getElementById('addMediaUrlBtn'),
  mediaList: document.getElementById('mediaList'),
  generateInfo: document.getElementById('generateInfo'),
  generateError: document.getElementById('generateError'),

  saveDraftForm: document.getElementById('saveDraftForm'),
  saveError: document.getElementById('saveError'),

  refreshBtn: document.getElementById('refreshBtn'),
  runPublishBtn: document.getElementById('runPublishBtn'),

  statusFilter: document.getElementById('statusFilter'),
  postsBody: document.getElementById('postsBody'),
  postsError: document.getElementById('postsError'),
  stats: document.getElementById('stats'),

  calendarPrevBtn: document.getElementById('calendarPrevBtn'),
  calendarTodayBtn: document.getElementById('calendarTodayBtn'),
  calendarNextBtn: document.getElementById('calendarNextBtn'),
  calendarTitle: document.getElementById('calendarTitle'),
  calendarGrid: document.getElementById('calendarGrid'),
  calendarDayList: document.getElementById('calendarDayList'),

  editModal: document.getElementById('editModal'),
  editPostForm: document.getElementById('editPostForm'),
  editPostId: document.getElementById('editPostId'),
  editChannelInput: document.getElementById('editChannelInput'),
  editTopicInput: document.getElementById('editTopicInput'),
  editContentInput: document.getElementById('editContentInput'),
  editScheduledAtInput: document.getElementById('editScheduledAtInput'),
  editMediaUrlInput: document.getElementById('editMediaUrlInput'),
  editAddMediaUrlBtn: document.getElementById('editAddMediaUrlBtn'),
  editMediaFileInput: document.getElementById('editMediaFileInput'),
  editUploadMediaBtn: document.getElementById('editUploadMediaBtn'),
  editUploadMediaInfo: document.getElementById('editUploadMediaInfo'),
  editMediaList: document.getElementById('editMediaList'),
  editDeleteScheduleBtn: document.getElementById('editDeleteScheduleBtn'),
  editCancelBtn: document.getElementById('editCancelBtn'),
  editInfo: document.getElementById('editInfo'),
  editError: document.getElementById('editError'),

  scheduleModal: document.getElementById('scheduleModal'),
  scheduleForm: document.getElementById('scheduleForm'),
  schedulePostId: document.getElementById('schedulePostId'),
  scheduleAtInput: document.getElementById('scheduleAtInput'),
  scheduleIn1hBtn: document.getElementById('scheduleIn1hBtn'),
  scheduleTomorrowBtn: document.getElementById('scheduleTomorrowBtn'),
  scheduleCancelBtn: document.getElementById('scheduleCancelBtn'),
  scheduleError: document.getElementById('scheduleError')
};

const channelLabelMap = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  meta: 'Meta (Facebook + Instagram)',
  whatsapp: 'WhatsApp'
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    credentials: 'include'
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const message = data.error || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function normalizeStatus(value) {
  return value === 'approved' ? 'scheduled' : value;
}

function normalizePost(post) {
  const status = normalizeStatus(post.status);
  const mediaUrls = Array.isArray(post.mediaUrls)
    ? post.mediaUrls.map((url) => String(url || '').trim()).filter(Boolean)
    : (post.mediaUrl ? [String(post.mediaUrl).trim()] : []);

  return {
    ...post,
    status,
    mediaUrls,
    mediaUrl: mediaUrls[0] || null
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeMediaHref(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, window.location.origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeMediaCandidate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.startsWith('/uploads/')) return raw;

  try {
    const parsed = new URL(raw, window.location.origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.origin === window.location.origin && parsed.pathname.startsWith('/uploads/')) {
      return parsed.pathname;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const comma = dataUrl.indexOf(',');
      if (comma === -1) {
        reject(new Error('No s\'ha pogut llegir el fitxer.'));
        return;
      }
      resolve(dataUrl.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('Error llegint el fitxer.'));
    reader.readAsDataURL(file);
  });
}

function setChannelOptions(channels) {
  const allowed = Array.isArray(channels) && channels.length ? channels : ['facebook', 'instagram', 'meta'];
  state.allowedChannels = allowed;

  const optionsHtml = allowed
    .map((channel) => `<option value="${channel}">${channelLabelMap[channel] || channel}</option>`)
    .join('');

  els.channelInput.innerHTML = optionsHtml;
  els.editChannelInput.innerHTML = optionsHtml;

  if (!allowed.includes(state.currentChannel)) {
    state.currentChannel = allowed[0];
  }
  if (state.currentChannel) {
    els.channelInput.value = state.currentChannel;
  }
}

function setLoggedIn(isLoggedIn) {
  els.loginSection.classList.toggle('hidden', isLoggedIn);
  els.appSection.classList.toggle('hidden', !isLoggedIn);
}

function renderUserContext() {
  const orgName = state.user?.orgName ? String(state.user.orgName) : 'Entitat';
  if (els.topbarTitle) els.topbarTitle.textContent = orgName;
  if (els.topbarSubtitle) {
    const email = state.user?.email ? String(state.user.email) : '';
    els.topbarSubtitle.textContent = email ? `Panell de comunicacio i publicacio · ${email}` : 'Panell de comunicacio i publicacio';
  }
}

function setIntegrationsInfo(message, isError = false) {
  if (els.integrationsInfo) {
    els.integrationsInfo.textContent = isError ? '' : String(message || '');
  }
  if (els.integrationsError) {
    els.integrationsError.textContent = isError ? String(message || '') : '';
  }
}

function parseOAuthResultFromUrl() {
  const query = new URLSearchParams(window.location.search);
  const status = String(query.get('oauth_status') || '').trim();
  const message = String(query.get('oauth_message') || '').trim();
  if (!status) return;

  if (status === 'ok') {
    setIntegrationsInfo(message || 'Connexio OAuth completada correctament.', false);
  } else {
    setIntegrationsInfo(message || 'No s ha pogut completar la connexio OAuth.', true);
  }

  query.delete('oauth_status');
  query.delete('oauth_message');
  const next = `${window.location.pathname}${query.toString() ? `?${query.toString()}` : ''}`;
  window.history.replaceState({}, '', next);
}

function renderIntegrations() {
  const meta = state.integrations?.meta || null;
  const connected = Boolean(meta?.connected);
  const pageText = connected
    ? `${meta.facebookPageName || 'Pagina sense nom'} (${meta.facebookPageId || '-'})`
    : 'Sense pagina connectada';
  const instagramText = connected
    ? (meta.instagramUsername
      ? `@${meta.instagramUsername}`
      : (meta.instagramBusinessAccountId ? `ID ${meta.instagramBusinessAccountId}` : 'Sense compte d Instagram Business'))
    : '-';

  if (els.integrationsStatus) {
    els.integrationsStatus.innerHTML = `
      <div class="integration-pill ${connected ? 'connected' : 'disconnected'}">
        <strong>Meta</strong>
        <div class="small">Estat: ${connected ? 'connectat' : 'desconnectat'}</div>
        <div class="small">Facebook: ${escapeHtml(pageText)}</div>
        <div class="small">Instagram: ${escapeHtml(instagramText)}</div>
      </div>
    `;
  }

  if (els.disconnectMetaBtn) {
    els.disconnectMetaBtn.disabled = !connected;
  }
}

function badge(status) {
  const normalized = normalizeStatus(status);
  return `<span class="badge ${normalized}">${statusLabelMap[normalized] || normalized}</span>`;
}

function renderStats(posts) {
  const statuses = ['draft', 'scheduled', 'publishing', 'published', 'failed'];
  const map = statuses.map((status) => ({
    status,
    total: posts.filter((p) => p.status === status).length
  }));

  els.stats.innerHTML = map
    .map((item) => `<div class="stat-pill"><strong>${item.total}</strong> ${statusLabelMap[item.status] || item.status}</div>`)
    .join('');
}

function canEditPost(post) {
  return ['draft', 'scheduled', 'failed'].includes(post.status);
}

function renderMediaList(container, urls, removeAttr) {
  if (!urls.length) {
    container.innerHTML = '<p class="muted small">Sense imatges afegides.</p>';
    return;
  }

  container.innerHTML = urls
    .map((url, idx) => {
      const href = safeMediaHref(url);
      if (!href) return '';
      return `
      <div class="media-item">
        <img src="${escapeHtml(href)}" alt="Imatge ${idx + 1}" class="media-thumb" />
        <div class="media-item-meta">
          <small class="code">${escapeHtml(url)}</small>
          <div class="row">
            ${idx === 0 ? '<span class="media-main small">Principal</span>' : ''}
            <button type="button" class="tiny danger" ${removeAttr}="${idx}">Treure</button>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

function renderCreateMediaList() {
  renderMediaList(els.mediaList, state.createMediaUrls, 'data-remove-media');
}

function renderEditMediaList() {
  renderMediaList(els.editMediaList, state.editMediaUrls, 'data-remove-edit-media');
}

function addMediaToCollection(collection, rawUrl) {
  const normalized = normalizeMediaCandidate(rawUrl);
  if (!normalized) return { ok: false, error: 'URL d\'imatge invàlida.' };
  if (!collection.includes(normalized)) collection.push(normalized);
  return { ok: true };
}

function buildActionButtons(post) {
  const actions = [];

  if (canEditPost(post)) {
    actions.push(`<button class="tiny secondary" data-action="edit" data-id="${post.id}">Editar</button>`);
  }

  if (post.status === 'draft' || post.status === 'failed') {
    actions.push(`<button class="tiny" data-action="schedule" data-id="${post.id}">Programar</button>`);
  }

  if (post.status === 'scheduled' || post.status === 'failed') {
    actions.push(`<button class="tiny secondary" data-action="publish" data-id="${post.id}">Publicar ara</button>`);
  }

  if (post.status !== 'publishing') {
    actions.push(`<button class="tiny danger" data-action="delete" data-id="${post.id}">Eliminar</button>`);
  }

  return actions.join(' ');
}

function renderPosts() {
  const filter = els.statusFilter.value;
  const posts = state.posts.filter((p) => (filter === 'all' ? true : p.status === filter));

  renderStats(state.posts);

  if (!posts.length) {
    els.postsBody.innerHTML = '<tr><td colspan="6">No hi ha resultats.</td></tr>';
    return;
  }

  els.postsBody.innerHTML = posts
    .map((post) => {
      const mediaInfo = post.mediaUrls.length
        ? `<small class="code">Imatges: ${post.mediaUrls.length}</small>`
        : '';

      return `
      <tr>
        <td>${escapeHtml(post.channel)}</td>
        <td>
          <strong>${escapeHtml(post.topic)}</strong>
          <small class="code">${escapeHtml(post.content)}</small>
          ${Array.isArray(post.citationRefs) && post.citationRefs.length ? `<small class="code">Referències: ${escapeHtml(post.citationRefs.map((r) => r.text).join(' | '))}</small>` : ''}
          ${mediaInfo}
          ${post.lastError ? `<small class="code" style="color:#a12727;">${escapeHtml(post.lastError)}</small>` : ''}
        </td>
        <td>${badge(post.status)}</td>
        <td>${formatDate(post.scheduledAt)}</td>
        <td>${formatDate(post.updatedAt)}</td>
        <td><div class="actions">${buildActionButtons(post)}</div></td>
      </tr>`;
    })
    .join('');
}

function getScheduledPosts() {
  return state.posts
    .filter((post) => Number.isFinite(post.scheduledAt))
    .slice()
    .sort((a, b) => a.scheduledAt - b.scheduledAt);
}

function getScheduledMapByDay() {
  const map = new Map();
  for (const post of getScheduledPosts()) {
    const key = toDayKey(post.scheduledAt);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(post);
  }
  return map;
}

function renderCalendarDayList(scheduledMap) {
  const selected = state.calendarSelectedDayKey;
  const list = scheduledMap.get(selected) || [];

  const selectedDate = new Date(`${selected}T00:00:00`);
  const selectedLabel = selectedDate.toLocaleDateString('ca-ES', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });

  if (!list.length) {
    els.calendarDayList.innerHTML = `
      <h4>${escapeHtml(selectedLabel)}</h4>
      <p class="muted small">No hi ha posts programats aquest dia.</p>
    `;
    return;
  }

  const rows = list
    .map((post) => {
      const editButton = canEditPost(post)
        ? `<button class="tiny secondary" type="button" data-calendar-edit="${post.id}">Editar</button>`
        : '';

      return `
      <div class="calendar-item-row">
        <div>
          <strong>${formatTime(post.scheduledAt)}</strong>
          <span class="muted small"> · ${escapeHtml(post.channel)} · ${escapeHtml(statusLabelMap[post.status] || post.status)}</span>
          <div class="small">${escapeHtml(post.topic)}</div>
        </div>
        ${editButton}
      </div>`;
    })
    .join('');

  els.calendarDayList.innerHTML = `
    <h4>${escapeHtml(selectedLabel)}</h4>
    <div class="calendar-item-list">${rows}</div>
  `;
}

function renderCalendar() {
  const monthStart = monthStartTs(state.calendarMonthTs);
  const monthDate = new Date(monthStart);
  els.calendarTitle.textContent = monthDate.toLocaleDateString('ca-ES', {
    month: 'long',
    year: 'numeric'
  });

  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthOffset = (new Date(year, month, 1).getDay() + 6) % 7;
  const totalCells = Math.ceil((monthOffset + daysInMonth) / 7) * 7;

  const scheduledMap = getScheduledMapByDay();
  const todayKey = toDayKey(Date.now());

  const head = weekdayLabels.map((label) => `<div class="calendar-head">${label}</div>`).join('');
  const cells = [];

  for (let i = 0; i < totalCells; i += 1) {
    const dayNum = i - monthOffset + 1;
    const dayDate = new Date(year, month, dayNum);
    const dayTs = dayDate.getTime();
    const key = toDayKey(dayTs);
    const entries = scheduledMap.get(key) || [];
    const count = entries.length;

    const previewTopics = entries
      .slice(0, 2)
      .map((post) => `<div class="calendar-topic">${escapeHtml(post.topic)}</div>`)
      .join('');
    const more = count > 2 ? `<div class="calendar-topic more">+${count - 2} més</div>` : '';

    const classes = [
      'calendar-cell',
      dayNum >= 1 && dayNum <= daysInMonth ? 'in-month' : 'out-month',
      key === state.calendarSelectedDayKey ? 'selected' : '',
      key === todayKey ? 'today' : ''
    ]
      .filter(Boolean)
      .join(' ');

    cells.push(`
      <button type="button" class="${classes}" data-day="${key}">
        <span class="calendar-day-number">${dayDate.getDate()}</span>
        ${count ? `<span class="calendar-count">${count} programat${count > 1 ? 's' : ''}</span>` : '<span class="calendar-count empty">-</span>'}
        <div class="calendar-topics">${previewTopics}${more}</div>
      </button>
    `);
  }

  els.calendarGrid.innerHTML = `${head}${cells.join('')}`;
  renderCalendarDayList(scheduledMap);
}

async function loadIntegrations() {
  try {
    const result = await api('/api/integrations', { method: 'GET' });
    state.integrations = result.integrations || { meta: null };
    renderIntegrations();
  } catch (err) {
    state.integrations = { meta: null };
    renderIntegrations();
    setIntegrationsInfo(err.message, true);
  }
}

async function loadMe() {
  try {
    const me = await api('/api/me', { method: 'GET' });
    state.user = me.user;
    setLoggedIn(true);
    renderUserContext();
    try {
      const caps = await api('/api/capabilities', { method: 'GET' });
      setChannelOptions(caps.channels);
    } catch {
      setChannelOptions(['facebook', 'instagram', 'meta']);
    }
    await loadIntegrations();
    await loadPosts();
  } catch {
    state.user = null;
    state.integrations = { meta: null };
    renderIntegrations();
    setLoggedIn(false);
    renderUserContext();
  }
}

async function loadPosts() {
  els.postsError.textContent = '';
  try {
    const all = [];
    let cursor = '';
    let keepLoading = true;

    while (keepLoading) {
      const query = new URLSearchParams();
      query.set('limit', '200');
      if (cursor) query.set('cursor', cursor);

      // eslint-disable-next-line no-await-in-loop
      const data = await api(`/api/posts?${query.toString()}`, { method: 'GET' });
      all.push(...(data.posts || []));
      cursor = data?.pagination?.nextCursor || '';
      keepLoading = Boolean(cursor);
      if (all.length >= 5000) keepLoading = false;
    }

    state.posts = all.map((post) => normalizePost(post));
    renderPosts();
    renderCalendar();
  } catch (err) {
    els.postsError.textContent = err.message;
  }
}

async function uploadImage(file) {
  if (!file) throw new Error('Selecciona una imatge.');
  if (!String(file.type || '').startsWith('image/')) {
    throw new Error('El fitxer ha de ser una imatge.');
  }

  const dataBase64 = await fileToBase64(file);
  const uploaded = await api('/api/media/upload', {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      dataBase64
    })
  });

  return uploaded.mediaPath || uploaded.mediaUrl || '';
}

async function onLoginSubmit(event) {
  event.preventDefault();
  els.loginError.textContent = '';

  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        email: els.loginEmail.value.trim(),
        password: els.loginPassword.value
      })
    });

    els.loginPassword.value = '';
    await loadMe();
  } catch (err) {
    els.loginError.textContent = err.message;
  }
}

async function onSignupSubmit(event) {
  event.preventDefault();
  els.signupError.textContent = '';

  const orgName = els.signupOrgName.value.trim();
  const email = els.signupEmail.value.trim();
  const password = els.signupPassword.value;

  if (!orgName || !email || !password) {
    els.signupError.textContent = 'Cal omplir nom d entitat, email i contrasenya.';
    return;
  }

  try {
    const result = await api('/api/signup', {
      method: 'POST',
      body: JSON.stringify({ orgName, email, password })
    });

    els.signupPassword.value = '';
    if (result.requiresEmailVerification) {
      els.signupError.textContent = result.message || 'Compte creat. Verifica l email i fes login.';
      return;
    }
    await loadMe();
  } catch (err) {
    els.signupError.textContent = err.message;
  }
}

async function onLogout() {
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => null);
  state.user = null;
  state.integrations = { meta: null };
  renderIntegrations();
  setLoggedIn(false);
  renderUserContext();
}

function onConnectMeta() {
  setIntegrationsInfo('', false);
  window.location.assign('/api/integrations/meta/connect');
}

async function onDisconnectMeta() {
  setIntegrationsInfo('', false);
  if (!window.confirm('Vols desconnectar Meta d aquesta entitat?')) return;

  try {
    await api('/api/integrations/meta', { method: 'DELETE' });
    await loadIntegrations();
    setIntegrationsInfo('Meta desconnectat correctament.', false);
  } catch (err) {
    setIntegrationsInfo(err.message, true);
  }
}

async function onGenerateSubmit(event) {
  event.preventDefault();
  els.generateError.textContent = '';
  els.generateInfo.textContent = '';

  const topic = els.topicInput.value.trim();
  const channel = els.channelInput.value;
  if (!topic) {
    els.generateError.textContent = 'Tema obligatori.';
    return;
  }
  if (!channel) {
    els.generateError.textContent = 'Canal obligatori.';
    return;
  }

  state.currentTopic = topic;
  state.currentChannel = channel;

  try {
    const data = await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ topic, channel })
    });

    state.lastGenerated = data.content;
    state.lastGeneratedQuoteIds = Array.isArray(data.quoteIdsUsed) ? data.quoteIdsUsed : [];
    state.lastGeneratedRefs = Array.isArray(data.citationRefs) ? data.citationRefs : [];
    els.contentInput.value = data.content;

    if (state.lastGeneratedRefs.length) {
      const refs = state.lastGeneratedRefs.map((ref) => ref.text).join(' | ');
      els.generateInfo.textContent = `Cites literals verificades amb referència d'obra: ${refs}`;
    } else {
      els.generateInfo.textContent = 'Generat sense cites literals.';
    }
  } catch (err) {
    els.generateError.textContent = err.message;
  }
}

async function onSaveDraftSubmit(event) {
  event.preventDefault();
  els.saveError.textContent = '';

  const content = els.contentInput.value.trim();
  if (!content) {
    els.saveError.textContent = 'Cal contingut per guardar.';
    return;
  }

  const topic = state.currentTopic || els.topicInput.value.trim();
  const channel = state.currentChannel || els.channelInput.value;
  const scheduledAt = parseLocalDatetimeInput(els.scheduledAtInput.value);

  if (!topic) {
    els.saveError.textContent = 'Tema obligatori.';
    return;
  }
  if (!channel) {
    els.saveError.textContent = 'Canal obligatori.';
    return;
  }
  if (els.scheduledAtInput.value && scheduledAt === null) {
    els.saveError.textContent = 'Data de programació invàlida.';
    return;
  }

  try {
    await api('/api/posts', {
      method: 'POST',
      body: JSON.stringify({
        topic,
        channel,
        content,
        scheduledAt,
        mediaUrls: state.createMediaUrls
      })
    });

    els.topicInput.value = '';
    els.contentInput.value = '';
    els.scheduledAtInput.value = '';
    els.mediaUrlInput.value = '';
    els.mediaFileInput.value = '';
    els.uploadMediaInfo.textContent = '';
    state.createMediaUrls = [];
    renderCreateMediaList();

    els.generateInfo.textContent = '';
    state.currentTopic = '';
    state.lastGenerated = '';
    state.lastGeneratedQuoteIds = [];
    state.lastGeneratedRefs = [];
    await loadPosts();
  } catch (err) {
    els.saveError.textContent = err.message;
  }
}

async function onUploadMedia() {
  els.saveError.textContent = '';
  els.uploadMediaInfo.textContent = '';

  const file = els.mediaFileInput.files?.[0];
  if (!file) {
    els.saveError.textContent = 'Selecciona una imatge.';
    return;
  }

  els.uploadMediaBtn.disabled = true;
  try {
    const mediaUrl = await uploadImage(file);
    const result = addMediaToCollection(state.createMediaUrls, mediaUrl);
    if (!result.ok) throw new Error(result.error);

    els.mediaFileInput.value = '';
    els.uploadMediaInfo.textContent = `Imatge afegida. Total: ${state.createMediaUrls.length}`;
    renderCreateMediaList();
  } catch (err) {
    els.saveError.textContent = err.message;
  } finally {
    els.uploadMediaBtn.disabled = false;
  }
}

function onAddMediaUrl() {
  els.saveError.textContent = '';
  const value = els.mediaUrlInput.value.trim();
  const result = addMediaToCollection(state.createMediaUrls, value);
  if (!result.ok) {
    els.saveError.textContent = result.error;
    return;
  }
  els.mediaUrlInput.value = '';
  renderCreateMediaList();
}

function onCreateMediaListClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest('button[data-remove-media]');
  if (!button) return;

  const idx = Number.parseInt(button.getAttribute('data-remove-media') || '', 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= state.createMediaUrls.length) return;
  state.createMediaUrls.splice(idx, 1);
  renderCreateMediaList();
}

function openEditModal(postId) {
  const post = state.posts.find((p) => p.id === postId);
  if (!post || !canEditPost(post)) return;

  state.editingPostStatus = post.status;
  state.editMediaUrls = [...post.mediaUrls];

  els.editPostId.value = post.id;
  els.editChannelInput.value = post.channel;
  els.editTopicInput.value = post.topic || '';
  els.editContentInput.value = post.content || '';
  els.editScheduledAtInput.value = Number.isFinite(post.scheduledAt) ? toLocalDatetimeInputValue(post.scheduledAt) : '';
  els.editMediaUrlInput.value = '';
  els.editMediaFileInput.value = '';
  els.editUploadMediaInfo.textContent = '';
  els.editError.textContent = '';
  els.editInfo.textContent = post.status === 'scheduled'
    ? 'Post programat: pots canviar data/hora, contingut i imatges.'
    : 'Pots editar aquest post i desar canvis.';

  renderEditMediaList();
  els.editModal.classList.remove('hidden');
}

function closeEditModal() {
  els.editModal.classList.add('hidden');
  els.editError.textContent = '';
  els.editInfo.textContent = '';
  state.editMediaUrls = [];
}

function onEditAddMediaUrl() {
  els.editError.textContent = '';
  const value = els.editMediaUrlInput.value.trim();
  const result = addMediaToCollection(state.editMediaUrls, value);
  if (!result.ok) {
    els.editError.textContent = result.error;
    return;
  }
  els.editMediaUrlInput.value = '';
  renderEditMediaList();
}

async function onEditUploadMedia() {
  els.editError.textContent = '';
  els.editUploadMediaInfo.textContent = '';

  const file = els.editMediaFileInput.files?.[0];
  if (!file) {
    els.editError.textContent = 'Selecciona una imatge.';
    return;
  }

  els.editUploadMediaBtn.disabled = true;
  try {
    const mediaUrl = await uploadImage(file);
    const result = addMediaToCollection(state.editMediaUrls, mediaUrl);
    if (!result.ok) throw new Error(result.error);

    els.editMediaFileInput.value = '';
    els.editUploadMediaInfo.textContent = `Imatge afegida. Total: ${state.editMediaUrls.length}`;
    renderEditMediaList();
  } catch (err) {
    els.editError.textContent = err.message;
  } finally {
    els.editUploadMediaBtn.disabled = false;
  }
}

function onEditMediaListClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest('button[data-remove-edit-media]');
  if (!button) return;

  const idx = Number.parseInt(button.getAttribute('data-remove-edit-media') || '', 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= state.editMediaUrls.length) return;
  state.editMediaUrls.splice(idx, 1);
  renderEditMediaList();
}

async function onEditPostSubmit(event) {
  event.preventDefault();
  els.editError.textContent = '';

  const id = els.editPostId.value;
  const topic = els.editTopicInput.value.trim();
  const content = els.editContentInput.value.trim();
  const channel = els.editChannelInput.value;
  const scheduledAt = parseLocalDatetimeInput(els.editScheduledAtInput.value);

  if (!id) {
    els.editError.textContent = 'No s\'ha trobat el post a editar.';
    return;
  }
  if (!topic) {
    els.editError.textContent = 'Tema obligatori.';
    return;
  }
  if (!content) {
    els.editError.textContent = 'Contingut obligatori.';
    return;
  }
  if (!channel) {
    els.editError.textContent = 'Canal obligatori.';
    return;
  }
  if (els.editScheduledAtInput.value && scheduledAt === null) {
    els.editError.textContent = 'Data de programació invàlida.';
    return;
  }

  try {
    await api(`/api/posts/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        topic,
        channel,
        content,
        scheduledAt,
        mediaUrls: state.editMediaUrls
      })
    });
    closeEditModal();
    await loadPosts();
  } catch (err) {
    els.editError.textContent = err.message;
  }
}

function onEditRemoveSchedule() {
  els.editScheduledAtInput.value = '';
}

function openScheduleModal(postId) {
  const post = state.posts.find((p) => p.id === postId);
  if (!post) return;

  const defaultTs = Number.isFinite(post.scheduledAt) ? post.scheduledAt : (Date.now() + 60 * 60 * 1000);
  els.schedulePostId.value = postId;
  els.scheduleAtInput.value = toLocalDatetimeInputValue(defaultTs);
  els.scheduleError.textContent = '';
  els.scheduleModal.classList.remove('hidden');
}

function closeScheduleModal() {
  els.scheduleModal.classList.add('hidden');
  els.scheduleError.textContent = '';
}

function onScheduleIn1h() {
  els.scheduleAtInput.value = toLocalDatetimeInputValue(Date.now() + 60 * 60 * 1000);
}

function onScheduleTomorrowMorning() {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  els.scheduleAtInput.value = toLocalDatetimeInputValue(target.getTime());
}

async function onScheduleSubmit(event) {
  event.preventDefault();
  els.scheduleError.textContent = '';

  const postId = String(els.schedulePostId.value || '').trim();
  const scheduledAt = parseLocalDatetimeInput(els.scheduleAtInput.value);

  if (!postId) {
    els.scheduleError.textContent = 'No s\'ha trobat el post.';
    return;
  }
  if (scheduledAt === null) {
    els.scheduleError.textContent = 'Selecciona una data i hora vàlides.';
    return;
  }

  try {
    await api(`/api/posts/${postId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ scheduledAt })
    });
    closeScheduleModal();
    await loadPosts();
  } catch (err) {
    els.scheduleError.textContent = err.message;
  }
}

async function publishNow(postId) {
  await api(`/api/posts/${postId}/publish-now`, {
    method: 'POST',
    body: '{}'
  });
  await loadPosts();
}

async function deletePost(postId) {
  if (!window.confirm('Vols eliminar aquesta publicació?')) return;
  await api(`/api/posts/${postId}`, {
    method: 'DELETE'
  });
  await loadPosts();
}

function onPostsClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest('button[data-action]');
  if (!button) return;

  const action = button.getAttribute('data-action');
  const id = button.getAttribute('data-id');
  if (!id || !action) return;

  button.disabled = true;

  (async () => {
    try {
      if (action === 'edit') openEditModal(id);
      if (action === 'schedule') openScheduleModal(id);
      if (action === 'publish') await publishNow(id);
      if (action === 'delete') await deletePost(id);
    } catch (err) {
      els.postsError.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  })();
}

function onCalendarGridClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest('button[data-day]');
  if (!button) return;

  const day = button.getAttribute('data-day');
  if (!day) return;

  state.calendarSelectedDayKey = day;
  renderCalendar();
}

function onCalendarDayListClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest('button[data-calendar-edit]');
  if (!button) return;

  const id = button.getAttribute('data-calendar-edit');
  if (!id) return;
  openEditModal(id);
}

function onCalendarPrev() {
  state.calendarMonthTs = addMonths(state.calendarMonthTs, -1);
  renderCalendar();
}

function onCalendarNext() {
  state.calendarMonthTs = addMonths(state.calendarMonthTs, 1);
  renderCalendar();
}

function onCalendarToday() {
  const now = Date.now();
  state.calendarMonthTs = monthStartTs(now);
  state.calendarSelectedDayKey = toDayKey(now);
  renderCalendar();
}

async function onRunPublish() {
  els.postsError.textContent = '';
  try {
    await api('/api/publish/run', {
      method: 'POST',
      body: '{}'
    });
    await loadPosts();
  } catch (err) {
    els.postsError.textContent = err.message;
  }
}

function setupEvents() {
  setChannelOptions(state.allowedChannels);
  renderCreateMediaList();
  renderIntegrations();

  els.loginForm.addEventListener('submit', onLoginSubmit);
  if (els.signupForm) els.signupForm.addEventListener('submit', onSignupSubmit);
  els.logoutBtn.addEventListener('click', onLogout);
  if (els.refreshIntegrationsBtn) els.refreshIntegrationsBtn.addEventListener('click', () => loadIntegrations());
  if (els.connectMetaBtn) els.connectMetaBtn.addEventListener('click', onConnectMeta);
  if (els.disconnectMetaBtn) els.disconnectMetaBtn.addEventListener('click', onDisconnectMeta);

  els.channelInput.addEventListener('change', () => {
    state.currentChannel = els.channelInput.value || 'facebook';
  });

  els.generateForm.addEventListener('submit', onGenerateSubmit);
  els.saveDraftForm.addEventListener('submit', onSaveDraftSubmit);

  els.uploadMediaBtn.addEventListener('click', onUploadMedia);
  els.addMediaUrlBtn.addEventListener('click', onAddMediaUrl);
  els.mediaList.addEventListener('click', onCreateMediaListClick);

  els.refreshBtn.addEventListener('click', () => loadPosts());
  els.runPublishBtn.addEventListener('click', onRunPublish);
  els.statusFilter.addEventListener('change', renderPosts);
  els.postsBody.addEventListener('click', onPostsClick);

  els.calendarPrevBtn.addEventListener('click', onCalendarPrev);
  els.calendarNextBtn.addEventListener('click', onCalendarNext);
  els.calendarTodayBtn.addEventListener('click', onCalendarToday);
  els.calendarGrid.addEventListener('click', onCalendarGridClick);
  els.calendarDayList.addEventListener('click', onCalendarDayListClick);

  els.editPostForm.addEventListener('submit', onEditPostSubmit);
  els.editDeleteScheduleBtn.addEventListener('click', onEditRemoveSchedule);
  els.editCancelBtn.addEventListener('click', closeEditModal);
  els.editAddMediaUrlBtn.addEventListener('click', onEditAddMediaUrl);
  els.editUploadMediaBtn.addEventListener('click', onEditUploadMedia);
  els.editMediaList.addEventListener('click', onEditMediaListClick);

  els.scheduleForm.addEventListener('submit', onScheduleSubmit);
  els.scheduleIn1hBtn.addEventListener('click', onScheduleIn1h);
  els.scheduleTomorrowBtn.addEventListener('click', onScheduleTomorrowMorning);
  els.scheduleCancelBtn.addEventListener('click', closeScheduleModal);

  els.editModal.addEventListener('click', (event) => {
    if (event.target === els.editModal) closeEditModal();
  });
  els.scheduleModal.addEventListener('click', (event) => {
    if (event.target === els.scheduleModal) closeScheduleModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.editModal.classList.contains('hidden')) {
      closeEditModal();
    }
    if (event.key === 'Escape' && !els.scheduleModal.classList.contains('hidden')) {
      closeScheduleModal();
    }
  });
}

setupEvents();
parseOAuthResultFromUrl();
loadMe();
