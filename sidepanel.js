/**
 * Side panel controller:
 * - Renders model/provider status, search/Ask inputs, highlights, and settings.
 * - Delegates all operations to the background worker via message passing.
 * - Keeps UI state (pause toggle, provider health, logs link) in sync.
 */

// ---------------------------------------------------------------------------
// Model selector utilities
// ---------------------------------------------------------------------------
function populateModelSelectors(models, selectedSummary, selectedChat, selectedEmbed) {
  const summarySelect = document.getElementById('summaryModelSelect');
  const chatSelect = document.getElementById('chatModelSelect');
  const embedSelect = document.getElementById('embedModelSelect');
  // Clear existing options.
  summarySelect.innerHTML = '';
  chatSelect.innerHTML = '';
  if (embedSelect) embedSelect.innerHTML = '';
  const addOption = (select, model, isSelected) => {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    if (isSelected) {
      opt.selected = true;
    }
    select.appendChild(opt);
  };
  models.forEach(model => {
    addOption(summarySelect, model, model === selectedSummary);
    addOption(chatSelect, model, model === selectedChat);
    if (embedSelect) addOption(embedSelect, model, model === selectedEmbed);
  });
}

// ---------------------------------------------------------------------------
// Provider configuration/rendering
// ---------------------------------------------------------------------------
function initModels() {
  function renderProvidersStatusList(providers) {
    const wrap = document.getElementById('ollamaStatus');
    if (!wrap) return;
    const parts = [];
    for (const p of (providers || [])) {
      const st = p.status || {};
      const known = (typeof st.online === 'boolean');
      const text = known ? (st.online ? 'online' : 'offline') : 'checking…';
      const color = known ? (st.online ? 'green' : 'red') : '#666';
      parts.push(`<span style="margin-right:10px;">${p.name}: <span style="color:${color}">${text}</span></span>`);
    }
    wrap.innerHTML = parts.join('');
  }
  function refreshProvidersStatus() {
    chrome.runtime.sendMessage({ type: 'GET_PROVIDERS' }, (res) => {
      renderProvidersStatusList(res?.providers || []);
    });
  }
  refreshProvidersStatus();
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'PROVIDER_STATUS') {
        refreshProvidersStatus();
      } else if (msg?.type === 'PAUSE_STATE') {
        try {
          const pauseToggle = document.getElementById('pauseToggle');
          if (pauseToggle) pauseToggle.checked = !!msg.paused;
          const badge = document.getElementById('pausedBadge');
          if (badge) badge.style.display = msg.paused ? '' : 'none';
        } catch (_) {}
      }
    });
  } catch (_) {}

  function renderProviders() {
    const statusSpan = document.getElementById('testConnStatus');
    if (statusSpan) statusSpan.textContent = '';
    const containerId = 'providerSettings';
    let container = document.getElementById(containerId);
    if (!container) {
      container = document.createElement('div');
      container.id = containerId;
      const logLevelRow = document.getElementById('logLevel')?.parentElement;
      // Insert after the logging row if found
      if (logLevelRow && logLevelRow.parentElement) {
        logLevelRow.parentElement.insertBefore(container, logLevelRow.nextSibling);
      } else {
        document.body.appendChild(container);
      }
    }
    container.innerHTML = '';
    chrome.runtime.sendMessage({ type: 'GET_PROVIDERS' }, (res) => {
      if (!res || !Array.isArray(res.providers)) return;
      for (const p of res.providers) {
        const sec = document.createElement('div');
        sec.style.margin = '6px 0';
        const title = document.createElement('div');
        title.style.fontWeight = 'bold';
        title.textContent = `${p.name} Settings:`;
        sec.appendChild(title);
        const actionsById = new Map((p.actions || []).map(a => [a.id, a]));
        for (const f of (p.settings || [])) {
          const row = document.createElement('div');
          const label = document.createElement('label');
          label.textContent = `${f.label}:`;
          const input = document.createElement('input');
          input.value = f.value || '';
          input.style.marginLeft = '6px'; input.style.width = '280px';
          row.appendChild(label); row.appendChild(input);
          const saveBtn = document.createElement('button');
          saveBtn.textContent = 'Save';
          saveBtn.style.marginLeft = '6px';
          saveBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'SET_PROVIDER_SETTING', providerId: p.id, key: f.key, value: input.value }, (r) => {
              if (r?.error) { alert(`Save failed: ${r.error}`); return; }
              renderProviders();
            });
          });
          row.appendChild(saveBtn);
          // Place Test button inline next to Save when available
          if (actionsById.has('test')) {
            const testBtn = document.createElement('button');
            testBtn.textContent = 'Test';
            testBtn.style.marginLeft = '6px';
            const testResult = document.createElement('span');
            testResult.style.marginLeft = '8px';
            testResult.style.fontSize = '0.9em';
            testBtn.addEventListener('click', () => {
              // Clear and show interim state
              testResult.textContent = 'Testing…';
              testResult.style.color = '#666';
              const baseOverride = input.value || '';
              chrome.runtime.sendMessage({ type: 'PROVIDER_ACTION', providerId: p.id, action: 'test', baseOverride }, (r) => {
                const ok = !!r?.ok && !!(r?.status?.online);
                const ms = r?.detail?.ms;
                const http = r?.detail?.status;
                const err = r?.detail?.error || r?.status?.lastError;
                if (ok) {
                  const extra = (http ? `HTTP ${http}` : '') + (ms ? `, ${ms}ms` : '');
                  testResult.textContent = `Connected${extra ? ` (${extra})` : ''}`;
                  testResult.style.color = 'green';
                } else {
                  let note = 'No connection';
                  if (err) note += ` (${err})`;
                  else if (http) note += ` (HTTP ${http})`;
                  testResult.textContent = note;
                  testResult.style.color = 'red';
                }
                // Do not update global provider status; this is a disconnected test
              });
            });
            row.appendChild(testBtn);
            row.appendChild(testResult);
          }
          sec.appendChild(row);
        }
        const actionsRow = document.createElement('div');
        for (const a of (p.actions || [])) {
          if (a.id === 'test') continue; // already rendered inline
          const btn = document.createElement('button');
          btn.textContent = a.label;
          btn.style.marginLeft = '0px'; btn.style.marginTop = '4px';
          btn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'PROVIDER_ACTION', providerId: p.id, action: a.id }, () => refreshProvidersStatus());
          });
          actionsRow.appendChild(btn);
        }
        if (actionsRow.childElementCount > 0) sec.appendChild(actionsRow);
        container.appendChild(sec);
      }
    });
  }
  renderProviders();

  // Request available models (once) and populate selectors
  chrome.runtime.sendMessage({ type: 'LIST_MODELS' }, (response) => {
    const models = response?.models || [];
    chrome.runtime.sendMessage({ type: 'GET_MODEL_SETTINGS' }, (settings) => {
      populateModelSelectors(models, settings.summaryModel, settings.chatModel, settings.embedModel);
    });
  });

  // Pause toggle wiring
  const pauseToggle = document.getElementById('pauseToggle');
  if (pauseToggle) {
    // Read current setting
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
      if (resp && typeof resp.paused === 'boolean') {
        pauseToggle.checked = !!resp.paused;
        const badge = document.getElementById('pausedBadge');
        if (badge) badge.style.display = resp.paused ? '' : 'none';
      }
    });
    pauseToggle.addEventListener('change', (e) => {
      const v = !!e.target.checked;
      chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: { paused: v } }, () => {
        try { showToast(v ? 'Capture paused' : 'Capture resumed'); } catch (_) {}
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Search + Ask interaction handlers
// ---------------------------------------------------------------------------
function runSearch(optionalQuery) {
  const query = (optionalQuery !== undefined ? optionalQuery : document.getElementById('query').value || '').trim();
  if (!query) return;
  // Determine requested result count (default 10, bounds 1..50)
  let limit = parseInt(document.getElementById('limitInput').value, 10);
  if (isNaN(limit) || limit < 1) limit = 1;
  if (limit > 50) limit = 50;
  const resultsDiv = document.getElementById('results');
  resultsDiv.textContent = 'Searching...';
  const clearBtn = document.getElementById('clearResultsBtn');
  if (clearBtn) clearBtn.style.display = 'none';
  chrome.runtime.sendMessage({ type: 'SEARCH_QUERY', query, limit }, (response) => {
    resultsDiv.innerHTML = '';
    if (response?.error) {
      const errElem = document.createElement('div');
      errElem.textContent = `Error: ${response.error}`;
      resultsDiv.appendChild(errElem);
      return;
    }
    let results = response?.results || [];
    // Apply filters if present
    const domainSel = (document.getElementById('domainFilter')?.value) || '';
    const fromStr = document.getElementById('dateFrom')?.value || '';
    const toStr = document.getElementById('dateTo')?.value || '';
    const thresholdEl = document.getElementById('threshold');
    const threshold = thresholdEl ? (parseInt(thresholdEl.value, 10) || 0) : 0;
    if (domainSel) {
      results = results.filter(r => { try { return new URL(r.url).hostname === domainSel; } catch (_) { return false; } });
    }
    if (fromStr) {
      const fromTs = new Date(fromStr + 'T00:00:00').getTime();
      results = results.filter(r => typeof r.timestamp === 'number' ? r.timestamp >= fromTs : true);
    }
    if (toStr) {
      const toTs = new Date(toStr + 'T23:59:59').getTime();
      results = results.filter(r => typeof r.timestamp === 'number' ? r.timestamp <= toTs : true);
    }
    if (threshold > 0) {
      results = results.filter(r => (typeof r.calibrated === 'number' ? r.calibrated : (r.similarityPct || 0)) >= threshold);
    }
    // Collapse by canonical URL: take top per canonicalUrl
    const groups = new Map();
    for (const r of results) {
      const key = r.canonicalUrl || r.url;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const collapsed = [];
    for (const [key, arr] of groups.entries()) {
      // arr is already ordered by rank; pick the first as representative
      const rep = arr[0];
      rep._groupSize = arr.length;
      collapsed.push(rep);
    }
    results = collapsed;

    if (results.length === 0) {
      resultsDiv.textContent = 'No results.';
      if (clearBtn) clearBtn.style.display = 'none';
      return;
    }
    if (clearBtn) clearBtn.style.display = '';
    for (const res of results) {
      const container = document.createElement('div');
      container.className = 'result';
      const link = document.createElement('a');
      link.href = res.url;
      link.textContent = res.title;
      link.target = '_blank';
      container.appendChild(link);
      if (res._groupSize && res._groupSize > 1) {
        const badge = document.createElement('span');
        badge.textContent = ` — ${res._groupSize} hits`; // basic badge
        badge.style.marginLeft = '6px';
        badge.style.fontSize = '0.85em';
        badge.style.color = '#555';
        container.appendChild(badge);
      }
      // Show metrics and exact indicator
      const meta = document.createElement('div');
      meta.className = 'snippet';
      const parts = [];
      if (typeof res.similarityPct === 'number') parts.push(`Similarity: ${res.similarityPct}%`);
      if (typeof res.llmRankPct === 'number') parts.push(`LLM rank: ${(res.llmRankPct/10).toFixed(1)}/10`);
      if (typeof res.calibrated === 'number') parts.push(`Calibrated: ${res.calibrated}%`);
      if (res.containsExact) parts.push('[Exact match]');
      if (parts.length > 0) meta.textContent = parts.join(' · ');
      if (typeof res.recencyWeight === 'number') {
        meta.title = `Similarity: ${res.similarityPct ?? 'n/a'}%\nLLM rank: ${res.llmRankPct ? (res.llmRankPct/10).toFixed(1) : 'n/a' }/10\nRecency weight: ${res.recencyWeight.toFixed(3)}\nCalibrated: ${res.calibrated ?? 'n/a'}%`;
      }
      if (parts.length > 0) container.appendChild(meta);
      const snippet = document.createElement('p');
      snippet.className = 'snippet';
      snippet.innerHTML = highlightPhrase((res.snippet || '') + '...', (document.getElementById('query').value || ''));
      container.appendChild(snippet);
      resultsDiv.appendChild(container);
    }
  });
}

function escapeHtml(s) { return (s||'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function highlightPhrase(text, phrase) {
  const esc = escapeHtml(text);
  const q = (phrase || '').trim();
  if (!q) return esc;
  try {
    const re = new RegExp(escapeRegex(q), 'ig');
    return esc.replace(re, (m) => `<mark>${m}</mark>`);
  } catch (_) {
    return esc;
  }
}

// ---------------------------------------------------------------------------
// Event delegation and initialisation
// ---------------------------------------------------------------------------
document.getElementById('searchBtn').addEventListener('click', () => runSearch());
// Clear results
const clearBtn = document.getElementById('clearResultsBtn');
if (clearBtn) {
  clearBtn.addEventListener('click', () => {
    const resultsDiv = document.getElementById('results');
    if (resultsDiv) resultsDiv.innerHTML = '';
    clearBtn.style.display = 'none';
  });
}
// Toggle Advanced
const advBtn = document.getElementById('toggleAdvancedBtn');
if (advBtn) {
  advBtn.addEventListener('click', () => {
    const cont = document.getElementById('advancedContainer');
    const show = cont.style.display === 'none' || cont.style.display === '';
    cont.style.display = show ? 'block' : 'none';
    advBtn.textContent = show ? 'Advanced ▾' : 'Advanced ▸';
  });
}

// Handle the 'Today's Highlights' button.  When clicked, it requests
// daily highlights from the background script and displays them below
// the search results.  If there is an error or no pages captured,
// an appropriate message is shown.
document.getElementById('highlightsBtn').addEventListener('click', () => {
  const highlightDiv = document.getElementById('highlight');
  // Clear existing content and indicate loading.
  highlightDiv.textContent = 'Loading highlights...';
  // Request highlights for today.  We rely on the background script to
  // determine the correct date when the date parameter is omitted.
  chrome.runtime.sendMessage({ type: 'GET_HIGHLIGHTS' }, (response) => {
    highlightDiv.innerHTML = '';
    if (response?.error) {
      highlightDiv.textContent = `Error: ${response.error}`;
      return;
    }
    const highlight = response?.highlight;
    if (!highlight || highlight.trim().length === 0) {
      highlightDiv.textContent = 'No highlights available for today.';
      return;
    }
    // Display the highlight as a paragraph.  You could enhance this
    // section to include links to individual pages or times visited.
    const para = document.createElement('p');
    para.className = 'snippet';
    para.textContent = highlight;
    highlightDiv.appendChild(para);
  });
});

// Event handler for model selection changes.  When a user selects a new model,
// persist the setting in chrome.storage via the background script.
document.getElementById('summaryModelSelect').addEventListener('change', (e) => {
  const model = e.target.value;
  chrome.runtime.sendMessage({ type: 'SET_MODEL', key: 'summaryModel', value: model }, () => {});
});
document.getElementById('chatModelSelect').addEventListener('change', (e) => {
  const model = e.target.value;
  chrome.runtime.sendMessage({ type: 'SET_MODEL', key: 'chatModel', value: model }, () => {});
});
const embedSel = document.getElementById('embedModelSelect');
if (embedSel) {
  embedSel.addEventListener('change', (e) => {
    const model = e.target.value;
    chrome.runtime.sendMessage({ type: 'SET_MODEL', key: 'embedModel', value: model }, () => {});
  });
}

// Event handler for refreshing the model list.
document.getElementById('refreshModelsBtn').addEventListener('click', () => {
  initModels();
});

// Event handler for asking a question via RAG.  Retrieves the text from the
// question input, sends it to the background script and displays the answer.
document.getElementById('askBtn').addEventListener('click', () => {
  const question = (document.getElementById('question').value || '').trim();
  const answerDiv = document.getElementById('answer');
  const progressDiv = document.getElementById('askProgress');
  const sourcesDiv = document.getElementById('sources');
  const actionsDiv = document.getElementById('answerActions');
  if (!question) {
    return;
  }
  answerDiv.textContent = 'Thinking...';
  if (progressDiv) progressDiv.textContent = '';
  sourcesDiv.innerHTML = '';
  actionsDiv.innerHTML = '';
  chrome.runtime.sendMessage({ type: 'ASK_QUESTION', question }, (response) => {
    answerDiv.innerHTML = '';
    const lastErr = chrome.runtime.lastError;
    if (lastErr) {
      answerDiv.textContent = `Error: ${lastErr.message || String(lastErr)}`;
      return;
    }
    if (!response) {
      answerDiv.textContent = 'No answer.';
      return;
    }
    if (response.error) {
      answerDiv.textContent = `Error: ${response.error}`;
    } else {
      const text = (response.answer !== undefined && response.answer !== null) ? response.answer : 'No answer.';
      // Render answer with citation anchors [1], [2] linking to sources
      renderAnswerWithCitations(answerDiv, text, response.sources || []);
      // Render sources with Open links
      const sources = response.sources || [];
      const explanations = response.explanations || [];
      if (Array.isArray(sources) && sources.length > 0) {
        const ul = document.createElement('ul');
        for (const s of sources) {
          const li = document.createElement('li');
          li.id = `source-${s.index}`;
          const idx = document.createElement('strong');
          idx.textContent = `[${s.index}] `;
          li.appendChild(idx);
          const a = document.createElement('a');
          a.href = s.url;
          a.textContent = s.title;
          a.target = '_blank';
          li.appendChild(a);
          if (s.domain) {
            const span = document.createElement('span');
            span.textContent = ` (${s.domain})`;
            span.style.marginLeft = '4px';
            li.appendChild(span);
          }
          // Placeholder for inline explanation under each source
          const explainDiv = document.createElement('div');
          explainDiv.className = 'explain-block';
          explainDiv.style.marginTop = '4px';
          li.appendChild(explainDiv);
          ul.appendChild(li);
        }
        sourcesDiv.appendChild(ul);
      }
      // Copy answer + sources button
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy Answer';
      copyBtn.addEventListener('click', async () => {
        let copyText = text;
        if (Array.isArray(response.sources) && response.sources.length) {
          copyText += '\n\nSources:\n' + response.sources.map(s => `[${s.index}] ${s.title}${s.domain ? ` (${s.domain})` : ''} — ${s.url}`).join('\n');
        }
        try {
          await navigator.clipboard.writeText(copyText);
          showToast('Copied');
        } catch (_) {}
      });
      actionsDiv.appendChild(copyBtn);

      if (Array.isArray(explanations) && explanations.length > 0) {
        const explainBtn = document.createElement('button');
        let explainShown = false;
        explainBtn.textContent = 'Explain Answer';
        explainBtn.style.marginLeft = '6px';
        explainBtn.addEventListener('click', () => {
          if (!explainShown) {
            renderExplanation(explanations);
            explainBtn.textContent = 'Hide Explanation';
            explainShown = true;
          } else {
            // Clear inline explanations
            document.querySelectorAll('.explain-block').forEach(b => { b.innerHTML = ''; });
            explainBtn.textContent = 'Explain Answer';
            explainShown = false;
          }
        });
        actionsDiv.appendChild(explainBtn);
      }
    }
  });
});

// Replace [n] with anchor links to #source-n, escaping other content
function renderAnswerWithCitations(container, text, sources) {
  function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  const escaped = escapeHtml(text);
  let linked = escaped.replace(/\[(\d+)\]/g, (m, g1) => {
    const idx = parseInt(g1, 10);
    if (!isNaN(idx) && sources.find(s => s.index === idx)) {
      return `<a href="#source-${idx}" class="citation" data-idx="${idx}">[${idx}]</a>`;
    }
    return m;
  });
  container.innerHTML = `<div class="answerText">${linked}</div>`;
  // Smooth-scroll on citation click
  container.querySelectorAll('a.citation').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.getAttribute('href').slice(1);
      const target = document.getElementById(id);
      if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function renderExplanation(exps) {
  // Attach explanation under each corresponding source list item
  exps.forEach(e => {
    const li = document.getElementById(`source-${e.index}`);
    if (!li) return;
    let block = li.querySelector('.explain-block');
    if (!block) {
      block = document.createElement('div');
      block.className = 'explain-block';
      li.appendChild(block);
    }
    // Build meta + snippet
    const parts = [];
    if (typeof e.score === 'number') parts.push(`similarity: ${((e.score+1)/2*100).toFixed(0)}%`);
    if (typeof e.weightedScore === 'number') parts.push(`weighted: ${e.weightedScore.toFixed(3)}`);
    if (typeof e.crossScore === 'number') parts.push(`rerank: ${e.crossScore}`);
    const metaLine = parts.join(' · ');
    block.innerHTML = `<div class="snippet">${escapeHtml(metaLine)}</div><div class="snippet">${escapeHtml(e.snippet || '')}</div>`;
  });
}

// Kick off initialisation once the side panel is loaded.
initModels();

// Settings: load current values and wire change handlers
function initSettings() {
  const rewriteToggle = document.getElementById('rewriteToggle');
  const crossToggle = document.getElementById('crossToggle');
  const answerMode = document.getElementById('answerMode');
  const logLevel = document.getElementById('logLevel');
  const logFullBodies = document.getElementById('logFullBodies');
  const enableTools = document.getElementById('enableTools');
  const maxToolSteps = document.getElementById('maxToolSteps');
  const toolTimeoutMs = document.getElementById('toolTimeoutMs');
  const calibWSim = document.getElementById('calibWSim');
  const calibWLLM = document.getElementById('calibWLLM');
  const saveCalibBtn = document.getElementById('saveCalibBtn');
  const whitelist = document.getElementById('whitelist');
  const blacklist = document.getElementById('blacklist');
  const saveRulesBtn = document.getElementById('saveRulesBtn');
  const manageMemoryBtn = document.getElementById('manageMemoryBtn');
  // Load
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
    if (resp && !resp.error) {
      if (typeof resp.queryRewrite === 'boolean') rewriteToggle.checked = resp.queryRewrite;
      if (typeof resp.crossEncoder === 'boolean') crossToggle.checked = resp.crossEncoder;
      if (resp.answerMode) answerMode.value = resp.answerMode;
      if (resp.logLevel) logLevel.value = resp.logLevel;
      if (typeof resp.logFullBodies === 'boolean') logFullBodies.checked = !!resp.logFullBodies;
      // Provider base URL configured via Provider Settings
      if (typeof resp.enableTools === 'boolean') enableTools.checked = !!resp.enableTools;
      if (typeof resp.maxToolSteps === 'number') maxToolSteps.value = resp.maxToolSteps;
      if (typeof resp.toolTimeoutMs === 'number') toolTimeoutMs.value = resp.toolTimeoutMs;
    }
  });
  // Load capture rules
  chrome.runtime.sendMessage({ type: 'GET_CAPTURE_RULES' }, (resp) => {
    if (resp && !resp.error) {
      whitelist.value = (resp.whitelistDomains || []).join('\n');
      blacklist.value = (resp.blacklistDomains || []).join('\n');
    }
  });
  chrome.runtime.sendMessage({ type: 'GET_CALIBRATION' }, (c) => {
    if (c && !c.error) {
      if (typeof c.wSim === 'number') calibWSim.value = c.wSim.toFixed(2);
      if (typeof c.wLLM === 'number') calibWLLM.value = c.wLLM.toFixed(2);
    }
  });
  // Save on change (partial updates)
  rewriteToggle.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: { queryRewrite: !!e.target.checked } }, () => {});
  });
  crossToggle.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: { crossEncoder: !!e.target.checked } }, () => {});
  });
  answerMode.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: { answerMode: e.target.value } }, () => {});
  });
  logLevel.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: { logLevel: e.target.value } }, () => {
      showToast('Log level updated');
    });
  });
  logFullBodies.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: { logFullBodies: !!e.target.checked } }, () => {
      showToast('Log body detail updated');
    });
  });
  enableTools.addEventListener('change', (e) => {
    chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: { enableTools: !!e.target.checked } }, () => {
      showToast('Tools setting saved');
    });
  });
  maxToolSteps.addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: { maxToolSteps: v } }, () => {
      showToast('Max tool steps saved');
    });
  });
  toolTimeoutMs.addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10) || 10000;
    chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: { toolTimeoutMs: v } }, () => {
      showToast('Tool timeout saved');
    });
  });
  // Base URL saving and connectivity tests are handled per-provider in Provider Settings.
  saveCalibBtn.addEventListener('click', () => {
    const wSim = parseFloat(calibWSim.value);
    const wLLM = parseFloat(calibWLLM.value);
    if (isNaN(wSim) || isNaN(wLLM)) return;
    chrome.runtime.sendMessage({ type: 'SET_CALIBRATION', calibWSim: wSim, calibWLLM: wLLM }, () => {
      showToast('Calibration saved');
    });
  });
  saveRulesBtn.addEventListener('click', () => {
    const wl = whitelist.value.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const bl = blacklist.value.split(/\n+/).map(s => s.trim()).filter(Boolean);
    chrome.runtime.sendMessage({ type: 'SET_CAPTURE_RULES', whitelistDomains: wl, blacklistDomains: bl }, () => {
      showToast('Rules saved');
    });
  });
  manageMemoryBtn.addEventListener('click', () => {
    window.open(chrome.runtime.getURL('manage.html'), '_blank');
  });
}

