// ==UserScript==
// @name         TicketDive Auto Entry
// @namespace    https://ticketdive.com/
// @version      2.1.0
// @description  Auto-select ticket options and fill apply form on TicketDive
// @match        https://ticketdive.com/event/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // ============================================================
  //
  // ============================================================
  const CONFIG = {
    common: {
      timeoutMs: 15000,
      debug: true,
      startDate: '',
      startTime: '',
    },
    event: {
      ticketCount: 1,
      autoClick: true,
      waitMs: 300,
      favoriteGroup: '',
      favoriteGroupAuto: true,
    },
    apply: {
      lastName: '',
      firstName: '',
      phoneNumber: '',
      stepDelayMs: 150,
      autoSubmit: false,
    },
  };

  const SETTINGS_STORAGE_KEY = 'ticketdive-unified-settings-v1';

  // ============================================================
  //
  // ============================================================
  const STYLE = {
    info:  'color:#1e90ff;font-weight:bold;',
    ok:    'color:#2ecc40;font-weight:bold;',
    warn:  'color:#ff851b;font-weight:bold;',
    error: 'color:#ff4136;font-weight:bold;',
    dim:   'color:#aaa;',
  };

  function createLogger(scope) {
    const prefix = `%c[TicketDive${scope ? '/' + scope : ''}]`;
    return {
      info:  (m, ...r) => console.log  (prefix, STYLE.info,  m, ...r),
      ok:    (m, ...r) => console.log  (prefix, STYLE.ok,    m, ...r),
      warn:  (m, ...r) => console.warn (prefix, STYLE.warn,  m, ...r),
      error: (m, ...r) => console.error(prefix, STYLE.error, m, ...r),
      dim:   (m, ...r) => console.log  (prefix, STYLE.dim,   m, ...r),
      group:    label  => console.groupCollapsed(`[TicketDive${scope ? '/' + scope : ''}] ${label}`),
      groupEnd: ()     => console.groupEnd(),
      table:   data    => console.table(data),
    };
  }

  function createStepLogger(log, flowName) {
    const startedAt = Date.now();
    const fmt = (stepNo, phase, message) => `[${flowName}] STEP ${stepNo} ${phase} - ${message}`;
    return {
      start: (stepNo, message, ...rest) => log.info(fmt(stepNo, 'START', message), ...rest),
      ok:    (stepNo, message, ...rest) => log.ok(fmt(stepNo, 'OK', message), ...rest),
      skip:  (stepNo, message, ...rest) => log.warn(fmt(stepNo, 'SKIP', message), ...rest),
      fail:  (stepNo, message, ...rest) => log.error(fmt(stepNo, 'FAIL', message), ...rest),
      done:  (message = 'flow finished') => log.ok(`[${flowName}] DONE (${Date.now() - startedAt}ms) - ${message}`),
    };
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ============================================================
  //
  // ============================================================
  function waitForElement(selector, timeoutMs, log, abortSignal) {
    return new Promise((resolve, reject) => {
      //
      if (abortSignal?.aborted) {
        return reject(new DOMException('Aborted', 'AbortError'));
      }

      const el = document.querySelector(selector);
      if (el) {
        log.dim(`waitForElement: "${selector}" found immediately`);
        return resolve(el);
      }

      log.dim('debug');

      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          cleanup();
          log.dim(`waitForElement: "${selector}" appeared`);
          resolve(found);
        }
      });

      const cleanup = () => {
        observer.disconnect();
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };

      abortSignal?.addEventListener('abort', onAbort);

      observer.observe(document.body, { childList: true, subtree: true });

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout (${timeoutMs}ms): "${selector}" not found`));
      }, timeoutMs);
    });
  }

  function setReactValue(el, value) {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    nativeSetter.call(el, String(value));
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getNextPageProps() {
    return window.__NEXT_DATA__?.props?.pageProps ?? null;
  }

  function pickFavoriteGroupFromNextData() {
    const pageProps = getNextPageProps();
    const ticketInfoList = pageProps?.eventDetail?.ticketInfoList ?? [];

    const pickFromOptions = options => {
      if (!Array.isArray(options)) return '';
      for (const option of options) {
        if (option && typeof option === 'object') {
          if (option.hidden === true) continue;
          const value = String(option.value ?? option.label ?? '').trim();
          if (value) return value;
          continue;
        }
        const value = String(option ?? '').trim();
        if (value) return value;
      }
      return '';
    };

    for (const info of ticketInfoList) {
      const merged = [...(info?.customizeList ?? []), ...(info?.customize ?? [])];
      for (const field of merged) {
        const value = pickFromOptions(field?.selectOptions);
        if (value) return value;
      }
    }

    const stages = pageProps?.eventDetail?.stages ?? [];
    for (const stage of stages) {
      const value = pickFromOptions(stage?.favoriteSelections?.selectOptions);
      if (value) return value;
    }

    return '';
  }

  function collectFavoriteGroupsFromNextData() {
    const pageProps = getNextPageProps();
    const ticketInfoList = pageProps?.eventDetail?.ticketInfoList ?? [];
    const set = new Set();

    const pushFromOptions = options => {
      if (!Array.isArray(options)) return;
      for (const option of options) {
        if (option && typeof option === 'object') {
          if (option.hidden === true) continue;
          const value = String(option.value ?? option.label ?? '').trim();
          if (value) set.add(value);
          continue;
        }
        const value = String(option ?? '').trim();
        if (value) set.add(value);
      }
    };

    for (const info of ticketInfoList) {
      const merged = [...(info?.customizeList ?? []), ...(info?.customize ?? [])];
      for (const field of merged) {
        pushFromOptions(field?.selectOptions);
      }
    }

    const stages = pageProps?.eventDetail?.stages ?? [];
    for (const stage of stages) {
      pushFromOptions(stage?.favoriteSelections?.selectOptions);
    }

    return Array.from(set);
  }

  function resolveFavoriteGroup(log) {
    const manual = String(CONFIG.event.favoriteGroup ?? '').trim();
    if (manual) return manual;
    if (!CONFIG.event.favoriteGroupAuto) return '';

    const auto = pickFavoriteGroupFromNextData();
    if (auto) log.info(`favorite group auto selected from __NEXT_DATA__: ${auto}`);
    else log.warn('favorite group could not be resolved from __NEXT_DATA__');
    return auto;
  }

  function toInt(value, fallback, min, max) {
    const n = Number.parseInt(String(value), 10);
    if (Number.isNaN(n)) return fallback;
    if (typeof min === 'number' && n < min) return min;
    if (typeof max === 'number' && n > max) return max;
    return n;
  }

  function toBool(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value === 'true') return true;
      if (value === 'false') return false;
    }
    return fallback;
  }

  function exportCurrentSettings() {
    return {
      common: {
        startDate: CONFIG.common.startDate,
        startTime: CONFIG.common.startTime,
      },
      event: {
        ticketCount: CONFIG.event.ticketCount,
        autoClick: CONFIG.event.autoClick,
        waitMs: CONFIG.event.waitMs,
        favoriteGroup: CONFIG.event.favoriteGroup,
        favoriteGroupAuto: CONFIG.event.favoriteGroupAuto,
      },
      apply: {
        lastName: CONFIG.apply.lastName,
        firstName: CONFIG.apply.firstName,
        phoneNumber: CONFIG.apply.phoneNumber,
        stepDelayMs: CONFIG.apply.stepDelayMs,
        autoSubmit: CONFIG.apply.autoSubmit,
      },
    };
  }

  function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const commonSrc = src.common && typeof src.common === 'object' ? src.common : {};
    const eventSrc = src.event && typeof src.event === 'object' ? src.event : {};
    const applySrc = src.apply && typeof src.apply === 'object' ? src.apply : {};

    return {
      common: (() => {
        const rawDate = String(commonSrc.startDate ?? '').trim();
        const rawTime = String(commonSrc.startTime ?? '').trim();
        const legacy = String(commonSrc.startAt ?? '').trim();
        if (!legacy) return { startDate: rawDate, startTime: rawTime };
        if (rawDate || rawTime) return { startDate: rawDate, startTime: rawTime };
        const normalized = legacy.replace('T', ' ').replace(/\//g, '-');
        const m = normalized.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}(?::\d{2})?)$/);
        if (m) return { startDate: m[1], startTime: m[2] };
        const t = normalized.match(/^(\d{1,2}:\d{2}(?::\d{2})?)$/);
        if (t) return { startDate: '', startTime: t[1] };
        return { startDate: rawDate, startTime: rawTime };
      })(),
      event: {
        ticketCount: toInt(eventSrc.ticketCount, 1, 1, 10),
        autoClick: toBool(eventSrc.autoClick, true),
        waitMs: toInt(eventSrc.waitMs, 300, 0, 30000),
        favoriteGroup: String(eventSrc.favoriteGroup ?? '').trim(),
        favoriteGroupAuto: toBool(eventSrc.favoriteGroupAuto, true),
      },
      apply: {
        lastName: String(applySrc.lastName ?? '').trim(),
        firstName: String(applySrc.firstName ?? '').trim(),
        phoneNumber: String(applySrc.phoneNumber ?? ''),
        stepDelayMs: toInt(applySrc.stepDelayMs, 150, 0, 5000),
        autoSubmit: toBool(applySrc.autoSubmit, false),
      },
    };
  }

  function applySettingsToConfig(settings) {
    const normalized = normalizeSettings(settings);

    CONFIG.common.startDate = normalized.common.startDate;
    CONFIG.common.startTime = normalized.common.startTime;
    CONFIG.event.ticketCount = normalized.event.ticketCount;
    CONFIG.event.autoClick = normalized.event.autoClick;
    CONFIG.event.waitMs = normalized.event.waitMs;
    CONFIG.event.favoriteGroup = normalized.event.favoriteGroup;
    CONFIG.event.favoriteGroupAuto = normalized.event.favoriteGroupAuto;

    CONFIG.apply.lastName = normalized.apply.lastName;
    CONFIG.apply.firstName = normalized.apply.firstName;
    CONFIG.apply.phoneNumber = normalized.apply.phoneNumber;
    CONFIG.apply.stepDelayMs = normalized.apply.stepDelayMs;
    CONFIG.apply.autoSubmit = normalized.apply.autoSubmit;
  }

  function loadSettingsFromStorage() {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveSettingsToStorage(settings) {
    const normalized = normalizeSettings(settings);
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function initSettings(log) {
    const saved = loadSettingsFromStorage();
    if (!saved) {
      saveSettingsToStorage(exportCurrentSettings());
      return;
    }
    applySettingsToConfig(saved);
    log.info('settings loaded from localStorage');
  }

  function mountSettingsPanel() {
    if (window.__TD_SETTINGS_UI_MOUNTED__) return;
    window.__TD_SETTINGS_UI_MOUNTED__ = true;

    const root = document.createElement('div');
    root.id = 'td-settings-root';
    root.style.position = 'fixed';
    root.style.right = '16px';
    root.style.bottom = '16px';
    root.style.zIndex = '2147483647';
    root.style.fontFamily = 'system-ui, -apple-system, Segoe UI, sans-serif';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = 'TD Settings';
    toggle.style.border = '0';
    toggle.style.borderRadius = '999px';
    toggle.style.padding = '10px 14px';
    toggle.style.cursor = 'pointer';
    toggle.style.background = '#111';
    toggle.style.color = '#fff';
    toggle.style.boxShadow = '0 6px 20px rgba(0,0,0,0.3)';

    const panel = document.createElement('div');
    panel.style.display = 'none';
    panel.style.marginTop = '10px';
    panel.style.width = '340px';
    panel.style.maxHeight = '70vh';
    panel.style.overflow = 'auto';
    panel.style.background = '#fff';
    panel.style.color = '#111';
    panel.style.border = '1px solid #ddd';
    panel.style.borderRadius = '12px';
    panel.style.padding = '12px';
    panel.style.boxShadow = '0 10px 30px rgba(0,0,0,0.2)';

    const createSection = title => {
      const section = document.createElement('div');
      section.style.border = '1px solid #eee';
      section.style.borderRadius = '10px';
      section.style.padding = '10px';
      section.style.marginBottom = '10px';

      const heading = document.createElement('div');
      heading.textContent = title;
      heading.style.fontWeight = '700';
      heading.style.fontSize = '12px';
      heading.style.marginBottom = '8px';
      section.appendChild(heading);

      panel.appendChild(section);
      return section;
    };

    const inputSection = createSection('Input Settings');
    const delaySection = createSection('Delay / Time Settings');

    const fieldRows = [];
    const addField = (key, label, type, container = panel) => {
      const row = document.createElement('label');
      row.style.display = 'block';
      row.style.marginBottom = '8px';
      row.style.fontSize = '12px';

      const title = document.createElement('div');
      title.textContent = label;
      title.style.marginBottom = '4px';
      row.appendChild(title);

      const input = document.createElement('input');
      input.type = type;
      input.dataset.key = key;
      if (type !== 'checkbox') {
        input.style.width = '100%';
        input.style.boxSizing = 'border-box';
        input.style.padding = '6px 8px';
      }
      row.appendChild(input);
      container.appendChild(row);
      fieldRows.push(input);
      return input;
    };

    const addSelectField = (key, label, container = panel) => {
      const row = document.createElement('label');
      row.style.display = 'block';
      row.style.marginBottom = '8px';
      row.style.fontSize = '12px';

      const title = document.createElement('div');
      title.textContent = label;
      title.style.marginBottom = '4px';
      row.appendChild(title);

      const select = document.createElement('select');
      select.dataset.key = key;
      select.style.width = '100%';
      select.style.boxSizing = 'border-box';
      select.style.padding = '6px 8px';
      row.appendChild(select);
      container.appendChild(row);
      fieldRows.push(select);
      return select;
    };

    addField('event.ticketCount', 'ticketCount', 'number', inputSection);
    addField('event.autoClick', 'autoClick', 'checkbox', inputSection);
    const favoriteGroupSelect = addSelectField('event.favoriteGroup', 'favoriteGroup', inputSection);
    addField('event.favoriteGroupAuto', 'favoriteGroupAuto', 'checkbox', inputSection);

    addField('apply.lastName', 'lastName value', 'text', inputSection);
    addField('apply.firstName', 'firstName value', 'text', inputSection);
    addField('apply.phoneNumber', 'phoneNumber value', 'text', inputSection);
    addField('apply.autoSubmit', 'autoSubmit', 'checkbox', inputSection);

    addField('common.startDate', 'startDate (YYYY-MM-DD)', 'date', delaySection);
    addField('common.startTime', 'startTime (HH:mm:ss)', 'time', delaySection);
    addField('event.waitMs', 'waitMs', 'number', delaySection);
    addField('apply.stepDelayMs', 'stepDelayMs', 'number', delaySection);

    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.gap = '8px';
    controls.style.marginTop = '10px';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.style.flex = '1';
    saveBtn.style.padding = '8px';
    saveBtn.style.cursor = 'pointer';

    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.textContent = 'Reload';
    reloadBtn.style.flex = '1';
    reloadBtn.style.padding = '8px';
    reloadBtn.style.cursor = 'pointer';

    controls.appendChild(saveBtn);
    controls.appendChild(reloadBtn);
    panel.appendChild(controls);

    const status = document.createElement('div');
    status.style.marginTop = '8px';
    status.style.fontSize = '11px';
    status.style.color = '#555';
    panel.appendChild(status);

    const populateFavoriteGroupSelect = selectedValue => {
      const options = collectFavoriteGroupsFromNextData();
      favoriteGroupSelect.innerHTML = '';

      const autoOption = document.createElement('option');
      autoOption.value = '';
      autoOption.textContent = '(auto)';
      favoriteGroupSelect.appendChild(autoOption);

      options.forEach(value => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        favoriteGroupSelect.appendChild(option);
      });

      const target = selectedValue == null ? '' : String(selectedValue);
      if (target && !options.includes(target)) {
        const customOption = document.createElement('option');
        customOption.value = target;
        customOption.textContent = `${target} (custom)`;
        favoriteGroupSelect.appendChild(customOption);
      }
      favoriteGroupSelect.value = target;
    };

    const readFromConfigToPanel = () => {
      const current = exportCurrentSettings();
      populateFavoriteGroupSelect(current.event.favoriteGroup);
      fieldRows.forEach(input => {
        const key = input.dataset.key;
        const value = key.split('.').reduce((obj, seg) => (obj == null ? undefined : obj[seg]), current);
        if (input.type === 'checkbox') input.checked = value === true;
        else input.value = value == null ? '' : String(value);
      });
    };

    const readFromPanelToSettings = () => {
      const settings = exportCurrentSettings();
      fieldRows.forEach(input => {
        const key = input.dataset.key;
        const path = key.split('.');
        let cursor = settings;
        for (let i = 0; i < path.length - 1; i += 1) {
          const seg = path[i];
          if (!cursor[seg] || typeof cursor[seg] !== 'object') cursor[seg] = {};
          cursor = cursor[seg];
        }
        const last = path[path.length - 1];
        cursor[last] = input.type === 'checkbox' ? input.checked : input.value;
      });
      return settings;
    };

    toggle.addEventListener('click', () => {
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      if (!open) readFromConfigToPanel();
    });

    saveBtn.addEventListener('click', () => {
      const fromPanel = readFromPanelToSettings();
      const saved = saveSettingsToStorage(fromPanel);
      applySettingsToConfig(saved);
      status.textContent = `saved: ${new Date().toLocaleString()}`;
    });

    reloadBtn.addEventListener('click', () => {
      const saved = loadSettingsFromStorage();
      if (!saved) {
        status.textContent = 'no saved settings';
        return;
      }
      applySettingsToConfig(saved);
      readFromConfigToPanel();
      status.textContent = 'reloaded from storage';
    });

    root.appendChild(toggle);
    root.appendChild(panel);
    document.body.appendChild(root);
  }

  // ============================================================
  //
  // ============================================================
  let lastHref = location.href;
  let currentAbortController = null;
  let currentStartTimer = null;

  function setupNavigationHook() {
    //
    if (window.__TD_NAV_HOOKED__) return;
    window.__TD_NAV_HOOKED__ = true;

    const log = createLogger('nav');
    log.info('info');

    const emit = (type) => {
      const newHref = location.href;
      //
      if (newHref === lastHref) {
        log.dim('debug');
        return;
      }
      lastHref = newHref;
      log.info('info');
      window.dispatchEvent(new CustomEvent('td:navigation', { detail: { type, href: newHref } }));
    };

    //
    const origPushState = history.pushState;
    history.pushState = function (...args) {
      const result = origPushState.apply(this, args);
      emit('pushState');
      return result;
    };

    //
    const origReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const result = origReplaceState.apply(this, args);
      emit('replaceState');
      return result;
    };

    //
    window.addEventListener('popstate', () => emit('popstate'));

    //
    window.addEventListener('td:navigation', () => {
      runRouter();
    });
  }

  // ============================================================
  //
  // ============================================================
  async function runEvent(abortSignal) {
    const log = createLogger('event');
    const step = createStepLogger(log, 'event');
    const SEL_SELECT = '[class*="TicketTypeCard_numberSelector"]';
    const SEL_BUTTON = '[class*="Button_rectMain"]';
    step.start('0', 'event flow started');

    log.dim('sanitized');
    log.dim('debug');

    //
    const selectBtn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.trim() === '選択する');
    step.start('0.1', 'check/open ticket select modal');
    if (selectBtn) {
      log.info('info');
      selectBtn.click();
      log.ok('ticket select modal opened');
      step.ok('0.1', 'ticket select modal opened');
      await sleep(500);
    } else {
      step.skip('0.1', 'ticket select modal button not found');
    }

    //
    step.start('0.2', 'dump ticket info from __NEXT_DATA__');
    logTicketInfo(log);
    logInputCandidates(log);
    logFormSchema(log);
    step.ok('0.2', 'ticket info logged');

    //
    const favoriteGroup = resolveFavoriteGroup(log);
    if (favoriteGroup) {
      step.start('0.5', 'try favorite group select');
      log.info('info');
      const customizeSelects = document.querySelectorAll('select');
      let favoriteMatched = false;
      for (const sel of customizeSelects) {
        const options = Array.from(sel.options);
        const targetOption = options.find(o => o.value === favoriteGroup || o.text === favoriteGroup);
        if (targetOption) {
          log.group('debug');
          console.log('debug');
          console.log('debug');
          log.table(options.map(o => ({ value: o.value, text: o.text, selected: o.selected })));
          log.groupEnd();

          setReactValue(sel, targetOption.value);
          log.ok(`favorite group set: "${favoriteGroup}"`);
          step.ok('0.5', `favorite group selected: ${favoriteGroup}`);
          favoriteMatched = true;
          await sleep(300);
          break;
        }
      }
      if (!favoriteMatched) {
        step.skip('0.5', `favorite group not found: ${favoriteGroup}`);
      }
    } else {
      step.skip('0.5', 'favorite group config is empty');
    }

    //
    step.start('1', 'wait for ticket count selector');
    log.info('info');
    let selectEl;
    try {
      selectEl = await waitForElement(SEL_SELECT, CONFIG.common.timeoutMs, log, abortSignal);
      step.ok('1', 'ticket count selector found');
    } catch (e) {
      if (e.name === 'AbortError') { step.skip('1', 'aborted while waiting selector'); log.warn('aborted while waiting selector'); return; }
      step.fail('1', e.message);
      log.error(e.message);
      return;
    }

    //
    const options = Array.from(selectEl.options).map(o => ({
      value: o.value,
      text: o.text,
      hidden: o.hidden,
      selected: o.selected,
    }));
    log.dim('sanitized');
    console.log('debug');
    console.log('debug');
    console.log('disabled:', selectEl.disabled);
    log.table(options);
    log.groupEnd();

    //
    const count = CONFIG.event.ticketCount;
    const validValues = options.filter(o => o.value !== '0').map(o => o.value);
    step.start('2', `validate ticket count: ${count}`);
    log.info('info');
    if (!validValues.includes(String(count))) {
      step.fail('2', `invalid ticket count: ${count}`);
      log.error(`invalid ticket count: ${count}`);
      return;
    }
    step.ok('2', `ticket count is valid: ${count}`);

    //
    step.start('3', 'set ticket count');
    setReactValue(selectEl, count);
    log.ok('ok');
    step.ok('3', `ticket count applied: ${selectEl.value}`);

    //
    if (!CONFIG.event.autoClick) {
      step.skip('4', 'autoClick disabled');
      step.done('event flow completed without button click');
      log.dim('sanitized');
      return;
    }

    //
    step.start('4', 'wait for apply button');
    log.info('info');
    let btnEl;
    try {
      btnEl = await waitForElement(SEL_BUTTON, CONFIG.common.timeoutMs, log, abortSignal);
      step.ok('4', 'apply button found');
    } catch (e) {
      if (e.name === 'AbortError') { step.skip('4', 'aborted while waiting button'); log.warn('aborted while waiting button'); return; }
      step.fail('4', e.message);
      log.error(e.message);
      return;
    }

    //
    log.dim('sanitized');
    console.log('debug');
    console.log('debug');
    console.log('disabled:', btnEl.disabled);
    console.log('className:', btnEl.className);
    log.groupEnd();

    //
    if (btnEl.disabled) {
      step.fail('5', 'apply button is disabled');
      log.dim('sanitized');
      return;
    }

    //
    step.start('5', `wait before button click: ${CONFIG.event.waitMs}ms`);
    log.info('info');
    await sleep(CONFIG.event.waitMs);

    //
    if (abortSignal?.aborted) {
      step.skip('5', 'aborted before click');
      log.warn('aborted before click');
      return;
    }

    btnEl.click();
    log.dim('sanitized');
    step.ok('5', 'apply button clicked');
    step.done('event flow completed');
  }

  function logTicketInfo(log) {
    try {
      const pageProps = window.__NEXT_DATA__?.props?.pageProps;
      const ticketInfoList = pageProps?.eventDetail?.ticketInfoList ?? [];
      log.group('debug');
      ticketInfoList.forEach((info, i) => {
        console.group(`[${i}] ${info.name} (id: ${info.id})`);
        console.log('debug');
        console.log('debug');
        log.table(
          info.ticketTypes?.map(t => ({
            id: t.id,
            name: t.name,
            price: `¥${t.price}`,
            fee: `¥${t.fee}`,
            maxNum: t.maxNumPerApply,
            status: t.status,
            type: t.type,
          }))
        );
        console.groupEnd();
      });
      log.groupEnd();
    } catch (e) {
      log.warn('warn');
    }
  }

  // ============================================================
  //
  // ============================================================
  function collectInputCandidates() {
    const pageProps = window.__NEXT_DATA__?.props?.pageProps;
    if (!pageProps) return [];

    const candidates = [];
    const seen = new Set();

    const isObject = v => v && typeof v === 'object';
    const pickFirst = (obj, keys) => {
      for (const k of keys) {
        if (obj && obj[k] != null) return obj[k];
      }
      return null;
    };
    const getOptionsArray = obj =>
      (Array.isArray(obj?.options) && obj.options) ||
      (Array.isArray(obj?.choices) && obj.choices) ||
      (Array.isArray(obj?.items) && obj.items) ||
      (Array.isArray(obj?.values) && obj.values) ||
      null;

    const pushCandidate = (path, obj) => {
      const label = String(pickFirst(obj, ['label', 'title', 'question', 'name']) ?? '');
      const type = String(pickFirst(obj, ['type', 'inputType', 'format', 'answerType']) ?? '');
      const required = pickFirst(obj, ['required', 'isRequired', 'mandatory']);
      const optionsArr = getOptionsArray(obj);
      const optionsPreview = optionsArr
        ? optionsArr
            .slice(0, 5)
            .map(o => (isObject(o) ? (o.label ?? o.title ?? o.name ?? o.value ?? o.id) : o))
            .filter(v => v != null)
            .map(v => String(v))
            .join(', ')
        : '';

      const key = `${path}|${label}|${type}`;
      if (!label && !type && !optionsArr) return;
      if (seen.has(key)) return;
      seen.add(key);

      candidates.push({
        path,
        label,
        type,
        required: required === true ? true : required === false ? false : '',
        options: optionsArr ? optionsArr.length : '',
        preview: optionsPreview,
      });
    };

    const stack = [{ path: 'pageProps', value: pageProps }];
    while (stack.length) {
      const { path, value } = stack.pop();
      if (!isObject(value)) continue;

      if (Array.isArray(value)) {
        value.forEach((v, i) => {
          stack.push({ path: `${path}[${i}]`, value: v });
        });
        continue;
      }

      const keys = Object.keys(value);
      const hasLabel = keys.some(k => ['label', 'title', 'question', 'name'].includes(k));
      const hasType = keys.some(k => ['type', 'inputType', 'format', 'answerType'].includes(k));
      const hasOptions = keys.some(k => ['options', 'choices', 'items', 'values'].includes(k));
      const hasRequired = keys.some(k => ['required', 'isRequired', 'mandatory'].includes(k));

      if ((hasLabel && hasType) || (hasLabel && hasOptions) || (hasType && hasOptions) || (hasLabel && hasRequired)) {
        pushCandidate(path, value);
      }

      for (const k of keys) {
        if (k.startsWith('_')) continue;
        stack.push({ path: `${path}.${k}`, value: value[k] });
      }
    }

    return candidates;
  }

  function logInputCandidates(log) {
    const candidates = collectInputCandidates();
    window.__TD_INPUT_CANDIDATES__ = candidates;
    if (!candidates.length) {
      log.dim('__NEXT_DATA__ input candidates: none');
      return;
    }
    log.dim('sanitized');
    log.table(candidates);
    log.groupEnd();
  }

  // ============================================================
  //
  //
  // ============================================================
  function collectFormSchemaFromNextData() {
    const pageProps = window.__NEXT_DATA__?.props?.pageProps;
    if (!pageProps) return { formDictionary: [], customizeFields: [] };

    const formDictionary = Object.entries(pageProps?.messages?.form ?? {})
      .filter(([, v]) => typeof v === 'string')
      .map(([key, label]) => ({ key, label }));

    const ticketInfoList = pageProps?.eventDetail?.ticketInfoList ?? [];
    const customizeFields = [];
    const seen = new Set();

    ticketInfoList.forEach(info => {
      const merged = [...(info?.customizeList ?? []), ...(info?.customize ?? [])];
      merged.forEach(field => {
        if (!field || typeof field !== 'object') return;
        const label = String(field.label ?? field.title ?? field.name ?? '').trim();
        const type = String(field.type ?? field.inputType ?? '').trim() || (Array.isArray(field.selectOptions) ? 'select' : '');
        const required = field.required === true;
        const placeholder = String(field.placeholder ?? '');
        const options = Array.isArray(field.selectOptions)
          ? field.selectOptions
              .map(o => (o && typeof o === 'object' ? String(o.value ?? o.label ?? '') : String(o)))
              .filter(v => v)
          : [];

        const uniq = `${info?.id ?? ''}|${label}|${type}|${options.join('|')}`;
        if (!label || seen.has(uniq)) return;
        seen.add(uniq);

        customizeFields.push({
          ticketInfoId: info?.id ?? '',
          ticketInfoName: info?.name ?? '',
          label,
          type,
          required,
          placeholder,
          optionsCount: options.length,
          optionsPreview: options.slice(0, 6).join(', '),
        });
      });
    });

    return { formDictionary, customizeFields };
  }

  function collectDomFormFields() {
    const fields = [];
    const nodes = document.querySelectorAll('input, select, textarea');
    nodes.forEach((el, idx) => {
      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? (el.getAttribute('type') || 'text') : tag;
      const name = el.getAttribute('name') || '';
      const id = el.getAttribute('id') || '';
      const required = el.required === true || el.getAttribute('aria-required') === 'true';
      const placeholder = el.getAttribute('placeholder') || '';
      const value = type === 'password' ? '' : (el.value ?? '');

      let optionsCount = '';
      let optionsPreview = '';
      if (tag === 'select') {
        const opts = Array.from(el.options)
          .map(o => o.textContent?.trim() || o.value)
          .filter(v => v);
        optionsCount = opts.length;
        optionsPreview = opts.slice(0, 6).join(', ');
      }

      fields.push({
        index: idx,
        tag,
        type,
        name,
        id,
        required,
        placeholder,
        valuePreview: String(value).slice(0, 40),
        optionsCount,
        optionsPreview,
      });
    });
    return fields;
  }

  function logFormSchema(log) {
    const fromNextData = collectFormSchemaFromNextData();
    const domFields = collectDomFormFields();
    const schema = {
      capturedAt: new Date().toISOString(),
      path: location.pathname,
      ...fromNextData,
      domFields,
    };

    window.__TD_FORM_SCHEMA__ = schema;

    log.group('form schema summary');
    console.log('window.__TD_FORM_SCHEMA__ saved');
    if (schema.formDictionary.length) log.table(schema.formDictionary);
    else log.dim('formDictionary: none');
    if (schema.customizeFields.length) log.table(schema.customizeFields);
    else log.dim('customizeFields: none');
    if (schema.domFields.length) log.table(schema.domFields);
    else log.dim('domFields: none');
    log.groupEnd();
  }

  // ============================================================
  //
  // ============================================================
  async function runApply(abortSignal) {
    const log = createLogger('apply');
    const step = createStepLogger(log, 'apply');

    step.start('0', 'apply flow started');
    log.dim('sanitized');
    log.dim('sanitized');
    log.table({
      lastName: CONFIG.apply.lastName,
      firstName: CONFIG.apply.firstName,
      phoneNumber: CONFIG.apply.phoneNumber,
      autoSubmit: CONFIG.apply.autoSubmit ? 'enabled' : 'disabled',
    });
    log.groupEnd();

    //
    step.start('1', 'wait for apply form hydration');
    log.info('info');
    try {
      await waitForElement('input[name="lastName"]', CONFIG.common.timeoutMs, log, abortSignal);
      step.ok('1', 'apply form is ready');
      logFormSchema(log);
    } catch (e) {
      if (e.name === 'AbortError') { step.skip('1', 'aborted while waiting form'); log.warn('aborted while waiting form'); return; }
      step.fail('1', e.message);
      log.error(e.message);
      return;
    }

    //
    step.start('2', 'select konbini payment radio');
    log.info('info');
    const konbiniLabel = findRadioLabelByText('コンビニ支払い');
    if (!konbiniLabel) {
      step.fail('2', 'konbini label not found');
      log.error('konbini label not found');
      return;
    }
    const konbiniRadio = konbiniLabel.querySelector('input[type="radio"]');
    log.dim('sanitized');
    console.log('debug');
    console.log('debug');
    console.log('checked:', konbiniRadio?.checked);
    console.log('debug');
    log.groupEnd();

    if (!konbiniRadio?.checked) {
      konbiniLabel.click();
      log.ok('konbini radio clicked');
      step.ok('2', 'konbini radio clicked');
    } else {
      log.dim('sanitized');
      step.skip('2', 'konbini radio already selected');
    }
    await sleep(CONFIG.apply.stepDelayMs);

    //
    if (abortSignal?.aborted) { step.skip('2', 'aborted after radio step'); log.warn('aborted after radio step'); return; }

    //
    step.start('3', 'input lastName');
    log.info('input lastName...');
    const lastNameValue = String(CONFIG.apply.lastName ?? '').trim();
    if (!lastNameValue) {
      step.fail('3', 'lastName is required but empty in saved settings');
      return;
    }
    const lastNameEl = document.querySelector('input[name="lastName"]');
    if (!lastNameEl) {
      step.fail('3', 'lastName field not found');
      return;
    }
    setReactValue(lastNameEl, lastNameValue);
    step.ok('3', `lastName set: ${lastNameEl.value}`);
    await sleep(CONFIG.apply.stepDelayMs);

    step.start('4', 'input firstName');
    log.info('input firstName...');
    const firstNameValue = String(CONFIG.apply.firstName ?? '').trim();
    if (!firstNameValue) {
      step.fail('4', 'firstName is required but empty in saved settings');
      return;
    }
    const firstNameEl = document.querySelector('input[name="firstName"]');
    if (!firstNameEl) {
      step.fail('4', 'firstName field not found');
      return;
    }
    setReactValue(firstNameEl, firstNameValue);
    step.ok('4', `firstName set: ${firstNameEl.value}`);
    await sleep(CONFIG.apply.stepDelayMs);

    step.start('5', 'input phoneNumber');
    log.info('input phoneNumber...');
    const phoneNumberValue = String(CONFIG.apply.phoneNumber ?? '').trim();
    if (!phoneNumberValue) {
      step.fail('5', 'phoneNumber is required but empty in saved settings');
      return;
    }
    const phoneEl = document.querySelector('input[name="phoneNumber"]');
    if (!phoneEl) {
      step.fail('5', 'phoneNumber field not found');
      return;
    }
    setReactValue(phoneEl, phoneNumberValue);
    step.ok('5', `phoneNumber set: ${phoneEl.value}`);
    await sleep(CONFIG.apply.stepDelayMs);
    step.start('6', 'verify final input state');
    log.dim('sanitized');
    log.table({
      konbini: {
        checked: findRadioLabelByText('コンビニ支払い')?.className?.includes('containerActive'),
      },
      lastName: { value: document.querySelector('input[name="lastName"]')?.value },
      firstName: { value: document.querySelector('input[name="firstName"]')?.value },
      phoneNumber: { value: document.querySelector('input[name="phoneNumber"]')?.value },
    });
    log.groupEnd();
    log.ok('all input completed');
    step.ok('6', 'all input fields verified');

    //
    step.start('7', 'process submit button');
    log.info('info');
    const submitBtn = findButtonByText('申し込みを完了する');
    if (!submitBtn) {
      step.fail('7', 'submit button not found');
      log.error('submit button not found');
      return;
    }

    log.dim('sanitized');
    console.log('debug');
    console.log('disabled:', submitBtn.disabled);
    console.log('className:', submitBtn.className);
    log.groupEnd();

    if (submitBtn.disabled) {
      step.fail('7', 'submit button is disabled');
      log.error('submit button is disabled');
      return;
    }

    if (!CONFIG.apply.autoSubmit) {
      //
      step.skip('7', 'autoSubmit disabled (test mode)');
      log.dim('sanitized');
      log.ok('apply flow completed in test mode');
      step.done('apply flow completed in test mode');
      return;
    }

    //
    log.info('info');
    clickButton(submitBtn);
    log.dim('sanitized');
    step.ok('7', 'submit button clicked');
    step.done('apply flow completed');
  }

  function findRadioLabelByText(text) {
    const labels = document.querySelectorAll('label');
    return Array.from(labels).find(l => l.textContent.trim().includes(text)) || null;
  }

  function findButtonByText(text) {
    const buttons = document.querySelectorAll('button[type="button"]');
    return Array.from(buttons).find(b => b.textContent.trim() === '申し込みを完了する') || null;
  }

  function clickButton(btn) {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  function parseStartDateTimeToDate(startDateText, startTimeText, now = new Date()) {
    const dateText = String(startDateText ?? '').trim();
    const timeText = String(startTimeText ?? '').trim();
    if (!timeText) return null;

    const mt = timeText.match(/^(\\d{1,2}):(\\d{2})(?::(\\d{2}))?$/);
    if (!mt) return null;

    const h = Number.parseInt(mt[1], 10);
    const mi = Number.parseInt(mt[2], 10);
    const s = Number.parseInt(mt[3] ?? '0', 10);
    if (h > 23 || mi > 59 || s > 59) return null;

    let target;
    if (dateText) {
      const md = dateText.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
      if (!md) return null;
      const y = Number.parseInt(md[1], 10);
      const m = Number.parseInt(md[2], 10) - 1;
      const d = Number.parseInt(md[3], 10);
      target = new Date(y, m, d, h, mi, s, 0);
    } else {
      target = new Date(now.getTime());
      target.setHours(h, mi, s, 0);
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    }

    if (Number.isNaN(target.getTime())) return null;
    return target;
  }

  function getStartDelayMs(startDateText, startTimeText) {
    const target = parseStartDateTimeToDate(startDateText, startTimeText);
    if (!target) return 0;
    return Math.max(0, target.getTime() - Date.now());
  }

// ============================================================
  //
  // ============================================================
  const routes = [
    { test: p => /^\/event\/[^/]+\/apply\/?$/.test(p), run: runApply },
    { test: p => /^\/event\/[^/]+\/?$/.test(p), run: runEvent },
  ];

  function runRouter() {
    const log = createLogger('router');
    const step = createStepLogger(log, 'router');
    const path = location.pathname;
    step.start('1', `route evaluate: ${path}`);

    //
    if (currentAbortController) {
      log.dim('debug');
      currentAbortController.abort();
      step.ok('1', 'previous flow aborted');
    }
    if (currentStartTimer) {
      clearTimeout(currentStartTimer);
      currentStartTimer = null;
    }
    currentAbortController = new AbortController();

    for (const route of routes) {
      if (route.test(path)) {
        log.info('info');
        step.ok('1', `route matched: ${path}`);
        const delayMs = getStartDelayMs(CONFIG.common.startDate, CONFIG.common.startTime);
        if (delayMs > 0) {
          step.skip('1', `scheduled start in ${delayMs}ms`);
          log.warn('start schedule active: waiting ' + delayMs + 'ms until ' + CONFIG.common.startDate + ' ' + CONFIG.common.startTime);
          currentStartTimer = setTimeout(() => {
            currentStartTimer = null;
            if (currentAbortController?.signal?.aborted) return;
            route.run(currentAbortController.signal);
          }, delayMs);
        } else {
          route.run(currentAbortController.signal);
        }
        return;
      }
    }
    step.skip('1', `no route target: ${path}`);
    log.dim('debug');
  }

  // ============================================================
  //
  // ============================================================
  const bootLog = createLogger('boot');
  initSettings(bootLog);
  mountSettingsPanel();
  setupNavigationHook();
  runRouter();
})();








