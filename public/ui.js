(() => {
  const refreshers = new Map();
  const notice = document.querySelector('#app-notice');
  let current = null;
  let noticeTimer;
  let menuId = 0;
  let locked = false;
  let returnFocus;

  function restoreFocus() {
    returnFocus?.focus();
    returnFocus = null;
  }

  function dismiss(id) {
    if (!current || current.dialog.id !== id) return;
    const { dialog, opener, fallback } = current;
    current = null;
    dialog.close();
    returnFocus = opener?.isConnected && !opener.disabled && opener.matches('button,a[href],input,select,[tabindex]')
      ? opener : document.querySelector(fallback);
    if (!locked) restoreFocus();
  }

  function requestClose() {
    if (!current || current.busy()) return;
    const { dialog, onCancel } = current;
    onCancel();
    dismiss(dialog.id);
  }

  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.querySelector('[data-close]').addEventListener('click', requestClose);
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      requestClose();
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) requestClose();
    });
  }

  function closeMenus(except) {
    for (const menu of document.querySelectorAll('.action-menu')) {
      if (menu === except) continue;
      menu.hidden = true;
      document.querySelector('[aria-controls="' + menu.id + '"]')?.setAttribute('aria-expanded', 'false');
    }
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('.card-actions')) closeMenus();
  });

  // Native dialogs provide modal focus containment and Escape handling. Keep
  // the sheet above the phone's software keyboard when the visual viewport shrinks.
  function sizeSheets() {
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty('--sheet-height', (viewport?.height || window.innerHeight) + 'px');
    document.documentElement.style.setProperty('--keyboard-offset', Math.max(0, window.innerHeight - (viewport?.height || window.innerHeight) - (viewport?.offsetTop || 0)) + 'px');
  }
  window.visualViewport?.addEventListener('resize', sizeSheets);
  window.visualViewport?.addEventListener('scroll', sizeSheets);
  window.addEventListener('resize', sizeSheets);
  sizeSheets();

  let selected = 'kitchen';
  try { if (localStorage.getItem('kitchen.selectedView') === 'shopping') selected = 'shopping'; } catch {}
  let comparing = false;
  const tabs = ['kitchen', 'shopping'].map(name => document.querySelector('#' + name + '-tab'));
  const compare = document.querySelector('#compare-button');
  function showView() {
    closeMenus();
    document.querySelector('.workspace').classList.toggle('comparing', comparing);
    for (const name of ['kitchen', 'shopping']) {
      document.querySelector('#' + name + '-panel').hidden = !comparing && selected !== name;
      document.querySelector('#' + name + '-tab').setAttribute('aria-pressed', String(!comparing && selected === name));
    }
    compare.textContent = comparing ? 'Exit Compare' : 'Compare';
    compare.setAttribute('aria-pressed', String(comparing));
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      selected = index ? 'shopping' : 'kitchen'; comparing = false;
      try { localStorage.setItem('kitchen.selectedView', selected); } catch {}
      showView();
    });
  });
  compare.addEventListener('click', () => { comparing = !comparing; showView(); });
  document.querySelectorAll('.skip-link').forEach(link => link.addEventListener('click', () => {
    selected = link.hash === '#shopping-list' ? 'shopping' : 'kitchen'; comparing = false; showView();
  }));
  showView();

  globalThis.kitchenUI = {
    register(name, refresh) { refreshers.set(name, refresh); },
    async refreshAll() {
      await Promise.allSettled([...refreshers.values()].map(refresh => refresh()));
    },
    open(id, { onCancel, busy = () => false, fallback }) {
      if (current) return;
      closeMenus();
      const dialog = document.getElementById(id);
      current = { dialog, onCancel, busy, fallback, opener: document.activeElement };
      dialog.showModal();
      dialog.querySelector('.sheet-content').scrollTop = 0;
    },
    dismiss,
    content(id, node) { document.getElementById(id).replaceChildren(node); },
    busy(value) {
      // Retain the interaction lock while both lists refresh after a successful save.
      document.querySelector('main').inert = value;
      locked = value;
      for (const button of document.querySelectorAll('[data-close]')) button.disabled = value;
      if (!value && !current) restoreFocus();
    },
    toast(text, error = false) {
      clearTimeout(noticeTimer);
      notice.textContent = text;
      notice.className = 'app-notice' + (error ? ' error' : '');
      notice.hidden = false;
      noticeTimer = setTimeout(() => { notice.hidden = true; }, 6000);
    },
    cardActions(name, primary, edit, remove) {
      const root = document.createElement('div');
      root.className = 'card-actions';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'button icon-button more-button';
      toggle.textContent = '⋯';
      toggle.setAttribute('aria-label', 'More actions for ' + name);
      toggle.setAttribute('aria-expanded', 'false');
      const menu = document.createElement('div');
      menu.className = 'action-menu';
      menu.id = 'card-menu-' + ++menuId;
      menu.hidden = true;
      toggle.setAttribute('aria-controls', menu.id);
      toggle.addEventListener('click', () => {
        const opening = menu.hidden;
        closeMenus(menu);
        menu.hidden = !opening;
        toggle.setAttribute('aria-expanded', String(opening));
        if (opening) menu.scrollIntoView({ block: 'nearest' });
      });
      root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !menu.hidden) {
          event.preventDefault();
          menu.hidden = true;
          toggle.setAttribute('aria-expanded', 'false');
          toggle.focus();
        }
      });
      menu.append(edit, remove);
      if (primary) {
        primary.className = 'button quick-action';
        root.append(primary);
      }
      root.append(toggle, menu);
      return { root, toggle };
    }
  };
})();