initSettings();

// Toast helper
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, 1500);
}

// Processing and saved lists
function renderList(elemId, items, isSaved = false) {
  const ul = document.getElementById(elemId);
  if (!ul) return;
  ul.innerHTML = '';
  if (!items || items.length === 0) {
    const li = document.createElement('li');
    li.textContent = isSaved ? 'No pages yet.' : 'Nothing processing.';
    ul.appendChild(li);
    return;
  }
  for (const it of items) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = it.url;
    a.target = '_blank';
    a.textContent = it.title || it.url;
    li.appendChild(a);
    const small = document.createElement('span');
    const d = new Date(it.timestamp);
    let suffix = ` — ${d.toLocaleString()}`;
    if (!isSaved && it.status) {
      suffix += ` — ${it.status}`;
      if (typeof it.attempts === 'number') suffix += ` (attempts: ${it.attempts})`;
    }
    small.textContent = suffix;
    small.style.marginLeft = '6px';
    small.style.fontSize = '0.85em';
    small.style.color = '#666';
    li.appendChild(small);
    if (!isSaved) {
      const btn = document.createElement('button');
      btn.textContent = 'Open page';
      btn.style.marginLeft = '8px';
      btn.addEventListener('click', () => window.open(it.url, '_blank'));
      li.appendChild(btn);
      const retryBtn = document.createElement('button');
      retryBtn.textContent = 'Retry now';
      retryBtn.style.marginLeft = '6px';
      retryBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'RETRY_PROCESSING', url: it.url }, (resp) => {
          if (resp?.error) {
            showToast('Retry failed: ' + resp.error);
          } else {
            showToast('Retry scheduled');
            refreshStatus();
          }
        });
      });
      li.appendChild(retryBtn);
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.marginLeft = '6px';
      cancelBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'CANCEL_PROCESSING', url: it.url }, (resp) => {
          if (resp?.error) {
            showToast('Cancel failed: ' + resp.error);
          } else {
            showToast('Canceled');
            refreshStatus();
          }
        });
      });
      li.appendChild(cancelBtn);
    }
    ul.appendChild(li);
  }
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'GET_PROCESSING' }, (resp) => {
    if (resp && !resp.error) {
      renderList('processingList', resp.processing || [], false);
    }
  });
  chrome.runtime.sendMessage({ type: 'GET_PAGE_LIST' }, (resp) => {
    if (resp && !resp.error) {
      renderList('savedList', resp.pages || [], true);
    }
  });
}

