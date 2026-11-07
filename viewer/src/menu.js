(() => {
  'use strict';

  const mechanic = document.getElementById('mechanic-link');
  const studio = document.getElementById('studio-link');
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(event.target.tagName))) return;
    const destination = event.key === '1' ? mechanic : event.key === '2' ? studio : null;
    if (!destination) return;
    event.preventDefault();
    destination.click();
  });
})();
