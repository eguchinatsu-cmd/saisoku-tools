/**
 * 仮査定後催促タスク（API方式）
 *
 * LINE Chat REST APIでチャットリストをページネーション取得し、
 * 昨日「本査定のご案内」が送信されたユーザーを特定。
 * 検索で各ユーザーを開き、テンプレート送信＋タグ付与。
 * スクロール完全不要。
 */

import { cdpClick, cdpSelectAll, cdpType, cdpEnableBackgroundMode, cdpDisableBackgroundMode } from '../lib/cdp.js';
import { sleep, execMain, withTimeout, waitForTabLoad, waitForLineChatReady, waitForChatContent, ensureWindowVisible, normalizeName, getCurrentMonthTag, getYesterdayJST } from '../lib/utils.js';
import {
  getFilterStatus, getFilterAllOptionPosition,
  clickUserInChatList, clickBestMatchInChatList, checkKarisateiEligibility,
  sendTemplateMessageByDOM,
  getChatClosePosition, getSearchBoxPosition,
  checkUnreadMarkerInChat, scrollChatToBottom,
} from '../lib/line-chat.js';

const BOT_ID = 'U6d15f79f9d4634a23b9a085612b087b5';
const TEMPLATE_NAME = '仮査定中の方へ';
const TAG_PREFIX = '仮査定後催促';
const USER_TIMEOUT_MS = 60000;

export async function runKarisatei(tabId, popupWindowId, logger) {
  const summary = { sent: 0, skipped: 0, errors: 0 };
  const sentUsers = new Set();
  const tagName = getCurrentMonthTag(TAG_PREFIX);

  logger.info(`テンプレート: ${TEMPLATE_NAME}`);
  logger.info(`タグ: ${tagName}`);

  await cdpEnableBackgroundMode(tabId);

  // Step 1: APIで対象ユーザーを取得（スクロール不要）
  logger.info('LINE Chat APIで対象ユーザーを取得中...');
  let targets, tagId;
  try {
    const apiResult = await fetchTargetsViaAPI(tabId, tagName, logger);
    targets = apiResult.targets;
    tagId = apiResult.tagId;
  } catch (e) {
    logger.error(`API取得失敗: ${e.message}`);
    await cdpDisableBackgroundMode(tabId);
    return { summary };
  }

  if (targets.length === 0) {
    logger.info('対象ユーザーなし');
    await cdpDisableBackgroundMode(tabId);
    return { summary };
  }

  // "unknown"（名前未設定）ユーザーをフィルタ
  const named = targets.filter(t => t.name !== 'unknown');
  const unknownCount = targets.length - named.length;
  if (unknownCount > 0) {
    logger.info(`名前未設定: ${unknownCount}人スキップ（検索不可）`);
    summary.skipped += unknownCount;
  }
  if (named.length === 0) {
    logger.info('名前ありの対象ユーザーなし');
    await cdpDisableBackgroundMode(tabId);
    return { summary };
  }
  logger.info(`対象: ${named.length}人 - ${named.map(t => t.name).join(', ')}`);

  // Step 2: フィルターを「すべて」に切り替え（検索のため）
  try {
    const filterStatus = await execMain(tabId, getFilterStatus);
    if (filterStatus && !filterStatus.isAll) {
      logger.info(`フィルター切替: ${filterStatus.current} → すべて`);
      await cdpClick(tabId, filterStatus.x, filterStatus.y);
      await sleep(1000);
      const allPos = await execMain(tabId, getFilterAllOptionPosition);
      if (allPos?.x > 0) {
        await cdpClick(tabId, allPos.x, allPos.y);
        await sleep(500);
      }
    }
  } catch (e) {
    logger.info(`フィルター切替スキップ: ${e.message}`);
  }

  // Step 3: 各ユーザーを処理
  for (let i = 0; i < named.length; i++) {
    const target = named[i];
    if (sentUsers.has(normalizeName(target.name))) {
      logger.info(`${target.name}: セッション内で送信済み → スキップ`);
      summary.skipped++;
      continue;
    }

    logger.progress(i + 1, named.length, target.name);
    await ensureWindowVisible(popupWindowId);

    try {
      const result = await withTimeout(
        () => processUser(tabId, target, tagName, tagId, sentUsers, logger),
        USER_TIMEOUT_MS,
        target.name
      );

      if (result.success) {
        summary.sent++;
        logger.success(`${target.name}: 送信完了`);
      } else if (result.skipped) {
        summary.skipped++;
        logger.info(`${target.name}: スキップ (${result.reason})`);
      } else if (result.error) {
        summary.errors++;
        logger.error(`${target.name}: ${result.error}`);
      }
    } catch (e) {
      summary.errors++;
      logger.error(`${target.name}: ${e.message}`);
      if (e.message.includes('TIMEOUT')) {
        await chrome.tabs.update(tabId, { url: 'https://chat.line.biz/' });
        await waitForLineChatReady(tabId, 10000);
      }
    }

    // チャットを閉じる
    try {
      const closePos = await execMain(tabId, getChatClosePosition);
      if (closePos) await cdpClick(tabId, closePos.x, closePos.y);
      await sleep(1000);
    } catch (_) {}
  }

  await cdpDisableBackgroundMode(tabId);

  logger.success(`完了: ${summary.sent}送信, ${summary.skipped}スキップ, ${summary.errors}エラー`);
  return { summary };
}

