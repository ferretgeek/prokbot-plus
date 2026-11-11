// Layout for phone-width windows: the parts CSS alone cannot express.

/** Below this width the window is a phone: the Bot list and a conversation are separate screens. */
export const PHONE_QUERY = '(max-width: 599px)';

const BACK_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

/**
 * Image attachments get a fixed inline size (for example 320 x 180) chosen for desktop
 * message columns. On a phone the column can be narrower, so the frame is scaled down
 * with its aspect ratio kept. A later render that restores the size is fitted again.
 */
export function fitAttachmentFrames(root = document) {
  for (const frame of root.querySelectorAll('.sand-attachment__image-frame[style]')) {
    const width = Number.parseFloat(frame.style.width), height = Number.parseFloat(frame.style.height);
    const available = frame.parentElement?.clientWidth ?? 0;
    if (!(width > 0 && height > 0 && available > 0) || width <= available + 1) continue;
    frame.style.width = `${available}px`;
    frame.style.height = `${Math.round(height * available / width)}px`;
  }
}

/** The large Bot computer view stays mounted after it is closed; only its visibility changes. */
export function computerStageOpen(root = document) {
  const stage = root.querySelector('.sand-computer-fullscreen');
  return stage != null && getComputedStyle(stage).visibility !== 'hidden';
}

/** True while the details pane covers the conversation as a full-screen layer (android.css). */
export function paneLayerOpen(root = document) {
  const pane = root.querySelector('.sand-info-pane[data-open="true"]');
  return pane != null && matchMedia('(max-width: 791px)').matches && getComputedStyle(pane).visibility !== 'hidden';
}

/**
 * Which phone screen should show after the selected Bot changed from `previous` to `current`.
 * In the list, a Bot the user just created opens its conversation (`creating`: the user pressed
 * "Create" a moment ago, and the Host may take a while to answer); any other change (deleting
 * the selected Bot, the list loading) keeps the list. In a conversation the screen stays, unless
 * the Bot was deleted (`previousListed` is false), which returns to the list.
 */
export function screenAfterAgentChange({ previous, current, screen, previousListed, currentKnown, userCaused, creating = false }) {
  if (previous === undefined || previous === current) return screen;
  if (screen === 'chat') return previous !== null && !previousListed ? 'list' : 'chat';
  if (current !== null && creating) return 'chat';
  return current !== null && !currentKnown && userCaused ? 'chat' : 'list';
}

/**
 * When a Bot was last active, as the official phone app shows it at the right of each row:
 * the time for today, "Yesterday", the weekday within a week, otherwise the date.
 */
export function activityTime(at, now = Date.now(), locale = 'en') {
  if (!Number.isFinite(at) || at <= 0) return null;
  const date = new Date(at), today = new Date(now);
  const day = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(today) - day(date)) / 86_400_000);
  if (days <= 0) return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day');
    return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
  }
  if (days < 7) return date.toLocaleDateString(locale, { weekday: 'long' });
  return date.toLocaleDateString(locale, date.getFullYear() === today.getFullYear()
    ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}
// Called by the patched Bot row (patchers/renderer-patches.mjs).
globalThis.grokbotActivityTime = at => activityTime(at, Date.now(), document.documentElement.lang || navigator.language);

const phone = {
  query: null,
  screen: 'list',
  agent: undefined,
  known: new Set(),
  deleted: null,
  newChat: false,
  interactedAt: -Infinity,
  creatingAt: -Infinity,
  shownAt: -Infinity,
  fieldPointerAt: -Infinity,
  back: null,
};

export function isPhone() {
  return document.documentElement.classList.contains('grokbot-phone');
}

function setScreen(screen) {
  phone.screen = screen;
  const classes = document.documentElement.classList;
  classes.toggle('grokbot-view-chat', screen === 'chat');
  classes.toggle('grokbot-view-list', screen === 'list');
  if (screen === 'chat') phone.shownAt = performance.now();
  else {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.sand-chat')) active.blur();
  }
}