refreshStatus();

// Subscribe to background updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'ASK_PROGRESS') {
    const d = document.getElementById('askProgress');
    if (d && msg.message) {
      const line = document.createElement('div');
      line.textContent = msg.message;
      d.appendChild(line);
    }
  }
  if (msg?.type === 'ASK_TOOL_METRICS') {
    const d = document.getElementById('askProgress');
    if (d && Array.isArray(msg.metrics)) {
      const hdr = document.createElement('div');
      hdr.textContent = 'Tools summary:';
      hdr.style.marginTop = '6px';
      d.appendChild(hdr);
      msg.metrics.forEach(m => {
        const row = document.createElement('div');
        const status = m.ok ? 'ok' : (m.error || 'err');
        row.textContent = `• ${m.name} — ${status} — ${m.ms}ms`;
        d.appendChild(row);
      });
    }
  }
  if (msg?.type === 'PAGE_PROCESSING_STARTED') {
    refreshStatus();
  }
  if (msg?.type === 'PAGE_PROCESSING_ENDED') {
    refreshStatus();
  }
  if (msg?.type === 'PAGE_CAPTURED') {
    showToast('Captured!');
    refreshStatus();
  }
  if (msg?.type === 'PREFILL_QUERY') {
    if (msg.query) {
      const q = document.getElementById('query');
      q.value = msg.query;
      if (msg.autoSearch) runSearch(q.value);
    }
  }
});

