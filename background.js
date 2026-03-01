/**
 * 催促ツール - Background Service Worker
 * popup からのメッセージを受信し、各タスクを実行
 */

import { attachDebugger, detachDebugger, cdpClick } from './lib/cdp.js';
import { sleep, execMain, waitForTabLoad, waitForLineChatReady, ensureWindowVisible, cleanupOrphanedPopups, getCurrentMonthTag } from './lib/utils.js';
import { createLogger, getLogBuffer, clearLogBuffer, restoreLogBuffer } from './lib/logger.js';
import { getChatClosePosition } from './lib/line-chat.js';
import { initSlackConfig, notifyResult, notifyError, notifyAllResults } from './lib/slack.js';

// 起動時にログバッファを復元
restoreLogBuffer();
import { runKarisatei } from './tasks/karisatei.js';
import { runHonsatei } from './tasks/honsatei.js';
import { runKonpokit } from './tasks/konpokit.js';

const LINE_CHAT_URL = 'https://chat.line.biz/U6d15f79f9d4634a23b9a085612b087b5';
const WINDOW_WIDTH = 2200;
const WINDOW_HEIGHT = 900;

let isRunning = false;
let currentTask = null;

// === タスク完了時刻を永続保存 ===
async function saveTaskCompletion(taskName, result) {
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const time = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const data = await chrome.storage.local.get('taskCompletions');
  const completions = data.taskCompletions || {};
  // 日付が変わったらリセット
  if (completions._date !== dateKey) {
    for (const k of Object.keys(completions)) delete completions[k];
    completions._date = dateKey;
  }
  completions[taskName] = {
    time,
    summary: result.summary || null,
    error: result.error || null,
  };
  await chrome.storage.local.set({ taskCompletions: completions });
}

// === メッセージハンドラ ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'run') {
    if (isRunning) { sendResponse({ error: '別のタスクが実行中です' }); return; }
    handleRun(msg.task);
    sendResponse({ started: true });
  }
  if (msg.type === 'runAll') {
    if (isRunning) { sendResponse({ error: '別のタスクが実行中です' }); return; }
    handleRunAll();
    sendResponse({ started: true });
  }
  if (msg.type === 'getStatus') {
    sendResponse({ isRunning, currentTask });
  }
  if (msg.type === 'getLogs') {
    sendResponse({ logs: getLogBuffer() });
  }
  if (msg.type === 'clearLogs') {
    clearLogBuffer();
    sendResponse({ ok: true });
  }
  return true; // keep channel open
});

// === 月初タグ自動作成アラーム ===
const TAG_ALARM = 'saisoku-tag-check';
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(TAG_ALARM, { periodInMinutes: 60 }); // 1時間ごとにチェック
  // Slack通知トークン初期化
  initSlackConfig(atob('eG94Yi0xODI1MTgzODY0NjUtMTA0MTgxMzk2MjIxMTctQUpGVEF3R0N0QkRMb1htdkRNNUlPODNY'));
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(TAG_ALARM, { periodInMinutes: 60 });
  // 起動時もトークン初期化（onInstalledが発火しないケース対策）
  initSlackConfig(atob('eG94Yi0xODI1MTgzODY0NjUtMTA0MTgxMzk2MjIxMTctQUpGVEF3R0N0QkRMb1htdkRNNUlPODNY'));
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TAG_ALARM) checkAndCreateMonthlyTags();
});

// === ポップアップ初期化（共通） ===
async function initLinePopup() {
  await cleanupOrphanedPopups();

  const prevWindow = await chrome.windows.getLastFocused();
  const popup = await chrome.windows.create({
    url: LINE_CHAT_URL,
    type: 'popup',
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    left: 100, top: 100,
    focused: true,
  });
  const tab = popup.tabs[0];

  // フォーカスを元に戻す
  if (prevWindow?.id) {
    try { await chrome.windows.update(prevWindow.id, { focused: true }); } catch (_) {}
  }

  // ページ読み込み → 要素検出待ち（固定sleep廃止）
  await waitForTabLoad(tab.id, 30000);
  await waitForLineChatReady(tab.id, 10000);

  // ログイン確認
  const urlCheck = await chrome.tabs.get(tab.id);
  if (!urlCheck.url.startsWith('https://chat.line.biz/')) {
    await chrome.windows.remove(popup.id);
    throw new Error('LINE Chatにログインしていません。先にブラウザでログインしてください。');
  }

  // CDP デバッガーアタッチ
  await attachDebugger(tab.id);
  await sleep(500);

  return { tab, popupWindowId: popup.id };
}

function getKintoneConfig(settings) {
  return {
    domain: settings.kintoneDomain || 'japanconsulting.cybozu.com',
    appId: settings.kintoneAppId || '11',
    apiToken: settings.kintoneApiToken || '0GQbfXlZoPSgQzFGFiBaCjpHgbSZW7cW4lZ9m8j7',
  };
}