/** Shows the conversation screen (a Bot was opened, for example from a notification). */
export function showConversation() {
  setScreen('chat');
}

/** The back gesture in a conversation returns to the Bot list. */
export function phoneBack() {
  if (!isPhone() || phone.screen !== 'chat') return false;
  setScreen('list');
  return true;
}

function currentAgentId() {
  return document.querySelector('.sand-agents-sidebar .sand-agent-item[aria-current="page"]')?.dataset.agentId ?? null;
}

function listedAgents() {
  return new Set([...document.querySelectorAll('.sand-agents-sidebar .sand-agent-item[data-agent-id]')].map(row => row.dataset.agentId));
}

function backButton() {
  if (phone.back) return phone.back;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'grokbot-nav-back';
  button.innerHTML = BACK_ICON;
  button.addEventListener('click', () => setScreen('list'));
  return phone.back = button;
}

function updatePhone() {
  const chat = document.querySelector('.sand-chat');
  const button = backButton();
  button.setAttribute('aria-label', document.documentElement.lang.startsWith('zh') ? '返回' : 'Back');
  if (chat && button.parentElement !== chat) chat.append(button);

  const current = currentAgentId(), listed = listedAgents(), now = performance.now();
  if (current !== phone.agent) {
    const previous = phone.agent;
    phone.agent = current;
    const creating = current !== null && now - phone.creatingAt < 20000;
    const next = screenAfterAgentChange({ previous, current, screen: phone.screen,
      previousListed: previous == null || listed.has(previous), currentKnown: current == null || phone.known.has(current),
      userCaused: now - phone.interactedAt < 2000, creating });
    if (creating) phone.creatingAt = -Infinity;
    if (next !== phone.screen) setScreen(next);
    // A deleted Bot's row can stay in the list while it animates out; look again shortly.
    if (phone.screen === 'chat' && previous) {
      phone.deleted = { id: previous, until: now + 3000 };
      setTimeout(updatePhone, 1200);
    }
  }
  if (phone.deleted && (now > phone.deleted.until || phone.screen !== 'chat')) phone.deleted = null;
  if (phone.deleted && !listed.has(phone.deleted.id)) {
    phone.deleted = null;
    setScreen('list');
  }
  for (const id of listed) phone.known.add(id);
  // "New group chat" replaces the conversation with an empty one; show it.
  const newChat = document.querySelector('.sand-chat .sand-new-chat-stage') != null;
  if (newChat && !phone.newChat && now - phone.interactedAt < 2000) setScreen('chat');
  phone.newChat = newChat;

  // The details pane has no title of its own on its first page; show the Bot's name there.
  const top = document.querySelector('.sand-info-pane[data-open="true"] .sand-info-pane__top');
  if (top) {
    const title = top.querySelector('.sand-info-pane__subpage-title') ? ''
      : document.querySelector('.sand-chat-header__title')?.textContent?.trim() ?? '';
    if (title && top.dataset.grokbotTitle !== title) top.dataset.grokbotTitle = title;
    else if (!title && top.dataset.grokbotTitle !== undefined) delete top.dataset.grokbotTitle;
  }
  if (isPhone()) addMarketplaceEntry();
}

/**
 * The official phone app reaches the marketplace from the account sheet, and on a phone
 * android.css hides the marketplace button next to the account. While the account menu is
 * open it gets an entry that presses that button.
 */
