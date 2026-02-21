// Runs in the PAGE's own JS context (world: "MAIN") — NOT in the extension sandbox.
// This gives us access to n8n's Vue app, Pinia stores, and all page-level JS.
// Sends results back to the content script via window.postMessage().

(function () {
  var LOG = '[n8n SubFlow Probe]';
  var probeTimer = null;
  var isProbing = false;
  var didSucceed = false;
  var _originalFetch = window.fetch;
  var isActiveN8nPage = false;
  var networkHooksInstalled = false;

  // Keep captured headers private inside a closure.
  var authCapture = (function () {
    var capturedAuthHeaders = null;
    var capturedXhrHeaders = null;

    function cloneHeaders(input) {
      if (!input || typeof input !== 'object') return null;
      var out = {};
      var keys = Object.keys(input);
      for (var i = 0; i < keys.length; i++) out[keys[i]] = input[keys[i]];
      return out;
    }

    return {
      setFetchHeaders: function (headers) {
        capturedAuthHeaders = cloneHeaders(headers);
      },
      setXhrHeaders: function (headers) {
        capturedXhrHeaders = cloneHeaders(headers);
      },
      getFetchHeaders: function () {
        return cloneHeaders(capturedAuthHeaders);
      },
      getXhrHeaders: function () {
        return cloneHeaders(capturedXhrHeaders);
      },
      clearCapturedHeaders: function () {
        capturedAuthHeaders = null;
        capturedXhrHeaders = null;
      }
    };
  })();

  function isSameOriginPageMessage(event) {
    return Boolean(
      event
      && event.source === window
      && event.origin === window.location.origin
    );
  }

  function looksLikeN8nWorkflowPage() {
    if (window.location.pathname.indexOf('/workflow/') === -1) return false;

    var appEl = document.getElementById('app');
    var hasVueApp = !!(appEl && appEl.__vue_app__);
    var hasCanvasNode = !!document.querySelector('[data-test-id="canvas-node"]');
    var titleHasN8n = (document.title || '').toLowerCase().indexOf('n8n') !== -1;
    var sidebar = document.querySelector('#sidebar');
    var sidebarText = (sidebar && sidebar.textContent ? sidebar.textContent : '').toLowerCase();
    var hasN8nSidebar = !!(
      sidebar
      && (sidebarText.indexOf('n8n') !== -1 || sidebarText.indexOf('workflow') !== -1 || sidebarText.indexOf('executions') !== -1)
    );

    return hasVueApp || hasCanvasNode || titleHasN8n || hasN8nSidebar;
  }

  function installNetworkHooks() {
    if (networkHooksInstalled) return;
    networkHooksInstalled = true;

    // ---- Intercept fetch to capture auth headers n8n uses for /rest/ calls ----
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        if (url.indexOf('/rest/') !== -1 && init && init.headers) {
          var h = {};
          if (typeof Headers !== 'undefined' && init.headers instanceof Headers) {
            init.headers.forEach(function (val, key) { h[key.toLowerCase()] = val; });
          } else if (typeof init.headers === 'object' && !Array.isArray(init.headers)) {
            var keys = Object.keys(init.headers);
            for (var i = 0; i < keys.length; i++) { h[keys[i].toLowerCase()] = init.headers[keys[i]]; }
          }
          if (Object.keys(h).length > 0) {
            authCapture.setFetchHeaders(h);
          }
        }
      } catch (_e) { /* never break n8n's own fetch */ }
      return _originalFetch.apply(this, arguments);
    };

    // ---- Intercept XMLHttpRequest to capture auth headers from Axios/XHR calls ----
    // n8n uses Axios which goes through XHR, not fetch — this is where the real auth lives
    var _xhrOpen = XMLHttpRequest.prototype.open;
    var _xhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url) {
      // Tag this XHR instance so setRequestHeader knows to capture headers
      this._n8nSubflowUrl = (typeof url === 'string') ? url : '';
      this._n8nSubflowHeaders = {};
      return _xhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try {
        if (this._n8nSubflowUrl && this._n8nSubflowUrl.indexOf('/rest/') !== -1) {
          this._n8nSubflowHeaders[name.toLowerCase()] = value;
          // Persist the most recent complete set of auth headers from /rest/ calls
          if (Object.keys(this._n8nSubflowHeaders).length > 0) {
            authCapture.setXhrHeaders(this._n8nSubflowHeaders);
          }
        }
      } catch (_e) { /* never break n8n's XHR */ }
      return _xhrSetRequestHeader.apply(this, arguments);
    };
  }

  function getWorkflowsStore() {
    // Get the Pinia "workflows" store (the one with the current workflow data)
    try {
      var appEl = document.getElementById('app') || document.querySelector('[data-v-app]');
      if (!appEl || !appEl.__vue_app__) return null;

      var pinia = appEl.__vue_app__.config.globalProperties.$pinia;
      if (!pinia || !pinia.state || !pinia.state.value) return null;

      return pinia.state.value.workflows || null;
    } catch (e) {
      console.warn(LOG, 'Error accessing Pinia:', e.message);
      return null;
    }
  }

  function tryExtract() {
    var store = getWorkflowsStore();
    if (!store) {
      console.log(LOG, 'Pinia "workflows" store not found yet');
      return null;
    }

    // ---- Check store.workflow ----
    // n8n's workflow property is reactive — nodes may start empty then populate
    if (store.workflow) {
      var wf = store.workflow;

      // Log keys on first attempt
      if (attempts === 1) {
        var wfKeys = Object.keys(wf);
        console.log(LOG, 'workflows.workflow keys:', wfKeys.join(', '));
      }

      // Check if nodes is an array with actual entries
      if (Array.isArray(wf.nodes) && wf.nodes.length > 0) {
        console.log(LOG, 'HIT — workflows.workflow.nodes has ' + wf.nodes.length + ' nodes');
        return {
          source: 'pinia:workflows.workflow',
          data: JSON.parse(JSON.stringify(wf))
        };
      }

      // nodes might be an object/map keyed by node ID
      if (wf.nodes && typeof wf.nodes === 'object' && !Array.isArray(wf.nodes)) {
        var nodeKeys = Object.keys(wf.nodes);
        if (nodeKeys.length > 0) {
          console.log(LOG, 'HIT — workflows.workflow.nodes is an object with ' + nodeKeys.length + ' entries');
          var clone = JSON.parse(JSON.stringify(wf));
          clone.nodes = nodeKeys.map(function (k) { return wf.nodes[k]; });
          return { source: 'pinia:workflows.workflow (object→array)', data: clone };
        }
      }

      if (attempts <= 2) {
        console.log(LOG, 'workflows.workflow exists but nodes is empty, will retry...');
      }
    }

    // ---- Check store.workflowObject ----
    // This might be a runtime Workflow class instance with getNodes() or .nodes
    if (store.workflowObject) {
      var wo = store.workflowObject;
      if (attempts === 1) {
        console.log(LOG, 'Found workflowObject, constructor:', (wo.constructor && wo.constructor.name) || 'unknown');
      }

      // Try .nodes property
      var nodes = null;
      if (wo.nodes && typeof wo.nodes === 'object') {
        if (Array.isArray(wo.nodes) && wo.nodes.length > 0) {
          nodes = wo.nodes;
        } else if (!Array.isArray(wo.nodes)) {
          var nKeys = Object.keys(wo.nodes);
          if (nKeys.length > 0) {
            nodes = nKeys.map(function (k) { return wo.nodes[k]; });
          }
        }
      }

      // Log keys occasionally for debugging (without calling internal methods)
      if (!nodes) {
        var woKeys = [];
        try { woKeys = Object.keys(wo); } catch (e) {}
        if (attempts === 1) {
          console.log(LOG, 'workflowObject keys:', woKeys.slice(0, 20).join(', '));
        }
      }

      if (nodes && nodes.length > 0) {
        console.log(LOG, 'HIT — workflowObject has ' + nodes.length + ' nodes');
        try {
          return {
            source: 'pinia:workflows.workflowObject',
            data: JSON.parse(JSON.stringify({
              id: wo.id,
              name: wo.name,
              nodes: nodes,
              connections: wo.connections || wo.connectionsBySourceNode || {}
            }))
          };
        } catch (e) {
          console.warn(LOG, 'Could not serialize workflowObject:', e.message);
        }
      }
    }

    // ---- Check top-level store properties ----
    // Some n8n versions put nodes directly on the store
    if (Array.isArray(store.nodes) && store.nodes.length > 0) {
      console.log(LOG, 'HIT — store.nodes has', store.nodes.length, 'nodes');
      return {
        source: 'pinia:workflows (top-level)',
        data: JSON.parse(JSON.stringify({
          id: store.workflowId || store.id,
          name: store.workflowName || store.name,
          nodes: store.nodes,
          connections: store.connections || {}
        }))
      };
    }

    return null; // not ready yet — will retry
  }

  // ---- Retry loop ----
  var attempts = 0;
  var maxAttempts = 25;

  async function probe() {
    if (didSucceed || isProbing) return;
    isProbing = true;
    attempts++;
    console.log(LOG, 'Attempt ' + attempts + '/' + maxAttempts);

    var result = tryExtract();

    if (result && result.data && result.data.nodes && result.data.nodes.length > 0) {
      console.log(LOG, 'SUCCESS via ' + result.source + ' — ' + result.data.nodes.length + ' nodes');
      didSucceed = true;
      if (probeTimer) clearTimeout(probeTimer);
      await enrichNodesWithIcons(result.data.nodes);
      window.postMessage({
        type: 'n8n-subflow-probe-result',
        payload: result.data,
        source: result.source
      }, '*');
      isProbing = false;
    } else if (attempts < maxAttempts) {
      isProbing = false;
      probeTimer = setTimeout(probe, 1000);
    } else {
      console.warn(LOG, 'Gave up after ' + maxAttempts + ' attempts — could not find populated workflow data');
      window.postMessage({
        type: 'n8n-subflow-probe-result',
        payload: null,
        error: 'Workflow store found but nodes never populated'
      }, '*');
      isProbing = false;
    }
  }

  // Listen for re-probe requests from the content script (e.g. on URL change)
  window.addEventListener('message', function (event) {
    if (!isActiveN8nPage || !isSameOriginPageMessage(event) || !event.data) return;
    if (event.data.type !== 'n8n-subflow-probe-request') return;
    console.log(LOG, 'Re-probe requested by content script');
    if (probeTimer) clearTimeout(probeTimer);
    attempts = 0;
    didSucceed = false;
    isProbing = false;
    probe();
  });

  // ---- Listen for sub-workflow fetch requests ----
  // Runs in page context, so fetch() sends session cookies automatically (n8n Cloud)
  function looksLikeJwt(value) {
    return typeof value === 'string' && /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(value);
  }

  function extractTokenCandidate(raw) {
    if (!raw) return null;

    // Raw JWT string
    if (looksLikeJwt(raw)) return raw;

    // JSON object string
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      var keys = ['token', 'accessToken', 'jwt', 'authToken', 'bearerToken', 'idToken'];
      for (var i = 0; i < keys.length; i++) {
        var v = parsed[keys[i]];
        if (looksLikeJwt(v)) return v;
      }
    } catch (_err) {
      // ignore
    }
    return null;
  }

  function discoverAuthHeaders() {
    var headers = { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    var token = null;

    // Try Pinia users store first
    try {
      var appEl = document.getElementById('app') || document.querySelector('[data-v-app]');
      if (appEl && appEl.__vue_app__) {
        var pinia = appEl.__vue_app__.config.globalProperties.$pinia;
        if (pinia && pinia.state && pinia.state.value && pinia.state.value.users) {
          var users = pinia.state.value.users;
          var candidateKeys = ['token', 'accessToken', 'jwt', 'authToken', 'bearerToken', 'idToken'];
          for (var i = 0; i < candidateKeys.length; i++) {
            var v = users[candidateKeys[i]];
            if (looksLikeJwt(v)) {
              token = v;
              break;
            }
          }
        }
      }
    } catch (_err) {
      // ignore
    }

    // Fallback: scan storage keys for token-like values
    if (!token) {
      try {
        for (var li = 0; li < localStorage.length; li++) {
          var lk = localStorage.key(li);
          if (!lk) continue;
          var lv = localStorage.getItem(lk);
          var found = extractTokenCandidate(lv);
          if (found) {
            token = found;
            break;
          }
        }
      } catch (_err) {
        // ignore
      }
    }
    if (!token) {
      try {
        for (var si = 0; si < sessionStorage.length; si++) {
          var sk = sessionStorage.key(si);
          if (!sk) continue;
          var sv = sessionStorage.getItem(sk);
          var found2 = extractTokenCandidate(sv);
          if (found2) {
            token = found2;
            break;
          }
        }
      } catch (_err) {
        // ignore
      }
    }

    if (token) {
      headers.Authorization = 'Bearer ' + token;
    }

    return { headers: headers, hasBearer: !!token };
  }

  function getVueApp() {
    var appEl = document.getElementById('app') || document.querySelector('[data-v-app]');
    if (!appEl || !appEl.__vue_app__) return null;
    return appEl.__vue_app__;
  }

  function getStoreInstance(storeId) {
    try {
      var app = getVueApp();
      if (!app) return null;
      var pinia = app.config.globalProperties.$pinia;
      if (!pinia || !pinia._s || typeof pinia._s.get !== 'function') return null;
      return pinia._s.get(storeId) || null;
    } catch (_err) {
      return null;
    }
  }

  // ---- Resolve real n8n node icon URLs from the nodeTypes store ----
  function getNodeTypesStore() {
    return getStoreInstance('nodeTypes');
  }

  function ensureLeadingSlash(path) {
    if (!path) return path;
    if (path.indexOf('http://') === 0 || path.indexOf('https://') === 0 || path.indexOf('data:') === 0) return path;
    return path.charAt(0) === '/' ? path : ('/' + path);
  }

  var _iconProbeCache = Object.create(null);
  var _fileIconResolutionCache = Object.create(null);

  function getPackageNameFromNodeType(nodeTypeName) {
    if (!nodeTypeName) return 'n8n-nodes-base';
    var dotIdx = nodeTypeName.indexOf('.');
    return dotIdx > 0 ? nodeTypeName.slice(0, dotIdx) : nodeTypeName;
  }

  function getNodeTypeLookupCandidates(nodeTypeName) {
    var out = [nodeTypeName];
    if (typeof nodeTypeName !== 'string') return out;

    if (nodeTypeName.indexOf('@n8n/') === 0) {
      out.push(nodeTypeName.slice(5));
    } else if (nodeTypeName.indexOf('n8n-') === 0) {
      out.push('@n8n/' + nodeTypeName);
    }

    var seen = Object.create(null);
    return out.filter(function (name) {
      if (!name || seen[name]) return false;
      seen[name] = true;
      return true;
    });
  }

  function toPascalCase(value) {
    return String(value || '')
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .map(function (part) { return part ? (part.charAt(0).toUpperCase() + part.slice(1)) : ''; })
      .join('');
  }

  function basename(path) {
    var idx = String(path).lastIndexOf('/');
    return idx >= 0 ? path.slice(idx + 1) : path;
  }

  function buildFileIconCandidates(nodeTypeName, nodeType, fileName) {
    var packageName = getPackageNameFromNodeType(nodeTypeName);
    var base = window.location.origin + '/icons/' + packageName + '/dist/nodes/';
    var normalizedFileName = String(fileName || '').replace(/^\/+/, '');
    var fileBaseName = basename(normalizedFileName);
    var candidates = [];
    var seen = Object.create(null);

    function push(url) {
      if (!url || seen[url]) return;
      seen[url] = true;
      candidates.push(url);
    }

    // First try direct value from "file:" field.
    push(base + normalizedFileName);

    // Common n8n pattern: /nodes/FolderName/file.svg (e.g. /nodes/Code/code.svg).
    if (normalizedFileName.indexOf('/') === -1 && nodeType && nodeType.displayName) {
      var folderFromDisplay = toPascalCase(nodeType.displayName);
      if (folderFromDisplay) push(base + folderFromDisplay + '/' + fileBaseName);
    }

    // Fallback folder derived from type suffix.
    var typeSuffix = String(nodeTypeName || '').split('.').slice(1).join('.');
    if (typeSuffix) {
      var folderFromType = toPascalCase(typeSuffix);
      if (folderFromType) push(base + folderFromType + '/' + fileBaseName);
    }

    return candidates;
  }

  async function canFetchIcon(url) {
    if (Object.prototype.hasOwnProperty.call(_iconProbeCache, url)) return _iconProbeCache[url];

    try {
      var headRes = await _originalFetch(url, { method: 'HEAD', credentials: 'include' });
      if (headRes && headRes.ok) {
        _iconProbeCache[url] = true;
        return true;
      }
    } catch (_headErr) {
      // Some setups block HEAD; fallback to GET below.
    }

    try {
      var getRes = await _originalFetch(url, { method: 'GET', credentials: 'include' });
      var ok = !!(getRes && getRes.ok);
      _iconProbeCache[url] = ok;
      return ok;
    } catch (_getErr) {
      _iconProbeCache[url] = false;
      return false;
    }
  }

  async function resolveFileIconUrl(nodeTypeName, nodeType, fileName) {
    var cacheKey = String(nodeTypeName || '') + '|' + String(fileName || '');
    if (Object.prototype.hasOwnProperty.call(_fileIconResolutionCache, cacheKey)) {
      return _fileIconResolutionCache[cacheKey];
    }

    var candidates = buildFileIconCandidates(nodeTypeName, nodeType, fileName);
    for (var i = 0; i < candidates.length; i++) {
      if (await canFetchIcon(candidates[i])) {
        _fileIconResolutionCache[cacheKey] = candidates[i];
        return candidates[i];
      }
    }

    _fileIconResolutionCache[cacheKey] = null;
    return null;
  }

  async function resolveIconUrlForType(nodeTypeName) {
    try {
      var ntStore = getNodeTypesStore();
      if (!ntStore) return null;

      var nodeType = null;
      var resolvedTypeName = nodeTypeName;
      if (typeof ntStore.getNodeType === 'function') {
        var lookupNames = getNodeTypeLookupCandidates(nodeTypeName);
        for (var i = 0; i < lookupNames.length && !nodeType; i++) {
          nodeType = ntStore.getNodeType(lookupNames[i]);
          if (!nodeType) nodeType = ntStore.getNodeType(lookupNames[i], 1);
          if (nodeType) resolvedTypeName = lookupNames[i];
        }
      }
      if (!nodeType) return null;

      // iconUrl: string path ready to use (e.g. "icons/n8n-nodes-base/dist/nodes/Form/form.svg")
      if (nodeType.iconUrl) {
        if (typeof nodeType.iconUrl === 'object') {
          var url = nodeType.iconUrl.light || nodeType.iconUrl.dark || null;
          if (url) return window.location.origin + ensureLeadingSlash(url);
        }
        if (typeof nodeType.iconUrl === 'string') {
          return window.location.origin + ensureLeadingSlash(nodeType.iconUrl);
        }
      }

      // icon: "file:filename.svg" → resolve to n8n's icon serving path
      var iconField = nodeType.icon;
      if (typeof iconField === 'string' && iconField.startsWith('file:')) {
        var fileName = iconField.slice(5);
        return await resolveFileIconUrl(resolvedTypeName, nodeType, fileName);
      }
      if (typeof iconField === 'object' && iconField) {
        var lightIcon = (iconField.light || iconField.dark || '');
        if (lightIcon.startsWith('file:')) {
          var fn = lightIcon.slice(5);
          return await resolveFileIconUrl(resolvedTypeName, nodeType, fn);
        }
      }
    } catch (_e) {
      // Best-effort — never break
    }
    return null;
  }

  // Scrape icon URLs directly from n8n's rendered canvas DOM nodes
  function scrapeCanvasIcons() {
    var iconMap = {};
    try {
      var canvasNodes = document.querySelectorAll('[data-test-id="canvas-node"]');
      canvasNodes.forEach(function (el) {
        var typeAttr = el.getAttribute('data-node-type') || '';
        if (!typeAttr || iconMap[typeAttr]) return;

        // n8n renders node icons as <img> inside the node card
        var img = el.querySelector('img[src*="icon"]') || el.querySelector('img[src*="/icons/"]') || el.querySelector('.node-icon img') || el.querySelector('img');
        if (img && img.src) {
          iconMap[typeAttr] = img.src;
          return;
        }

        // Some icons are SVG elements with a use/href or inline
        var svg = el.querySelector('svg.node-icon') || el.querySelector('.node-icon svg');
        if (svg) {
          var use = svg.querySelector('use');
          if (use) {
            var href = use.getAttribute('href') || use.getAttribute('xlink:href');
            if (href) { iconMap[typeAttr] = href; return; }
          }
        }
      });
    } catch (_e) { /* ignore */ }
    return iconMap;
  }

  // Build type→icon maps from allLatestNodeTypes.
  // Returns { urls: { type: url }, fa: { type: faIconName } }
  function buildIconMaps() {
    var urls = {};
    var fa = {};
    try {
      var ntStore = getNodeTypesStore();
      if (!ntStore) return { urls: urls, fa: fa };

      var allTypes = ntStore.allLatestNodeTypes || ntStore.allNodeTypes || [];
      var entries = Array.isArray(allTypes) ? allTypes : Object.values(allTypes);

      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (!entry || !entry.name) continue;

        if (entry.iconUrl) {
          var raw = typeof entry.iconUrl === 'object'
            ? (entry.iconUrl.light || entry.iconUrl.dark)
            : entry.iconUrl;
          if (raw) { urls[entry.name] = window.location.origin + ensureLeadingSlash(raw); continue; }
        }

        var iconField = entry.icon;
        if (typeof iconField === 'string' && iconField.startsWith('fa:')) {
          fa[entry.name] = iconField.slice(3);
          continue;
        }
      }
      console.log(LOG, 'Icon maps built:', Object.keys(urls).length, 'SVG +', Object.keys(fa).length, 'FA');
    } catch (_e) {
      console.warn(LOG, 'buildIconMaps error:', _e);
    }
    return { urls: urls, fa: fa };
  }

  var _globalIconMaps = null;
  var _iconMapsBuiltAt = 0;

  function getGlobalIconMaps(forceRefresh) {
    var now = Date.now();
    // Rebuild maps if forced or if more than 10s have passed (node types may have loaded lazily)
    if (!_globalIconMaps || forceRefresh || (now - _iconMapsBuiltAt > 10000)) {
      _globalIconMaps = buildIconMaps();
      _iconMapsBuiltAt = now;
    }
    return _globalIconMaps;
  }

  // Enrich nodes with _iconUrl (SVG) or _iconFa (FA class name for content.js to resolve)
  async function enrichNodesWithIcons(nodes, forceRefreshMaps) {
    if (!Array.isArray(nodes) || nodes.length === 0) return;

    var maps = getGlobalIconMaps(!!forceRefreshMaps);
    var domIcons = scrapeCanvasIcons();
    var svgCount = 0, faCount = 0;

    for (var j = 0; j < nodes.length; j++) {
      var type = nodes[j].type;
      if (!type) continue;

      var url = maps.urls[type] || await resolveIconUrlForType(type) || domIcons[type] || null;
      if (url) { nodes[j]._iconUrl = url; svgCount++; continue; }

      var faName = maps.fa[type] || null;
      if (faName) { nodes[j]._iconFa = faName; faCount++; }
    }

    console.log(LOG, 'Icon enrichment:', nodes.length, 'nodes,', svgCount, 'SVG +', faCount, 'FA =', (svgCount + faCount), 'total');
  }

  function normalizeWorkflowPayload(value) {
    if (!value) return null;
    var candidate = value;

    if (candidate.data) candidate = candidate.data;
    if (candidate.workflow) candidate = candidate.workflow;
    if (candidate.data && candidate.data.workflow) candidate = candidate.data.workflow;

    if (candidate && Array.isArray(candidate.nodes)) return candidate;
    return null;
  }

  function getWorkflowFromStoreState(workflowId) {
    var stateStore = getWorkflowsStore();
    if (!stateStore || !stateStore.workflow) return null;
    var wf = stateStore.workflow;
    if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) return null;

    // If id is available, match to ensure we got the requested sub-workflow.
    if (wf.id && workflowId && String(wf.id) !== String(workflowId)) return null;
    return JSON.parse(JSON.stringify(wf));
  }

  async function tryInPageApiHelper(workflowId) {
    var attempts = [];

    var workflowsStore = getStoreInstance('workflows');
    if (!workflowsStore) {
      return { ok: false, attempts: [{ authMode: 'inPageApiHelper', endpointUsed: 'pinia._s.get(workflows)', status: 'missing' }] };
    }

    // workflows store found

    // Try known store method names that might fetch a workflow by ID
    var methodSpecs = [
      { name: 'fetchWorkflow', argsList: [[workflowId], [{ id: workflowId }], [{ workflowId: workflowId }]] },
      { name: 'getWorkflow', argsList: [[workflowId], [{ id: workflowId }]] },
      { name: 'fetchWorkflowById', argsList: [[workflowId], [{ id: workflowId }]] },
      { name: 'loadWorkflow', argsList: [[workflowId], [{ id: workflowId }]] }
    ];

    for (var i = 0; i < methodSpecs.length; i++) {
      var spec = methodSpecs[i];
      var method = workflowsStore[spec.name];
      if (typeof method !== 'function') continue;

      for (var j = 0; j < spec.argsList.length; j++) {
        var args = spec.argsList[j];
        try {
          var result = method.apply(workflowsStore, args);
          if (result && typeof result.then === 'function') result = await result;

          var normalized = normalizeWorkflowPayload(result);
          if (!normalized) normalized = getWorkflowFromStoreState(workflowId);

          attempts.push({
            authMode: 'inPageApiHelper',
            endpointUsed: 'workflowsStore.' + spec.name,
            status: normalized ? 200 : 'empty'
          });

          if (normalized) {
            return {
              ok: true,
              payload: normalized,
              diagnostics: {
                authMode: 'inPageApiHelper',
                endpointUsed: 'workflowsStore.' + spec.name,
                status: 200,
                attempts: attempts
              }
            };
          }
        } catch (err) {
          attempts.push({
            authMode: 'inPageApiHelper',
            endpointUsed: 'workflowsStore.' + spec.name,
            status: 'error',
            message: err && err.message ? err.message : String(err)
          });
        }
      }
    }

    // Try global API helpers exposed on Vue globalProperties.
    try {
      var app = getVueApp();
      var gp = app && app.config ? app.config.globalProperties : null;
      var restApi = gp && (gp.$restApi || gp.$api || gp.$client);
      if (restApi) {
        var globalCandidates = [];
        if (typeof restApi.getWorkflow === 'function') globalCandidates.push({ fn: restApi.getWorkflow, name: 'global.getWorkflow', ctx: restApi });
        if (restApi.workflows && typeof restApi.workflows.get === 'function') globalCandidates.push({ fn: restApi.workflows.get, name: 'global.workflows.get', ctx: restApi.workflows });
        if (restApi.workflows && typeof restApi.workflows.getById === 'function') globalCandidates.push({ fn: restApi.workflows.getById, name: 'global.workflows.getById', ctx: restApi.workflows });

        for (var g = 0; g < globalCandidates.length; g++) {
          try {
            var candidate = globalCandidates[g];
            var out = candidate.fn.call(candidate.ctx, workflowId);
            if (out && typeof out.then === 'function') out = await out;
            var normalizedGlobal = normalizeWorkflowPayload(out);
            attempts.push({
              authMode: 'inPageApiHelper',
              endpointUsed: candidate.name,
              status: normalizedGlobal ? 200 : 'empty'
            });
            if (normalizedGlobal) {
              return {
                ok: true,
                payload: normalizedGlobal,
                diagnostics: {
                  authMode: 'inPageApiHelper',
                  endpointUsed: candidate.name,
                  status: 200,
                  attempts: attempts
                }
              };
            }
          } catch (errGlobal) {
            attempts.push({
              authMode: 'inPageApiHelper',
              endpointUsed: globalCandidates[g].name,
              status: 'error',
              message: errGlobal && errGlobal.message ? errGlobal.message : String(errGlobal)
            });
          }
        }
      }
    } catch (_errGlobalOuter) {
      // ignore helper probing errors
    }

    return { ok: false, attempts: attempts };
  }

  window.addEventListener('message', function (event) {
    if (!isActiveN8nPage || !isSameOriginPageMessage(event) || !event.data) return;
    if (event.data.type !== 'n8n-subflow-fetch-request') return;
    (async function () {
      var reqId = event.data.reqId;
      var workflowId = event.data.workflowId;
      var diagnostics = { authMode: 'unknown', endpointUsed: 'unknown', status: 'unknown', attempts: [] };

      // Strategy 1: use in-page helper path (closest to n8n's own runtime behavior)
      var helperResult = await tryInPageApiHelper(workflowId);
      if (helperResult && helperResult.attempts) diagnostics.attempts = diagnostics.attempts.concat(helperResult.attempts);
      if (helperResult && helperResult.ok) {
        await enrichNodesWithIcons(helperResult.payload.nodes, true);
        diagnostics.authMode = helperResult.diagnostics.authMode;
        diagnostics.endpointUsed = helperResult.diagnostics.endpointUsed;
        diagnostics.status = helperResult.diagnostics.status;
        window.postMessage({
          type: 'n8n-subflow-fetch-result',
          reqId: reqId,
          payload: helperResult.payload,
          diagnostics: diagnostics
        }, '*');
        return;
      }

      // Strategy 2: fetch using headers captured from n8n's own requests
      var fetchUrl = window.location.origin + '/rest/workflows/' + workflowId;
      var headerSources = [];

      // Prefer headers captured from XHR (Axios) — this is where n8n's real auth lives
      var capturedXhrHeaders = authCapture.getXhrHeaders();
      if (capturedXhrHeaders && Object.keys(capturedXhrHeaders).length > 0) {
        var xhrH = {};
        for (var xk in capturedXhrHeaders) { xhrH[xk] = capturedXhrHeaders[xk]; }
        xhrH['accept'] = 'application/json';
        headerSources.push({ label: 'captured-xhr', headers: xhrH, usesCapturedHeaders: true });
      }

      // Also try headers from fetch interception (Sentry/telemetry might not help, but worth a shot)
      var capturedAuthHeaders = authCapture.getFetchHeaders();
      if (capturedAuthHeaders && Object.keys(capturedAuthHeaders).length > 0) {
        var captured = {};
        for (var ck in capturedAuthHeaders) { captured[ck] = capturedAuthHeaders[ck]; }
        captured['accept'] = 'application/json';
        headerSources.push({ label: 'captured-fetch', headers: captured, usesCapturedHeaders: true });
      }

      // Fallback: headers discovered from Pinia/storage
      var discoveredAuth = discoverAuthHeaders();
      headerSources.push({ label: discoveredAuth.hasBearer ? 'discovered+bearer' : 'cookie-only', headers: discoveredAuth.headers });

      for (var hs = 0; hs < headerSources.length; hs++) {
        var src = headerSources[hs];
        diagnostics.authMode = src.label;
        diagnostics.endpointUsed = fetchUrl;
        try {
          console.log(LOG, 'Fetching sub-workflow:', fetchUrl, '| auth:', src.label);
          var res = await _originalFetch(fetchUrl, { credentials: 'include', headers: src.headers });
          diagnostics.attempts.push({ authMode: src.label, endpointUsed: fetchUrl, status: res.status });
          if (!res.ok) {
            diagnostics.status = res.status;
            continue;
          }

          var json = await res.json();
          var data = json.data || json;
          if (data && Array.isArray(data.nodes)) await enrichNodesWithIcons(data.nodes, true);
          if (src.usesCapturedHeaders) {
            authCapture.clearCapturedHeaders();
          }
          diagnostics.status = 200;
          window.postMessage({
            type: 'n8n-subflow-fetch-result',
            reqId: reqId,
            payload: data,
            diagnostics: diagnostics
          }, '*');
          return;
        } catch (err) {
          diagnostics.attempts.push({
            authMode: src.label,
            endpointUsed: fetchUrl,
            status: 'network_error',
            message: err && err.message ? err.message : String(err)
          });
          diagnostics.status = 'network_error';
        }
      }

      var statusCode = Number(diagnostics.status);
      window.postMessage({
        type: 'n8n-subflow-fetch-result',
        reqId: reqId,
        error: statusCode === 404 ? 'not_found' : 'auth_failed',
        message: statusCode === 404
          ? 'Workflow not found'
          : 'Auth failed (' + diagnostics.status + ')',
        diagnostics: diagnostics
      }, '*');
    })();
  });

  function startIfN8nPage() {
    if (!looksLikeN8nWorkflowPage()) {
      return;
    }
    isActiveN8nPage = true;
    installNetworkHooks();
    console.log(LOG, 'Starting — looking for workflow data in n8n stores...');
    // Start after a short delay to give n8n time to initialize
    probeTimer = setTimeout(probe, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startIfN8nPage, { once: true });
  } else {
    startIfN8nPage();
  }
})();
