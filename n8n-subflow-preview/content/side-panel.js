// Chunk 3 side panel (right drawer) for expanded sub-workflow view.

const SidePanel = (() => {
  let panelEl = null;
  let escHandlerBound = false;

  function ensurePanel() {
    if (panelEl) return;

    panelEl = document.createElement('aside');
    panelEl.className = 'n8n-sf-side-panel';
    panelEl.innerHTML = `
      <div class="n8n-sf-sp-header">
        <h2 class="n8n-sf-sp-title">Sub-workflow</h2>
        <button class="n8n-sf-sp-close" aria-label="Close">×</button>
      </div>
      <div class="n8n-sf-sp-body"></div>
    `;
    document.body.appendChild(panelEl);

    panelEl.querySelector('.n8n-sf-sp-close').addEventListener('click', close);
  }

  function open(workflowData, workflowId, theme) {
    ensurePanel();
    const resolvedTheme = theme || ThemeDetector.detect() || 'dark';
    panelEl.classList.remove('theme-light', 'theme-dark');
    panelEl.classList.add('theme-' + resolvedTheme);

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