function addMarketplaceEntry() {
  const account = document.querySelector('.sand-agents-sidebar__footer button[aria-haspopup="menu"][aria-expanded="true"]');
  const menu = account && document.getElementById(account.getAttribute('aria-controls'));
  if (!menu || menu.querySelector('.grokbot-marketplace-entry')) return;
  const marketplace = account.closest('.sand-agents-sidebar__footer').querySelector('button:not([aria-haspopup])');
  const template = [...menu.querySelectorAll('[role="menuitem"]')].find(item => !item.hasAttribute('aria-haspopup'));
  const label = marketplace?.textContent.trim();
  if (!label || !template) return;
  const entry = template.cloneNode(true);
  entry.removeAttribute('id');
  entry.classList.add('grokbot-marketplace-entry');
  entry.querySelector('[data-component="menu-item-content"]').textContent = label;
  const icon = entry.querySelector('.ui-icon'), source = marketplace.querySelector('.ui-icon');
  if (icon && source) {
    icon.dataset.iconName = source.dataset.iconName ?? '';
    icon.style.cssText = source.style.cssText;
  }
  entry.addEventListener('click', () => {
    account.click();
    marketplace.click();
  });
  menu.querySelector('[role^="menuitem"]').before(entry);
}

function installPhone() {
  phone.query = matchMedia(PHONE_QUERY);
  const apply = () => {
    document.documentElement.classList.toggle('grokbot-phone', phone.query.matches);
    setScreen(phone.screen);
  };
  phone.query.addEventListener('change', apply);
  apply();

  addEventListener('click', event => {
    if (!isPhone() || !(event.target instanceof Element)) return;
    // "Create" in the new Bot sheet: the new Bot's conversation opens once the Host has made it.
    if (event.target.closest('.sand-create-bot-dialog > :last-child > button[data-variant="primary"]'))
      phone.creatingAt = performance.now();
    // A Bot opened from the list or from search shows its conversation.
    if (event.target.closest('.sand-agents-sidebar .sand-agent-item')
      || event.target.closest('.sand-command-palette [role="option"]')?.querySelector('.sand-kit-base-avatar, .sand-grok-bot-mark'))
      setScreen('chat');
  }, true);
  for (const type of ['pointerup', 'keydown'])
    addEventListener(type, () => { phone.interactedAt = performance.now(); }, true);
  addEventListener('pointerdown', event => {
    if (event.target instanceof Element && event.target.closest('textarea, input, [contenteditable="true"]'))
      phone.fieldPointerAt = performance.now();
  }, true);
  // Opening a conversation should not raise the keyboard: the desktop interface focuses the
  // message field when a Bot is selected. A tap on the field itself still focuses it.
  addEventListener('focusin', event => {
    if (!isPhone() || phone.screen !== 'chat' || !(event.target instanceof HTMLElement)) return;
    if (!event.target.closest('.sand-chat') || !event.target.matches('textarea, input, [contenteditable="true"]')) return;
    const now = performance.now();
    if (now - phone.shownAt < 800 && now - phone.fieldPointerAt > 800) event.target.blur();
  }, true);
}

export function installLayoutFixes() {
  let scheduled = false;
  installPhone();
  // The desktop interface hands focus back to the message field, for example after the
  // large computer view closes. Under the pane layer that field is out of sight, and on a
  // phone a focused field also raises the keyboard; so nothing covered keeps the focus.
  const releaseCoveredFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.sand-chat') && paneLayerOpen()) active.blur();
  };
  const run = () => {
    scheduled = false;
    fitAttachmentFrames();
    // Enter sends the message, as on the desktop; the on-screen keyboard labels the key that way.
    const prompt = document.querySelector('.sand-prompt-form [contenteditable="true"]');
    if (prompt && prompt.getAttribute('enterkeyhint') !== 'send') prompt.setAttribute('enterkeyhint', 'send');
    // android.css moves the details pane layer aside while the large computer view is open.
    document.documentElement.classList.toggle('grokbot-computer-stage', computerStageOpen());
    releaseCoveredFocus();
    updatePhone();
  };
  const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(run); } };
  new MutationObserver(schedule).observe(document.documentElement,
    { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'aria-current', 'data-open'] });
  addEventListener('resize', schedule);
  addEventListener('focusin', schedule, true);
  schedule();
}
