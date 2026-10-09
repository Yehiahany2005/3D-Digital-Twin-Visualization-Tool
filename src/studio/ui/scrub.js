// Pixels of drag per step.
const PIXELS_PER_STEP = 4;

function decimalsOf(unit) {
  return Math.max(0, Math.min(6, Math.ceil(-Math.log10(unit) - 1e-9)));
}

// Drag a number field's label left or right to change its value (like Blender or Roblox Studio):
// one step every few pixels, Shift for steps ten times finer. preview(value) runs while dragging
// (to show it right away), commit(value) once when let go (one undo step). A plain click on the
// label still just puts the cursor in the field.
export function makeScrubbable(handle, input, { step = 1, min, max, preview, commit }) {
  handle.classList.add('is-scrubbable');
  if (!handle.title) handle.title = 'Drag left or right to change (Shift: finer)';
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || input.disabled) return;
    event.preventDefault();
    const start = Number(input.value) || 0;
    const startX = event.clientX;
    let value = start;
    let moved = false;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      document.body.classList.add('is-scrubbing');
      const unit = moveEvent.shiftKey ? step / 10 : step;
      let next = start + Math.round(dx / PIXELS_PER_STEP) * unit;
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      next = Number(next.toFixed(decimalsOf(unit)));
      if (next === value) return;
      value = next;
      input.value = String(next);
      preview?.(next);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('is-scrubbing');
      if (!moved) input.focus();
      else if (value !== start) commit(value);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}
