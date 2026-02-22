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
      await enrichNodesWithIcons(result.data.nodes, true);
      var probeIconMaps = await getGlobalIconMaps(false);
      _persistedProbeIconLookup = cloneIconLookupForMessage(probeIconMaps);
      window.postMessage({
        type: 'n8n-subflow-probe-result',
        payload: result.data,
        source: result.source,
        iconLookup: cloneIconLookupForMessage(probeIconMaps)
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

  function getPiniaInstance() {
    try {
      var app = getVueApp();
      if (!app || !app.config || !app.config.globalProperties) return null;
      return app.config.globalProperties.$pinia || null;
    } catch (_err) {
      return null;
    }
  }

  function getStoreInstance(storeId) {
    try {
      var pinia = getPiniaInstance();
      if (!pinia || !pinia._s || typeof pinia._s.get !== 'function') return null;
      return pinia._s.get(storeId) || null;
    } catch (_err) {
      return null;
    }
  }

  function looksLikeNodeTypesStore(store) {
    if (!store || typeof store !== 'object') return false;
    if (typeof store.getNodeType === 'function') return true;
    if (store.allLatestNodeTypes || store.allNodeTypes) return true;
    if (store.nodeTypes || store.types || store.byName) return true;
    return false;
  }

  var _nodeTypesSourceLogCache = Object.create(null);

  function getNodeTypesStoreCandidates() {
    var pinia = getPiniaInstance();
    var out = [];
    var seen = Object.create(null);
    if (!pinia) return out;

    function push(label, store) {
      if (!store || typeof store !== 'object') return;
      if (!looksLikeNodeTypesStore(store)) return;
      var key = label + '::' + Object.prototype.toString.call(store);
      if (seen[key]) return;
      seen[key] = true;
      out.push({ label: label, store: store });
      if (!_nodeTypesSourceLogCache[label]) {
        _nodeTypesSourceLogCache[label] = true;
        try {
          var keys = Object.keys(store);
          console.log(LOG, 'nodeTypes source keys [' + label + ']:', keys.slice(0, 40).join(', '));
        } catch (_err) {
          console.log(LOG, 'nodeTypes source keys [' + label + ']: <unavailable>');
        }
      }
    }

    // Preferred: real pinia store instance by id.
    push('pinia._s.nodeTypes', getStoreInstance('nodeTypes'));

    // Iterate all store instances to catch renamed ids.
    try {
      if (pinia._s && typeof pinia._s.forEach === 'function') {
        pinia._s.forEach(function (store, id) {
          push('pinia._s.' + id, store);
        });
      }
    } catch (_err) {
      // ignore
    }

    // Check reactive state snapshots used by some n8n versions.
    try {
      var state = pinia.state && pinia.state.value ? pinia.state.value : null;
      if (state && typeof state === 'object') {
        push('pinia.state.value.nodeTypes', state.nodeTypes);
        push('pinia.state.value.ndv', state.ndv);
        Object.keys(state).forEach(function (k) {
          push('pinia.state.value.' + k, state[k]);
        });
      }
    } catch (_err) {
      // ignore
    }

    return out;
  }

  function getNodeTypeEntries(store) {
    if (!store || typeof store !== 'object') return [];
    var candidates = [
      store.allLatestNodeTypes,
      store.allNodeTypes,
      store.nodeTypes,
      store.types,
      store.byName
    ];
    for (var i = 0; i < candidates.length; i++) {
      var value = candidates[i];
      if (!value) continue;
      if (Array.isArray(value)) return value;
      if (typeof value === 'object') return Object.values(value);
    }
    return [];
  }

  // ---- Resolve real n8n node icon URLs from the nodeTypes store ----
  function getNodeTypesStore() {
    var candidates = getNodeTypesStoreCandidates();
    return candidates.length > 0 ? candidates[0].store : null;
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

  var _typesNodesJsonPromise = null;

  async function loadTypesNodesJson() {
    if (_typesNodesJsonPromise) return _typesNodesJsonPromise;
    _typesNodesJsonPromise = (async function () {
      try {
        var res = await _originalFetch(window.location.origin + '/types/nodes.json', {
          method: 'GET',
          credentials: 'include'
        });
        if (!res || !res.ok) return null;
        var json = await res.json();
        return json || null;
      } catch (_err) {
        return null;
      }
    })();
    return _typesNodesJsonPromise;
  }

  function getTypesNodesEntry(raw, nodeTypeName) {
    if (!raw || !nodeTypeName) return null;
    try {
      if (Array.isArray(raw)) {
        for (var i = 0; i < raw.length; i++) {
          var item = raw[i];
          if (item && item.name === nodeTypeName) return item;
        }
      }
      if (raw.data && Array.isArray(raw.data)) {
        for (var j = 0; j < raw.data.length; j++) {
          var item2 = raw.data[j];
          if (item2 && item2.name === nodeTypeName) return item2;
        }
      }
      if (raw.nodeTypes && typeof raw.nodeTypes === 'object') {
        if (raw.nodeTypes[nodeTypeName]) return raw.nodeTypes[nodeTypeName];
      }
      if (typeof raw === 'object' && raw[nodeTypeName]) return raw[nodeTypeName];
    } catch (_err) {
      // ignore
    }
    return null;
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

  function normalizeNodeColor(raw) {
    if (!raw) return null;
    var value = String(raw).trim();
    if (!value) return null;
    if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
    if (/^[0-9a-fA-F]{3,8}$/.test(value)) return '#' + value;
    return null;
  }

  function extractNodeTypeColor(nodeType) {
    if (!nodeType || typeof nodeType !== 'object') return null;
    var raw = null;
    if (nodeType.defaults && typeof nodeType.defaults === 'object') {
      raw = nodeType.defaults.color || null;
    }
    if (!raw && nodeType.color) raw = nodeType.color;
    return normalizeNodeColor(raw);
  }

  async function resolveIconFromEntry(nodeTypeName, nodeType) {
    if (!nodeType || typeof nodeType !== 'object') return { url: null, fa: null, color: null };
    var nodeColor = extractNodeTypeColor(nodeType);

    // iconUrl: string path ready to use (e.g. "icons/n8n-nodes-base/dist/nodes/Form/form.svg")
    if (nodeType.iconUrl) {
      if (typeof nodeType.iconUrl === 'object') {
        var objUrl = nodeType.iconUrl.light || nodeType.iconUrl.dark || null;
        if (objUrl) return { url: window.location.origin + ensureLeadingSlash(objUrl), fa: null, color: nodeColor };
      }
      if (typeof nodeType.iconUrl === 'string') {
        return { url: window.location.origin + ensureLeadingSlash(nodeType.iconUrl), fa: null, color: nodeColor };
      }
    }

    // icon: "file:filename.svg" | "fa:robot"
    var iconField = nodeType.icon;
    if (typeof iconField === 'string') {
      if (iconField.indexOf('fa:') === 0) {
        return { url: null, fa: iconField.slice(3), color: nodeColor };
      }
      if (iconField.indexOf('file:') === 0) {
        var fileName = iconField.slice(5);
        var fileUrl = await resolveFileIconUrl(nodeTypeName, nodeType, fileName);
        return { url: fileUrl, fa: null, color: nodeColor };
      }
      if (iconField.indexOf('/') >= 0 || iconField.indexOf('.svg') >= 0) {
        return { url: window.location.origin + ensureLeadingSlash(iconField), fa: null, color: nodeColor };
      }
    }

    if (typeof iconField === 'object' && iconField) {
      var iconValue = iconField.light || iconField.dark || '';
      if (typeof iconValue === 'string' && iconValue.indexOf('fa:') === 0) {
        return { url: null, fa: iconValue.slice(3), color: nodeColor };
      }
      if (typeof iconValue === 'string' && iconValue.indexOf('file:') === 0) {
        var fn = iconValue.slice(5);
        var fileUrl2 = await resolveFileIconUrl(nodeTypeName, nodeType, fn);
        return { url: fileUrl2, fa: null, color: nodeColor };
      }
    }

    return { url: null, fa: null, color: nodeColor };
  }

  async function resolveIconDetailsForType(nodeTypeName) {
    try {
      var lookupNames = getNodeTypeLookupCandidates(nodeTypeName);
      var stores = getNodeTypesStoreCandidates();

      // 1) Prefer store getter lookup.
      for (var s = 0; s < stores.length; s++) {
        var store = stores[s].store;
        if (typeof store.getNodeType !== 'function') continue;
        for (var i = 0; i < lookupNames.length; i++) {
          var candidateName = lookupNames[i];
          var nodeType = store.getNodeType(candidateName) || store.getNodeType(candidateName, 1);
          if (!nodeType) continue;
          var resolved = await resolveIconFromEntry(candidateName, nodeType);
          if (resolved.url || resolved.fa || resolved.color) return resolved;
        }
      }

      // 2) Fallback to enumerated arrays/maps in state/store objects.
      for (var s2 = 0; s2 < stores.length; s2++) {
        var entries = getNodeTypeEntries(stores[s2].store);
        if (!entries || entries.length === 0) continue;
        for (var j = 0; j < entries.length; j++) {
          var entry = entries[j];
          if (!entry || !entry.name) continue;
          var matches = lookupNames.indexOf(entry.name) !== -1;
          if (!matches) continue;
          var resolved2 = await resolveIconFromEntry(entry.name, entry);
          if (resolved2.url || resolved2.fa || resolved2.color) return resolved2;
        }
      }

      // 3) Try /types/nodes.json registry if available.
      var typesJson = await loadTypesNodesJson();
      for (var k = 0; k < lookupNames.length; k++) {
        var fromJson = getTypesNodesEntry(typesJson, lookupNames[k]);
        if (!fromJson) continue;
        var merged = fromJson;
        if (!merged.name) merged = Object.assign({ name: lookupNames[k] }, fromJson);
        var resolved3 = await resolveIconFromEntry(lookupNames[k], merged);
        if (resolved3.url || resolved3.fa || resolved3.color) return resolved3;
      }
    } catch (_e) {
      // Best-effort — never break
    }
    return { url: null, fa: null, color: null };
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
  async function buildIconMaps() {
    var urls = {};
    var fa = {};
    var colors = {};
    var registryEntries = 0;
    var loggedStoreSamples = false;
    try {
      var stores = getNodeTypesStoreCandidates();
      var seenNames = Object.create(null);

      for (var s = 0; s < stores.length; s++) {
        var entries = getNodeTypeEntries(stores[s].store);
        if (!loggedStoreSamples && entries && entries.length > 0) {
          loggedStoreSamples = true;
          console.log(LOG, 'nodeTypes sample source:', stores[s].label, '| total entries:', entries.length);
          for (var sampleIdx = 0; sampleIdx < Math.min(3, entries.length); sampleIdx++) {
            var sample = entries[sampleIdx];
            var sampleKeys = sample && typeof sample === 'object' ? Object.keys(sample) : [];
            console.log(LOG, 'nodeTypes sample[' + sampleIdx + '] keys:', sampleKeys.join(', '));
            console.log(LOG, 'nodeTypes sample[' + sampleIdx + '] value:', sample);
          }
        }
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i];
          if (!entry || !entry.name || seenNames[entry.name]) continue;
          seenNames[entry.name] = true;
          registryEntries++;
          var resolved = await resolveIconFromEntry(entry.name, entry);
          if (resolved.url) urls[entry.name] = resolved.url;
          if (resolved.fa) fa[entry.name] = resolved.fa;
          if (resolved.color) colors[entry.name] = resolved.color;
        }
      }

      // Merge /types/nodes.json registry as additional source.
      var typesJson = await loadTypesNodesJson();
      var lookup = Object.create(null);
      if (typesJson) {
        var items = [];
        if (Array.isArray(typesJson)) items = typesJson;
        else if (typesJson.data && Array.isArray(typesJson.data)) items = typesJson.data;
        else if (typesJson.nodeTypes && typeof typesJson.nodeTypes === 'object') {
          items = Object.keys(typesJson.nodeTypes).map(function (name) {
            var item = typesJson.nodeTypes[name];
            if (!item || typeof item !== 'object') return null;
            return item.name ? item : Object.assign({ name: name }, item);
          }).filter(Boolean);
        } else if (typeof typesJson === 'object') {
          items = Object.keys(typesJson).map(function (name) {
            var item = typesJson[name];
            if (!item || typeof item !== 'object') return null;
            return item.name ? item : Object.assign({ name: name }, item);
          }).filter(Boolean);
        }

        for (var j = 0; j < items.length; j++) {
          var item = items[j];
          if (!item || !item.name || lookup[item.name]) continue;
          lookup[item.name] = true;
          if (!urls[item.name] && !fa[item.name]) {
            var resolvedJson = await resolveIconFromEntry(item.name, item);
            if (resolvedJson.url) urls[item.name] = resolvedJson.url;
            if (resolvedJson.fa) fa[item.name] = resolvedJson.fa;
            if (resolvedJson.color) colors[item.name] = resolvedJson.color;
          } else if (!colors[item.name]) {
            var colorOnly = extractNodeTypeColor(item);
            if (colorOnly) colors[item.name] = colorOnly;
          }
        }
      }

      console.log(
        LOG,
        'Icon maps built from registry:',
        registryEntries,
        'entries ->',
        Object.keys(urls).length,
        'SVG +',
        Object.keys(fa).length,
        'FA,',
        Object.keys(colors).length,
        'colors'
      );
    } catch (_e) {
      console.warn(LOG, 'buildIconMaps error:', _e);
    }
    return { urls: urls, fa: fa, colors: colors, registryEntries: registryEntries };
  }

  var _globalIconMaps = null;
  var _iconMapsBuiltAt = 0;
  var _persistedProbeIconLookup = { urls: {}, fa: {}, colors: {} };

  async function getGlobalIconMaps(forceRefresh) {
    var now = Date.now();
    // Rebuild maps if forced or if more than 10s have passed (node types may have loaded lazily)
    if (!_globalIconMaps || forceRefresh || (now - _iconMapsBuiltAt > 10000)) {
      _globalIconMaps = await buildIconMaps();
      _iconMapsBuiltAt = now;
    }
    return _globalIconMaps;
  }

  function cloneIconLookupForMessage(maps) {
    var out = { urls: {}, fa: {}, colors: {} };
    if (!maps || typeof maps !== 'object') return out;
    var urls = maps.urls || {};
    var fa = maps.fa || {};
    var colors = maps.colors || {};
    Object.keys(urls).forEach(function (k) { out.urls[k] = urls[k]; });
    Object.keys(fa).forEach(function (k) { out.fa[k] = fa[k]; });
    Object.keys(colors).forEach(function (k) { out.colors[k] = colors[k]; });
    return out;
  }

  function mergeIconLookups(primary, fallback) {
    var out = { urls: {}, fa: {}, colors: {} };
    var a = fallback || { urls: {}, fa: {}, colors: {} };
    var b = primary || { urls: {}, fa: {}, colors: {} };
    Object.keys(a.urls || {}).forEach(function (k) { out.urls[k] = a.urls[k]; });
    Object.keys(a.fa || {}).forEach(function (k) { out.fa[k] = a.fa[k]; });
    Object.keys(a.colors || {}).forEach(function (k) { out.colors[k] = a.colors[k]; });
    Object.keys(b.urls || {}).forEach(function (k2) { out.urls[k2] = b.urls[k2]; });
    Object.keys(b.fa || {}).forEach(function (k3) { out.fa[k3] = b.fa[k3]; });
    Object.keys(b.colors || {}).forEach(function (k4) { out.colors[k4] = b.colors[k4]; });
    return out;
  }

  // Enrich nodes with _iconUrl (SVG) or _iconFa (FA class name for content.js to resolve)
  async function enrichNodesWithIcons(nodes, forceRefreshMaps, preferredLookup) {
    if (!Array.isArray(nodes) || nodes.length === 0) return;

    var maps = await getGlobalIconMaps(!!forceRefreshMaps);
    maps = mergeIconLookups(maps, preferredLookup || _persistedProbeIconLookup);
    var domIcons = scrapeCanvasIcons();
    var svgCount = 0, faCount = 0;
    var registryResolved = 0, fallbackResolved = 0;

    for (var j = 0; j < nodes.length; j++) {
      var type = nodes[j].type;
      if (!type) continue;

      var url = maps.urls[type] || null;
      var registryFa = maps.fa[type] || null;
      var registryColor = maps.colors[type] || null;
      if (registryColor) nodes[j]._iconColor = registryColor;
      console.log(LOG, '[icon-debug] node:', nodes[j].name || '(unnamed)', '| type:', type, '| registry map:', {
        url: url,
        fa: registryFa,
        color: registryColor
      });
      if (url) {
        nodes[j]._iconUrl = url;
        svgCount++;
        registryResolved++;
        console.log(LOG, '[icon-debug] resolved from registry URL:', type, '->', url, '| success');
        continue;
      }

      var faName = registryFa;
      if (faName) {
        nodes[j]._iconFa = faName;
        faCount++;
        registryResolved++;
        console.log(LOG, '[icon-debug] resolved from registry FA:', type, '->', faName, '| success (CDN step in content script)');
        continue;
      }

      var resolved = await resolveIconDetailsForType(type);
      console.log(LOG, '[icon-debug] fallback lookup result for', type, ':', resolved);
      if (resolved && resolved.color && !nodes[j]._iconColor) {
        nodes[j]._iconColor = resolved.color;
      }
      if (resolved && resolved.url) {
        nodes[j]._iconUrl = resolved.url;
        svgCount++;
        fallbackResolved++;
        console.log(LOG, '[icon-debug] resolved from fallback URL:', type, '->', resolved.url, '| success');
        continue;
      }
      if (resolved && resolved.fa) {
        nodes[j]._iconFa = resolved.fa;
        faCount++;
        fallbackResolved++;
        console.log(LOG, '[icon-debug] resolved from fallback FA:', type, '->', resolved.fa, '| success (CDN step in content script)');
        continue;
      }

      var domUrl = domIcons[type] || null;
      if (domUrl) {
        nodes[j]._iconUrl = domUrl;
        svgCount++;
        fallbackResolved++;
        console.log(LOG, '[icon-debug] resolved from DOM scrape:', type, '->', domUrl, '| success');
      } else {
        console.log(LOG, '[icon-debug] no icon resolved for', type, '| will fall back to emoji glyph');
      }
    }

    console.log(
      LOG,
      'Icon enrichment:',
      nodes.length,
      'nodes,',
      svgCount,
      'SVG +',
      faCount,
      'FA =',
      (svgCount + faCount),
      'total | via registry map:',
      registryResolved,
      '| via fallback:',
      fallbackResolved
    );
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
        await enrichNodesWithIcons(helperResult.payload.nodes, true, _persistedProbeIconLookup);
        var helperIconMaps = await getGlobalIconMaps(false);
        diagnostics.authMode = helperResult.diagnostics.authMode;
        diagnostics.endpointUsed = helperResult.diagnostics.endpointUsed;
        diagnostics.status = helperResult.diagnostics.status;
        window.postMessage({
          type: 'n8n-subflow-fetch-result',
          reqId: reqId,
          payload: helperResult.payload,
          diagnostics: diagnostics,
          iconLookup: cloneIconLookupForMessage(helperIconMaps)
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
          if (data && Array.isArray(data.nodes)) await enrichNodesWithIcons(data.nodes, true, _persistedProbeIconLookup);
          var fetchIconMaps = await getGlobalIconMaps(false);
          if (src.usesCapturedHeaders) {
            authCapture.clearCapturedHeaders();
          }
          diagnostics.status = 200;
          window.postMessage({
            type: 'n8n-subflow-fetch-result',
            reqId: reqId,
            payload: data,
            diagnostics: diagnostics,
            iconLookup: cloneIconLookupForMessage(fetchIconMaps)
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
