// Simple in-memory + chrome.storage caching layer.
// TTL defaults to 5 minutes. Used by content script to avoid repeated API calls.

const WorkflowCache = (() => {
  const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const mem = new Map(); // fast in-memory first-level cache

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
    const entry = { data, fetchedAt: Date.now() };
    mem.set(workflowId, entry);
    const key = `workflow_cache_${workflowId}`;
    await chrome.storage.local.set({ [key]: entry });
  }

  return { get, set };
})();
