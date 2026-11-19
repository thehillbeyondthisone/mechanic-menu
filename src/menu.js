(() => {
  'use strict';

  const shortcuts = new Map([
    ['1', document.getElementById('mechanic-link')],
    ['2', document.getElementById('studio-link')],
    ['3', document.getElementById('repair-link')],
    ['4', document.getElementById('finished-workshop-link')],
  ]);
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(event.target.tagName))) return;
    const destination = shortcuts.get(event.key);
    if (!destination) return;
    event.preventDefault();
    destination.click();
  });
})();
