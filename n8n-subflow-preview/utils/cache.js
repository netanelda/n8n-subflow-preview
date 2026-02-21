// Simple in-memory + chrome.storage caching layer.
// TTL defaults to 5 minutes. Used by content script to avoid repeated API calls.

const WorkflowCache = (() => {
  const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const mem = new Map(); // fast in-memory first-level cache
  const SENSITIVE_PARAM_KEYS = new Set([
    'apikey',
    'password',
    'token',
    'secret',
    'credentials',
    'authentication',
    'privatekey',
    'passphrase',
    'accesstoken',
    'refreshtoken',
    'clientsecret'
  ]);

  async function get(workflowId) {
    // Check memory first
    if (mem.has(workflowId)) {
      const entry = mem.get(workflowId);
      if (Date.now() - entry.fetchedAt < DEFAULT_TTL_MS) return entry.data;
      mem.delete(workflowId);
    }

    // Fall back to chrome.storage
    const key = `workflow_cache_${workflowId}`;
    const stored = await chrome.storage.local.get(key);
    if (stored[key]) {
      const entry = stored[key];
      if (Date.now() - entry.fetchedAt < DEFAULT_TTL_MS) {
        mem.set(workflowId, entry); // promote to memory
        return entry.data;
      }
      chrome.storage.local.remove(key); // expired
    }

    return null;
  }

  async function set(workflowId, data) {
    const sanitized = sanitizeWorkflowData(data);
    if (!sanitized) return;
    const entry = { data: sanitized, fetchedAt: Date.now() };
    mem.set(workflowId, entry);
    const key = `workflow_cache_${workflowId}`;
    await chrome.storage.local.set({ [key]: entry });
  }

  function sanitizeWorkflowData(data) {
    const cloned = deepClone(data);
    if (!cloned || !Array.isArray(cloned.nodes)) return cloned;

    cloned.nodes = cloned.nodes.map((node) => {
      if (!node || typeof node !== 'object') return node;
      const nextNode = { ...node };
      if (nextNode.parameters && typeof nextNode.parameters === 'object') {
        // Remove secret-like parameter keys before persisting to cache.
        nextNode.parameters = stripSensitiveKeys(nextNode.parameters);
      }
      return nextNode;
    });
    return cloned;
  }

  function deepClone(value) {
    try {
      if (typeof structuredClone === 'function') return structuredClone(value);
      return JSON.parse(JSON.stringify(value));
    } catch (_err) {
      // If cloning fails, skip caching to avoid storing raw sensitive data.
      return null;
    }
  }

  function stripSensitiveKeys(value) {
    if (Array.isArray(value)) {
      return value.map(stripSensitiveKeys);
    }
    if (!value || typeof value !== 'object') {
      return value;
    }

    const out = {};
    Object.keys(value).forEach((key) => {
      const normalized = key.toLowerCase();
      if (SENSITIVE_PARAM_KEYS.has(normalized)) return;
      out[key] = stripSensitiveKeys(value[key]);
    });
    return out;
  }

  return { get, set };
})();
