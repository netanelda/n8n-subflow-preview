// Chunk 3 side panel (right drawer) for expanded sub-workflow view.

const SidePanel = (() => {
  const WIDTH_STORAGE_KEY = 'n8n_subflow_side_panel_width';
  const DEFAULT_PANEL_WIDTH = 800;
  const MIN_PANEL_WIDTH = 320;
  const MAX_PANEL_WIDTH_RATIO = 0.8;

  let panelEl = null;
  let escHandlerBound = false;
  let viewportResizeBound = false;
  let panelWidth = DEFAULT_PANEL_WIDTH;
  let panelWidthLoaded = false;

  function ensurePanel() {
    if (panelEl) return;

    panelEl = document.createElement('aside');
    panelEl.className = 'n8n-sf-side-panel';
    panelEl.innerHTML = `
      <div class="n8n-sf-sp-resize-handle" aria-hidden="true"><span>◂▸</span></div>
      <div class="n8n-sf-sp-header">
        <h2 class="n8n-sf-sp-title">Sub-workflow</h2>
        <div class="n8n-sf-sp-header-actions">
          <span class="n8n-sf-sp-esc-hint">Press Esc to close</span>
          <button class="n8n-sf-sp-close" aria-label="Close">×</button>
        </div>
      </div>
      <div class="n8n-sf-sp-body"></div>
    `;
    document.body.appendChild(panelEl);

    panelEl.querySelector('.n8n-sf-sp-close').addEventListener('click', close);
    bindResizeHandle();
    restoreSavedWidth();
    if (!viewportResizeBound) {
      viewportResizeBound = true;
      window.addEventListener('resize', () => {
        if (!panelEl) return;
        applyPanelWidth(panelWidth, false);
      });
    }
  }

  function open(workflowData, workflowId, theme) {
    ensurePanel();
    const resolvedTheme = theme || ThemeDetector.detect() || 'dark';
    panelEl.classList.remove('theme-light', 'theme-dark');
    panelEl.classList.add('theme-' + resolvedTheme);
    applyPanelWidth(panelWidth, false);

    const body = panelEl.querySelector('.n8n-sf-sp-body');
    const name = workflowData?.name || 'Sub-workflow';
    const description = escapeHtml(workflowData?.description || '');
    const nodesRaw = Array.isArray(workflowData?.nodes) ? workflowData.nodes : [];
    // Sort nodes left-to-right, top-to-bottom by canvas position (matches flow order)
    const nodes = [...nodesRaw].sort((a, b) => {
      const ax = Array.isArray(a.position) ? Number(a.position[0]) || 0 : 0;
      const ay = Array.isArray(a.position) ? Number(a.position[1]) || 0 : 0;
      const bx = Array.isArray(b.position) ? Number(b.position[0]) || 0 : 0;
      const by = Array.isArray(b.position) ? Number(b.position[1]) || 0 : 0;
      if (ax !== bx) return ax - bx;
      return ay - by;
    });
    const openUrl = `${window.location.origin}/workflow/${encodeURIComponent(workflowId || '')}`;

    body.innerHTML = `
      ${description ? `<p class="n8n-sf-sp-description">${description}</p>` : ''}
      <div class="n8n-sf-sp-map" role="region" aria-label="Workflow diagram"></div>
      <h3 class="n8n-sf-sp-subtitle">Nodes (${nodes.length})</h3>
      <ul class="n8n-sf-sp-list">
        ${nodes.map((node) => `<li>${escapeHtml(node.name)} <span>${escapeHtml(node.type)}</span></li>`).join('')}
      </ul>
      <a class="n8n-sf-sp-open-btn" href="${openUrl}" target="_blank" rel="noopener noreferrer">Open Full Workflow</a>
    `;

    panelEl.querySelector('.n8n-sf-sp-title').textContent = name;
    const mapContainer = body.querySelector('.n8n-sf-sp-map');
    PreviewRenderer.render(workflowData, mapContainer, { theme: resolvedTheme, size: 'large' });
    setupMapScrollAndPan(mapContainer);

    panelEl.classList.add('visible');
    bindEscHandler();
  }

  function close() {
    if (!panelEl) return;
    panelEl.classList.remove('visible');
  }

  // Horizontal scroll + drag-to-pan for the flow diagram in the side panel
  function setupMapScrollAndPan(container) {
    if (!container) return;
    let startX = 0;
    let startScrollLeft = 0;

    const onMove = (e) => {
      container.scrollLeft = startScrollLeft + startX - e.clientX;
    };
    const onUp = () => {
      container.classList.remove('n8n-sf-sp-map-grabbing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    container.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      startX = e.clientX;
      startScrollLeft = container.scrollLeft;
      container.classList.add('n8n-sf-sp-map-grabbing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    container.addEventListener('mouseleave', () => {
      if (container.classList.contains('n8n-sf-sp-map-grabbing')) onUp();
    });
  }

  function clampPanelWidth(value) {
    const maxWidth = Math.max(MIN_PANEL_WIDTH, Math.floor(window.innerWidth * MAX_PANEL_WIDTH_RATIO));
    return Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, Math.round(value || DEFAULT_PANEL_WIDTH)));
  }

  function applyPanelWidth(width, persist) {
    if (!panelEl) return;
    panelWidth = clampPanelWidth(width);
    panelEl.style.width = panelWidth + 'px';
    if (persist) {
      try {
        chrome.storage.local.set({ [WIDTH_STORAGE_KEY]: panelWidth });
      } catch (_err) {
        // Ignore storage edge cases.
      }
    }
  }

  function restoreSavedWidth() {
    if (panelWidthLoaded) return;
    panelWidthLoaded = true;
    try {
      chrome.storage.local.get([WIDTH_STORAGE_KEY], (data) => {
        const saved = Number(data && data[WIDTH_STORAGE_KEY]);
        if (Number.isFinite(saved) && saved > 0) {
          panelWidth = saved;
        }
        applyPanelWidth(panelWidth, false);
      });
    } catch (_err) {
      applyPanelWidth(panelWidth, false);
    }
  }

  function bindResizeHandle() {
    if (!panelEl) return;
    const handle = panelEl.querySelector('.n8n-sf-sp-resize-handle');
    if (!handle) return;

    let startX = 0;
    let startWidth = 0;
    let dragging = false;

    const onMove = (event) => {
      if (!dragging) return;
      const delta = startX - event.clientX;
      applyPanelWidth(startWidth + delta, false);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      panelEl.classList.remove('is-resizing');
      document.body.classList.remove('n8n-sf-panel-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      applyPanelWidth(panelWidth, true);
    };

    handle.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      dragging = true;
      startX = event.clientX;
      startWidth = panelEl.getBoundingClientRect().width || panelWidth;
      panelEl.classList.add('is-resizing');
      document.body.classList.add('n8n-sf-panel-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      event.preventDefault();
    });
  }

  function bindEscHandler() {
    if (escHandlerBound) return;
    escHandlerBound = true;
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
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

  return { open, close };
})();
