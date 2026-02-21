# n8n Sub-Workflow Preview — Chrome Extension PRD

## 1. Overview

### Problem
In n8n, workflows frequently call other workflows via the **"Execute Workflow"** node (sometimes called "Execute Sub-Workflow"). Currently, the only way to see what that sub-workflow contains is to click "Open Sub-Workflow" which opens it in a new browser tab. This breaks your visual flow, forces context-switching, and makes it hard to understand the full picture of a complex automation.

### Solution
A **Google Chrome Extension** called **n8n SubFlow Preview** that provides an inline visual preview of any referenced sub-workflow — directly on the n8n canvas — without leaving the current workflow.

### Target User
Non-technical n8n power users and automation builders who work with multi-workflow architectures and want faster navigation and better visibility into their automation systems.

---

## 2. Product Requirements

### 2.1 Core Feature: Hover Preview
- When the user **hovers** over an "Execute Workflow" node on the n8n canvas, a **floating preview panel** appears after a short delay (~400ms).
- The preview panel shows:
  - **Sub-workflow name** (as a header)
  - **Visual mini-map** of the sub-workflow: a simplified node-and-connection diagram rendered on a small canvas
  - **Node count** and **trigger type** as metadata badges
  - **"Open in New Tab"** link (preserving existing behavior)
- The preview panel **disappears** when the mouse leaves the node and the panel area.
- The panel should have a subtle animation (fade-in) and a clean, modern look that matches n8n's dark/light theme.

### 2.2 Enhanced Feature: Click-to-Peek Side Panel
- Clicking the preview panel (or a dedicated "Expand" icon on it) opens a **larger side panel** (right-side drawer, ~400px wide).
- The side panel shows:
  - A more detailed and zoomable rendering of the sub-workflow
  - A list of all nodes in that sub-workflow with their types
  - The sub-workflow's description (if one exists)
  - A prominent **"Open Full Workflow"** button
- The side panel can be closed with an X button or by pressing `Escape`.

### 2.3 Enhanced Feature: Visual Badge on Nodes
- Any "Execute Workflow" node on the canvas should get a small **overlay badge** (e.g., a layered-squares icon 🔗) indicating it links to a sub-workflow.
- This badge is always visible (not just on hover), making it instantly clear which nodes reference external workflows.

### 2.4 Enhanced Feature: Breadcrumb Navigation (Stretch Goal)
- If the user navigates into a sub-workflow (opens it), the extension shows a **breadcrumb bar** at the top of the n8n editor:  
  `Parent Workflow → Sub-Workflow A → Current Workflow`
- Clicking any breadcrumb navigates back to that workflow.
- This helps users who go deep into nested workflow chains.

### 2.5 Settings / Options Page
- A simple settings popup accessible from the extension icon in Chrome toolbar:
  - **n8n Instance URL**: The base URL of their n8n instance (e.g., `https://n8n.mycompany.com` or `http://localhost:5678`)
  - **API Key**: The user's n8n API key (stored securely in `chrome.storage.local`, never transmitted anywhere except to the user's own n8n instance)
  - **Preview delay**: Slider for hover delay (200ms–1000ms, default 400ms)
  - **Theme**: Auto-detect / Light / Dark
  - **Enable/disable** individual features (hover preview, badges, breadcrumbs)

---

## 3. Technical Architecture

### 3.1 Technology Stack

| Component | Technology | Notes |
|---|---|---|
| Extension manifest | **Manifest V3** | Required for modern Chrome extensions |
| Content Script | **Vanilla JavaScript + CSS** | Injected into n8n pages to interact with the DOM |
| Popup / Settings UI | **HTML + CSS + JS** | Simple options page, no framework needed |
| Mini-map Rendering | **HTML5 Canvas** or **SVG** | For drawing the sub-workflow node diagram |
| API Communication | **Fetch API** via background service worker | To call n8n's REST API securely |
| Storage | **chrome.storage.local** | For API key, settings, and workflow cache |

### 3.2 Chrome Extension File Structure

```
n8n-subflow-preview/
├── manifest.json              # Extension manifest (V3)
├── background.js              # Service worker — handles API calls to n8n
├── content/
│   ├── content.js             # Main content script — DOM observation + UI injection
│   ├── content.css            # Styles for preview panel, badges, breadcrumbs
│   ├── preview-renderer.js    # Draws the mini-map (Canvas/SVG rendering logic)
│   └── side-panel.js          # Side panel drawer logic
├── popup/
│   ├── popup.html             # Extension popup (settings)
│   ├── popup.css              # Popup styles
│   └── popup.js               # Popup logic (save/load settings)
├── utils/
│   ├── n8n-api.js             # n8n API helper functions
│   ├── cache.js               # Simple caching layer for fetched workflows
│   └── theme.js               # Theme detection and application
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── README.md
```