// === 単一タスク実行 ===
async function runTask(taskName, tab, popupWindowId, kintoneConfig) {
  const logger = createLogger(taskName);
  switch (taskName) {
    case 'karisatei':
      return await runKarisatei(tab.id, popupWindowId, logger);
    case 'honsatei':
      if (!kintoneConfig.apiToken) throw new Error('kintone APIトークンが設定されていません。⚙設定で入力してください。');
      return await runHonsatei(tab.id, popupWindowId, logger, kintoneConfig);
    case 'konpokit':
      if (!kintoneConfig.apiToken) throw new Error('kintone APIトークンが設定されていません。⚙設定で入力してください。');
      return await runKonpokit(tab.id, popupWindowId, logger, kintoneConfig);
    default:
      throw new Error(`Unknown task: ${taskName}`);
  }
}

// === メイン実行（単独タスク） ===
async function handleRun(taskName) {
  isRunning = true;
  currentTask = taskName;
  clearLogBuffer(); // 新しい実行開始時にログをクリア
  chrome.runtime.sendMessage({ type: 'taskStart', task: taskName }).catch(() => {});

  let tab = null;
  let popupWindowId = null;
  let debuggerAttached = false;

  try {
    const popup = await initLinePopup();
    tab = popup.tab;
    popupWindowId = popup.popupWindowId;
    debuggerAttached = true;

    const settings = await chrome.storage.sync.get(['kintoneApiToken', 'kintoneDomain', 'kintoneAppId']);
    const kintoneConfig = getKintoneConfig(settings);

    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 25000);
    let result;
    try {
      result = await runTask(taskName, tab, popupWindowId, kintoneConfig);
    } finally {
      clearInterval(keepAlive);
    }

    await saveTaskCompletion(taskName, result);
    chrome.runtime.sendMessage({ type: 'complete', task: taskName, result }).catch(() => {});
    // Slack通知
    const taskLabels = { karisatei: '仮査定', honsatei: '本査定', konpokit: '梱包キット' };
    if (result.summary) await notifyResult(taskLabels[taskName] || taskName, result.summary).catch(() => {});
    return result;

  } catch (e) {
    const errResult = { error: e.message };
    await saveTaskCompletion(taskName, errResult);
    chrome.runtime.sendMessage({ type: 'complete', task: taskName, result: errResult }).catch(() => {});
    // Slackエラー通知
    const taskLabels = { karisatei: '仮査定', honsatei: '本査定', konpokit: '梱包キット' };
    await notifyError(taskLabels[taskName] || taskName, e.message).catch(() => {});
    return errResult;
  } finally {
    if (tab && debuggerAttached) {
      try {
        const closePos = await execMain(tab.id, getChatClosePosition);
        if (closePos) await cdpClick(tab.id, closePos.x, closePos.y);
      } catch (_) {}
      await sleep(500);
    }
    if (debuggerAttached && tab) await detachDebugger(tab.id);
    if (popupWindowId) {
      try { await chrome.windows.remove(popupWindowId); } catch (_) {}
    }
    isRunning = false;
    currentTask = null;
  }
}

// === 全タスク一括実行（ポップアップ1回だけ） ===
async function handleRunAll() {
  isRunning = true;
  clearLogBuffer(); // 新しい実行開始時にログをクリア
  const results = {};

  let tab = null;
  let popupWindowId = null;
  let debuggerAttached = false;

  try {
    const popup = await initLinePopup();
    tab = popup.tab;
    popupWindowId = popup.popupWindowId;
    debuggerAttached = true;

    const settings = await chrome.storage.sync.get(['kintoneApiToken', 'kintoneDomain', 'kintoneAppId']);
    const kintoneConfig = getKintoneConfig(settings);

    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 25000);

    try {
      for (const taskName of ['karisatei', 'honsatei', 'konpokit']) {
        currentTask = taskName;
        chrome.runtime.sendMessage({ type: 'taskStart', task: taskName }).catch(() => {});

        try {
          results[taskName] = await runTask(taskName, tab, popupWindowId, kintoneConfig);
        } catch (e) {
          results[taskName] = { error: e.message };
        }

        await saveTaskCompletion(taskName, results[taskName]);
        chrome.runtime.sendMessage({ type: 'complete', task: taskName, result: results[taskName] }).catch(() => {});

        // タスク間: チャットを閉じてからLINE Chatトップに戻す
        try {
          const closePos = await execMain(tab.id, getChatClosePosition);
          if (closePos) await cdpClick(tab.id, closePos.x, closePos.y);
        } catch (_) {}
        await sleep(1000);
      }
    } finally {
      clearInterval(keepAlive);
    }

  } catch (e) {
    console.error('[Saisoku] handleRunAll error:', e.message);
  } finally {
    if (tab && debuggerAttached) {
      try {
        const closePos = await execMain(tab.id, getChatClosePosition);
        if (closePos) await cdpClick(tab.id, closePos.x, closePos.y);
      } catch (_) {}
      await sleep(500);
    }
    if (debuggerAttached && tab) await detachDebugger(tab.id);
    if (popupWindowId) {
      try { await chrome.windows.remove(popupWindowId); } catch (_) {}
    }
    isRunning = false;
    currentTask = null;
  }

  chrome.runtime.sendMessage({ type: 'completeAll', results }).catch(() => {});
  // Slack通知（全タスク完了まとめ）
  await notifyAllResults(results).catch(() => {});
}

