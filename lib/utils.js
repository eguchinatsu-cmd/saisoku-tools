/**
 * 共通ユーティリティ
 */

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function withTimeout(fn, ms, label) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT: ${label} - ${ms / 1000}秒超過`)), ms)),
  ]);
}

/** chrome.scripting.executeScript の world:"MAIN" ラッパー（タイムアウト付き） */
export async function execMain(tabId, func, args = [], timeoutMs = 10000) {
  const execPromise = chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
    world: 'MAIN',
  });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('execMain timeout')), timeoutMs)
  );
  const results = await Promise.race([execPromise, timeoutPromise]);
  return results?.[0]?.result;
}

/** タブ読み込み完了を待つ */
export function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** ポップアップウィンドウが最小化されていたら復元 */
export async function ensureWindowVisible(windowId) {
  if (!windowId) return;
  try {
    const win = await chrome.windows.get(windowId);
    if (win.state === 'minimized') {
      await chrome.windows.update(windowId, { state: 'normal' });
      await sleep(500);
      const focused = await chrome.windows.getLastFocused();
      if (focused?.id === windowId) {
        const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
        const other = all.find(w => w.id !== windowId);
        if (other) try { await chrome.windows.update(other.id, { focused: true }); } catch (_) {}
      }
    }
  } catch (_) {}
}

/** 背面レンダリングを再開する（Page.startScreencast + visibility override） */
export async function reEnableBackgroundMode(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
      format: 'jpeg', quality: 1, maxWidth: 1, maxHeight: 1, everyNthFrame: 30,
    });
  } catch (_) {}
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function(){Object.defineProperty(document,'hidden',{get:function(){return false},configurable:true});Object.defineProperty(document,'visibilityState',{get:function(){return 'visible'},configurable:true});})()`,
    });
  } catch (_) {}
}

/** LINE Chatのページが使用可能になるまで待つ（固定sleepの代わり） */
export async function waitForLineChatReady(tabId, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const ready = await execMain(tabId, () => {
        // チャットリストまたは検索ボックスが存在すれば準備完了
        const chatList = document.querySelector('[class*="chatlist"], [class*="ChatList"], [data-testid*="chat"]');
        const searchBox = document.querySelector('input[type="text"], input[type="search"]');
        return !!(chatList || searchBox);
      });
      if (ready) return true;
    } catch (_) {
      // ページ読み込み中のexecMainエラーは無視してリトライ
    }
    await sleep(500);
  }
  // タイムアウトしても続行（従来の固定waitと同等）
  return false;
}

/** LINE Chatの孤立ポップアップを掃除 */
export async function cleanupOrphanedPopups() {
  try {
    const all = await chrome.windows.getAll({ windowTypes: ['popup'], populate: true });
    for (const win of all) {
      const hasLine = win.tabs?.some(t => t.url?.startsWith('https://chat.line.biz/'));
      if (hasLine) {
        for (const t of win.tabs) {
          try { await chrome.debugger.detach({ tabId: t.id }); } catch (_) {}
        }
        await chrome.windows.remove(win.id);
      }
    }
  } catch (_) {}
}

// === 日付ヘルパー（JST基準） ===

function jstNow() {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC -> JST
}

export function getYesterdayJST() {
  const jst = jstNow();
  jst.setUTCDate(jst.getUTCDate() - 1);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return { year: y, month: m, day: d, formatted: `${y}-${m}-${d}` };
}

export function getFiveDaysAgoJST() {
  const jst = jstNow();
  jst.setUTCDate(jst.getUTCDate() - 5);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return { year: y, month: m, day: d, formatted: `${y}-${m}-${d}` };
}

/** 今月のタグ名を生成 (例: "仮査定後催促2026/2") ※月はゼロ埋めなし */
export function getCurrentMonthTag(prefix) {
  const jst = jstNow();
  return `${prefix}${jst.getUTCFullYear()}/${jst.getUTCMonth() + 1}`;
}

/** チャット内容がロードされるまで待つ（.chatsys-date またはテンプレートアイコン） */
export async function waitForChatContent(tabId, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const found = await execMain(tabId, () => {
        return !!(document.querySelector('.chatsys-date') || document.querySelector('i.lar.la-chat-plus'));
      });
      if (found) return true;
    } catch (_) {
      // ページ読み込み中のexecMainエラーは無視してリトライ
    }
    await sleep(500);
  }
  return false;
}

/**
 * LINE Chat内でSPA遷移する（chrome.tabs.update + コンテンツポーリング）
 * CDP Page.navigateはフレーム破壊でexMainがハングするため使わない。
 *
 * 重要: chrome.tabs.updateによるフルリロードで Page.startScreencast が失われる。
 * ポップアップが背面にある場合、Chromeがタブをスロットルし execMain がハングする。
 * 遷移後にscreencast + visibility overrideを再開して回避。
 */
export async function navigateToLineChat(tabId, url, timeout = 20000) {
  await chrome.tabs.update(tabId, { url });
  await sleep(2000);

  // 背面レンダリング再開（フルリロードでscreencast + visibility overrideが失われる）
  for (let i = 0; i < 3; i++) {
    try {
      await reEnableBackgroundMode(tabId);
      break;
    } catch (_) {
      await sleep(1000);
    }
  }

  await waitForChatContent(tabId, timeout);
}

/** ユーザー名の正規化（ゼロ幅文字除去） */
export function normalizeName(name) {
  return name
    .normalize('NFC')
    .replace(/[\u200b\u200c\u200d\u2060\ufeff\u00a0\u3164\u1160]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
