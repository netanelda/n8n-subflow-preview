// Detects n8n's current theme (light or dark) by inspecting the DOM.

const ThemeDetector = (() => {
  function detect() {
    // n8n sets data-theme or class on <body> / <html>
    const body = document.body;
    const html = document.documentElement;

    if (body.classList.contains('theme--dark') || html.getAttribute('data-theme') === 'dark') {
      return 'dark';
    }
    if (body.classList.contains('theme--light') || html.getAttribute('data-theme') === 'light') {
      return 'light';
    }

    // Fallback: check computed background luminance
    const bg = getComputedStyle(body).backgroundColor;
    const match = bg.match(/\d+/g);
    if (match) {
      const [r, g, b] = match.map(Number);
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      return luminance < 128 ? 'dark' : 'light';
    }

    return 'dark'; // safe default for n8n
  }

  return { detect };
})();
