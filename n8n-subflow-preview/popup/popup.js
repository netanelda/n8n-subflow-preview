const hoverDelayInput = document.getElementById('hoverDelay');
const delayValueSpan  = document.getElementById('delayValue');
const themeSelect     = document.getElementById('theme');
const enableHover     = document.getElementById('enableHover');
const enableBadges    = document.getElementById('enableBadges');
const enableBreadcrumbs = document.getElementById('enableBreadcrumbs');
const saveBtn         = document.getElementById('saveBtn');
const statusEl        = document.getElementById('status');

chrome.storage.local.get([
  'hoverDelay', 'theme', 'enableHover', 'enableBadges', 'enableBreadcrumbs'
], (data) => {
  if (data.hoverDelay) {
    hoverDelayInput.value = data.hoverDelay;
    delayValueSpan.textContent = data.hoverDelay;
  }
  if (data.theme) themeSelect.value = data.theme;
  enableHover.checked      = data.enableHover !== false;
  enableBadges.checked     = data.enableBadges !== false;
  enableBreadcrumbs.checked = data.enableBreadcrumbs !== false;
});

hoverDelayInput.addEventListener('input', () => {
  delayValueSpan.textContent = hoverDelayInput.value;
});

saveBtn.addEventListener('click', () => {
  const settings = {
    hoverDelay:        Number(hoverDelayInput.value),
    theme:             themeSelect.value,
    enableHover:       enableHover.checked,
    enableBadges:      enableBadges.checked,
    enableBreadcrumbs: enableBreadcrumbs.checked
  };

  chrome.storage.local.set(settings, () => {
    statusEl.textContent = 'Settings saved \u2713';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  });
});