### 3.3 manifest.json Specification

```json
{
  "manifest_version": 3,
  "name": "n8n SubFlow Preview",
  "version": "1.0.0",
  "description": "Preview sub-workflows inline on the n8n canvas without opening new tabs.",
  "permissions": [
    "storage",
    "activeTab"
  ],
  "host_permissions": [
    "http://localhost:5678/*",
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/content.js", "content/preview-renderer.js", "content/side-panel.js"],
      "css": ["content/content.css"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

**Important note on `host_permissions`**: Using `<all_urls>` is a broad permission. This is acceptable for personal/internal use. If this were ever published to the Chrome Web Store, this should be narrowed to just the user's n8n domain. For personal use, this is fine and necessary because n8n can run on any domain.

### 3.4 How the Extension Detects "Execute Workflow" Nodes

n8n's workflow editor renders nodes on an HTML canvas area. The extension's content script needs to:

1. **Wait for the n8n editor to load** — use a `MutationObserver` to watch for the workflow canvas to appear in the DOM.

2. **Identify the correct node type** — This is critical. n8n has TWO similarly named nodes:

   | Node | Internal Type | Purpose | Target? |
   |---|---|---|---|
   | **Execute Workflow** | `n8n-nodes-base.executeWorkflow` | Placed in a workflow to **call** another workflow | ✅ YES — this is the one we preview |
   | **Execute Workflow Trigger** | `n8n-nodes-base.executeWorkflowTrigger` | Sits at the **start** of a sub-workflow, indicating it can be called | ❌ NO — ignore this completely |

   The extension must **ONLY** target `n8n-nodes-base.executeWorkflow` (the caller node) and **NEVER** target `n8n-nodes-base.executeWorkflowTrigger` (the trigger/receiver node). These are completely different nodes with different purposes. The trigger node does not reference another workflow — it IS the entry point of the current workflow.

   **Detection strategy (try in order):**
   ```
   a) Look for DOM elements with [data-test-id="canvas-node"] whose node type 
      is exactly "n8n-nodes-base.executeWorkflow" (NOT executeWorkflowTrigger)
   b) If node type isn't in the DOM attributes, check the displayed title — but 
      ONLY match "Execute Workflow" when it does NOT also contain "Trigger"
   c) As a final validation, fetch the current workflow JSON from the API and 
      cross-reference: only nodes with type "n8n-nodes-base.executeWorkflow" 
      in the workflow JSON should get the preview treatment
   ```
   
   **Fallback validation**: Even if DOM detection suggests a node is an Execute Workflow node, always cross-check against the workflow JSON from the API. The JSON is the source of truth — each node has an explicit `"type"` field. Only proceed if `node.type === "n8n-nodes-base.executeWorkflow"`.

3. **Extract the sub-workflow ID** — When hovering over such a node, the extension needs the workflow ID that the node references. This can be found by:
   - Inspecting the node's parameters in n8n's internal Vue state (accessible via `__vue__` on DOM elements)
   - OR intercepting/reading the workflow JSON that n8n loads (the extension can read the page's network requests or access n8n's internal store)
   - OR reading the workflow data from the n8n REST API for the *current* workflow, then finding the relevant node's parameters

   **Recommended approach**: Fetch the current workflow's JSON from the n8n API (`GET /api/v1/workflows/{currentWorkflowId}`), find the Execute Workflow node's parameters, and extract the `workflowId` field from its parameters.

4. **Get the current workflow ID** — Extract from the URL. n8n URLs follow the pattern: `https://your-instance.com/workflow/{workflowId}`.

### 3.5 API Communication Flow

All API calls go through the **background service worker** (background.js) to keep the API key secure and avoid CORS issues.

```
[Content Script]                    [Background Service Worker]           [n8n API]
     |                                        |                              |
     |-- chrome.runtime.sendMessage() ------->|                              |
     |   { action: "fetchWorkflow",           |                              |
     |     workflowId: "abc123" }             |                              |
     |                                        |-- fetch() ------------------>|
     |                                        |   GET /api/v1/workflows/abc  |
     |                                        |   Headers: X-N8N-API-KEY     |
     |                                        |                              |
     |                                        |<-- workflow JSON ------------|
     |<-- response (workflow data) -----------|                              |
     |                                        |                              |
     |--> Render mini-map preview             |                              |
```

