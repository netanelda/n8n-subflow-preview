// Content script:
// - Detect executeWorkflow caller nodes
// - Render inline faded subflow overlay on canvas hover
// - Keep using page-probe for current-workflow data + sub-workflow fetches

(function () {
  'use strict';

  const LOG_PREFIX = '[n8n SubFlow Preview]';
  const HIDE_DELAY_MS = 200;
  const FADE_OUT_MS = 150;
  const OVERLAY_SAFETY_HIDE_MS = 8000;
  const INLINE_OFFSET_X = 24;
  const INLINE_OFFSET_Y = -26;

  let currentWorkflowId = null;
  let currentWorkflowData = null;
  let hoverTimer = null;
  let hideTimer = null;
  let overlaySafetyTimer = null;
  let activeNodeElement = null;
  let inlineOverlayEl = null;
  let breadcrumbEl = null;
  let breadcrumbTrail = [];
  const workflowNamesById = new Map();

  // CDN-based Font Awesome SVG resolver (content script can fetch freely)
  const FA_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/svgs';
  const FA_STYLE_ORDER = ['solid', 'regular', 'brands'];
  // n8n still emits some FA5 names; map them to FA6 file names.
  const FA5_TO_FA6_ALIASES = {
    'sign-in-alt': 'right-to-bracket',
    'sign-out-alt': 'right-from-bracket'
  };
  // Cache value is data URL (string) or null for negative lookups.
  const faIconCache = Object.create(null);

  async function resolveSingleFaIcon(name) {
    if (Object.prototype.hasOwnProperty.call(faIconCache, name)) return;

    const alias = FA5_TO_FA6_ALIASES[name] || null;
    const candidateNames = alias && alias !== name ? [alias, name] : [name];

    for (const candidateName of candidateNames) {
      for (const style of FA_STYLE_ORDER) {
        try {
          const res = await fetch(`${FA_CDN_BASE}/${style}/${candidateName}.svg`);
          if (!res.ok) continue;
          let svg = await res.text();
          // Replace fill="currentColor" with white so icons are visible on colored circles.
          svg = svg.replace(/fill="currentColor"/g, 'fill="white"');
          faIconCache[name] = `data:image/svg+xml,${encodeURIComponent(svg)}`;
          return;
        } catch (_e) {
          // Keep trying the next candidate path.
        }
      }
    }

    // Negative caching prevents repeated 404 spam for unknown icons.
    faIconCache[name] = null;
  }

  async function resolveFaIcons(nodes) {
    if (!Array.isArray(nodes)) return;

    // Collect unique FA icon names that need fetching.
    const needed = {};
    for (const node of nodes) {
      if (
        node._iconFa &&
        !node._iconUrl &&
        !Object.prototype.hasOwnProperty.call(faIconCache, node._iconFa)
      ) {
        needed[node._iconFa] = true;
      }
    }

    // Fetch all missing FA icons in parallel.
    const names = Object.keys(needed);
    if (names.length > 0) {
      await Promise.all(names.map(resolveSingleFaIcon));
    }

    // Apply cached data URLs to nodes.
    for (const node of nodes) {
      if (node._iconFa && !node._iconUrl) {
        const dataUrl = faIconCache[node._iconFa];
        if (dataUrl) node._iconUrl = dataUrl;
      }
    }
  }

  const pendingSubflowFetches = new Map();
  const hoverState = {
    hoveringExecuteNode: false,
    overlayVisible: false,
    activeSubflowId: null,
    activeRequestSeq: 0,
    cachedWorkflowData: null
  };

  let settings = {
    hoverDelay: 400,
    enableHover: true,
    enableBadges: true
  };

  function init() {
    currentWorkflowId = getWorkflowIdFromUrl();
    if (!currentWorkflowId) return;

    console.log(`${LOG_PREFIX} active — workflow ${currentWorkflowId}`);

    loadSettings().then(() => {
      ensureInlineOverlay();
      ensureBreadcrumbBar();
      breadcrumbTrail = loadBreadcrumbTrail();
      syncBreadcrumbTrail(currentWorkflowId);
      listenForProbeResults();
      observeCanvas();
      requestProbeRefresh();
    });

    watchUrlChanges();
    window.addEventListener('resize', () => {
      if (inlineOverlayEl && inlineOverlayEl.classList.contains('visible')) {
        positionInlineOverlay();
      }
    });
    document.addEventListener('keydown', onGlobalKeydown);
    document.addEventListener('mousemove', onGlobalMouseMove, true);
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get(['hoverDelay', 'enableHover', 'enableBadges']);
    if (data.hoverDelay) settings.hoverDelay = data.hoverDelay;
    if (data.enableHover !== undefined) settings.enableHover = data.enableHover;
    if (data.enableBadges !== undefined) settings.enableBadges = data.enableBadges;
  }

  function getWorkflowIdFromUrl() {
    const match = window.location.pathname.match(/\/workflow\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  }

  function watchUrlChanges() {
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;

      const newId = getWorkflowIdFromUrl();
      if (newId && newId !== currentWorkflowId) {
        currentWorkflowId = newId;
        currentWorkflowData = null;
        hoverState.hoveringExecuteNode = false;
        hoverState.activeRequestSeq++;
        hideInlineOverlay();
        syncBreadcrumbTrail(currentWorkflowId);
        requestProbeRefresh();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function requestProbeRefresh() {
    window.postMessage({ type: 'n8n-subflow-probe-request' }, '*');
  }

  function listenForProbeResults() {
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data) return;

      if (event.data.type === 'n8n-subflow-probe-result') {
        if (event.data.payload) {
          currentWorkflowData = event.data.payload;
          registerWorkflowMeta(currentWorkflowId, event.data.payload.name);
          syncBreadcrumbTrail(currentWorkflowId);
          WorkflowCache.set(currentWorkflowId, currentWorkflowData);
          scanForExecuteWorkflowNodes();
        } else {
          fetchCurrentWorkflowViaApi();
        }
        return;
      }

      if (event.data.type === 'n8n-subflow-fetch-result') {
        const resolve = pendingSubflowFetches.get(event.data.reqId);
        if (!resolve) return;

        pendingSubflowFetches.delete(event.data.reqId);
        if (event.data.payload) {
          resolve({ data: event.data.payload, diagnostics: event.data.diagnostics || null });
        } else {
          resolve({
            error: event.data.error || 'unknown',
            message: event.data.message || 'Failed',
            diagnostics: event.data.diagnostics || null
          });
        }
      }
    });
  }

  function fetchSubWorkflowViaPage(workflowId) {
    return new Promise((resolve) => {
      const reqId = `sf_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      pendingSubflowFetches.set(reqId, resolve);
      window.postMessage({ type: 'n8n-subflow-fetch-request', reqId, workflowId }, '*');

      setTimeout(() => {
        if (!pendingSubflowFetches.has(reqId)) return;
        pendingSubflowFetches.delete(reqId);
        resolve({ error: 'timeout', message: 'Request timed out' });
      }, 15000);
    });
  }

  async function fetchCurrentWorkflowViaApi() {
    const res = await N8nApi.fetchWorkflow(currentWorkflowId);
    if (!res || res.error) return;

    currentWorkflowData = res.data;
    registerWorkflowMeta(currentWorkflowId, res.data.name);
    syncBreadcrumbTrail(currentWorkflowId);
    await WorkflowCache.set(currentWorkflowId, res.data);
    scanForExecuteWorkflowNodes();
  }

  function observeCanvas() {
    const observer = new MutationObserver(() => {
      if (hoverState.overlayVisible && (!activeNodeElement || !activeNodeElement.isConnected)) {
        hoverState.hoveringExecuteNode = false;
        hideInlineOverlay();
      }
      if (currentWorkflowData) scanForExecuteWorkflowNodes();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function scanForExecuteWorkflowNodes() {
    if (!currentWorkflowData || !Array.isArray(currentWorkflowData.nodes)) return;

    const executeNodes = currentWorkflowData.nodes.filter(
      (n) => n.type === 'n8n-nodes-base.executeWorkflow'
    );
    if (executeNodes.length === 0) return;

    const domNodes = document.querySelectorAll('[data-test-id="canvas-node"]');
    domNodes.forEach((el) => {
      try {
        attachHoverDetection(el, executeNodes);
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to bind node`, err);
      }
    });
  }

  function attachHoverDetection(el, executeNodes) {
    if (el.dataset.subflowDetected) return;

    const nameEl = el.querySelector('[data-test-id="canvas-node-box-title"]')
      || el.querySelector('.node-name')
      || el.querySelector('[class*="NodeName"]');
    const nodeName = nameEl ? nameEl.textContent.trim() : null;

    let matchedNode = null;
    if (nodeName) matchedNode = executeNodes.find((n) => n.name === nodeName);

    if (!matchedNode) {
      const typeAttr = el.getAttribute('data-node-type') || '';
      if (typeAttr === 'n8n-nodes-base.executeWorkflow' && executeNodes.length === 1) {
        matchedNode = executeNodes[0];
      }
    }

    if (!matchedNode || matchedNode.type !== 'n8n-nodes-base.executeWorkflow') return;

    el.dataset.subflowDetected = 'true';
    if (settings.enableBadges) addNodeBadge(el);

    if (settings.enableHover) {
      el.addEventListener('mouseenter', () => onNodeHover(matchedNode, el));
      el.addEventListener('mouseleave', onNodeLeave);
    }
  }

  function addNodeBadge(el) {
    if (el.dataset.subflowBadge === 'true') return;
    el.dataset.subflowBadge = 'true';

    const position = window.getComputedStyle(el).position;
    if (position === 'static') el.style.position = 'relative';

    const badge = document.createElement('span');
    badge.className = 'n8n-subflow-badge';
    badge.textContent = '↗';
    badge.title = 'Calls sub-workflow';
    el.appendChild(badge);
  }

  function onNodeHover(nodeData, el) {
    activeNodeElement = el;
    hoverState.hoveringExecuteNode = true;
    clearTimeout(hideTimer);
    clearTimeout(hoverTimer);
    resetOverlaySafetyTimer();
    const requestSeq = ++hoverState.activeRequestSeq;

    hoverTimer = setTimeout(async () => {
      const subWorkflowId = extractSubWorkflowId(nodeData);
      if (!subWorkflowId) {
        showInlineError(el, 'Dynamic sub-workflow reference.');
        return;
      }

      hoverState.activeSubflowId = subWorkflowId;
      showInlineLoading(el);
      const res = await fetchSubWorkflowData(subWorkflowId);
      if (activeNodeElement !== el || requestSeq !== hoverState.activeRequestSeq) return;

      if (res && !res.error) {
        await showInlineWorkflow(el, res.data, subWorkflowId);
      } else {
        if (res && res.diagnostics) {
          console.warn(`${LOG_PREFIX} sub-workflow diagnostics:`, res.diagnostics);
        }
        const message = getErrorMessage(res);
        showInlineError(el, message, subWorkflowId);
      }
    }, settings.hoverDelay);
  }

  function onNodeLeave() {
    hoverState.hoveringExecuteNode = false;
    clearTimeout(hoverTimer);
    scheduleHideOverlay();
  }

  function scheduleHideOverlay() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (hoverState.hoveringExecuteNode) return;
      hideInlineOverlay();
    }, HIDE_DELAY_MS);
  }

  function hideInlineOverlay() {
    if (!inlineOverlayEl || !hoverState.overlayVisible) return;
    hoverState.overlayVisible = false;
    hoverState.activeSubflowId = null;
    hoverState.cachedWorkflowData = null;
    clearTimeout(overlaySafetyTimer);
    inlineOverlayEl.classList.add('fading');
    inlineOverlayEl.classList.remove('visible');
    window.setTimeout(() => {
      if (!inlineOverlayEl || hoverState.overlayVisible) return;
      inlineOverlayEl.classList.remove('fading');
      inlineOverlayEl.innerHTML = '';
    }, FADE_OUT_MS);
  }

  function resetOverlaySafetyTimer() {
    clearTimeout(overlaySafetyTimer);
    overlaySafetyTimer = window.setTimeout(() => {
      if (!hoverState.overlayVisible) return;
      if (hoverState.hoveringExecuteNode) return;
      hideInlineOverlay();
    }, OVERLAY_SAFETY_HIDE_MS);
  }

  function onGlobalKeydown(event) {
    if (event.key === 'Escape') {
      hoverState.hoveringExecuteNode = false;
      hideInlineOverlay();
    }
  }

  function onGlobalMouseMove(event) {
    if (!hoverState.overlayVisible || hoverState.hoveringExecuteNode) return;
    if (!activeNodeElement || !activeNodeElement.isConnected) {
      hideInlineOverlay();
      return;
    }

    // Check if mouse is over the source node or the overlay itself
    const nodeRect = activeNodeElement.getBoundingClientRect();
    const overNode = event.clientX >= nodeRect.left
      && event.clientX <= nodeRect.right
      && event.clientY >= nodeRect.top
      && event.clientY <= nodeRect.bottom;

    let overOverlay = false;
    if (inlineOverlayEl && inlineOverlayEl.classList.contains('visible')) {
      const oRect = inlineOverlayEl.getBoundingClientRect();
      overOverlay = event.clientX >= oRect.left
        && event.clientX <= oRect.right
        && event.clientY >= oRect.top
        && event.clientY <= oRect.bottom;
    }

    if (!overNode && !overOverlay) scheduleHideOverlay();
  }

  async function fetchSubWorkflowData(subWorkflowId) {
    const cached = await WorkflowCache.get(subWorkflowId);
    if (cached) return { data: cached };

    let res = await fetchSubWorkflowViaPage(subWorkflowId);
    if (res && !res.error) {
      await WorkflowCache.set(subWorkflowId, res.data);
      return res;
    }

    if (res && (res.error === 'auth_failed' || res.error === 'not_found')) {
      return res;
    }

    res = await N8nApi.fetchWorkflow(subWorkflowId);
    if (res && !res.error) await WorkflowCache.set(subWorkflowId, res.data);
    return res;
  }

  function getErrorMessage(res) {
    if (!res || !res.error) return 'Failed to load preview.';
    if (res.error === 'missing_config') return 'Add n8n URL and API key in extension settings.';
    if (res.error === 'not_found') return 'Sub-workflow not found. It may have been deleted.';
    if (res.error === 'auth_failed') {
      const status = res.diagnostics && res.diagnostics.status ? ` (${res.diagnostics.status})` : '';
      return `Could not access sub-workflow via n8n auth context${status}.`;
    }
    if (res.error === 'network_error' || res.error === 'timeout') return 'Connection error while loading preview.';
    return res.message || 'Failed to load preview.';
  }

  function registerWorkflowMeta(workflowId, name) {
    if (!workflowId) return;
    if (name) workflowNamesById.set(workflowId, name);
  }

  function loadBreadcrumbTrail() {
    try {
      const raw = sessionStorage.getItem('n8n_subflow_breadcrumb_trail');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch (_err) {
      return [];
    }
  }

  function saveBreadcrumbTrail() {
    try {
      sessionStorage.setItem('n8n_subflow_breadcrumb_trail', JSON.stringify(breadcrumbTrail.slice(-8)));
    } catch (_err) {
      // ignore storage edge cases
    }
  }

  function syncBreadcrumbTrail(workflowId) {
    if (!workflowId) return;

    const existingIndex = breadcrumbTrail.indexOf(workflowId);
    if (existingIndex >= 0) {
      breadcrumbTrail = breadcrumbTrail.slice(0, existingIndex + 1);
    } else {
      breadcrumbTrail.push(workflowId);
      if (breadcrumbTrail.length > 8) breadcrumbTrail = breadcrumbTrail.slice(-8);
    }
    saveBreadcrumbTrail();
    renderBreadcrumbBar();
  }

  function ensureBreadcrumbBar() {
    if (breadcrumbEl) return;
    breadcrumbEl = document.createElement('div');
    breadcrumbEl.className = 'n8n-sf-breadcrumb';
    document.body.appendChild(breadcrumbEl);
  }

  function renderBreadcrumbBar() {
    if (!breadcrumbEl) return;
    if (breadcrumbTrail.length <= 1) {
      breadcrumbEl.classList.remove('visible');
      breadcrumbEl.innerHTML = '';
      return;
    }

    const segments = breadcrumbTrail.map((id, index) => {
      const name = workflowNamesById.get(id) || `Workflow ${id.slice(0, 6)}`;
      const safeName = escapeHtml(name);
      const isLast = index === breadcrumbTrail.length - 1;
      if (isLast) {
        return `<span class="current">${safeName}</span>`;
      }
      return `<a href="#" data-workflow-id="${escapeHtml(id)}">${safeName}</a>`;
    });

    breadcrumbEl.innerHTML = `<span class="home">🏠</span> ${segments.join('<span class="sep">›</span>')}`;
    breadcrumbEl.classList.add('visible');

    breadcrumbEl.querySelectorAll('a[data-workflow-id]').forEach((linkEl) => {
      linkEl.addEventListener('click', (event) => {
        event.preventDefault();
        const targetId = linkEl.getAttribute('data-workflow-id');
        if (!targetId) return;
        window.location.href = `${window.location.origin}/workflow/${encodeURIComponent(targetId)}`;
      });
    });
  }

  function ensureInlineOverlay() {
    if (inlineOverlayEl) return;

    inlineOverlayEl = document.createElement('div');
    inlineOverlayEl.className = 'n8n-subflow-inline-overlay';
    document.body.appendChild(inlineOverlayEl);

    // Hovering the overlay itself keeps it open; leaving triggers hide
    inlineOverlayEl.addEventListener('mouseenter', () => {
      hoverState.hoveringExecuteNode = true;
      clearTimeout(hideTimer);
    });
    inlineOverlayEl.addEventListener('mouseleave', () => {
      hoverState.hoveringExecuteNode = false;
      scheduleHideOverlay();
    });
  }

  function buildOverlayHeader(workflowName, options = {}) {
    const safeName = workflowName ? escapeHtml(workflowName) : '';
    const nameHtml = safeName
      ? ` <span class="n8n-sf-overlay-wf-name">${safeName}</span>`
      : '';
    const expandBtn = options.showExpand
      ? `<span class="n8n-sf-overlay-header-spacer"></span><button type="button" class="n8n-sf-overlay-expand" title="Expand side panel" aria-label="Expand side panel">⤢</button>`
      : '';
    return `<div class="n8n-sf-overlay-header">Sub-workflow preview${nameHtml}${expandBtn}</div>`;
  }

  function showInlineLoading(anchorEl) {
    ensureInlineOverlay();
    applyInlineTheme();
    inlineOverlayEl.classList.remove('fading');
    inlineOverlayEl.style.width = '556px';
    inlineOverlayEl.style.height = '';
    inlineOverlayEl.innerHTML = `
      ${buildOverlayHeader()}
      <div class="n8n-sf-inline-loading">
        <span class="n8n-sf-spinner"></span>
        <span>Loading subflow...</span>
      </div>
    `;
    positionInlineOverlay();
    inlineOverlayEl.classList.add('visible');
    hoverState.overlayVisible = true;
    resetOverlaySafetyTimer();
  }

  function showInlineError(anchorEl, message, subWorkflowId = null) {
    ensureInlineOverlay();
    applyInlineTheme();
    inlineOverlayEl.classList.remove('fading');
    inlineOverlayEl.style.width = '556px';
    inlineOverlayEl.style.height = '';
    const openUrl = subWorkflowId
      ? `${window.location.origin}/workflow/${encodeURIComponent(subWorkflowId)}`
      : '';
    inlineOverlayEl.innerHTML = `
      ${buildOverlayHeader()}
      <div class="n8n-sf-inline-hint">
        <span>${escapeHtml(message)}</span>
        ${openUrl ? `<a href="${openUrl}" target="_blank" rel="noopener noreferrer">Open once</a>` : ''}
      </div>
    `;
    positionInlineOverlay();
    inlineOverlayEl.classList.add('visible');
    hoverState.overlayVisible = true;
    hoverState.activeSubflowId = subWorkflowId || null;
    resetOverlaySafetyTimer();
  }

  async function showInlineWorkflow(anchorEl, workflowData, subWorkflowId) {
    ensureInlineOverlay();
    applyInlineTheme();
    inlineOverlayEl.classList.remove('fading');
    registerWorkflowMeta(subWorkflowId, workflowData.name);

    // Resolve Font Awesome icons via CDN before rendering
    if (Array.isArray(workflowData.nodes)) {
      await resolveFaIcons(workflowData.nodes);
    }

    hoverState.cachedWorkflowData = workflowData;
    inlineOverlayEl.innerHTML = `
      ${buildOverlayHeader(workflowData.name, { showExpand: true })}
      <div class="n8n-sf-inline-map"></div>
    `;

    const mapContainer = inlineOverlayEl.querySelector('.n8n-sf-inline-map');
    const expandBtn = inlineOverlayEl.querySelector('.n8n-sf-overlay-expand');
    if (expandBtn) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (hoverState.cachedWorkflowData && hoverState.activeSubflowId) {
          SidePanel.open(hoverState.cachedWorkflowData, hoverState.activeSubflowId, ThemeDetector.detect());
        }
      });
    }
    const nodeCount = Array.isArray(workflowData.nodes) ? workflowData.nodes.length : 0;
    const isLarge = nodeCount > 8;
    PreviewRenderer.render(workflowData, mapContainer, {
      theme: ThemeDetector.detect(),
      width: isLarge ? 720 : 556,
      height: isLarge ? 320 : 260,
      nodeWidth: 72,
      nodeHeight: 64,
      totalNodeHeight: 82,
      pad: 24
    });

    // Size overlay to fit map (no scrolling); cap at viewport
    const wrapper = mapContainer.firstElementChild;
    if (wrapper) {
      const mapW = wrapper.offsetWidth;
      const mapH = wrapper.offsetHeight;
      const maxW = Math.min(920, Math.floor(window.innerWidth * 0.92));
      const maxH = Math.min(420, Math.floor(window.innerHeight * 0.8));
      const headerH = 36;
      const overlayW = Math.min(Math.max(mapW, 556), maxW);
      const overlayH = Math.min(headerH + mapH, maxH);
      inlineOverlayEl.style.width = overlayW + 'px';
      inlineOverlayEl.style.height = overlayH + 'px';
    }

    positionInlineOverlay();
    inlineOverlayEl.classList.add('visible');
    hoverState.overlayVisible = true;
    hoverState.activeSubflowId = subWorkflowId;
    resetOverlaySafetyTimer();
  }

  function applyInlineTheme() {
    const theme = ThemeDetector.detect();
    inlineOverlayEl.classList.toggle('theme-dark', theme === 'dark');
    inlineOverlayEl.classList.toggle('theme-light', theme !== 'dark');
  }

  function positionInlineOverlay() {
    if (!inlineOverlayEl) return;
    // Bottom-center dock: always sits at the bottom of the viewport, out of the way
    const overlayWidth = inlineOverlayEl.offsetWidth || 580;
    const left = Math.max(12, (window.innerWidth - overlayWidth) / 2);
    const bottom = 16;

    inlineOverlayEl.style.left = `${left}px`;
    inlineOverlayEl.style.top = '';
    inlineOverlayEl.style.bottom = `${bottom}px`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function extractSubWorkflowId(nodeData) {
    const params = nodeData.parameters || {};

    if (typeof params.workflowId === 'string' && params.workflowId.startsWith('=')) return null;
    if (typeof params.workflowId === 'string' && params.workflowId) return params.workflowId;

    if (params.workflowId && typeof params.workflowId === 'object') {
      const val = params.workflowId.value;
      if (typeof val === 'string' && val.startsWith('=')) return null;
      if (val) return String(val);
    }
    return null;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