// === 内部関数 ===

/**
 * LINE Chat REST APIでチャットリストをページネーション取得し対象者を特定。
 *
 * 対象条件:
 * - 最新メッセージが昨日の日付
 * - botから「本査定のご案内」が送信されている
 * - 今月の催促タグがまだ付いていない
 */
async function fetchTargetsViaAPI(tabId, tagName, logger) {
  // タグ一覧を取得して対象タグIDを特定
  const tagId = await execMain(tabId, async function(botId, targetTagName) {
    var res = await fetch('/api/v1/bots/' + botId + '/tags');
    var data = await res.json();
    var tag = data.list.find(function(t) { return t.name === targetTagName; });
    return tag ? tag.tagId : null;
  }, [BOT_ID, tagName], 15000);

  logger.info(tagId ? `タグID: ${tagId}` : `タグ「${tagName}」未検出（全件対象）`);

  const yesterday = getYesterdayJST();
  logger.info(`対象日: ${yesterday.formatted}`);

  const targets = [];
  let nextToken = null;

  for (let page = 0; page < 40; page++) {
    // 1ページ分のチャットを取得（25件ずつ）
    const result = await execMain(tabId, async function(botId, token) {
      var url = '/api/v2/bots/' + botId + '/chats?folderType=ALL&tagIds=&autoTagIds=&limit=25&prioritizePinnedChat=true';
      if (token) url += '&next=' + encodeURIComponent(token);
      var res = await fetch(url);
      return await res.json();
    }, [BOT_ID, nextToken], 15000);

    if (!result?.list || result.list.length === 0) break;

    let pastYesterday = false;
    for (const chat of result.list) {
      const ev = chat.latestEvent;
      if (!ev?.timestamp) continue;

      // JSTで日付判定
      const ts = new Date(ev.timestamp);
      const jst = new Date(ts.getTime() + 9 * 60 * 60 * 1000);
      const dateStr = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;

      // 昨日より前 → ページネーション終了
      if (dateStr < yesterday.formatted) {
        pastYesterday = true;
        break;
      }
      // 今日 → スキップ（昨日だけが対象）
      if (dateStr > yesterday.formatted) continue;

      // 昨日のチャット: botが「本査定のご案内」を送信 & 催促タグなし
      const msgText = ev.message?.text || '';
      const isFromBot = ev.source?.userId === BOT_ID;
      const hasTag = tagId && (chat.tagIds || []).includes(tagId);

      if (isFromBot && msgText.includes('本査定のご案内') && !hasTag) {
        targets.push({
          name: chat.profile?.name || 'unknown',
          chatId: chat.chatId,
        });
      }
    }

    if (pastYesterday) break;
    nextToken = result.next;
    if (!nextToken) break;

    if ((page + 1) % 5 === 0) {
      logger.info(`[API] ${page + 1}ページ取得、${targets.length}人検出...`);
    }
  }

  logger.info(`[API] 完了: ${targets.length}人の対象を検出`);
  return { targets, tagId };
}

/**
 * 個別ユーザー処理: 検索→資格チェック→テンプレート送信→タグ付与
 */