### 3.6 n8n REST API Endpoints Used

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/workflows` | GET | List all workflows (for breadcrumb/search features) |
| `/api/v1/workflows/{id}` | GET | Fetch a specific workflow's full JSON (nodes + connections) |

**API Key**: Set via the `X-N8N-API-KEY` header. The user generates this in n8n under Settings → API → Create API Key.

**Response structure** (simplified) for `GET /api/v1/workflows/{id}`:
```json
{
  "id": "abc123",
  "name": "My Sub-Workflow",
  "active": true,
  "nodes": [
    {
      "id": "node-uuid",
      "name": "Start",
      "type": "n8n-nodes-base.start",
      "position": [250, 300],
      "parameters": {}
    },
    {
      "id": "node-uuid-2",
      "name": "HTTP Request",
      "type": "n8n-nodes-base.httpRequest",
      "position": [500, 300],
      "parameters": { ... }
    }
  ],
  "connections": {
    "Start": {
      "main": [[{ "node": "HTTP Request", "type": "main", "index": 0 }]]
    }
  }
}
```

### 3.7 Mini-Map Rendering Logic (preview-renderer.js)

The renderer takes a workflow's `nodes` and `connections` arrays and draws a simplified visual:

1. **Calculate bounding box** of all node positions.
2. **Scale** all positions to fit within the preview panel dimensions (e.g., 350×200px).
3. **Draw each node** as a small rounded rectangle with:
   - A color based on its node type category (trigger = green, action = blue, logic = orange, etc.)
   - The node name truncated to fit
4. **Draw connections** as curved lines (quadratic bezier) between nodes.
5. **Optionally** highlight the trigger/start node differently.

Use **SVG** rather than Canvas for this — SVG is easier to style, theme, and make interactive (hover states on individual nodes, etc.).

### 3.8 Caching Strategy

To avoid hitting the n8n API on every hover:

- Cache fetched workflow data in `chrome.storage.local` with a key like `workflow_cache_{id}`.
- Each cache entry includes a `fetchedAt` timestamp.
- Cache TTL: **5 minutes** (configurable in settings).
- On hover, check cache first. If valid cache exists, use it. Otherwise, fetch from API.
- Show a subtle loading spinner in the preview while fetching.

### 3.9 Theme Detection

n8n supports light and dark themes. The extension should detect the active theme by:
- Checking the `<body>` element for a class like `theme-dark` or a `data-theme` attribute.
- Alternatively, reading the computed background color of the canvas area.
- Applying matching CSS custom properties to the preview panel.

---

## 4. Detailed UI/UX Specifications

### 4.1 Hover Preview Panel

```
┌─────────────────────────────────────────┐
│  📋 Send Slack Notification (workflow)  │  ← Sub-workflow name
│─────────────────────────────────────────│
│                                         │
│   [Trigger] ──→ [Format] ──→ [Slack]   │  ← Mini-map (simplified)
│                     │                   │
│                     └──→ [Log]          │
│                                         │
│─────────────────────────────────────────│
│  🔢 4 nodes  ⚡ Webhook Trigger  ✅ Active │  ← Metadata badges
│  🔗 Open Full Workflow    ⬜ Expand     │  ← Action links
└─────────────────────────────────────────┘
```

- **Size**: ~380px wide, height auto (max ~300px, scrollable if very large workflow)
- **Position**: Appears to the right of the hovered node (or left if near right edge)
- **Border**: 1px subtle border matching n8n's UI, with a small box-shadow
- **Border radius**: 8px
- **Background**: Matches n8n theme (white / dark gray)
- **Z-index**: Very high (99999) to float above all n8n UI elements

### 4.2 Visual Badge on Execute Workflow Nodes

- Small icon (16×16px) positioned at the **top-right corner** of the node
- Icon: A "layers" or "external link" style icon
- Subtle pulsing animation on first appearance to draw attention
- Semi-transparent background pill so it doesn't clash with the node's own design

### 4.3 Side Panel (Expanded View)

- Slides in from the **right edge** of the viewport
- Width: **420px**
- Full viewport height
- Contains:
  - Workflow name (large, bold)
  - Description (if any)
  - Larger, pannable mini-map
  - Node list with types and names
  - "Open Full Workflow" button (prominent)
  - Close button (X) at top-right

### 4.4 Breadcrumb Bar

- Fixed position at the **top of the n8n editor area**, just below n8n's own toolbar
- Height: ~36px
- Shows: `🏠 Main Workflow  ›  Sub-Workflow A  ›  Current`
- Each segment is clickable (navigates to that workflow)
- Only appears when the user has navigated into a sub-workflow (detected by tracking navigation history in the extension)

---

## 5. Security Considerations

### 5.1 API Key Storage
- The API key is stored in `chrome.storage.local` — this is sandboxed to the extension and not accessible by web pages or other extensions.
- The API key is **never** injected into the page DOM or exposed to content scripts directly. All API calls go through the background service worker.
- The API key is only sent to the user's own n8n instance URL (which they configure).

### 5.2 Content Script Safety
- The content script only runs on pages matching n8n URL patterns.
- All HTML injected into the page is sanitized — no raw HTML from API responses is inserted. Node names and workflow names are always text-escaped before rendering.
- No external scripts, tracking, or analytics are loaded.

### 5.3 Permissions
- `storage`: For saving settings and cache. Required.
- `activeTab`: For accessing the current tab's URL. Required.
- `host_permissions`: Needed to make API calls to the user's n8n instance. Uses `<all_urls>` because n8n can run on any domain. For personal use, this is acceptable.

---

## 6. Implementation Instructions for Cursor

### How to Use This PRD
Feed this entire document to Cursor (Opus 4.6) as context for all three prompts below. The PRD stays the same — only the instruction changes per chunk.

### Chunk 1 of 3 — Plumbing & Detection
**Prompt to Cursor**: *"Read the PRD. Implement Steps 1–2: scaffold the full file structure, manifest.json, popup settings page, background service worker, and content script with node detection. Do NOT build any UI preview panels yet — just get the extension loading, detecting the correct Execute Workflow nodes (NOT trigger nodes), and logging fetched sub-workflow data to the console."*

**What you test before moving on:**
- Load the extension in `chrome://extensions` (Developer Mode → Load Unpacked)
- Open your n8n instance and navigate to a workflow that has an Execute Workflow node
- Open browser DevTools console — you should see "n8n SubFlow Preview active"
- Hover over an Execute Workflow **caller** node → console should log the fetched sub-workflow JSON
- Hover over an Execute Workflow **Trigger** node → nothing should happen
- Open the extension popup → save your n8n URL and API key → verify it persists after closing