// === 月初タグ自動作成 ===
async function checkAndCreateMonthlyTags() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const day = jst.getUTCDate();
  if (day !== 1) return; // 1日以外はスキップ

  const monthKey = `${jst.getUTCFullYear()}-${jst.getUTCMonth() + 1}`;
  const { createdTagMonths = [] } = await chrome.storage.sync.get('createdTagMonths');
  if (createdTagMonths.includes(monthKey)) return; // 作成済み

  const tagNames = [
    getCurrentMonthTag('仮査定後催促'),
    getCurrentMonthTag('本査定後催促済'),
    getCurrentMonthTag('梱包キット催促完了'),
  ];

  console.log(`[Saisoku] 月初タグ作成: ${tagNames.join(', ')}`);

  // LINE Chat にアクセスしてタグ作成
  if (isRunning) return; // 催促実行中は避ける
  isRunning = true;
  currentTask = 'tagCreate';

  let tab = null;
  let popupWindowId = null;
  let debuggerAttached = false;

  try {
    await cleanupOrphanedPopups();
    const popup = await chrome.windows.create({
      url: LINE_CHAT_URL,
      type: 'popup', width: WINDOW_WIDTH, height: WINDOW_HEIGHT,
      left: 100, top: 100, focused: true,
    });
    tab = popup.tabs[0];
    popupWindowId = popup.id;

    // フォーカスを戻す
    const prev = await chrome.windows.getLastFocused();
    if (prev?.id && prev.id !== popupWindowId) {
      try { await chrome.windows.update(prev.id, { focused: true }); } catch (_) {}
    }

    await waitForTabLoad(tab.id, 30000);
    await waitForLineChatReady(tab.id, 10000);

    const urlCheck = await chrome.tabs.get(tab.id);
    if (!urlCheck.url.startsWith('https://chat.line.biz/')) {
      console.log('[Saisoku] タグ作成: ログインしていないためスキップ');
      return;
    }

    await attachDebugger(tab.id);
    debuggerAttached = true;
    await sleep(1000);

    // 設定ページのタグ管理に移動
    // LINE Chat の設定 → タグ管理ページ
    const settingsUrl = urlCheck.url.replace(/\/chat\/.*/, '/setting/tag') ||
                        'https://chat.line.biz/setting/tag';
    await chrome.tabs.update(tab.id, { url: settingsUrl });
    await waitForTabLoad(tab.id, 15000);
    await sleep(3000);

    // 各タグを作成
    for (const tagName of tagNames) {
      // タグが既に存在するかチェック
      const existing = await execMain(tab.id, () => {
        const els = document.querySelectorAll('span, div, td, label');
        const names = [];
        for (const el of els) {
          const t = el.textContent.trim();
          if (t && t.length < 50) names.push(t);
        }
        return names;
      });

      if (existing?.some(t => t === tagName)) {
        console.log(`[Saisoku] タグ「${tagName}」は既に存在`);
        continue;
      }

      // 「追加」ボタンをクリック
      const addBtnPos = await execMain(tab.id, () => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const t = btn.textContent.trim();
          if ((t === '追加' || t === '＋' || t === '+' || t.includes('タグを追加')) && btn.offsetParent !== null) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
        return null;
      });

      if (!addBtnPos) {
        console.log(`[Saisoku] 追加ボタンが見つかりません`);
        break;
      }

      await cdpClick(tab.id, addBtnPos.x, addBtnPos.y);
      await sleep(1000);

      // テキスト入力フィールドにタグ名を入力
      const inputSet = await execMain(tab.id, (name) => {
        const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
        // 最後の（新しく出現した）input
        for (let i = inputs.length - 1; i >= 0; i--) {
          const inp = inputs[i];
          if (inp.offsetParent !== null && inp.value === '') {
            inp.focus();
            inp.value = name;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, [tagName]);

      if (!inputSet) {
        console.log(`[Saisoku] 入力フィールドが見つかりません`);
        continue;
      }

      await sleep(500);

      // 保存/確定ボタン
      const saveBtnPos = await execMain(tab.id, () => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const t = btn.textContent.trim();
          if ((t === '保存' || t === '追加' || t === '確定' || t === 'OK') && btn.offsetParent !== null) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
        return null;
      });

      if (saveBtnPos) {
        await cdpClick(tab.id, saveBtnPos.x, saveBtnPos.y);
        await sleep(1500);
        console.log(`[Saisoku] タグ「${tagName}」を作成`);
      }
    }

    // 成功記録
    createdTagMonths.push(monthKey);
    await chrome.storage.sync.set({ createdTagMonths });
    console.log(`[Saisoku] 月初タグ作成完了: ${monthKey}`);

  } catch (e) {
    console.error(`[Saisoku] タグ作成エラー: ${e.message}`);
  } finally {
    if (debuggerAttached && tab) await detachDebugger(tab.id);
    if (popupWindowId) {
      try { await chrome.windows.remove(popupWindowId); } catch (_) {}
    }
    isRunning = false;
    currentTask = null;
  }
}
