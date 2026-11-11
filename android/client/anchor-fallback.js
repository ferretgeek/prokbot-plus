// CSS anchor positioning for WebView builds older than Chromium 125.
//
// The original interface lays the Bot computer view over its placeholder with CSS anchor
// positioning: the placeholder gets `style.setProperty('anchor-name', ...)` and the view
// gets React inline styles such as `positionAnchor`, `top: anchor(top)` and
// `width: anchor-size(width)`. An older WebView drops those declarations and the view
// collapses to nothing. Here anchor names and position anchors are kept as custom
// properties; the inset values are kept by renderer-patches.mjs as
// `--grokbot-anchor-<property>`. After layout they are turned into pixel offsets.
// Anchors declared in style sheets only place decorations and are left alone.

const PROPERTIES = {
  top: 'top', right: 'right', bottom: 'bottom', left: 'left',
  insetInlineStart: 'inset-inline-start', insetInlineEnd: 'inset-inline-end',
  width: 'width', height: 'height',
};
const KEEP = name => `--grokbot-anchor-${name}`;
const ANCHOR_NAME = '--grokbot-anchor-name';
const POSITION_ANCHOR = '--grokbot-position-anchor';

/** Side of the anchor box, in viewport pixels, that `side` names for an inset property. */
function edge(side, property, anchor, rtl) {
  const vertical = property === 'top' || property === 'bottom';
  const start = vertical ? anchor.top : anchor.left, size = vertical ? anchor.height : anchor.width;
  const percent = /^(-?[\d.]+)%$/.exec(side);
  if (percent) return start + size * Number(percent[1]) / 100;
  const named = { top: 0, left: 0, bottom: 1, right: 1, center: 0.5,
    start: rtl ? 1 : 0, end: rtl ? 0 : 1, 'self-start': rtl ? 1 : 0, 'self-end': rtl ? 0 : 1 }[side];
  return named == null ? null : start + size * named;
}

/**
 * Replaces every anchor() / anchor-size() in `expression` with pixels. `anchor` and `box`
 * are viewport rectangles of the default anchor and of the containing block (null when
 * missing); `named` looks up anchors written as anchor(--name side). Returns null when a
 * value cannot be resolved and has no fallback.
 */
export function resolveAnchorExpression(expression, property, anchor, box, { rtl = false, named = () => null } = {}) {
  const physical = property === 'insetInlineStart' ? (rtl ? 'right' : 'left')
    : property === 'insetInlineEnd' ? (rtl ? 'left' : 'right') : property;
  let failed = false;
  const value = expression.replace(/anchor(-size)?\(\s*(?:(--[\w-]+)\s+)?([\w.%-]+)\s*(?:,\s*([^()]+))?\)/g,
    (_, size, name, side, fallback) => {
      const target = name ? named(name) : anchor;
      if (!target || !box) {
        if (fallback != null) return fallback.trim();
        failed = true;
        return '0px';
      }
      if (size) return `${/height|block/.test(side) ? target.height : target.width}px`;
      const at = edge(side, physical, target, rtl);
      if (at == null) { if (fallback != null) return fallback.trim(); failed = true; return '0px'; }
      const offset = physical === 'top' ? at - box.top : physical === 'left' ? at - box.left
        : physical === 'bottom' ? box.top + box.height - at : box.left + box.width - at;
      return `${Math.round(offset * 100) / 100}px`;
    });
  return failed ? null : value;
}

function containingBox(element) {
  if (getComputedStyle(element).position === 'fixed' || !element.offsetParent)
    return { top: 0, left: 0, width: innerWidth, height: innerHeight };
  const parent = element.offsetParent, rect = parent.getBoundingClientRect();
  return { top: rect.top + parent.clientTop - parent.scrollTop, left: rect.left + parent.clientLeft - parent.scrollLeft,
    width: parent.clientWidth, height: parent.clientHeight };
}

export function installAnchorFallback() {
  if (typeof CSS === 'undefined' || CSS.supports('anchor-name: --a')) return false;
  const prototype = CSSStyleDeclaration.prototype;
  const setProperty = prototype.setProperty, removeProperty = prototype.removeProperty;
  const keep = (style, name, value) => {
    if (value == null || value === '') removeProperty.call(style, name);
    else setProperty.call(style, name, String(value));
  };

  for (const [property, name] of [['anchorName', ANCHOR_NAME], ['positionAnchor', POSITION_ANCHOR]]) {
    // Not native properties on these builds, so React's `style.positionAnchor = ...` lands here.
    if (property in prototype) continue;
    Object.defineProperty(prototype, property, {
      configurable: true, enumerable: false,
      get() { return this.getPropertyValue(name).trim(); },
      set(value) { keep(this, name, value); },
    });
  }
  prototype.setProperty = function (name, value, priority) {
    if (name === 'anchor-name') return keep(this, ANCHOR_NAME, value);
    if (name === 'position-anchor') return keep(this, POSITION_ANCHOR, value);
    return setProperty.call(this, name, value, priority);
  };
  prototype.removeProperty = function (name) {
    if (name === 'anchor-name') name = ANCHOR_NAME;
    else if (name === 'position-anchor') name = POSITION_ANCHOR;
    return removeProperty.call(this, name);
  };

  const update = () => {
    const positioned = document.querySelectorAll(`[style*="${POSITION_ANCHOR}"]`);
    if (positioned.length === 0) return;
    const anchors = new Map();
    for (const element of document.querySelectorAll(`[style*="${ANCHOR_NAME}"],[style*="--x-anchorName"]`)) {
      const name = (element.style.getPropertyValue(ANCHOR_NAME) || element.style.getPropertyValue('--x-anchorName')).trim();
      if (name) anchors.set(name, element);
    }
    const rect = name => { const found = anchors.get(name); return found?.isConnected ? found.getBoundingClientRect() : null; };
    for (const element of positioned) {
      const anchor = rect(element.style.getPropertyValue(POSITION_ANCHOR).trim());
      const box = containingBox(element);
      const rtl = getComputedStyle(element).direction === 'rtl';
      for (const [property, css] of Object.entries(PROPERTIES)) {
        const expression = element.style.getPropertyValue(KEEP(property)).trim();
        if (!expression) continue;
        const value = resolveAnchorExpression(expression, property, anchor, box, { rtl, named: rect });
        if (value == null) removeProperty.call(element.style, css);
        else if (element.style.getPropertyValue(css) !== value) setProperty.call(element.style, css, value);
      }
    }
  };

  // Anchors move with scrolling, resizing and the pane's slide-in transition: keep
  // following them for a short while after anything changes, then go idle.
  let until = 0, running = false;
  const frame = () => {
    update();
    if (performance.now() < until) requestAnimationFrame(frame);
    else running = false;
  };
  const wake = () => {
    until = performance.now() + 1200;
    if (!running) { running = true; requestAnimationFrame(frame); }
  };
  new MutationObserver(wake).observe(document.documentElement,
    { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  addEventListener('scroll', wake, { capture: true, passive: true });
  addEventListener('resize', wake);
  addEventListener('transitionrun', wake, true);
  addEventListener('animationstart', wake, true);
  return true;
}
