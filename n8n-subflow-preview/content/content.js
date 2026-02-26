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
  const OVERLAY_SIZE_STORAGE_KEY = 'n8n_subflow_overlay_size';
  const OVERLAY_DEFAULT_MIN_WIDTH = 680;
  const OVERLAY_DEFAULT_MAP_HEIGHT = 320;
  const OVERLAY_AUTO_MAX_WIDTH = 750;
  const OVERLAY_RESIZE_MIN_WIDTH = 500;
  const OVERLAY_RESIZE_MIN_HEIGHT = 220;
  const OVERLAY_RESIZE_MAX_RATIO = 0.9;
  const OVERLAY_HEADER_HEIGHT = 36;
  const OVERLAY_MAP_MIN_HEIGHT = 220;
  const BREADCRUMB_STORAGE_KEY = 'n8n_subflow_breadcrumb_trail';

  let currentWorkflowId = null;
  let currentWorkflowData = null;
  let hoverTimer = null;
  let hideTimer = null;
  let overlaySafetyTimer = null;
  let activeNodeElement = null;
  let inlineOverlayEl = null;
  let breadcrumbEl = null;
  let breadcrumbTrail = [];
  let preferredOverlaySize = null;
  let overlayManualRect = null;
  let breadcrumbsEnabled = false;
  const workflowNamesById = new Map();

  // CDN-based Font Awesome SVG resolver (content script can fetch freely)
  const FA_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/svgs';
  const FA_STYLE_ORDER = ['solid', 'regular', 'brands'];
  const CATEGORY_ICON_COLORS = {
    trigger: '#34a853',
    action: '#1a73e8',
    logic: '#f29900',
    ai: '#7b61ff',
    data: '#0f9d58',
    http: '#e8710a'
  };
  // n8n still emits some FA5 names; map them to FA6 file names.
  const FA5_TO_FA6_ALIASES = {
    'sign-in-alt': 'right-to-bracket',
    'sign-out-alt': 'right-from-bracket',
    sync: 'arrows-rotate',
    'exchange-alt': 'right-left',
    random: 'shuffle',
    redo: 'rotate-right',
    cog: 'gear',
    cogs: 'gears',
    edit: 'pen-to-square',
    'trash-alt': 'trash-can',
    'file-alt': 'file-lines',
    envelope: 'envelope',
    'code-branch': 'code-branch',
    'clipboard-list': 'clipboard-list'
  };
  // Cache value is data URL (string) or null for negative lookups.
  const faIconCache = Object.create(null);
  const svgTintCache = Object.create(null);

  function getNodeColorClass(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('trigger') || t.includes('webhook') || t.endsWith('.start')) return 'trigger';
    if (t.includes('if') || t.includes('switch') || t.includes('filter') || t.includes('code') || t.includes('function')) return 'logic';
    if (t.includes('ai') || t.includes('langchain') || t.includes('agent') || t.includes('gemini') || t.includes('openai') || t.includes('chatmodel')) return 'ai';
    if (t.includes('google') || t.includes('sheet') || t.includes('database') || t.includes('postgres') || t.includes('mysql') || t.includes('mongo')) return 'data';
    if (t.includes('http') || t.includes('request')) return 'http';
    return 'action';
  }

  function getNodeIconColor(type) {
    return CATEGORY_ICON_COLORS[getNodeColorClass(type)] || CATEGORY_ICON_COLORS.action;
  }

  function decodeSvgDataUrl(url) {
    const match = String(url || '').match(/^data:image\/svg\+xml(?:;charset=[^;,]+)?(?:;(base64))?,(.*)$/i);
    if (!match) return null;
    const isBase64 = Boolean(match[1]);
    const payload = match[2] || '';
    try {
      return isBase64 ? atob(payload) : decodeURIComponent(payload);
    } catch (_err) {
      return null;
    }
  }

  function encodeSvgDataUrl(svgText) {
    return `data:image/svg+xml,${encodeURIComponent(svgText)}`;
  }

  function parseRgbChannel(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    if (value.endsWith('%')) {
      const pct = Number(value.slice(0, -1));
      if (!Number.isFinite(pct)) return null;
      return Math.max(0, Math.min(255, Math.round((pct / 100) * 255)));
    }
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.max(0, Math.min(255, Math.round(num)));
  }

  function isNeutralColorToken(rawToken) {
    const token = String(rawToken || '').trim();
    if (!token) return false;
    const clean = token.replace(/\s*!important\s*$/i, '');
    const lower = clean.toLowerCase();

    if (lower === 'none' || lower === 'transparent') return false;
    if (lower.indexOf('url(') !== -1) return false;
    if (lower === 'currentcolor') return true;
    if (lower === 'white' || lower === 'black' || lower === 'gray' || lower === 'grey' || lower === 'silver') return true;

    const hexMatch = lower.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (hexMatch) {
      const rawHex = hexMatch[1].toLowerCase();
      const hex = (rawHex.length === 3 || rawHex.length === 4)
        ? (rawHex[0] + rawHex[0] + rawHex[1] + rawHex[1] + rawHex[2] + rawHex[2])
        : rawHex.slice(0, 6);
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return Number.isFinite(r) && r === g && g === b;
    }

    const rgbMatch = lower.match(/^rgba?\(([^)]+)\)$/);
    if (rgbMatch) {
      const parts = rgbMatch[1].split(',');
      if (parts.length < 3) return false;
      const r2 = parseRgbChannel(parts[0]);
      const g2 = parseRgbChannel(parts[1]);
      const b2 = parseRgbChannel(parts[2]);
      if (r2 === null || g2 === null || b2 === null) return false;
      return r2 === g2 && g2 === b2;
    }

    return false;
  }

  function hasExplicitPaintInstructions(svgText) {
    return /(fill|stroke)\s*=/i.test(svgText) || /(?:^|;)\s*(fill|stroke)\s*:/i.test(svgText);
  }

  function withRootPaintFallback(svgText, color) {
    let changed = false;
    const output = String(svgText || '').replace(/<svg\b([^>]*)>/i, (match, attrs) => {
      if (/\sfill\s*=/.test(attrs) || /\sstroke\s*=/.test(attrs)) return match;
      changed = true;
      return `<svg${attrs} fill="${color}" stroke="${color}">`;
    });
    return { svg: output, changed };
  }

  function replaceNeutralPaintTokens(svgText, color) {
    let changed = false;
    let output = String(svgText || '').replace(
      /(fill|stroke)\s*=\s*(['"])([^'"]+)\2/gi,
      (match, prop, quote, value) => {
        if (!isNeutralColorToken(value)) return match;
        changed = true;
        return `${prop}=${quote}${color}${quote}`;
      }
    );

    output = output.replace(/style\s*=\s*(['"])([^'"]*)\1/gi, (match, quote, styleValue) => {
      let styleChanged = false;
      const nextStyle = String(styleValue || '').replace(
        /(^|;)\s*(fill|stroke)\s*:\s*([^;]+)/gi,
        (declaration, prefix, prop, value) => {
          if (!isNeutralColorToken(value)) return declaration;
          styleChanged = true;
          const lead = prefix || '';
          return `${lead}${lead ? ' ' : ''}${prop}: ${color}`;
        }
      );
      if (!styleChanged) return match;
      changed = true;
      return `style=${quote}${nextStyle}${quote}`;
    });

    return { svg: output, changed };
  }

  function hasBrandSpecificFill(svgText) {
    const source = String(svgText || '');
    if (!source) return false;
    if (/(fill|stroke)\s*=\s*['"]\s*url\(/i.test(source)) return true;
    if (/(^|;)\s*(fill|stroke)\s*:\s*url\(/i.test(source)) return true;

    const paintValues = [];
    source.replace(/(fill|stroke)\s*=\s*['"]([^'"]+)['"]/gi, (_m, _prop, value) => {
      paintValues.push(value);
      return _m;
    });
    source.replace(/style\s*=\s*['"]([^'"]*)['"]/gi, (_m, styleValue) => {
      String(styleValue || '').replace(/(^|;)\s*(fill|stroke)\s*:\s*([^;]+)/gi, (_d, _pfx, _prop, value) => {
        paintValues.push(value);
        return _d;
      });
      return _m;
    });

    for (const rawValue of paintValues) {
      const value = String(rawValue || '').trim().replace(/\s*!important\s*$/i, '');
      if (!value) continue;
      const lower = value.toLowerCase();
      if (lower === 'none' || lower === 'transparent' || lower === 'currentcolor') continue;
      if (!isNeutralColorToken(value)) return true;
    }
    return false;
  }

  function tintMonochromeSvg(svgText, color) {
    if (!svgText || !color) return null;
    if (hasBrandSpecificFill(svgText)) return null;

    let output = String(svgText);
    const replaced = replaceNeutralPaintTokens(output, color);
    output = replaced.svg;
    let changed = replaced.changed;

    if (!changed && !hasExplicitPaintInstructions(output)) {
      const fallback = withRootPaintFallback(output, color);
      output = fallback.svg;
      changed = fallback.changed;
    }

    return changed ? output : null;
  }

  async function resolveSingleFaIcon(name, color) {
    const cacheKey = `${name}|${color}`;
    if (Object.prototype.hasOwnProperty.call(faIconCache, cacheKey)) return;

    const alias = FA5_TO_FA6_ALIASES[name] || null;
    const candidateNames = alias && alias !== name ? [alias, name] : [name];

    for (const candidateName of candidateNames) {
      for (const style of FA_STYLE_ORDER) {
        try {
          const res = await fetch(`${FA_CDN_BASE}/${style}/${candidateName}.svg`);
          if (!res.ok) continue;
          let svg = await res.text();
          // Tint Font Awesome SVGs with the node category color.
          const replaced = replaceNeutralPaintTokens(svg, color);
          svg = replaced.svg;
          if (!replaced.changed) {
            const fallback = withRootPaintFallback(svg, color);
            svg = fallback.svg;
          }
          faIconCache[cacheKey] = encodeSvgDataUrl(svg);
          return;
        } catch (_e) {
          // Keep trying the next candidate path.
        }
      }
    }

    // Negative caching prevents repeated 404 spam for unknown icons.
    faIconCache[cacheKey] = null;
  }

  async function resolveFaIcons(nodes) {
    if (!Array.isArray(nodes)) return;
    console.log(`${LOG_PREFIX} [icon-debug] resolveFaIcons start:`, nodes.length, 'nodes');

    // Collect unique FA icon names that need fetching.
    const needed = {};
    for (const node of nodes) {
      const iconColor = getNodeIconColor(node.type);
      const cacheKey = `${node._iconFa}|${iconColor}`;
      if (
        node._iconFa &&
        !node._iconUrl &&
        !Object.prototype.hasOwnProperty.call(faIconCache, cacheKey)
      ) {
        needed[cacheKey] = {
          name: node._iconFa,
          color: iconColor
        };
      }
    }

    // Fetch all missing FA icons in parallel.
    const entries = Object.values(needed);
    if (entries.length > 0) {
      console.log(`${LOG_PREFIX} [icon-debug] FA CDN candidates:`, entries.map((item) => item.name).join(', '));
      await Promise.all(entries.map((item) => resolveSingleFaIcon(item.name, item.color)));
    }

    // Apply cached data URLs to nodes.
    for (const node of nodes) {
      if (node._iconFa && !node._iconUrl) {
        const iconColor = getNodeIconColor(node.type);
        const dataUrl = faIconCache[`${node._iconFa}|${iconColor}`];
        if (dataUrl) node._iconUrl = dataUrl;
      }
    }

    let resolvedFromRegistryOrUrl = 0;
    let resolvedFromFaCdn = 0;
    let emojiFallback = 0;
    for (const node of nodes) {
      if (node._iconUrl) {
        if (node._iconFa) resolvedFromFaCdn++;
        else resolvedFromRegistryOrUrl++;
      } else {
        emojiFallback++;
      }
    }
    console.log(
      `${LOG_PREFIX} [icon-debug] final tally | registry/url: ${resolvedFromRegistryOrUrl} | FA CDN: ${resolvedFromFaCdn} | emoji fallback: ${emojiFallback}`
    );
  }

  async function tintMonochromeSvgIcons(nodes) {
    if (!Array.isArray(nodes)) return;

    for (const node of nodes) {
      const iconUrl = String(node && node._iconUrl ? node._iconUrl : '');
      if (!iconUrl || node._iconFa) continue;
      const iconColor = getNodeIconColor(node.type);
      const cacheKey = `${iconUrl}|${iconColor}`;
      if (Object.prototype.hasOwnProperty.call(svgTintCache, cacheKey)) {
        if (svgTintCache[cacheKey]) node._iconUrl = svgTintCache[cacheKey];
        continue;
      }

      let svgText = null;
      if (/^data:image\/svg\+xml/i.test(iconUrl)) {
        svgText = decodeSvgDataUrl(iconUrl);
      } else if (/\.svg(?:$|\?)/i.test(iconUrl)) {
        try {
          const res = await fetch(iconUrl, { credentials: 'include' });
          if (!res.ok) {
            svgTintCache[cacheKey] = null;
            continue;
          }
          const contentType = String(res.headers.get('content-type') || '').toLowerCase();
          if (contentType && !contentType.includes('svg')) {
            svgTintCache[cacheKey] = null;
            continue;
          }
          svgText = await res.text();
        } catch (_err) {
          svgTintCache[cacheKey] = null;
          continue;
        }
      }

      if (!svgText) {
        svgTintCache[cacheKey] = null;
        continue;
      }

      const tinted = tintMonochromeSvg(svgText, iconColor);
      if (tinted) {
        const tintedDataUrl = encodeSvgDataUrl(tinted);
        node._iconUrl = tintedDataUrl;
        svgTintCache[cacheKey] = tintedDataUrl;
      } else {
        svgTintCache[cacheKey] = null;
      }
    }
  }

  const pendingSubflowFetches = new Map();
  const hoverState = {
    hoveringExecuteNode: false,
    overlayVisible: false,
    overlayInteracting: false,
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
    if (!looksLikeN8nPage()) {
      return;
    }

    currentWorkflowId = getWorkflowIdFromUrl();
    if (!currentWorkflowId) return;
    initializeBreadcrumbContext();

    console.log(`${LOG_PREFIX} active — workflow ${currentWorkflowId}`);

    loadSettings().then(() => {
      ensureInlineOverlay();
      if (breadcrumbsEnabled) {
        ensureBreadcrumbBar();
        syncBreadcrumbTrail(currentWorkflowId);
      }
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
    const data = await chrome.storage.local.get([
      'hoverDelay',
      'enableHover',
      'enableBadges',
      OVERLAY_SIZE_STORAGE_KEY
    ]);
    if (data.hoverDelay) settings.hoverDelay = data.hoverDelay;
    if (data.enableHover !== undefined) settings.enableHover = data.enableHover;
    if (data.enableBadges !== undefined) settings.enableBadges = data.enableBadges;
    const savedOverlaySize = sanitizeOverlaySize(data[OVERLAY_SIZE_STORAGE_KEY]);
    if (savedOverlaySize) preferredOverlaySize = savedOverlaySize;
  }

  function getWorkflowIdFromUrl() {
    const match = window.location.pathname.match(/\/workflow\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  }

  function looksLikeN8nPage() {
    const pathLooksRight = window.location.pathname.includes('/workflow/');
    if (!pathLooksRight) return false;

    const appEl = document.getElementById('app');
    const hasVueApp = Boolean(appEl && appEl.__vue_app__);
    const hasCanvasNode = Boolean(document.querySelector('[data-test-id="canvas-node"]'));
    const titleHasN8n = (document.title || '').toLowerCase().includes('n8n');
    const sidebarEl = document.querySelector('#sidebar');
    const sidebarText = (sidebarEl && sidebarEl.textContent ? sidebarEl.textContent : '').toLowerCase();
    const hasN8nSidebar = Boolean(
      sidebarEl
      && (sidebarText.includes('n8n') || sidebarText.includes('workflow') || sidebarText.includes('executions'))
    );

    return hasVueApp || hasCanvasNode || titleHasN8n || hasN8nSidebar;
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
        if (breadcrumbsEnabled) syncBreadcrumbTrail(currentWorkflowId);
        requestProbeRefresh();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function requestProbeRefresh() {
    window.postMessage({ type: 'n8n-subflow-probe-request' }, '*');
  }

  function initializeBreadcrumbContext() {
    breadcrumbsEnabled = false;
    breadcrumbTrail = [];
  }

  function isValidWorkflowId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9]+$/.test(id);
  }

  function parseBreadcrumbTrailParam(rawTrail) {
    if (!rawTrail || typeof rawTrail !== 'string') return [];
    return rawTrail
      .split(',')
      .map((item) => item.trim())
      .filter(isValidWorkflowId)
      .slice(-8);
  }

  function getOutboundBreadcrumbTrail() {
    const base = breadcrumbsEnabled ? breadcrumbTrail.slice() : [];
    if (isValidWorkflowId(currentWorkflowId)) {
      const last = base[base.length - 1];
      if (last !== currentWorkflowId) base.push(currentWorkflowId);
    }
    return base.filter(isValidWorkflowId).slice(-8);
  }

  function buildSubflowOpenUrl(subWorkflowId) {
    if (!isValidWorkflowId(subWorkflowId)) return '';
    const url = new URL(`${window.location.origin}/workflow/${encodeURIComponent(subWorkflowId)}`);
    if (breadcrumbsEnabled) {
      url.searchParams.set('sfbc', '1');
      const trail = getOutboundBreadcrumbTrail();
      if (trail.length > 0) {
        url.searchParams.set('sftrail', trail.join(','));
      }
    }
    return url.toString();
  }

  function listenForProbeResults() {
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data) return;
      if (event.origin !== window.location.origin) return;

      if (event.data.type === 'n8n-subflow-probe-result') {
        if (event.data.payload) {
          currentWorkflowData = event.data.payload;
          registerWorkflowMeta(currentWorkflowId, event.data.payload.name);
          if (breadcrumbsEnabled) syncBreadcrumbTrail(currentWorkflowId);
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
    if (breadcrumbsEnabled) syncBreadcrumbTrail(currentWorkflowId);
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
    let executeDomOrderIndex = 0;
    domNodes.forEach((el) => {
      try {
        const typeAttr = el.getAttribute('data-node-type') || '';
        const executeOrderIndex = typeAttr === 'n8n-nodes-base.executeWorkflow'
          ? executeDomOrderIndex++
          : -1;
        attachHoverDetection(el, executeNodes, executeOrderIndex);
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to bind node`, err);
      }
    });
  }

  function attachHoverDetection(el, executeNodes, executeOrderIndex = -1) {
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
      // Best-effort fallback when DOM titles are missing: map execute nodes by DOM order.
      if (
        !matchedNode
        && typeAttr === 'n8n-nodes-base.executeWorkflow'
        && executeNodes.length > 1
        && executeOrderIndex >= 0
        && executeOrderIndex < executeNodes.length
      ) {
        matchedNode = executeNodes[executeOrderIndex];
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
    if (hoverState.overlayInteracting) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (hoverState.hoveringExecuteNode) return;
      if (hoverState.overlayInteracting) return;
      hideInlineOverlay();
    }, HIDE_DELAY_MS);
  }

  function hideInlineOverlay() {
    if (!inlineOverlayEl || !hoverState.overlayVisible) return;
    hoverState.overlayVisible = false;
    hoverState.overlayInteracting = false;
    hoverState.activeSubflowId = null;
    hoverState.cachedWorkflowData = null;
    inlineOverlayEl.classList.remove('dragging', 'resizing');
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
      if (hoverState.overlayInteracting) return;
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
    if (hoverState.overlayInteracting) return;
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
      const raw = localStorage.getItem(BREADCRUMB_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(isValidWorkflowId)
        .slice(-8);
    } catch (_err) {
      return [];
    }
  }

  function saveBreadcrumbTrail() {
    try {
      const safeTrail = breadcrumbTrail
        .filter(isValidWorkflowId)
        .slice(-8);
      localStorage.setItem(BREADCRUMB_STORAGE_KEY, JSON.stringify(safeTrail));
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
    if (!breadcrumbsEnabled) {
      breadcrumbEl.classList.remove('visible');
      breadcrumbEl.innerHTML = '';
      return;
    }
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
      return `<a href="#" data-workflow-id="${escapeHtml(id)}" data-breadcrumb-index="${index}">${safeName}</a>`;
    });

    breadcrumbEl.innerHTML = `<span class="home">🏠</span> ${segments.join('<span class="sep">›</span>')}`;
    breadcrumbEl.classList.add('visible');

    breadcrumbEl.querySelectorAll('a[data-workflow-id]').forEach((linkEl) => {
      linkEl.addEventListener('click', (event) => {
        event.preventDefault();
        const targetId = linkEl.getAttribute('data-workflow-id');
        if (!targetId) return;
        const targetIndex = Number(linkEl.getAttribute('data-breadcrumb-index'));
        const baseTrail = Number.isInteger(targetIndex)
          ? breadcrumbTrail.slice(0, Math.max(0, targetIndex))
          : breadcrumbTrail.slice(0, -1);
        const url = new URL(`${window.location.origin}/workflow/${encodeURIComponent(targetId)}`);
        url.searchParams.set('sfbc', '1');
        const safeTrail = baseTrail.filter(isValidWorkflowId).slice(-8);
        if (safeTrail.length > 0) {
          url.searchParams.set('sftrail', safeTrail.join(','));
        }
        window.location.href = url.toString();
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
      if (hoverState.overlayInteracting) return;
      hoverState.hoveringExecuteNode = false;
      scheduleHideOverlay();
    });
  }

  function buildOverlayHeader(workflowName, options = {}) {
    const safeName = workflowName ? escapeHtml(workflowName) : '';
    const nameHtml = safeName
      ? ` <span class="n8n-sf-overlay-wf-name" title="${safeName}">${safeName}</span>`
      : '';
    const nodeCount = Number(options.nodeCount);
    const nodeCountBadge = Number.isFinite(nodeCount) && nodeCount >= 0
      ? ` <span class="n8n-sf-overlay-node-count">${nodeCount} ${nodeCount === 1 ? 'node' : 'nodes'}</span>`
      : '';
    const openUrl = options.openUrl || (options.subWorkflowId
      ? `${window.location.origin}/workflow/${encodeURIComponent(options.subWorkflowId)}`
      : '');
    const openBtn = options.showOpen && openUrl
      ? `<a class="n8n-sf-overlay-open" href="${openUrl}" target="_blank" rel="noopener noreferrer" title="Open sub-workflow in new tab" aria-label="Open sub-workflow in new tab">↗ <span>Open Subflow</span></a>`
      : '';
    const expandBtn = options.showExpand
      ? `<button type="button" class="n8n-sf-overlay-expand" title="Expand side panel" aria-label="Expand side panel">⤢</button>`
      : '';
    const actionsHtml = (openBtn || expandBtn)
      ? `<div class="n8n-sf-overlay-actions">${openBtn}${expandBtn}</div>`
      : '';
    return `<div class="n8n-sf-overlay-header"><div class="n8n-sf-overlay-title"><span class="n8n-sf-overlay-label">Sub-workflow preview</span>${nameHtml}${nodeCountBadge}</div>${actionsHtml}</div>`;
  }

  function showInlineLoading(anchorEl) {
    ensureInlineOverlay();
    applyInlineTheme();
    inlineOverlayEl.classList.remove('fading');
    inlineOverlayEl.style.width = getInitialOverlayWidth() + 'px';
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
    inlineOverlayEl.style.width = getInitialOverlayWidth() + 'px';
    inlineOverlayEl.style.height = '';
    const openUrl = subWorkflowId ? buildSubflowOpenUrl(subWorkflowId) : '';
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
      // Tint only monochrome SVG icons; keep native multicolor brand icons unchanged.
      await tintMonochromeSvgIcons(workflowData.nodes);
    }

    hoverState.cachedWorkflowData = workflowData;
    inlineOverlayEl.innerHTML = `
      ${buildOverlayHeader(workflowData.name, {
        showOpen: true,
        showExpand: true,
        subWorkflowId,
        openUrl: buildSubflowOpenUrl(subWorkflowId),
        nodeCount: Array.isArray(workflowData.nodes) ? workflowData.nodes.length : 0
      })}
      <div class="n8n-sf-inline-map"></div>
      <button type="button" class="n8n-sf-overlay-resize-handle dir-nw" data-dir="nw" title="Resize preview" aria-label="Resize preview">⟋</button>
      <button type="button" class="n8n-sf-overlay-resize-handle dir-ne" data-dir="ne" title="Resize preview" aria-label="Resize preview">⟋</button>
      <button type="button" class="n8n-sf-overlay-resize-handle dir-sw" data-dir="sw" title="Resize preview" aria-label="Resize preview">⟋</button>
      <button type="button" class="n8n-sf-overlay-resize-handle dir-se" data-dir="se" title="Resize preview" aria-label="Resize preview">⟋</button>
    `;

    const mapContainer = inlineOverlayEl.querySelector('.n8n-sf-inline-map');
    const openBtn = inlineOverlayEl.querySelector('.n8n-sf-overlay-open');
    if (openBtn) {
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }
    const expandBtn = inlineOverlayEl.querySelector('.n8n-sf-overlay-expand');
    if (expandBtn) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (hoverState.cachedWorkflowData && hoverState.activeSubflowId) {
          SidePanel.open(
            hoverState.cachedWorkflowData,
            hoverState.activeSubflowId,
            ThemeDetector.detect(),
            buildSubflowOpenUrl(hoverState.activeSubflowId)
          );
        }
      });
    }
    const nodeCount = Array.isArray(workflowData.nodes) ? workflowData.nodes.length : 0;
    const isLarge = nodeCount > 8;
    const preferredSize = getClampedPreferredOverlaySize();
    const initialOverlayWidth = preferredSize
      ? preferredSize.width
      : (isLarge ? 720 : OVERLAY_DEFAULT_MIN_WIDTH);
    const initialOverlayHeight = preferredSize ? preferredSize.height : (OVERLAY_HEADER_HEIGHT + OVERLAY_DEFAULT_MAP_HEIGHT);

    renderOverlayMapToSize(mapContainer, workflowData, initialOverlayWidth, initialOverlayHeight);

    // Size overlay to fit map and header; default max stays compact unless user resizes.
    const wrapper = mapContainer.firstElementChild;
    if (wrapper) {
      const mapW = wrapper.offsetWidth;
      const mapH = wrapper.offsetHeight;
      const headerEl = inlineOverlayEl.querySelector('.n8n-sf-overlay-header');
      const headerW = headerEl ? Math.ceil(headerEl.scrollWidth + 14) : 0;

      let overlayW = initialOverlayWidth;
      let overlayH = initialOverlayHeight;
      if (!preferredSize) {
        const maxW = getOverlayAutoMaxWidth();
        const maxH = Math.min(420, Math.floor(window.innerHeight * 0.8));
        overlayW = Math.min(Math.max(mapW, headerW, OVERLAY_DEFAULT_MIN_WIDTH), maxW);
        overlayH = Math.min(OVERLAY_HEADER_HEIGHT + mapH, maxH);
      }

      const clamped = clampOverlaySize(overlayW, overlayH, true);
      inlineOverlayEl.style.width = clamped.width + 'px';
      inlineOverlayEl.style.height = clamped.height + 'px';
      renderOverlayMapToSize(mapContainer, workflowData, clamped.width, clamped.height);
    }

    bindOverlayResizeHandles(mapContainer, workflowData);
    bindOverlayDragBehavior();

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
    if (overlayManualRect) {
      const clamped = clampOverlayRect(overlayManualRect, true);
      applyOverlayRect(clamped);
      overlayManualRect = clamped;
      return;
    }
    // Bottom-center dock: always sits at the bottom of the viewport, out of the way
    const overlayWidth = inlineOverlayEl.offsetWidth || 580;
    let left = Math.max(12, (window.innerWidth - overlayWidth) / 2);
    const sidePanelWidth = getVisibleSidePanelWidth();
    if (sidePanelWidth > 0) {
      const maxRight = window.innerWidth - sidePanelWidth - 20;
      const availableWidth = Math.max(320, maxRight - 12);
      if (overlayWidth > availableWidth) {
        inlineOverlayEl.style.width = availableWidth + 'px';
      }
      const adjustedWidth = inlineOverlayEl.offsetWidth || overlayWidth;
      const maxLeft = maxRight - adjustedWidth;
      left = Math.max(12, Math.min(left, maxLeft));
    }
    const bottom = 16;

    inlineOverlayEl.style.left = `${left}px`;
    inlineOverlayEl.style.top = '';
    inlineOverlayEl.style.bottom = `${bottom}px`;
  }

  function beginOverlayInteraction() {
    hoverState.overlayInteracting = true;
    hoverState.hoveringExecuteNode = true;
    clearTimeout(hideTimer);
    clearTimeout(overlaySafetyTimer);
  }

  function endOverlayInteraction(event) {
    hoverState.overlayInteracting = false;
    const keepOpen = isPointerOverOverlay(event) || isPointerOverNode(event);
    hoverState.hoveringExecuteNode = keepOpen;
    if (!keepOpen) scheduleHideOverlay();
    resetOverlaySafetyTimer();
  }

  function isPointerOverOverlay(event) {
    if (!event || !inlineOverlayEl || !inlineOverlayEl.classList.contains('visible')) return false;
    const rect = inlineOverlayEl.getBoundingClientRect();
    return event.clientX >= rect.left
      && event.clientX <= rect.right
      && event.clientY >= rect.top
      && event.clientY <= rect.bottom;
  }

  function isPointerOverNode(event) {
    if (!event || !activeNodeElement || !activeNodeElement.isConnected) return false;
    const rect = activeNodeElement.getBoundingClientRect();
    return event.clientX >= rect.left
      && event.clientX <= rect.right
      && event.clientY >= rect.top
      && event.clientY <= rect.bottom;
  }

  function getVisibleSidePanelWidth() {
    const sidePanel = document.querySelector('.n8n-sf-side-panel.visible');
    if (!sidePanel) return 0;
    const rect = sidePanel.getBoundingClientRect();
    return rect.width || 0;
  }

  function getOverlayViewportBounds() {
    const sidePanelWidth = getVisibleSidePanelWidth();
    const leftMin = 12;
    const rightMax = Math.max(leftMin + OVERLAY_RESIZE_MIN_WIDTH, Math.floor(window.innerWidth - (sidePanelWidth > 0 ? sidePanelWidth + 20 : 12)));
    const topMin = 12;
    const bottomMax = Math.max(topMin + OVERLAY_RESIZE_MIN_HEIGHT, Math.floor(window.innerHeight - 12));
    return { leftMin, rightMax, topMin, bottomMax };
  }

  function getOverlayNoOverlapMaxWidth() {
    const bounds = getOverlayViewportBounds();
    return Math.max(320, bounds.rightMax - bounds.leftMin);
  }

  function getOverlayAutoMaxWidth() {
    const baseMax = Math.min(OVERLAY_AUTO_MAX_WIDTH, Math.floor(window.innerWidth * 0.92));
    return Math.max(320, Math.min(baseMax, getOverlayNoOverlapMaxWidth()));
  }

  function getOverlayResizeMaxWidth() {
    const viewportMax = Math.floor(window.innerWidth * OVERLAY_RESIZE_MAX_RATIO);
    return Math.max(OVERLAY_RESIZE_MIN_WIDTH, Math.min(viewportMax, getOverlayNoOverlapMaxWidth()));
  }

  function getOverlayResizeMaxHeight() {
    return Math.max(OVERLAY_RESIZE_MIN_HEIGHT, Math.floor(window.innerHeight * OVERLAY_RESIZE_MAX_RATIO));
  }

  function sanitizeOverlaySize(value) {
    if (!value || typeof value !== 'object') return null;
    const width = Number(value.width);
    const height = Number(value.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width, height };
  }

  function clampOverlaySize(width, height, useResizeBounds) {
    const minW = useResizeBounds ? OVERLAY_RESIZE_MIN_WIDTH : OVERLAY_DEFAULT_MIN_WIDTH;
    const minH = useResizeBounds ? OVERLAY_RESIZE_MIN_HEIGHT : (OVERLAY_HEADER_HEIGHT + OVERLAY_MAP_MIN_HEIGHT);
    const maxW = useResizeBounds ? getOverlayResizeMaxWidth() : getOverlayAutoMaxWidth();
    const maxH = useResizeBounds
      ? getOverlayResizeMaxHeight()
      : Math.min(420, Math.floor(window.innerHeight * 0.8));
    const safeW = Math.min(maxW, Math.max(minW, Math.round(width || minW)));
    const safeH = Math.min(maxH, Math.max(minH, Math.round(height || minH)));
    return { width: safeW, height: safeH };
  }

  function clampOverlayRect(rect, useResizeBounds) {
    const bounds = getOverlayViewportBounds();
    const size = clampOverlaySize(rect.width, rect.height, useResizeBounds);
    const maxLeft = bounds.rightMax - size.width;
    const maxTop = bounds.bottomMax - size.height;
    return {
      left: Math.min(maxLeft, Math.max(bounds.leftMin, Math.round(rect.left))),
      top: Math.min(maxTop, Math.max(bounds.topMin, Math.round(rect.top))),
      width: size.width,
      height: size.height
    };
  }

  function applyOverlayRect(rect) {
    if (!inlineOverlayEl) return;
    inlineOverlayEl.style.left = rect.left + 'px';
    inlineOverlayEl.style.top = rect.top + 'px';
    inlineOverlayEl.style.bottom = '';
    inlineOverlayEl.style.width = rect.width + 'px';
    inlineOverlayEl.style.height = rect.height + 'px';
  }

  function getCurrentOverlayRect() {
    if (!inlineOverlayEl) return null;
    const rect = inlineOverlayEl.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
  }

  function getInitialOverlayWidth() {
    const preferred = getClampedPreferredOverlaySize();
    if (preferred) return preferred.width;
    return Math.min(OVERLAY_DEFAULT_MIN_WIDTH, getOverlayAutoMaxWidth());
  }

  function getClampedPreferredOverlaySize() {
    if (!preferredOverlaySize) return null;
    return clampOverlaySize(preferredOverlaySize.width, preferredOverlaySize.height, true);
  }

  function persistOverlaySize(width, height) {
    const size = clampOverlaySize(width, height, true);
    preferredOverlaySize = size;
    try {
      chrome.storage.local.set({ [OVERLAY_SIZE_STORAGE_KEY]: size });
    } catch (_err) {
      // Ignore storage edge cases.
    }
  }

  function renderOverlayMapToSize(mapContainer, workflowData, overlayWidth, overlayHeight) {
    if (!mapContainer || !workflowData) return;
    const mapHeight = Math.max(OVERLAY_MAP_MIN_HEIGHT, Math.round(overlayHeight - OVERLAY_HEADER_HEIGHT));
    const mapWidth = Math.max(320, Math.round(overlayWidth));
    PreviewRenderer.render(workflowData, mapContainer, {
      theme: ThemeDetector.detect(),
      width: mapWidth,
      height: mapHeight,
      nodeWidth: 72,
      nodeHeight: 64,
      totalNodeHeight: 96,
      pad: 24
    });
    setupMapPan(mapContainer);
  }

  function bindOverlayResizeHandles(mapContainer, workflowData) {
    if (!inlineOverlayEl || !mapContainer || !workflowData) return;
    const handles = inlineOverlayEl.querySelectorAll('.n8n-sf-overlay-resize-handle[data-dir]');
    if (!handles.length) return;

    handles.forEach((handle) => {
      handle.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        const dir = handle.getAttribute('data-dir') || 'se';
        const startRect = getCurrentOverlayRect();
        if (!startRect) return;

        let dragging = true;
        let rafId = 0;
        let pendingRect = null;
        beginOverlayInteraction();
        inlineOverlayEl.classList.add('resizing');
        overlayManualRect = clampOverlayRect(startRect, true);
        applyOverlayRect(overlayManualRect);

        const flushResize = () => {
          rafId = 0;
          if (!pendingRect) return;
          const rect = pendingRect;
          pendingRect = null;
          overlayManualRect = rect;
          applyOverlayRect(rect);
          renderOverlayMapToSize(mapContainer, workflowData, rect.width, rect.height);
        };

        const onMove = (moveEvent) => {
          if (!dragging) return;
          const dx = moveEvent.clientX - event.clientX;
          const dy = moveEvent.clientY - event.clientY;
          const next = {
            left: startRect.left,
            top: startRect.top,
            width: startRect.width,
            height: startRect.height
          };

          if (dir.indexOf('e') !== -1) next.width = startRect.width + dx;
          if (dir.indexOf('w') !== -1) {
            next.width = startRect.width - dx;
            next.left = startRect.left + dx;
          }
          if (dir.indexOf('s') !== -1) next.height = startRect.height + dy;
          if (dir.indexOf('n') !== -1) {
            next.height = startRect.height - dy;
            next.top = startRect.top + dy;
          }

          pendingRect = clampOverlayRect(next, true);
          if (!rafId) rafId = window.requestAnimationFrame(flushResize);
          moveEvent.preventDefault();
        };

        const onUp = (upEvent) => {
          if (!dragging) return;
          dragging = false;
          inlineOverlayEl.classList.remove('resizing');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if (rafId) {
            window.cancelAnimationFrame(rafId);
            rafId = 0;
          }
          if (pendingRect) {
            overlayManualRect = pendingRect;
            applyOverlayRect(pendingRect);
            renderOverlayMapToSize(mapContainer, workflowData, pendingRect.width, pendingRect.height);
            persistOverlaySize(pendingRect.width, pendingRect.height);
            pendingRect = null;
          } else if (overlayManualRect) {
            persistOverlaySize(overlayManualRect.width, overlayManualRect.height);
          }
          endOverlayInteraction(upEvent);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        event.preventDefault();
        event.stopPropagation();
      });
    });
  }

  function bindOverlayDragBehavior() {
    if (!inlineOverlayEl) return;
    const header = inlineOverlayEl.querySelector('.n8n-sf-overlay-header');
    if (!header) return;

    header.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const targetEl = event.target instanceof Element ? event.target : null;
      if (targetEl && targetEl.closest('.n8n-sf-overlay-actions, .n8n-sf-overlay-resize-handle')) return;

      const startRect = getCurrentOverlayRect();
      if (!startRect) return;
      let dragging = true;
      beginOverlayInteraction();
      inlineOverlayEl.classList.add('dragging');
      overlayManualRect = clampOverlayRect(startRect, true);
      applyOverlayRect(overlayManualRect);

      const onMove = (moveEvent) => {
        if (!dragging) return;
        const next = clampOverlayRect({
          left: startRect.left + (moveEvent.clientX - event.clientX),
          top: startRect.top + (moveEvent.clientY - event.clientY),
          width: startRect.width,
          height: startRect.height
        }, true);
        overlayManualRect = next;
        applyOverlayRect(next);
        moveEvent.preventDefault();
      };

      const onUp = (upEvent) => {
        if (!dragging) return;
        dragging = false;
        inlineOverlayEl.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        endOverlayInteraction(upEvent);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      event.preventDefault();
    });
  }

  // Drag-to-pan for overflowed mini-maps (X + Y) without scrollbars.
  function setupMapPan(container) {
    if (!container) return;
    if (container.dataset.panBound === 'true') return;
    container.dataset.panBound = 'true';
    container.classList.add('n8n-sf-pannable-map');
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;
    let dragging = false;

    const onMove = (event) => {
      if (!dragging) return;
      container.scrollLeft = startScrollLeft + startX - event.clientX;
      container.scrollTop = startScrollTop + startY - event.clientY;
    };
    const onUp = (upEvent) => {
      if (!dragging) return;
      dragging = false;
      container.classList.remove('n8n-sf-map-grabbing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      endOverlayInteraction(upEvent);
    };

    container.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      dragging = true;
      beginOverlayInteraction();
      startX = event.clientX;
      startY = event.clientY;
      startScrollLeft = container.scrollLeft;
      startScrollTop = container.scrollTop;
      container.classList.add('n8n-sf-map-grabbing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      event.preventDefault();
    });
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
