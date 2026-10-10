// Injected into the website while "Record my clicks" is running. Turns clicks,
// typing and key presses into scriptcast steps that describe targets the way a
// person would (button text, field labels), which is what scriptcast looks for.
(() => {
  if (window.top !== window) return;
  const send = (step) => window.__scriptcastStep(step);

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isTextField = (el) =>
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && /^(text|email|search|password|url|tel|number|)$/.test(el.type));

  const describe = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    if (el.labels && el.labels.length) {
      const text = clean(el.labels[0].innerText);
      if (text) return text;
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return clean(placeholder);
    const text = clean(el.innerText || el.getAttribute('value') || el.getAttribute('title') || el.getAttribute('alt'));
    // Long text still works as a target because partial matches are allowed.
    if (text) return text.split(' ').slice(0, 8).join(' ');
    if (el.id) return `#${el.id}`;
    return el.tagName.toLowerCase();
  };

  const lastSent = new WeakMap();
  const sendTyping = (el) => {
    if (!el.value || lastSent.get(el) === el.value) return;
    lastSent.set(el, el.value);
    // Never capture real passwords; the user fills in an environment variable instead.
    const text = el instanceof HTMLInputElement && el.type === 'password' ? '${PASSWORD}' : el.value;
    send({ type: { into: describe(el), text } });
  };

  const CLICKABLE =
    'button, a, summary, label, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option], input[type=checkbox], input[type=radio], input[type=submit], input[type=button]';

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element) || isTextField(target)) return; // typing is recorded as a "type" step
    const el = target.closest(CLICKABLE) || target;
    // Clicking a <label> also fires a synthetic click on its checkbox; keep only one step.
    if (el instanceof HTMLInputElement && el.labels && el.labels.length && e.detail === 0) return;
    send({ click: describe(el) });
  }, true);

  document.addEventListener('change', (e) => {
    if (e.target instanceof Element && isTextField(e.target)) sendTyping(e.target);
  }, true);

  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (e.key === 'Enter' && el instanceof Element && isTextField(el)) {
      sendTyping(el);
      send({ press: 'Enter' });
    } else if (e.key === 'Escape') {
      send({ press: 'Escape' });
    }
  }, true);
})();
