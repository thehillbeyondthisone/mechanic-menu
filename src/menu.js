(() => {
  'use strict';

  const mechanic = document.getElementById('mechanic-link');
  const studio = document.getElementById('studio-link');
  const repair = document.getElementById('repair-link');
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(event.target.tagName))) return;
    const destination = event.key === '1' ? mechanic : event.key === '2' ? studio : event.key === '3' ? repair : null;
    if (!destination) return;
    event.preventDefault();
    destination.click();
  });
})();