async function processUser(tabId, target, tagName, tagId, sentUsers, logger) {
  // Step 1: 検索でユーザーを開く
  const searchPos = await execMain(tabId, getSearchBoxPosition);
  if (!searchPos) return { error: '検索ボックスが見つかりません' };

  await cdpClick(tabId, searchPos.x, searchPos.y);
  await sleep(300);

  // 検索履歴ドロップダウンを閉じる（Escape）
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await sleep(200);

  // 検索ボックスを再クリック（フォーカス確保）
  await cdpClick(tabId, searchPos.x, searchPos.y);
  await sleep(200);

  // 全選択 → 名前入力 → Enter
  await cdpSelectAll(tabId);
  await sleep(100);
  await cdpType(tabId, target.name);
  await sleep(500);

  // Enterで検索実行
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  });
  await sleep(2000);

  // 検索結果からユーザーをクリック（複数ヒット時はタイムスタンプ+メッセージプレビューで絞り込み）
  const hints = { timestamp: '昨日', messageKeyword: '本査定のご案内' };
  let clickResult = await execMain(tabId, clickBestMatchInChatList, [target.name, hints]);
  if (clickResult?.hasUnread) {
    return { skipped: true, reason: '未読メッセージあり（既読防止）' };
  }
  if (clickResult?.clicked) {
    logger.info(`${target.name}: ${clickResult.matchedBy === 'hints' ? `複数候補${clickResult.total}件中[${clickResult.index}]を選択（${clickResult.timestamp}）` : '1件ヒット'}`);
  }

  // 見つからない場合: chatIdでURL直接遷移（フォールバック）
  if (!clickResult?.clicked) {
    const reason = clickResult?.multipleFound
      ? `複数候補${clickResult.multipleFound}件あるがヒント不一致`
      : '検索ヒットなし';
    logger.info(`${target.name}: ${reason} → chatIdで直接遷移`);
    const chatUrl = `https://chat.line.biz/${BOT_ID}/chat/${target.chatId}`;
    await chrome.tabs.update(tabId, { url: chatUrl });
    // ページロード完了を待ってからDOM操作（execMain timeoutの原因だった）
    await waitForTabLoad(tabId, 20000);
    await waitForLineChatReady(tabId, 15000);
    await waitForChatContent(tabId, 10000);

    // 遷移後に未読チェック
    const unreadMarker = await execMain(tabId, checkUnreadMarkerInChat);
    if (unreadMarker?.hasUnread) {
      return { skipped: true, reason: '未読メッセージあり（既読防止）' };
    }
  } else {
    await sleep(2000);
  }

  // Step 2: チャットを下までスクロール（最新メッセージを表示）
  await execMain(tabId, scrollChatToBottom);
  await sleep(1000);

  // Step 3: 資格チェック（安全ネット — APIフィルタ済みだが二重確認）
  let eligibility;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      eligibility = await execMain(tabId, checkKarisateiEligibility, [TAG_PREFIX]);
      break;
    } catch (e) {
      if (attempt === 2) return { error: `資格チェック失敗: ${e.message}` };
      logger.info(`資格チェック リトライ ${attempt + 1}/3`);
      await sleep(1000);
    }
  }

  if (!eligibility?.eligible) {
    return { skipped: true, reason: eligibility?.reason || 'unknown' };
  }

  // Step 4: テンプレートメッセージ送信
  logger.info(`テンプレート「${TEMPLATE_NAME}」を送信中...`);
  let sendResult;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      sendResult = await execMain(tabId, sendTemplateMessageByDOM, [TEMPLATE_NAME], 30000);
      if (sendResult?.messageSent) break;
    } catch (e) {
      logger.info(`送信タイムアウト リトライ ${attempt + 1}/2: ${e.message}`);
      await sleep(2000);
    }
  }
  if (sendResult?.error) return sendResult;
  if (!sendResult?.messageSent) return { error: 'メッセージ送信に失敗しました' };
  logger.info(`メッセージ送信成功${sendResult.verified ? '（確認済み）' : ''}`);

  sentUsers.add(normalizeName(target.name));

  // Step 5: タグ付与（API方式 — UI操作不要）
  let tagged = false;
  try {
    tagged = await applyTagViaAPI(tabId, target.chatId, tagId, tagName, logger);
  } catch (e) {
    logger.info(`タグ付与スキップ: ${e.message}`);
  }

  return { success: true, tagged };
}

/** タグ付与（API方式 — UI操作不要、タブ消失の影響なし） */
async function applyTagViaAPI(tabId, chatId, tagId, tagName, logger) {
  logger.info(`タグ付与(API): ${tagName}`);

  if (!tagId) {
    logger.error(`タグID未取得（タグ「${tagName}」がLINE Chatに存在しない可能性）`);
    return false;
  }

  // PUT /api/v1/bots/{botId}/chats/{chatId}/tags でタグ付与
  const result = await execMain(tabId, async function(botId, cId, tId) {
    try {
      var res = await fetch('/api/v1/bots/' + botId + '/chats/' + cId + '/tags', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ tagIds: [tId] }),
      });
      if (res.ok) return { success: true };
      return { error: 'PUT /tags 失敗: ' + res.status };
    } catch (e) {
      return { error: e.message };
    }
  }, [BOT_ID, chatId, tagId], 15000);

  if (result?.error) {
    logger.error(`タグAPI: ${result.error}`);
    return false;
  }
  if (result?.success) {
    logger.success(`タグ「${tagName}」を付与しました`);
    return true;
  }
  return false;
}
