(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const ui = {
    nav: $('#case-nav'), count: $('#case-count'), overview: $('#case-overview'),
    caseId: $('#active-case-id'), title: $('#case-title'), facts: $('#case-facts'),
    metadata: $('#metadata-content'), download: $('#download-case'), downloadAll: $('#download-all'), tools: $('#reader-tools'),
    search: $('#trace-search'), banner: $('#filter-banner'), filterStatus: $('#filter-status'),
    list: $('#message-list'), empty: $('#empty-search'), load: $('#load-state'),
    footer: $('#trace-footer'), footerText: $('#trace-footer-text'), announcement: $('#announcement'),
    dialog: $('#copy-dialog'), fallback: $('#fallback-link')
  };
  let rows = [];
  let active = null;
  let query = '';
  let callLookup = new Map();
  let resultLookup = new Map();
  let announcementTimer;
  let searchTimer;
  let files = null;
  const blobUrls = new Map();
  let stateKey;
  let generation = 0;
  let vaultController = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function valueText(value) {
    if (typeof value === 'string') return value;
    if (value === undefined) return '';
    return JSON.stringify(value, null, 2);
  }

  function pretty(value) {
    // Formatting affects only the reading view, never the downloadable records.
    if (typeof value !== 'string') return valueText(value);
    try {
      const parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
    } catch (_error) {
      // Plain text remains exactly as stored.
    }
    return value;
  }

  function occurrences(text, needle) {
    if (!needle) return 0;
    const haystack = text.toLocaleLowerCase();
    const lower = needle.toLocaleLowerCase();
    let count = 0;
    let offset = 0;
    while ((offset = haystack.indexOf(lower, offset)) !== -1) {
      count += 1;
      offset += lower.length;
    }
    return count;
  }

  function contains(text) {
    return query !== '' && occurrences(text, query) > 0;
  }

  function highlighted(node, value) {
    const text = valueText(value);
    if (!query) { node.textContent = text; return node; }
    const lower = text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    let cursor = 0;
    let found;
    while ((found = lower.indexOf(needle, cursor)) !== -1) {
      node.append(document.createTextNode(text.slice(cursor, found)));
      node.append(element('mark', '', text.slice(found, found + query.length)));
      cursor = found + query.length;
    }
    node.append(document.createTextNode(text.slice(cursor)));
    return node;
  }

  function caseTitle(row) {
    const first = row.messages.find((message) => message.role === 'user' && typeof message.content === 'string' && !message.content.startsWith('[Device notification:'));
    return first ? first.content.slice(0, 85) : row.case_id;
  }

  function messageLabel(index) { return `#${String(index + 1).padStart(3, '0')}`; }
  function messageId(index) { return `message-${index + 1}`; }
  function urlFor(caseId, index) {
    const params = new URLSearchParams();
    const key = new URLSearchParams(window.location.hash.slice(1)).get('k');
    if (key) params.set('k', key);
    params.set('case', caseId);
    if (index !== undefined) params.set('message', String(index + 1));
    const url = new URL(window.location.href);
    url.hash = params.toString();
    return url.href;
  }

  function announce(text) {
    window.clearTimeout(announcementTimer);
    ui.announcement.textContent = text;
    ui.announcement.classList.add('visible');
    announcementTimer = window.setTimeout(() => ui.announcement.classList.remove('visible'), 3000);
  }

  async function copyLink(url) {
    const copyGeneration = generation;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      if (copyGeneration !== generation) return;
      announce('Link copied');
    } catch (_error) {
      if (copyGeneration !== generation) return;
      ui.fallback.value = url;
      if (typeof ui.dialog.showModal === 'function') ui.dialog.showModal();
      else ui.dialog.setAttribute('open', '');
      window.setTimeout(() => { ui.fallback.focus(); ui.fallback.select(); }, 0);
    }
  }

  function buildLookups() {
    callLookup = new Map();
    resultLookup = new Map();
    active.messages.forEach((message, index) => {
      for (const call of message.tool_calls || []) {
        if (call.id) callLookup.set(call.id, { call, index });
      }
      if (message.role === 'tool' && message.tool_call_id) resultLookup.set(message.tool_call_id, index);
    });
  }

  function searchText(message) {
    const fields = [valueText(message.content), valueText(message.reasoning_content)];
    if (message.tool_calls) fields.push(valueText(message.tool_calls));
    if (message.tool_call_id) {
      fields.push(message.tool_call_id);
      const origin = callLookup.get(message.tool_call_id);
      if (origin) fields.push(origin.call.function.name);
    }
    return fields.join('\n');
  }

  function detail(label, className, content, options = {}) {
    const details = element('details', `message-details ${className || ''}`.trim());
    const summary = element('summary');
    const summaryLabel = element('span', 'summary-label');
    highlighted(summaryLabel, label);
    summary.append(summaryLabel);
    if (options.hint) summary.append(element('span', 'detail-hint', options.hint));
    details.append(summary);
    const body = element('div', 'detail-body');
    const pre = element(options.prose ? 'p' : 'pre', options.prose ? 'reasoning-text' : '');
    highlighted(pre, content);
    body.append(pre);
    details.append(body);
    if (options.open) details.open = true;
    return { details, body, pre };
  }

  function jumpLink(index, label, className) {
    const link = element('a', className, label);
    link.href = urlFor(active.case_id, index);
    link.addEventListener('click', (event) => {
      event.preventDefault();
      navigate(active.case_id, index);
    });
    return link;
  }

  function renderCall(call) {
    const name = call.function && call.function.name ? call.function.name : 'Unnamed function';
    const args = call.function && call.function.arguments !== undefined ? call.function.arguments : {};
    const callDetail = detail(name, 'tool-call', pretty(args), { open: contains(name) || contains(pretty(args)) || contains(call.id || '') });
    callDetail.details.querySelector('.summary-label').classList.add('tool-call-name');
    const label = element('div', 'tool-argument-label');
    label.append(element('span', '', 'Function arguments'));
    const resultIndex = resultLookup.get(call.id);
    if (resultIndex !== undefined) label.append(jumpLink(resultIndex, `Result ${messageLabel(resultIndex)} ↗`, 'tool-result-link'));
    else label.append(element('span', '', 'No matching result in this trace'));
    callDetail.body.insertBefore(label, callDetail.pre);
    if (call.id) callDetail.body.append(highlighted(element('span', 'call-id'), `Call ID: ${call.id}`));
    return callDetail.details;
  }

  function renderMessage(message, index) {
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    const card = element('article', `message role-${role.replace(/[^a-z-]/gi, '')}`);
    card.id = messageId(index);
    card.dataset.messageIndex = String(index + 1);
    card.setAttribute('aria-label', `Message ${index + 1}, ${role}`);
    const header = element('header', 'message-header');
    const labels = element('div', 'message-label');
    labels.append(element('span', 'message-index', messageLabel(index)));
    labels.append(element('span', 'role-tag', role));
    if (role === 'tool') {
      const origin = callLookup.get(message.tool_call_id);
      if (origin) labels.append(highlighted(element('span', 'tool-header-name'), origin.call.function.name));
    }
    const permalink = element('button', 'message-permalink', '↗');
    permalink.type = 'button';
    permalink.title = `Copy link to message ${index + 1}`;
    permalink.setAttribute('aria-label', `Copy permalink to message ${index + 1}`);
    permalink.addEventListener('click', () => copyLink(urlFor(active.case_id, index)));
    header.append(labels, permalink);
    card.append(header);

    const content = valueText(message.content);
    if (role === 'system') {
      card.append(detail('System instructions', 'system-detail', content, { hint: 'FULL TEXT', open: contains(content) }).details);
    } else if (role === 'tool') {
      const result = detail('Tool result', 'result-detail', pretty(message.content), { hint: 'FULL RESULT', open: query !== '' && occurrences(searchText(message), query) > 0 });
      const origin = callLookup.get(message.tool_call_id);
      const relation = element('div', 'result-origin');
      if (origin) relation.append(jumpLink(origin.index, `From assistant ${messageLabel(origin.index)} ↗`, 'call-origin-link'));
      if (message.tool_call_id) relation.append(highlighted(element('span', 'call-id'), `Call ID: ${message.tool_call_id}`));
      if (relation.childNodes.length) result.body.insertBefore(relation, result.pre);
      card.append(result.details);
    } else {
      if (content !== '') card.append(highlighted(element('div', 'message-body'), content));
      else if (role === 'assistant') card.append(element('p', 'no-visible-text', 'No user-facing text in this message.'));
      else card.append(element('p', 'no-visible-text', 'Empty content.'));
    }

    if (message.reasoning_content !== undefined) {
      const reasoning = valueText(message.reasoning_content);
      card.append(detail('Reasoning', 'reasoning-detail', reasoning || '(Empty reasoning content)', { prose: true, hint: 'RECORDED REASONING', open: contains(reasoning) }).details);
    }
    for (const call of message.tool_calls || []) card.append(renderCall(call));
    return card;
  }

  function renderMessages() {
    const fragment = document.createDocumentFragment();
    let visible = 0;
    let matches = 0;
    let lastShown = -1;
    active.messages.forEach((message, index) => {
      const hits = query ? occurrences(searchText(message), query) : 0;
      if (query && !hits) return;
      if (query && index > lastShown + 1) {
        const from = lastShown + 2;
        const to = index;
        fragment.append(element('div', 'search-gap', `Message${from === to ? '' : 's'} ${from === to ? from : `${from}–${to}`} hidden by search`));
      }
      fragment.append(renderMessage(message, index));
      visible += 1;
      matches += hits;
      lastShown = index;
    });
    if (query && lastShown < active.messages.length - 1 && visible) {
      const from = lastShown + 2;
      const to = active.messages.length;
      fragment.append(element('div', 'search-gap', `Message${from === to ? '' : 's'} ${from === to ? from : `${from}–${to}`} hidden by search`));
    }
    ui.list.replaceChildren(fragment);
    ui.banner.hidden = query === '';
    ui.filterStatus.textContent = `Filtered view · ${visible} of ${active.messages.length} messages · ${matches} match${matches === 1 ? '' : 'es'}`;
    ui.empty.hidden = !query || visible > 0;
    ui.footerText.textContent = query ? `Filtered view: ${visible} of ${active.messages.length} messages shown.` : `End of trace · All ${active.messages.length} messages shown in original order.`;
  }

  function renderNav() {
    ui.nav.replaceChildren();
    rows.forEach((row) => {
      const button = element('button', 'case-option');
      button.type = 'button';
      if (row === active) button.setAttribute('aria-current', 'page');
      button.append(element('span', 'option-id', row.case_id));
      button.append(element('span', 'option-title', caseTitle(row)));
      button.addEventListener('click', () => navigate(row.case_id));
      ui.nav.append(button);
    });
  }

  function renderOverview() {
    ui.caseId.textContent = active.case_id;
    ui.title.textContent = caseTitle(active);
    document.title = `${caseTitle(active)} · Personal Agent Trajectories`;
    const fileName = `${active.case_id}.json`;
    ui.download.href = downloadUrl(fileName);
    ui.download.download = fileName;
    ui.facts.replaceChildren();
    const messages = active.messages;
    const userTurns = messages.filter((message) => message.role === 'user').length;
    const calls = messages.reduce((sum, message) => sum + (message.tool_calls || []).length, 0);
    for (const [number, label] of [[messages.length, 'messages'], [userTurns, 'user-role inputs'], [calls, 'tool calls']]) {
      const fact = element('span');
      fact.append(element('strong', 'fact-number', String(number)), document.createTextNode(label));
      ui.facts.append(fact);
    }
    if (active.metadata && active.metadata.virtual_device_date) {
      const fact = element('span', 'fact-divider');
      fact.append(document.createTextNode('Virtual date'), element('strong', 'fact-number', active.metadata.virtual_device_date));
      ui.facts.append(fact);
    }
    ui.metadata.textContent = pretty(active.metadata || {});
    $('#metadata-details').open = false;
  }

  function clearSearch() {
    window.clearTimeout(searchTimer);
    query = '';
    ui.search.value = '';
    if (active) renderMessages();
  }

  function scrollToMessage(index) {
    const card = document.getElementById(messageId(index));
    if (!card) { announce('That message is not available in this case.'); return; }
    document.querySelectorAll('.message.is-focused').forEach((node) => node.classList.remove('is-focused'));
    card.classList.add('is-focused');
    if (active.messages[index].role === 'tool' || active.messages[index].role === 'system') {
      const mainDetail = card.querySelector('.result-detail, .system-detail');
      if (mainDetail) mainDetail.open = true;
    }
    card.scrollIntoView({ behavior: 'auto', block: 'start' });
    card.setAttribute('tabindex', '-1');
    card.focus({ preventScroll: true });
  }

  function applyLocation() {
    if (!rows.length) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const requestedId = params.get('case');
    const next = rows.find((row) => row.case_id === requestedId) || rows.find((row) => row.case_id === 'personal_agent_case001') || rows[0];
    const changed = next !== active;
    if (changed) {
      active = next;
      clearSearch();
      buildLookups();
      renderNav();
      renderOverview();
      renderMessages();
    }
    const rawMessage = params.get('message');
    if (rawMessage && /^\d+$/.test(rawMessage)) {
      const index = Number(rawMessage) - 1;
      if (query) clearSearch();
      const ticket = generation;
      window.requestAnimationFrame(() => { if (ticket === generation && active) scrollToMessage(index); });
    } else if (changed) {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
    if (!requestedId) window.history.replaceState(null, '', urlFor(active.case_id));
  }

  function navigate(caseId, index) {
    const url = urlFor(caseId, index);
    if (window.location.href === url) applyLocation();
    else window.location.hash = new URL(url).hash;
  }

  function validate(data) {
    if (!Array.isArray(data) || !data.length) throw new Error('The collection does not contain any case records.');
    const ids = new Set();
    for (const row of data) {
      if (!row || typeof row.case_id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(row.case_id) || !Array.isArray(row.messages)) throw new Error('A case record has an invalid identifier or message list.');
      if (ids.has(row.case_id)) throw new Error('The collection contains duplicate case identifiers.');
      ids.add(row.case_id);
      const calls = new Map();
      const results = new Set();
      row.messages.forEach((message, index) => {
        if (!message || typeof message.role !== 'string') throw new Error(`An invalid message was found in ${row.case_id}.`);
        if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error(`Invalid tool calls in ${row.case_id}.`);
        for (const call of message.tool_calls || []) {
          if (!call || !call.id || !call.function || typeof call.function.name !== 'string' || calls.has(call.id)) throw new Error(`An invalid or duplicate tool call was found in ${row.case_id}.`);
          calls.set(call.id, index);
        }
        if (message.role === 'tool') {
          if (!message.tool_call_id || !calls.has(message.tool_call_id) || results.has(message.tool_call_id)) throw new Error(`A tool result could not be paired in ${row.case_id}.`);
          results.add(message.tool_call_id);
        }
      });
      if (results.size !== calls.size) throw new Error(`Some tool calls have no recorded result in ${row.case_id}.`);
    }
  }

  $('#copy-case').addEventListener('click', () => { if (active) copyLink(urlFor(active.case_id)); });
  $('.skip-link').addEventListener('click', (event) => {
    event.preventDefault();
    $('#trace').focus({ preventScroll: true });
    $('#trace').scrollIntoView({ behavior: 'auto', block: 'start' });
  });
  $('#expand-all').addEventListener('click', () => ui.list.querySelectorAll('details').forEach((node) => { node.open = true; }));
  $('#collapse-all').addEventListener('click', () => ui.list.querySelectorAll('details').forEach((node) => { node.open = false; }));
  $('#clear-search').addEventListener('click', clearSearch);
  $('#empty-clear').addEventListener('click', clearSearch);
  $('#back-to-top').addEventListener('click', (event) => { event.preventDefault(); window.scrollTo({ top: 0, behavior: 'auto' }); });
  ui.search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => { query = ui.search.value.trim(); if (active) renderMessages(); }, 100);
  });
  document.addEventListener('keydown', (event) => {
    const editing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (event.key === '/' && !editing && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); ui.search.focus(); }
    if (event.key === 'Escape' && document.activeElement === ui.search) clearSearch();
  });
  window.addEventListener('hashchange', handleLocation);
  window.addEventListener('popstate', handleLocation);
  window.addEventListener('pageshow', handleLocation);

  function downloadUrl(fileName) {
    if (!files || typeof files[fileName] !== 'string') throw new Error('Download unavailable.');
    if (!blobUrls.has(fileName)) {
      blobUrls.set(fileName, URL.createObjectURL(new Blob([files[fileName]], { type: fileName.endsWith('.jsonl') ? 'application/x-ndjson;charset=utf-8' : 'application/json;charset=utf-8' })));
    }
    return blobUrls.get(fileName);
  }

  function clearUnlockedState() {
    if (vaultController) vaultController.abort();
    vaultController = null;
    window.clearTimeout(searchTimer);
    window.clearTimeout(announcementTimer);
    rows = [];
    active = null;
    files = null;
    query = '';
    callLookup.clear();
    resultLookup.clear();
    for (const url of blobUrls.values()) URL.revokeObjectURL(url);
    blobUrls.clear();
    ui.list.replaceChildren();
    ui.nav.replaceChildren(element('p', 'muted sidebar-loading', 'Private collection'));
    ui.count.textContent = '';
    ui.caseId.textContent = '';
    ui.title.textContent = '';
    ui.facts.replaceChildren();
    ui.metadata.textContent = '';
    ui.search.value = '';
    ui.filterStatus.textContent = '';
    ui.footerText.textContent = '';
    ui.overview.hidden = true;
    ui.tools.hidden = true;
    ui.footer.hidden = true;
    ui.empty.hidden = true;
    ui.banner.hidden = true;
    ui.download.removeAttribute('href');
    ui.download.removeAttribute('download');
    ui.downloadAll.removeAttribute('href');
    ui.downloadAll.setAttribute('aria-disabled', 'true');
    ui.announcement.textContent = '';
    ui.announcement.classList.remove('visible');
    ui.fallback.value = '';
    if (ui.dialog.open && typeof ui.dialog.close === 'function') ui.dialog.close();
    else ui.dialog.removeAttribute('open');
    document.title = 'Personal Agent Trajectories';
  }

  function lockedState(failed = false) {
    ui.load.hidden = false;
    ui.load.className = 'load-state is-locked';
    ui.load.replaceChildren(
      element('h2', '', failed ? 'This link could not unlock the collection' : 'This collection is private'),
      element('p', '', 'Open the complete private link to view this collection.')
    );
  }

  function decodeBase64Url(value, expectedLength) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding.');
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (expectedLength !== undefined && bytes.length !== expectedLength) throw new Error('Invalid length.');
    return bytes;
  }

  function stillCurrent(key, ticket) {
    return ticket === generation && new URLSearchParams(window.location.hash.slice(1)).get('k') === key;
  }

  async function unlock(key, ticket) {
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !window.crypto || !window.crypto.subtle) throw new Error('Unavailable.');
      const rawKey = decodeBase64Url(key, 32);
      const cryptoKey = await window.crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
      rawKey.fill(0);
      if (!stillCurrent(key, ticket)) return;
      ui.load.className = 'load-state';
      ui.load.replaceChildren(element('h2', '', 'Opening the private collection'), element('p', '', 'Unlocking this collection in your browser.'));
      vaultController = new AbortController();
      const response = await fetch('./data/vault.json', { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: vaultController.signal });
      if (!response.ok) throw new Error('Unavailable.');
      const vault = await response.json();
      if (!stillCurrent(key, ticket)) return;
      if (!vault || vault.version !== 1 || vault.algorithm !== 'AES-GCM') throw new Error('Invalid collection.');
      const iv = decodeBase64Url(vault.iv, 12);
      const ciphertext = decodeBase64Url(vault.ciphertext);
      if (ciphertext.length < 16) throw new Error('Invalid collection.');
      const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, cryptoKey, ciphertext);
      if (!stillCurrent(key, ticket)) { new Uint8Array(decrypted).fill(0); return; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(decrypted);
      new Uint8Array(decrypted).fill(0);
      const payload = JSON.parse(text);
      if (!payload || !payload.files || typeof payload.files !== 'object' || Array.isArray(payload.files)) throw new Error('Invalid collection.');
      if (typeof payload.files['personal_agent_messages.json'] !== 'string') throw new Error('Invalid collection.');
      const data = JSON.parse(payload.files['personal_agent_messages.json']);
      validate(data);
      for (const row of data) {
        if (typeof payload.files[`${row.case_id}.json`] !== 'string') throw new Error('Invalid collection.');
      }
      if (!stillCurrent(key, ticket)) return;
      files = payload.files;
      rows = data;
      ui.count.textContent = String(rows.length).padStart(2, '0');
      ui.load.hidden = true;
      ui.overview.hidden = false;
      ui.tools.hidden = false;
      ui.footer.hidden = false;
      ui.downloadAll.href = downloadUrl('personal_agent_messages.json');
      ui.downloadAll.download = 'personal_agent_messages.json';
      ui.downloadAll.removeAttribute('aria-disabled');
      applyLocation();
    } catch (_error) {
      if (!stillCurrent(key, ticket)) return;
      clearUnlockedState();
      lockedState(true);
    }
  }

  function handleLocation() {
    const key = new URLSearchParams(window.location.hash.slice(1)).get('k');
    if (key === stateKey) {
      if (rows.length) applyLocation();
      return;
    }
    stateKey = key;
    generation += 1;
    clearUnlockedState();
    lockedState();
    if (key) unlock(key, generation);
  }

  handleLocation();
})();
