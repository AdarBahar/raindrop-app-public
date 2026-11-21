// The page script, part 7 of 9: The keyboard shortcuts and the keyboard help.
// index.html loads the parts in this order: core.js → filters.js → list.js → bulk.js → review.js → bulk-drawer.js → keys.js → context.js → app.js. The parts share one global scope.

// ---- Keyboard shortcuts (section 6.1) ----
// Shortcuts stop while a text box, a select or a dialog has focus. Those keep their own keys.
function isTyping(el) {
  // A checkbox is not a text box. Space and the arrow keys still work on a focused checkbox.
  return Boolean(el?.matches?.('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]'));
}

// Up and Down move focus to the checkbox of the previous or next row. Focus stops at the ends.
function moveRow(step) {
  const rows = [...document.querySelectorAll('#list .row')];
  if (!rows.length) return false;
  const active = document.activeElement;
  const current = active?.closest?.('#list .row');
  let i;
  if (current) i = Math.min(Math.max(rows.indexOf(current) + step, 0), rows.length - 1);
  else if (!active || active === document.body) i = step > 0 ? 0 : rows.length - 1;
  else return false;
  rows[i].querySelector('.chk').focus();
  return true;
}

// Left and Right go to the previous or next page. The first row of the new page gets focus.
function turnPage(step) {
  const btn = document.querySelector(`[data-page="${step > 0 ? 'next' : 'prev'}"]:not([disabled])`);
  if (!btn) return false;
  goPage(step).then(() => document.querySelector('#list .row .chk')?.focus());
  return true;
}

document.addEventListener('keydown', e => {
  if (e.defaultPrevented || document.querySelector('dialog[open]') || document.body.classList.contains('filters-open')) return;
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
    e.preventDefault();
    openHelp();
    return;
  }
  // Ctrl+A selects or clears every row on the page, the same as the "Select all on this page" box.
  if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    if (isTyping(e.target)) return;
    e.preventDefault();
    const box = $('selectAll');
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
    return;
  }
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isTyping(e.target)) return;
  let handled = false;
  if (e.key === 'ArrowDown') handled = moveRow(1);
  else if (e.key === 'ArrowUp') handled = moveRow(-1);
  else if (e.key === 'ArrowRight') handled = turnPage(1);
  else if (e.key === 'ArrowLeft') handled = turnPage(-1);
  if (handled) e.preventDefault();
});

// ---- Keyboard help (section 6.1). Opened by the sidebar button or by ?. ----
function openHelp() {
  $('helpDlg').showModal();
  $('helpClose').focus();
}
$('helpBtn').onclick = openHelp;
$('helpClose').onclick = () => $('helpDlg').close();
$('helpDlg').addEventListener('close', () => $('helpBtn').focus());
