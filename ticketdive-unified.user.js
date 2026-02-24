// ==UserScript==
// @name         TicketDive 自動申し込み（SPA対応）
// @namespace    https://ticketdive.com/
// @version      2.1.0
// @description  枚数を自動選択して申し込みボタンをクリックし、フォームを自動入力する（Next.js SPA遷移対応）
// @match        https://ticketdive.com/event/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // ============================================================
  // ★ 設定 ここを変更してください
  // ============================================================
  const CONFIG = {
    common: {
      timeoutMs: 15000,  // 要素待機タイムアウト上限(ms)
      debug: true,       // デバッグログ出力
    },
    event: {
      ticketCount: 1,    // 購入枚数（1〜4）
      autoClick: true,   // true: ボタン自動クリック / false: 選択だけして止まる
      waitMs: 300,       // 枚数セット後、クリックまでの遅延(ms)
      favoriteGroup: '柊 優花', // お目当てグループ（必須項目がある場合）
    },
    apply: {
      lastName: '山田',          // 姓
      firstName: '太郎',         // 名
      phoneNumber: '09012345678', // 電話番号（ハイフンなし）
      stepDelayMs: 150,          // 各操作間の遅延(ms)
      autoSubmit: false,         // true: 申し込み完了ボタンを自動クリック / false: テストモード（ログのみ）
    },
  };

  // ============================================================
  // 共通ユーティリティ
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
  // キャンセル可能な要素待機
  // ============================================================
  function waitForElement(selector, timeoutMs, log, abortSignal) {
    return new Promise((resolve, reject) => {
      // すでにキャンセル済みならすぐ終了
      if (abortSignal?.aborted) {
        return reject(new DOMException('Aborted', 'AbortError'));
      }

      const el = document.querySelector(selector);
      if (el) {
        log.dim(`waitForElement: "${selector}" 即時発見`);
        return resolve(el);
      }

      log.dim(`waitForElement: "${selector}" MutationObserver で待機中...`);

      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          cleanup();
          log.dim(`waitForElement: "${selector}" 出現検知`);
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
        reject(new Error(`タイムアウト(${timeoutMs}ms): "${selector}" が見つかりません`));
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

  // ============================================================
  // SPA遷移監視（history.pushState/replaceState フック）
  // ============================================================
  let lastHref = location.href;
  let currentAbortController = null;

  function setupNavigationHook() {
    // フック登録は1回だけ
    if (window.__TD_NAV_HOOKED__) return;
    window.__TD_NAV_HOOKED__ = true;

    const log = createLogger('nav');
    log.info('SPA遷移フックを登録');

    const emit = (type) => {
      const newHref = location.href;
      // 同一URLなら無視（重複実行防止）
      if (newHref === lastHref) {
        log.dim(`同一URL遷移をスキップ: ${type}`);
        return;
      }
      lastHref = newHref;
      log.info(`遷移検知: ${type} → ${newHref}`);
      window.dispatchEvent(new CustomEvent('td:navigation', { detail: { type, href: newHref } }));
    };

    // history.pushState をフック
    const origPushState = history.pushState;
    history.pushState = function (...args) {
      const result = origPushState.apply(this, args);
      emit('pushState');
      return result;
    };

    // history.replaceState をフック
    const origReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const result = origReplaceState.apply(this, args);
      emit('replaceState');
      return result;
    };

    // popstate（戻る/進むボタン）
    window.addEventListener('popstate', () => emit('popstate'));

    // カスタムイベントでルーター再実行
    window.addEventListener('td:navigation', () => {
      runRouter();
    });
  }

  // ============================================================
  // イベントページ処理 (/event/xxx)
  // ============================================================
  async function runEvent(abortSignal) {
    const log = createLogger('event');
    const step = createStepLogger(log, 'event');
    const SEL_SELECT = '[class*="TicketTypeCard_numberSelector"]';
    const SEL_BUTTON = '[class*="Button_rectMain"]';
    step.start('0', 'event flow started');

    log.info('スクリプト開始');
    log.dim('設定:', CONFIG.event);

    // 0. 「選択する」ボタンがあれば先にクリック（モーダル表示）
    const selectBtn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.trim() === '選択する');
    step.start('0.1', 'check/open ticket select modal');
    if (selectBtn) {
      log.info('⓪ 「選択する」ボタンを検出、クリックします...');
      selectBtn.click();
      log.ok('⓪ 「選択する」ボタンをクリックしました');
      step.ok('0.1', 'ticket select modal opened');
      await sleep(500); // モーダル表示待ち
    } else {
      step.skip('0.1', 'ticket select modal button not found');
    }

    // __NEXT_DATA__ からチケット情報を表示
    step.start('0.2', 'dump ticket info from __NEXT_DATA__');
    logTicketInfo(log);
    step.ok('0.2', 'ticket info logged');

    // 0.5. 「お目当てグループ」セレクトがあれば選択
    if (CONFIG.event.favoriteGroup) {
      step.start('0.5', 'try favorite group select');
      log.info('⓪.5 「お目当てグループ」セレクトを探索...');
      const customizeSelects = document.querySelectorAll('select');
      let favoriteMatched = false;
      for (const sel of customizeSelects) {
        const options = Array.from(sel.options);
        const targetOption = options.find(o => o.value === CONFIG.event.favoriteGroup || o.text === CONFIG.event.favoriteGroup);
        if (targetOption) {
          log.group('📋 お目当てグループ セレクトボックス');
          console.log('要素:', sel);
          console.log('現在値:', sel.value);
          log.table(options.map(o => ({ value: o.value, text: o.text, selected: o.selected })));
          log.groupEnd();

          setReactValue(sel, targetOption.value);
          log.ok(`⓪.5 お目当てグループを "${CONFIG.event.favoriteGroup}" に設定しました`);
          step.ok('0.5', `favorite group selected: ${CONFIG.event.favoriteGroup}`);
          favoriteMatched = true;
          await sleep(300);
          break;
        }
      }
      if (!favoriteMatched) {
        step.skip('0.5', `favorite group not found: ${CONFIG.event.favoriteGroup}`);
      }
    } else {
      step.skip('0.5', 'favorite group config is empty');
    }

    // 1. セレクトボックス待機
    step.start('1', 'wait for ticket count selector');
    log.info('① セレクトボックスの出現を待機...');
    let selectEl;
    try {
      selectEl = await waitForElement(SEL_SELECT, CONFIG.common.timeoutMs, log, abortSignal);
      step.ok('1', 'ticket count selector found');
    } catch (e) {
      if (e.name === 'AbortError') { step.skip('1', 'aborted while waiting selector'); log.warn('処理がキャンセルされました'); return; }
      step.fail('1', e.message);
      log.error(e.message);
      return;
    }

    // 2. セレクトの現在状態をログ
    const options = Array.from(selectEl.options).map(o => ({
      value: o.value,
      text: o.text,
      hidden: o.hidden,
      selected: o.selected,
    }));
    log.group('📥 セレクトボックス 現在の状態');
    console.log('要素:', selectEl);
    console.log('現在値:', selectEl.value);
    console.log('disabled:', selectEl.disabled);
    log.table(options);
    log.groupEnd();

    // 3. 枚数検証
    const count = CONFIG.event.ticketCount;
    const validValues = options.filter(o => o.value !== '0').map(o => o.value);
    step.start('2', `validate ticket count: ${count}`);
    log.info(`② 枚数検証: 指定=${count} / 選択可能=${validValues.join(', ')}`);
    if (!validValues.includes(String(count))) {
      step.fail('2', `invalid ticket count: ${count}`);
      log.error(`枚数 ${count} は無効です。スクリプトを停止します。`);
      return;
    }
    step.ok('2', `ticket count is valid: ${count}`);

    // 4. セレクトに値をセット
    step.start('3', 'set ticket count');
    setReactValue(selectEl, count);
    log.ok(`③ 枚数を ${count} に設定しました (値: ${selectEl.value})`);
    step.ok('3', `ticket count applied: ${selectEl.value}`);

    // 5. autoClick 確認
    if (!CONFIG.event.autoClick) {
      step.skip('4', 'autoClick disabled');
      step.done('event flow completed without button click');
      log.warn('autoClick=false のためボタンクリックをスキップします');
      return;
    }

    // 6. ボタン待機
    step.start('4', 'wait for apply button');
    log.info('④ 申し込みボタンの出現を待機...');
    let btnEl;
    try {
      btnEl = await waitForElement(SEL_BUTTON, CONFIG.common.timeoutMs, log, abortSignal);
      step.ok('4', 'apply button found');
    } catch (e) {
      if (e.name === 'AbortError') { step.skip('4', 'aborted while waiting button'); log.warn('処理がキャンセルされました'); return; }
      step.fail('4', e.message);
      log.error(e.message);
      return;
    }

    // 7. ボタン状態をログ
    log.group('🔘 申し込みボタン 現在の状態');
    console.log('要素:', btnEl);
    console.log('テキスト:', btnEl.textContent.trim());
    console.log('disabled:', btnEl.disabled);
    console.log('className:', btnEl.className);
    log.groupEnd();

    // 8. disabled チェック
    if (btnEl.disabled) {
      step.fail('5', 'apply button is disabled');
      log.error('ボタンが disabled のためクリックできません。スクリプトを停止します。');
      return;
    }

    // 9. 遅延してクリック
    step.start('5', `wait before button click: ${CONFIG.event.waitMs}ms`);
    log.info(`⑤ ${CONFIG.event.waitMs}ms 待機後にクリックします...`);
    await sleep(CONFIG.event.waitMs);

    // キャンセルチェック
    if (abortSignal?.aborted) {
      step.skip('5', 'aborted before click');
      log.warn('処理がキャンセルされました');
      return;
    }

    btnEl.click();
    log.ok('⑥ 申し込みボタンをクリックしました ✅');
    step.ok('5', 'apply button clicked');
    step.done('event flow completed');
  }

  function logTicketInfo(log) {
    try {
      const pageProps = window.__NEXT_DATA__?.props?.pageProps;
      const ticketInfoList = pageProps?.eventDetail?.ticketInfoList ?? [];
      log.group('📋 __NEXT_DATA__ チケット情報');
      ticketInfoList.forEach((info, i) => {
        console.group(`[${i}] ${info.name} (id: ${info.id})`);
        console.log('販売種別:', info.receptionType, '| 申込終了:', info.endApply);
        console.log('支払方法:', info.paymentChannels?.join(', '));
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
      log.warn('チケット情報の取得に失敗:', e.message);
    }
  }

  // ============================================================
  // 申し込みフォームページ処理 (/event/xxx/apply)
  // ============================================================
  async function runApply(abortSignal) {
    const log = createLogger('apply');
    const step = createStepLogger(log, 'apply');

    step.start('0', 'apply flow started');
    log.info('スクリプト開始');
    log.group('⚙️ 設定');
    log.table({
      姓: CONFIG.apply.lastName,
      名: CONFIG.apply.firstName,
      電話番号: CONFIG.apply.phoneNumber,
      autoSubmit: CONFIG.apply.autoSubmit ? '有効（本番モード）' : '無効（テストモード）',
    });
    log.groupEnd();

    // ① フォーム要素の出現を待機（ハイドレーション完了の目安）
    step.start('1', 'wait for apply form hydration');
    log.info('① フォーム要素の出現を待機...');
    try {
      await waitForElement('input[name="lastName"]', CONFIG.common.timeoutMs, log, abortSignal);
      step.ok('1', 'apply form is ready');
    } catch (e) {
      if (e.name === 'AbortError') { step.skip('1', 'aborted while waiting form'); log.warn('処理がキャンセルされました'); return; }
      step.fail('1', e.message);
      log.error(e.message);
      return;
    }

    // ② コンビニ決済ラジオボタンを選択
    step.start('2', 'select konbini payment radio');
    log.info('② コンビニ決済ラジオボタンを探索...');
    const konbiniLabel = findRadioLabelByText('コンビニ決済');
    if (!konbiniLabel) {
      step.fail('2', 'konbini label not found');
      log.error('コンビニ決済のラジオラベルが見つかりません');
      return;
    }
    const konbiniRadio = konbiniLabel.querySelector('input[type="radio"]');
    log.group('📻 コンビニ決済ラジオ 現在の状態');
    console.log('label要素:', konbiniLabel);
    console.log('input要素:', konbiniRadio);
    console.log('checked:', konbiniRadio?.checked);
    console.log('Activeクラスあり:', konbiniLabel.className.includes('containerActive'));
    log.groupEnd();

    if (!konbiniRadio?.checked) {
      konbiniLabel.click();
      log.ok('② コンビニ決済ラジオをクリックしました');
      step.ok('2', 'konbini radio clicked');
    } else {
      log.ok('② コンビニ決済はすでに選択されています（スキップ）');
      step.skip('2', 'konbini radio already selected');
    }
    await sleep(CONFIG.apply.stepDelayMs);

    // キャンセルチェック
    if (abortSignal?.aborted) { step.skip('2', 'aborted after radio step'); log.warn('処理がキャンセルされました'); return; }

    // ③ 姓の入力
    step.start('3', 'input lastName');
    log.info('③ 姓を入力...');
    const lastNameEl = document.querySelector('input[name="lastName"]');
    if (!lastNameEl) {
      step.fail('3', 'lastName field not found');
      log.error('姓フィールドが見つかりません');
      return;
    }
    log.dim('  フィールド:', lastNameEl, '/ 現在値:', lastNameEl.value);
    setReactValue(lastNameEl, CONFIG.apply.lastName);
    log.ok(`③ 姓を "${CONFIG.apply.lastName}" に設定 (確認値: "${lastNameEl.value}")`);
    step.ok('3', `lastName set: ${lastNameEl.value}`);
    await sleep(CONFIG.apply.stepDelayMs);

    // ④ 名の入力
    step.start('4', 'input firstName');
    log.info('④ 名を入力...');
    const firstNameEl = document.querySelector('input[name="firstName"]');
    if (!firstNameEl) {
      step.fail('4', 'firstName field not found');
      log.error('名フィールドが見つかりません');
      return;
    }
    log.dim('  フィールド:', firstNameEl, '/ 現在値:', firstNameEl.value);
    setReactValue(firstNameEl, CONFIG.apply.firstName);
    log.ok(`④ 名を "${CONFIG.apply.firstName}" に設定 (確認値: "${firstNameEl.value}")`);
    step.ok('4', `firstName set: ${firstNameEl.value}`);
    await sleep(CONFIG.apply.stepDelayMs);

    // ⑤ 電話番号の入力
    step.start('5', 'input phoneNumber');
    log.info('⑤ 電話番号を入力...');
    const phoneEl = document.querySelector('input[name="phoneNumber"]');
    if (!phoneEl) {
      step.fail('5', 'phoneNumber field not found');
      log.error('電話番号フィールドが見つかりません');
      return;
    }
    log.dim('  フィールド:', phoneEl, '/ 現在値:', phoneEl.value);
    setReactValue(phoneEl, CONFIG.apply.phoneNumber);
    log.ok(`⑤ 電話番号を "${CONFIG.apply.phoneNumber}" に設定 (確認値: "${phoneEl.value}")`);
    step.ok('5', `phoneNumber set: ${phoneEl.value}`);
    await sleep(CONFIG.apply.stepDelayMs);

    // ⑥ 最終状態をまとめてログ出力
    step.start('6', 'verify final input state');
    log.group('✅ 入力完了 最終状態確認');
    log.table({
      コンビニ決済: {
        checked: findRadioLabelByText('コンビニ決済')?.className?.includes('containerActive'),
      },
      姓:     { value: document.querySelector('input[name="lastName"]')?.value },
      名:     { value: document.querySelector('input[name="firstName"]')?.value },
      電話番号: { value: document.querySelector('input[name="phoneNumber"]')?.value },
    });
    log.groupEnd();
    log.ok('すべての入力が完了しました');
    step.ok('6', 'all input fields verified');

    // ⑦ 申し込み完了ボタンの処理
    step.start('7', 'process submit button');
    log.info('⑦ 申し込み完了ボタンを探索...');
    const submitBtn = findButtonByText('申し込みを完了する');
    if (!submitBtn) {
      step.fail('7', 'submit button not found');
      log.error('申し込み完了ボタンが見つかりません');
      return;
    }

    log.group('🔘 申し込み完了ボタン 現在の状態');
    console.log('要素:', submitBtn);
    console.log('disabled:', submitBtn.disabled);
    console.log('className:', submitBtn.className);
    log.groupEnd();

    if (submitBtn.disabled) {
      step.fail('7', 'submit button is disabled');
      log.error('申し込み完了ボタンが disabled のためクリックできません');
      return;
    }

    if (!CONFIG.apply.autoSubmit) {
      // テストモード
      step.skip('7', 'autoSubmit disabled (test mode)');
      log.ok('⑦ [テストモード] 申し込み完了ボタンを検出しました（クリックはスキップ）');
      log.ok('🎉 テスト成功: すべての処理が正常に完了しました');
      step.done('apply flow completed in test mode');
      return;
    }

    // 本番モード: クリック実行
    log.info('⑦ 申し込み完了ボタンをクリックします...');
    clickButton(submitBtn);
    log.ok('⑦ 申し込み完了ボタンをクリックしました ✅');
    step.ok('7', 'submit button clicked');
    step.done('apply flow completed');
  }

  function findRadioLabelByText(text) {
    const labels = document.querySelectorAll('label');
    return Array.from(labels).find(l => l.textContent.trim().includes(text)) || null;
  }

  function findButtonByText(text) {
    const buttons = document.querySelectorAll('button[type="button"]');
    return Array.from(buttons).find(b => b.textContent.trim() === text) || null;
  }

  function clickButton(btn) {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  // ============================================================
  // ルーティング
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

    // 前回の処理をキャンセル
    if (currentAbortController) {
      log.dim('前回の処理をキャンセル');
      currentAbortController.abort();
      step.ok('1', 'previous flow aborted');
    }
    currentAbortController = new AbortController();

    for (const route of routes) {
      if (route.test(path)) {
        log.info(`ルートマッチ: ${path}`);
        step.ok('1', `route matched: ${path}`);
        route.run(currentAbortController.signal);
        return;
      }
    }
    step.skip('1', `no route target: ${path}`);
    log.dim(`対象外のパス: ${path}`);
  }

  // ============================================================
  // 初期化
  // ============================================================
  setupNavigationHook();
  runRouter();
})();