**If something is broken**, fix it with Cursor before moving to Chunk 2. The rest of the extension depends on this foundation.

---

### Chunk 2 of 3 — Core Visual Experience
**Prompt to Cursor**: *"Read the PRD. The extension scaffold from Chunk 1 is already built and working. Now implement Steps 3–4: the hover preview panel with SVG mini-map renderer, metadata badges, 'Open Full Workflow' link, show/hide with delay, visual badge overlays on Execute Workflow nodes, theme detection (light/dark), caching layer with 5-minute TTL, loading spinner, and all error states (no API key, workflow not found, connection error)."*

**What you test before moving on:**
- Hover over an Execute Workflow node → a styled preview panel appears after ~400ms
- The panel shows the sub-workflow name, a visual mini-map with colored nodes and connections, and metadata badges
- Moving mouse away dismisses the panel after ~200ms
- Moving mouse from the node into the panel keeps it open
- Execute Workflow nodes have a small visual badge icon on them (always visible)
- The panel matches your n8n theme (light or dark)
- Hover a second time quickly → data comes from cache (no network request in DevTools)
- If you haven't configured an API key → panel shows a helpful message
- If the sub-workflow was deleted → panel shows a friendly error

**After this chunk, you have a fully functional extension.** Chunk 3 is optional enhancements.

---

### Chunk 3 of 3 — Enhancements (Optional)
**Prompt to Cursor**: *"Read the PRD. The extension from Chunks 1–2 is fully working with hover previews, badges, caching, and theme support. Now implement Steps 5–6: the expandable side panel drawer (triggered by an 'Expand' button on the hover preview, with larger mini-map, node list, close on Escape) and the breadcrumb navigation bar (track workflow navigation, show breadcrumb trail, clickable segments)."*

**What you test:**
- Click "Expand" on the hover preview → side panel slides in from the right
- Side panel shows a larger workflow diagram and a list of nodes
- Press Escape or click X → side panel closes
- Navigate into a sub-workflow → breadcrumb bar appears at the top
- Click a breadcrumb segment → navigates back to that workflow

