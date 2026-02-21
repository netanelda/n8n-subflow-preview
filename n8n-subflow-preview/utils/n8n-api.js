// Fetches workflow data from n8n.
// Strategy:
//   1. Try /rest/workflows/{id} directly from content script (session cookies — n8n Cloud)
//   2. If that fails, fall back to background service worker using /api/v1/ + API key (self-hosted)

const N8nApi = (() => {
  const LOG = '[n8n SubFlow Preview API]';

  async function fetchWorkflow(workflowId) {
    // Primary: /rest/ endpoint with session cookies (works on n8n Cloud)
    const restResult = await tryRestEndpoint(workflowId);
    if (restResult) return restResult;

    // Fallback: background worker with /api/v1/ + API key (self-hosted instances)
    console.log(`${LOG} /rest/ failed, trying /api/v1/ via background worker...`);
    return tryBackgroundWorker(workflowId);
  }

  // Alias — same logic for both current and sub-workflow fetches
  const fetchCurrentWorkflow = fetchWorkflow;

  async function tryRestEndpoint(workflowId) {
    const baseUrl = `${window.location.origin}/rest/workflows/${workflowId}`;
    console.log(`${LOG} Trying: ${baseUrl} (session cookies)`);

    try {
      const res = await fetch(baseUrl, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });

      console.log(`${LOG} /rest/ response: ${res.status}`);

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.warn(`${LOG} /rest/ auth failed (${res.status}) — will try API key fallback`);
          return null; // trigger fallback
        }
        if (res.status === 404) {
          return { error: 'not_found', message: `Workflow ${workflowId} not found.` };
        }
        return null; // unknown error, try fallback
      }

      const json = await res.json();
      // n8n Cloud wraps response in { data: {...} }, self-hosted may not
      const data = json.data || json;
      console.log(`${LOG} /rest/ success — "${data.name}" (${data.nodes?.length} nodes)`);
      return { data };
    } catch (err) {
      console.warn(`${LOG} /rest/ fetch error:`, err.message);
      return null; // network error, try fallback
    }
  }

  function tryBackgroundWorker(workflowId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: 'fetchWorkflow', workflowId },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(`${LOG} Background worker error:`, chrome.runtime.lastError.message);
            resolve({ error: 'bg_error', message: chrome.runtime.lastError.message });
            return;
          }
          resolve(response);
        }
      );
    });
  }

  return { fetchWorkflow, fetchCurrentWorkflow };
})();
