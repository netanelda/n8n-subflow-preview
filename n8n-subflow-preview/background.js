// Background service worker — fallback API relay for self-hosted n8n instances.
// Uses /api/v1/ endpoint with X-N8N-API-KEY header.
// Primary fetching happens in the content script via /rest/ + session cookies.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'fetchWorkflow') {
    handleFetchWorkflow(msg.workflowId).then(sendResponse);
    return true;
  }
});

async function handleFetchWorkflow(workflowId) {
  try {
    const stored = await chrome.storage.local.get(['n8nUrl', 'apiKey']);
    const n8nUrl = stored.n8nUrl;
    const apiKey = stored.apiKey;

    console.log(`[BG] n8nUrl: "${n8nUrl || '(empty)'}", apiKey present: ${!!apiKey}`);

    if (!n8nUrl || !apiKey) {
      return { error: 'missing_config', message: 'n8n URL or API key not configured. Open extension settings.' };
    }

    const url = `${n8nUrl}/api/v1/workflows/${workflowId}`;
    console.log(`[BG] Fetching: ${url}`);

    const res = await fetch(url, {
      headers: { 'X-N8N-API-KEY': apiKey, 'Accept': 'application/json' }
    });

    console.log(`[BG] Response: ${res.status} ${res.statusText}`);

    if (!res.ok) {
      const body = await res.text();
      console.warn(`[BG] Error body:`, body);
      if (res.status === 404) return { error: 'not_found', message: `Workflow ${workflowId} not found.` };
      return { error: 'api_error', message: `n8n API returned ${res.status}: ${body}` };
    }

    const data = await res.json();
    console.log(`[BG] Success — "${data.name}" (${data.nodes?.length} nodes)`);
    return { data };
  } catch (err) {
    console.error(`[BG] Fetch error:`, err);
    return { error: 'network_error', message: err.message };
  }
}
