'use strict';
/* Bounds for text on its way to the model. The user-facing terminal replay has its own, much
   larger budget (lib/ssh-terminal's outputMax) and must never shrink because of these limits:
   what a viewer can scroll back through and what fits in a model turn are different questions.
   Everything here keeps the END. An error, an exit code and the next prompt all live at the end
   of terminal output, so the tail is the part worth spending context on; a head is kept only
   where the start of the text carries meaning of its own (a table header, the top of a file). */

const LINE_SCAN = 200; // how far to look for a line break so a cut lands between lines
const ESC_SCAN = 24;   // how far to look back for an escape sequence the cut would otherwise split

const DEFAULTS = {
  terminalRead: 6000, // one contiguous tail of the shared terminal, per ssh_terminal_read
  stdout: 6000,       // an approved command's stdout
  stderr: 2000,       // an approved command's stderr
  head: 800,          // kept in front of the tail where the start of the text is useful too
};

const defaultMarker = (dropped) => `\n…[${dropped} characters dropped to fit the assistant's context]…\n`;
const cap = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback);

/** Start index for a tail, moved so the tail never begins inside a character or an escape sequence. */
function cutStart(value, index) {
  let i = Math.max(0, Math.min(value.length, Math.trunc(index)));
  const brk = value.indexOf('\n', i);
  if (brk >= 0 && brk - i < LINE_SCAN) return brk + 1; // between lines: the cheapest way to stay whole
  if (/[\uDC00-\uDFFF]/.test(value[i] || '')) i++; // never start on the low half of a surrogate pair
  const esc = value.lastIndexOf('\x1b', i);
  // Re-include a sequence we would otherwise start halfway through; a few extra characters cost
  // far less than a stray "[31m" the model reads as text. The final byte of CSI/OSC is \x40-\x7e or BEL.
  if (esc >= 0 && i - esc <= ESC_SCAN && !/[\x40-\x7e\x07]/.test(value.slice(esc + 2, i))) i = esc;
  return i;
}

/** End index for a head, moved so the head never ends inside a character or an escape sequence. */
function cutEnd(value, index) {
  let i = Math.max(0, Math.min(value.length, Math.trunc(index)));
  const brk = value.lastIndexOf('\n', i);
  if (brk >= 0 && i - brk < LINE_SCAN) return brk + 1;
  if (/[\uD800-\uDBFF]/.test(value[i - 1] || '')) i--; // never end on the high half of a surrogate pair
  const esc = value.lastIndexOf('\x1b', i - 1);
  if (esc >= 0 && i - esc <= ESC_SCAN && !/[\x40-\x7e\x07]/.test(value.slice(esc + 2, i))) i = esc;
  return i;
}

/** Tail-first bound. Returns the kept text (plus a marker naming the gap) and how much was dropped.
 *  The marker itself is small and deliberately not counted against `max`. */
function boundText(text, options = {}) {
  const value = String(text ?? '');
  const max = cap(options.max, 0);
  if (!max || value.length <= max) return { text: value, dropped: 0 };
  const headMax = Math.max(0, Math.min(Math.trunc(Number(options.head) || 0), Math.floor(max / 2)));
  const head = headMax ? cutEnd(value, headMax) : 0;
  const start = cutStart(value, value.length - (max - head));
  const dropped = start - head;
  if (dropped <= 0) return { text: value, dropped: 0 };
  const marker = typeof options.marker === 'function' ? options.marker : defaultMarker;
  return { text: value.slice(0, head) + marker(dropped) + value.slice(start), dropped };
}

/** Bound a lib/ssh-terminal snapshot for the model, leaving the viewer's own replay untouched.
 *  A terminal view is cursor-addressed, so the model's copy stays ONE contiguous run ending at
 *  `cursor`: a head plus a tail would make `baseCursor` a lie, and a follow-up read from `cursor`
 *  would silently skip whatever sat in the middle. Hence tail only.
 *  `baseCursor` is normalised in every case, dropped or not: to a viewer it means "the oldest
 *  cursor the replay buffer can still serve", which sits before the returned window whenever a
 *  cursor was passed. For the model it must mean "the first character you are looking at", or it
 *  reads as having seen output nobody gave it. */
function boundTerminalView(view, options = {}) {
  if (!view || typeof view !== 'object') return view;
  const max = cap(options.max, DEFAULTS.terminalRead);
  const output = String(view.output ?? '');
  const start = output.length > max ? cutStart(output, output.length - max) : 0;
  const end = Number.isSafeInteger(view.cursor) ? view.cursor : null;
  const model = {
    ...view,
    output: start ? output.slice(start) : output,
    baseCursor: end === null ? view.baseCursor : end - (output.length - start),
    truncated: !!view.truncated || start > 0,
  };
  if (start > 0) {
    model.dropped = start;
    model.note = `${start} earlier characters were dropped to fit the assistant's context. What is returned here ends at cursor ${end === null ? 'the current cursor' : end}; read again from that cursor to continue. The terminal still holds the full buffer for the user.`;
  }
  return model;
}

module.exports = { boundText, boundTerminalView, cutStart, cutEnd, DEFAULTS };
