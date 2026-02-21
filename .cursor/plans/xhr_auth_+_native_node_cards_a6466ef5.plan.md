---
name: XHR auth + native node cards
overview: Fix the persistent 401 auth failure by intercepting XMLHttpRequest (n8n uses Axios/XHR, not fetch) and by calling the store's getWorkflowFromUrl method, then rebuild node visuals to match n8n's native square card + centered icon + name-below layout.
todos:
  - id: xhr-intercept
    content: In page-probe.js, add XMLHttpRequest interception (wrap open + setRequestHeader) to capture auth headers from n8n's Axios-based API calls.
    status: completed
  - id: store-getWorkflowFromUrl
    content: In page-probe.js tryInPageApiHelper, add getWorkflowFromUrl(url) as the first method to try, using the sub-workflow's full REST URL.
    status: completed
  - id: native-card-renderer
    content: "Rewrite preview-renderer.js node layout: vertical square card (72x64) with centered icon circle, node name below card, adjusted connection endpoints."
    status: completed
  - id: native-card-css
    content: "Update content.css: square card with centered icon, name-below layout, matching n8n's native node appearance in both light/dark themes."
    status: completed
  - id: render-dimensions
    content: Update content.js showInlineWorkflow render options to use new card dimensions (72x82 total).
    status: completed
isProject: false
---

# Fix 401 Auth (XHR interception) + Native-Style Node Cards

## Problem 1: Auth still returns 401 even with captured headers

**Root cause identified from console output**: n8n uses **Axios with XMLHttpRequest adapter**, NOT the Fetch API. The stack trace from earlier sessions confirms this:

```
dispatchXhrRequest @ _baseOrderBy-B5lXBmMF.js:1773
xhr @ _baseOrderBy-B5lXBmMF.js:1683
makeRestApiRequest @ _baseOrderBy-B5lXBmMF.js:2567
```

The current `window.fetch` interceptor captures nothing useful because n8n's internal API calls go through `XMLHttpRequest`. The "captured" headers are empty or from Sentry/telemetry calls, not from authenticated n8n API calls.

**Additionally**, the console now shows the actual store methods available. `getWorkflowFromUrl` is present and is the correct way to fetch a workflow using n8n's own authenticated HTTP pipeline.

### Fix in [page-probe.js](n8n-subflow-preview/content/page-probe.js):

**A) Add XHR header interception** alongside the existing fetch interception. Wrap `XMLHttpRequest.prototype.open` and `XMLHttpRequest.prototype.setRequestHeader` to capture headers from n8n's Axios calls to `/rest/` endpoints.

**B) Add `getWorkflowFromUrl` to `tryInPageApiHelper`**. The current method name list (`fetchWorkflow`, `getWorkflow`, etc.) doesn't match any real method. The console output reveals the actual method is `getWorkflowFromUrl`. Add it with the sub-workflow URL as argument.

**C) Use `_originalFetch` with XHR-captured headers** as the next fallback, since those will contain the real auth (e.g. cookie + CSRF token from Axios interceptors).

Strategy chain becomes:

1. `workflowsStore.getWorkflowFromUrl(subWorkflowUrl)` -- uses n8n's own auth pipeline
2. `_originalFetch` with XHR-captured headers -- replays exact auth
3. `_originalFetch` with discovered headers -- last resort

## Problem 2: Node visuals don't resemble n8n native nodes

Looking at the user's screenshot, actual n8n nodes on the canvas are:

- **Square white cards** (roughly 75x75px) with subtle border + shadow
- **Large centered icon** in the card (service-specific: globe, sheets icon, diamond, etc.)
- **Node name** displayed BELOW the card in small text
- **Small connector dots** on left/right edges

Current rendering uses horizontal bars (152x40) with tiny colored squares + inline text. This layout is fundamentally different.

### Fix in [preview-renderer.js](n8n-subflow-preview/content/preview-renderer.js):

Switch node layout from horizontal bars to **vertical cards matching n8n's native style**:

- Node card: 72x64px, white, rounded corners (10px), subtle border + shadow
- Icon area: centered 32x32 colored circle with a large glyph/emoji
- Node name: rendered BELOW the card as separate text (12px, max-width truncated)
- Connection endpoints adjusted to card center-left and center-right

### Fix in [content.css](n8n-subflow-preview/content/content.css):

Replace `.n8n-sf-html-node` styles:

- From horizontal flexbox to vertical centered layout
- Card body becomes a square with the icon centered inside
- Name becomes a separate element below
- Adjust dark mode accordingly

### Fix in [content.js](n8n-subflow-preview/content/content.js):

Update the `showInlineWorkflow` render options to use new node dimensions (72x64 card + 18px name below = ~82px total height).

## Files to change

- [page-probe.js](n8n-subflow-preview/content/page-probe.js) -- XHR interception + getWorkflowFromUrl
- [preview-renderer.js](n8n-subflow-preview/content/preview-renderer.js) -- vertical card layout
- [content.css](n8n-subflow-preview/content/content.css) -- native-style node CSS
- [content.js](n8n-subflow-preview/content/content.js) -- render dimensions