// Open Debug Logs
document.getElementById('openLogsBtn').addEventListener('click', () => {
  const url = chrome.runtime.getURL('logs.html');
  window.open(url, '_blank');
});

// Retry all failed in one click
document.getElementById('retryAllBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_PROCESSING' }, (resp) => {
    const list = (resp && Array.isArray(resp.processing)) ? resp.processing : [];
    const failed = list.filter(p => p.status === 'error');
    if (failed.length === 0) {
      showToast('No failed items');
      return;
    }
    let done = 0;
    for (const it of failed) {
      chrome.runtime.sendMessage({ type: 'RETRY_PROCESSING', url: it.url }, () => {
        done++;
        if (done === failed.length) {
          showToast(`Retried ${failed.length}`);
          refreshStatus();
        }
      });
    }
  });
});

// Capture Now: force immediate capture from the active tab
document.getElementById('captureNowBtn').addEventListener('click', () => {
  if (!chrome.tabs) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'FORCE_CAPTURE' }, () => {});
      showToast('Capture requested...');
    }
  });
});

// Open full Highlights page
const openHighlightsBtn = document.getElementById('openHighlightsBtn');
if (openHighlightsBtn) {
  openHighlightsBtn.addEventListener('click', () => {
    try { window.open(chrome.runtime.getURL('highlights.html'), '_blank'); } catch (_) {}
  });
}

// Settings button (top-right) toggles settings container
const settingsTopBtn = document.getElementById('settingsTopBtn');
if (settingsTopBtn) {
  settingsTopBtn.addEventListener('click', () => {
    const cont = document.getElementById('settingsContainer');
    const show = (cont.style.display === 'none' || cont.style.display === '');
    cont.style.display = show ? 'block' : 'none';
  });
}

// Pre-fill query if background stashed one
chrome.storage.local.get(['prefillQuery', 'prefillDoSearch'], (res) => {
  const q = (res.prefillQuery || '').trim();
  if (q) {
    const input = document.getElementById('query');
    input.value = q;
    if (res.prefillDoSearch) runSearch(input.value);
    chrome.storage.local.remove(['prefillQuery', 'prefillDoSearch']);
  }
});