**You can skip this chunk entirely** if you're happy with the Chunk 2 result. The hover preview + badges are the real value.

---

## 7. Key Technical Gotchas & Tips for Cursor

### 7.1 Do NOT Confuse the Two "Execute Workflow" Nodes
This is the single most important thing to get right. `n8n-nodes-base.executeWorkflow` (the caller — we want this) and `n8n-nodes-base.executeWorkflowTrigger` (the trigger at the start of a sub-workflow — we do NOT want this) are completely different nodes. The trigger node does not contain a reference to another workflow. If the extension accidentally targets trigger nodes, it will either show errors or nonsensical data. Always validate against the workflow JSON's `node.type` field.

### 7.2 n8n DOM Structure is Not Stable
n8n's internal DOM structure can change between versions. The content script should be **defensive**:
- Use multiple fallback selectors
- Don't crash if an expected element isn't found — just log a warning and skip
- Wrap DOM queries in try/catch

### 7.3 n8n Uses a Canvas/Vue.js Rendering Layer
n8n v1.0+ uses a new canvas system. Nodes may be rendered inside a `<canvas>` element or using a library like `@vue-flow`. If nodes are rendered on an actual HTML5 `<canvas>` (not DOM elements), hover detection becomes harder. In that case:
- The extension may need to **overlay invisible hit-target divs** on top of the canvas at the positions of Execute Workflow nodes
- The positions can be calculated by fetching the current workflow's JSON and reading node positions, then transforming them based on the canvas's zoom and pan state
- This is more complex but still doable. Check the n8n source or inspect the DOM to determine the rendering approach before coding.

### 7.4 Content Security Policy (CSP)
Some n8n instances may have strict CSP headers. If the extension's injected CSS or JS is blocked by CSP:
- Use `chrome.scripting.insertCSS()` and `chrome.scripting.executeScript()` from the background worker instead of declaring in `manifest.json`
- These bypass page CSP because they run in the extension's context

### 7.5 API Key Scope
n8n API keys have full access to the instance. The extension only needs read access. There's currently no way to scope n8n API keys to read-only, so the user should be aware that the key stored in the extension can also make changes. This is fine for personal use.

### 7.6 Handling Workflow IDs vs Names
In n8n, the Execute Workflow node can reference a sub-workflow by **ID** or by **name** (expression). The extension should handle both:
- If the parameter is a static ID → fetch directly
- If the parameter is an expression (dynamic) → show a message like "Dynamic sub-workflow reference — preview not available" rather than erroring out

### 7.7 Performance
- Never block the n8n UI thread. All API calls are async.
- Use `requestAnimationFrame` for any DOM manipulation.
- Debounce hover events so rapid mouse movements don't trigger dozens of API calls.
- The SVG mini-map rendering should be fast enough for workflows up to ~50 nodes. For very large workflows (100+ nodes), simplify by only showing a summary.

---

## 8. Testing Checklist

Before considering each phase "done", verify:

- [ ] Extension loads without errors in `chrome://extensions`
- [ ] Settings page saves and loads API key + URL correctly
- [ ] Console shows "n8n SubFlow Preview active" on n8n workflow pages
- [ ] Execute Workflow **caller** nodes (`executeWorkflow`) are correctly detected
- [ ] Execute Workflow **Trigger** nodes (`executeWorkflowTrigger`) are completely IGNORED
- [ ] Hovering over an Execute Workflow caller node fetches the sub-workflow data
- [ ] Preview panel appears in the correct position
- [ ] Mini-map renders nodes and connections accurately
- [ ] Preview panel disappears when mouse leaves
- [ ] Theme (light/dark) is detected and applied correctly
- [ ] Cached data is used when available (check network tab)
- [ ] Error states display correctly (no API key, wrong URL, workflow not found)
- [ ] Extension doesn't break or slow down the n8n editor
- [ ] Side panel opens and closes correctly
- [ ] Breadcrumbs appear and navigate correctly

---

## 9. Future Ideas (Post-MVP)

- **Search sub-workflows**: A command palette (Ctrl+Shift+F) to search across all workflows and jump to any one
- **Inline editing**: Edit sub-workflow parameters directly from the preview panel
- **Workflow dependency graph**: A full-screen view showing all workflows and how they connect to each other
- **Export diagram**: Export the dependency graph as an image or PDF
- **Notifications**: Badge on the extension icon showing how many sub-workflow references exist in the current workflow
