// Renders an inline subflow map using HTML node cards + SVG connections.
// Cards match n8n's native style: square card with centered icon, name below.

const PreviewRenderer = (() => {
  const DEFAULT_WIDTH = 560;
  const DEFAULT_HEIGHT = 260;
  const DEFAULT_NODE_W = 72;
  const DEFAULT_NODE_H = 64;
  const DEFAULT_TOTAL_H = 96; // card (64) + up to two-line name label below
  const DEFAULT_PAD = 24;
  // Never squeeze below this scale so cards don't overlap in dense workflows
  const MIN_SCALE = 0.55;

  function render(workflowData, container, options = {}) {
    if (!container) return;
    container.innerHTML = '';

    let width = Number(options.width) || DEFAULT_WIDTH;
    let height = Number(options.height) || DEFAULT_HEIGHT;
    const nodeW = Number(options.nodeWidth) || DEFAULT_NODE_W;
    const nodeH = Number(options.nodeHeight) || DEFAULT_NODE_H;
    const totalH = Number(options.totalNodeHeight) || DEFAULT_TOTAL_H;
    const pad = Number(options.pad) || DEFAULT_PAD;
    const theme = String(options.theme || 'light');

    const nodes = Array.isArray(workflowData?.nodes) ? workflowData.nodes : [];
    if (nodes.length === 0) return;

    // Compute scale and possibly grow canvas so we never go below MIN_SCALE
    const { positioned, requiredWidth, requiredHeight } = mapNodePositions(nodes, {
      width, height, nodeW, totalH, pad
    });
    width = requiredWidth;
    height = requiredHeight;

    const wrapper = document.createElement('div');
    wrapper.className = `n8n-sf-map-wrap ${theme === 'dark' ? 'theme-dark' : 'theme-light'}`;
    wrapper.style.width = width + 'px';
    wrapper.style.height = height + 'px';
    wrapper.style.position = 'relative';
    wrapper.style.overflow = 'hidden';
    container.appendChild(wrapper);

    // SVG layer for connections (behind nodes)
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('class', 'n8n-sf-conn-layer');
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.pointerEvents = 'none';
    wrapper.appendChild(svg);

    // Connection endpoints hit the vertical center of the card (not the total height with name)
    drawConnections(svg, workflowData.connections || {}, positioned, { nodeW, nodeH });

    drawHtmlNodes(wrapper, nodes, positioned, { nodeW, nodeH });
  }

  function mapNodePositions(nodes, config) {
    const { width, height, nodeW, totalH, pad } = config;
    const raw = nodes.map((node) => ({
      name: node.name,
      x: Array.isArray(node.position) ? Number(node.position[0]) || 0 : 0,
      y: Array.isArray(node.position) ? Number(node.position[1]) || 0 : 0
    }));

    const xs = raw.map((p) => p.x);
    const ys = raw.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    let scale = Math.min(
      (width - pad * 2 - nodeW) / spanX,
      (height - pad * 2 - totalH) / spanY
    );
    scale = Math.max(scale, MIN_SCALE);

    const requiredWidth = Math.ceil(pad * 2 + spanX * scale + nodeW);
    const requiredHeight = Math.ceil(pad * 2 + spanY * scale + totalH);

    const out = new Map();
    raw.forEach((item) => {
      out.set(item.name, {
        x: pad + (item.x - minX) * scale,
        y: pad + (item.y - minY) * scale
      });
    });
    return { positioned: out, requiredWidth, requiredHeight };
  }

  function drawConnections(svg, connections, positioned, config) {
    const { nodeW, nodeH } = config;
    const svgNS = 'http://www.w3.org/2000/svg';

    function drawOneConnection(sourcePos, targetPos, verticalDown) {
      let sx, sy, tx, ty;
      if (verticalDown) {
        sx = sourcePos.x + nodeW / 2;
        sy = sourcePos.y + nodeH;
        tx = targetPos.x + nodeW / 2;
        ty = targetPos.y;
      } else {
        sx = sourcePos.x + nodeW;
        sy = sourcePos.y + nodeH / 2;
        tx = targetPos.x;
        ty = targetPos.y + nodeH / 2;
      }
      const delta = Math.max(20, Math.abs(tx - sx) * 0.4);
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', `M ${sx} ${sy} C ${sx + delta} ${sy}, ${tx - delta} ${ty}, ${tx} ${ty}`);
      path.setAttribute('class', 'n8n-sf-conn');
      svg.appendChild(path);
      [{ cx: sx, cy: sy }, { cx: tx, cy: ty }].forEach((pt) => {
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('cx', pt.cx);
        dot.setAttribute('cy', pt.cy);
        dot.setAttribute('r', '3');
        dot.setAttribute('class', 'n8n-sf-conn-dot');
        svg.appendChild(dot);
      });
    }

    Object.entries(connections || {}).forEach(([sourceName, sourceData]) => {
      const sourcePos = positioned.get(sourceName);
      if (!sourcePos || !sourceData || typeof sourceData !== 'object') return;

      Object.entries(sourceData).forEach(([connKey, channels]) => {
        if (!Array.isArray(channels)) return;
        channels.forEach((channel) => {
          if (!Array.isArray(channel)) return;
          channel.forEach((target) => {
            const targetNodeName = target && (target.node ?? target);
            if (!targetNodeName) return;
            const targetPos = positioned.get(targetNodeName);
            if (!targetPos) return;

            const isAiConnection = /^ai_/.test(connKey);
            const targetBelow = targetPos.y > sourcePos.y + nodeH * 0.3;
            const verticalDown = isAiConnection && targetBelow;

            drawOneConnection(sourcePos, targetPos, verticalDown);
          });
        });
      });
    });
  }

  function drawHtmlNodes(wrapper, nodes, positioned, config) {
    const { nodeW, nodeH } = config;

    nodes.forEach((node) => {
      const pos = positioned.get(node.name);
      if (!pos) return;

      const colorClass = getNodeColorClass(node.type);
      const glyph = getGlyph(node.type);

      // Outer wrapper positions the card + name as one unit
      const outer = document.createElement('div');
      outer.className = 'n8n-sf-node-outer';
      outer.style.left = pos.x + 'px';
      outer.style.top = pos.y + 'px';
      outer.style.width = nodeW + 'px';

      // Square card body
      const card = document.createElement('div');
      card.className = 'n8n-sf-html-node';
      card.style.width = nodeW + 'px';
      card.style.height = nodeH + 'px';

      // Centered icon inside the card — use real n8n icon if available, else emoji glyph
      const icon = document.createElement('div');
      const safeIconUrl = sanitizeIconUrl(node._iconUrl);
      const iconClass = colorClass;
      icon.className = `n8n-sf-html-icon ${iconClass}`;

      if (safeIconUrl) {
        const img = document.createElement('img');
        img.src = safeIconUrl;
        img.className = 'n8n-sf-html-icon-img';
        img.alt = '';
        img.onerror = function () {
          this.remove();
          icon.className = `n8n-sf-html-icon ${colorClass}`;
          icon.textContent = glyph;
          console.warn('[n8n SubFlow Preview] icon image failed, using glyph fallback:', node.type, node._iconUrl);
        };
        icon.appendChild(img);
      } else {
        if (node._iconUrl) {
          console.warn('[n8n SubFlow Preview] blocked unsafe icon URL, using glyph fallback:', node._iconUrl);
        }
        icon.textContent = glyph;
      }
      card.appendChild(icon);

      outer.appendChild(card);

      // Name label below the card
      const name = document.createElement('div');
      name.className = 'n8n-sf-html-name';
      name.textContent = truncate(node.name || 'Node', 18);
      name.title = node.name || '';
      outer.appendChild(name);

      wrapper.appendChild(outer);
    });
  }

  function getNodeColorClass(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('trigger') || t.includes('webhook') || t.endsWith('.start')) return 'kind-trigger';
    if (t.includes('if') || t.includes('switch') || t.includes('filter') || t.includes('code') || t.includes('function')) return 'kind-logic';
    if (t.includes('ai') || t.includes('langchain') || t.includes('agent') || t.includes('gemini') || t.includes('openai') || t.includes('chatmodel')) return 'kind-ai';
    if (t.includes('google') || t.includes('sheet') || t.includes('database') || t.includes('postgres') || t.includes('mysql') || t.includes('mongo')) return 'kind-data';
    if (t.includes('http') || t.includes('request')) return 'kind-http';
    return 'kind-action';
  }

  function sanitizeIconUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const lower = raw.toLowerCase();
    if (lower.includes('javascript:') || lower.includes('vbscript:') || lower.includes('data:text/')) {
      return null;
    }

    if (lower.startsWith('https://')) return raw;
    if (lower.startsWith('http://localhost')) return raw;
    if (lower.startsWith('data:image/svg')) return raw;
    if (lower.startsWith('data:image/png')) return raw;
    return null;
  }

  function getGlyph(type) {
    const t = String(type || '').toLowerCase();
    if (t.includes('trigger') || t.includes('webhook') || t.endsWith('.start')) return '\u26A1';
    if (t.includes('http') || t.includes('request')) return '\uD83C\uDF10';
    if (t.includes('ai') || t.includes('langchain') || t.includes('agent') || t.includes('gemini') || t.includes('openai') || t.includes('chatmodel')) return '\u2728';
    if (t.includes('sheet') || t.includes('google')) return '\uD83D\uDCCA';
    if (t.includes('if') || t.includes('switch') || t.includes('filter') || t.includes('merge')) return '\uD83D\uDD00';
    if (t.includes('code') || t.includes('function') || t.includes('html')) return '\u2774\u2775';
    if (t.includes('execute') && t.includes('workflow')) return '\u21B3';
    if (t.includes('noop') || t.includes('noop')) return '\u23F8';
    if (t.includes('split') || t.includes('batch')) return '\u21C6';
    if (t.includes('set') || t.includes('updatefields') || t.includes('updateitem')) return '\u270E';
    if (t.includes('slack') || t.includes('email') || t.includes('send')) return '\u2709';
    if (t.includes('monday')) return '\uD83D\uDCCB';
    return '\u25A0';
  }

  function truncate(value, max) {
    return value.length > max ? value.slice(0, max - 1) + '\u2026' : value;
  }

  return { render };
})();
