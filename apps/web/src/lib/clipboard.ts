/**
 * Copy text to the clipboard, including over plain http://.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost), and
 * self-hosted SupOps is usually opened as http://<lan-ip>:3001 -- where it is simply
 * undefined. So fall back to the classic hidden-textarea + execCommand('copy'),
 * which browsers still honour on http during a click. Returns false if both fail.
 */
export async function copyText(text: string, doc: Document = document): Promise<boolean> {
  // `doc` is the document the click happened in: the floating call window is a
  // separate document, and only the focused one may write to the clipboard.
  const win = doc.defaultView ?? window;
  if (win.isSecureContext && win.navigator.clipboard?.writeText) {
    try {
      await win.navigator.clipboard.writeText(text);
      return true;
    } catch { /* permission refused: try the fallback */ }
  }
  const document = doc;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
