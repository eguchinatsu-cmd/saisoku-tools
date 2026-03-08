/**
 * 梱包キット催促タスク
 *
 * kintone APIで5日前に「梱包キット発送完了」になったレコードを取得し、
 * LINE Chatでレコード番号検索 → テンプレートメッセージ送信 → タグ付与。
 */

import { cdpClick, cdpSelectAll, cdpType } from '../lib/cdp.js';
import { sleep, execMain, withTimeout, waitForLineChatReady, waitForChatContent, ensureWindowVisible, getFiveDaysAgoJST, getCurrentMonthTag } from '../lib/utils.js';
import { getKintoneRecords } from '../lib/kintone-api.js';
import {
  getFilterStatus, getFilterAllOptionPosition,
  getSearchBoxPosition, clearSearchBox, getMessageSearchLinkPosition,
  getFirstSearchResultPosition, checkUnreadInSearchResult, checkSearchResultTimestampForKonpokit,
  checkUnreadMarkerInChat,
  scrollChatToBottom, checkKonpokitEligibility,
  sendTemplateMessageByDOM,
  getChatClosePosition,
} from '../lib/line-chat.js';

const BOT_ID = 'U6d15f79f9d4634a23b9a085612b087b5';
const TEMPLATE_NAME = '梱包キット催促';
const TAG_PREFIX = '梱包キット催促完了';
const USER_TIMEOUT_MS = 60000;

export async function runKonpokit(tabId, popupWindowId, logger, kintoneConfig) {
  const summary = { sent: 0, skipped: 0, errors: 0 };
  const tagName = getCurrentMonthTag(TAG_PREFIX);
  const fiveDaysAgo = getFiveDaysAgoJST();

  // 5日前の曜日を計算（タイムスタンプチェック用）
  const weekdays = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
  const fiveDaysAgoDate = new Date(`${fiveDaysAgo.formatted}T00:00:00+09:00`);
  const expectedDayOfWeek = weekdays[fiveDaysAgoDate.getUTCDay()];

  logger.info(`対象日: ${fiveDaysAgo.formatted}（5日前・${expectedDayOfWeek}）`);
  logger.info(`タグ: ${tagName}`);

  // タグIDを取得（API方式タグ付与用）
  let tagId = null;
  try {
    tagId = await execMain(tabId, async function(botId, targetTagName) {
      var res = await fetch('/api/v1/bots/' + botId + '/tags');
      var data = await res.json();
      var tag = data.list.find(function(t) { return t.name === targetTagName; });
      return tag ? tag.tagId : null;
    }, [BOT_ID, tagName], 15000);
    logger.info(tagId ? `タグID: ${tagId}` : `タグ「${tagName}」未検出`);
  } catch (e) {
    logger.info(`タグID取得スキップ: ${e.message}`);
  }

  // Step 1: kintoneからレコード取得
  logger.info('kintone APIからレコード取得中...');
  let targets;
  try {
    targets = await getKintoneRecords(kintoneConfig, 'konpokit', fiveDaysAgo.formatted);
  } catch (e) {
    logger.error(`kintone APIエラー: ${e.message}`);
    return { error: e.message, summary };
  }

  if (targets.length === 0) {
    logger.info('対象レコードなし');
    return { summary };
  }
  logger.info(`対象: ${targets.length}件 - ${targets.map(t => t.recordNumber).join(', ')}`);

  // Step 1.5: チャットフィルターを「すべて」に切り替え（CDPクリック版）
  try {
    const filterStatus = await execMain(tabId, getFilterStatus);
    if (filterStatus && !filterStatus.isAll) {
      logger.info(`フィルター切替中: ${filterStatus.current} → すべて`);
      await cdpClick(tabId, filterStatus.x, filterStatus.y);
      await sleep(1000);
      const allPos = await execMain(tabId, getFilterAllOptionPosition);
      if (allPos && allPos.x > 0) {
        await cdpClick(tabId, allPos.x, allPos.y);
        await sleep(500);
        logger.info(`フィルター切替完了: すべて (${allPos.debug})`);
      } else {
        logger.info(`フィルター: ドロップダウンに「すべて」が見つかりません (${allPos?.debug})`);
      }
    } else {
      logger.info(`フィルター: ${filterStatus?.isAll ? '既にすべて' : 'ボタン未検出'}`);
    }
  } catch (e) {
    logger.info(`フィルター切替スキップ: ${e.message}`);
  }

  // Step 2: 各レコードを処理
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    logger.progress(i + 1, targets.length, `${target.recordNumber} ${target.name}`);
    await ensureWindowVisible(popupWindowId);

    try {
      const result = await withTimeout(
        () => processTarget(tabId, target, tagName, tagId, expectedDayOfWeek, logger),
        USER_TIMEOUT_MS,
        target.recordNumber
      );

      if (result.success) {
        summary.sent++;
        logger.success(`${target.recordNumber}: 送信完了`);
      } else if (result.skipped) {
        summary.skipped++;
        logger.info(`${target.recordNumber}: スキップ (${result.reason})`);
      } else if (result.error) {
        summary.errors++;
        logger.error(`${target.recordNumber}: ${result.error}`);
      }
    } catch (e) {
      summary.errors++;
      logger.error(`${target.recordNumber}: ${e.message}`);
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

  logger.success(`完了: ${summary.sent}送信, ${summary.skipped}スキップ, ${summary.errors}エラー`);
  return { summary };
}

async function processTarget(tabId, target, tagName, tagId, expectedDayOfWeek, logger) {
  // 1. レコード番号で検索
  logger.info(`${target.recordNumber} で検索中...`);
  const searchPos = await execMain(tabId, getSearchBoxPosition);
  if (!searchPos) return { error: '検索ボックスが見つかりません' };

  await cdpClick(tabId, searchPos.x, searchPos.y);
  await sleep(300);
  // CDP で全選択→削除→入力（isTrusted: true でフレームワークに検知させる）
  await cdpSelectAll(tabId);
  await sleep(100);
  await cdpType(tabId, target.recordNumber);
  await sleep(300);

  // Enter
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  });
  await sleep(2000);

  // 2. 未読チェック
  const unreadCheck1 = await execMain(tabId, checkUnreadInSearchResult);
  logger.info(`[未読チェック1] hasUnread=${unreadCheck1?.hasUnread}, debug=${unreadCheck1?.debug}`);
  if (unreadCheck1?.hasUnread) {
    await execMain(tabId, clearSearchBox);
    return { skipped: true, reason: '未読メッセージあり（既読防止）' };
  }

  // 2.5. タイムスタンプチェック（5日前の曜日でなければスキップ）
  const tsCheck = await execMain(tabId, checkSearchResultTimestampForKonpokit, [expectedDayOfWeek]);
  logger.info(`[タイムスタンプ] isTarget=${tsCheck?.isTarget}, timestamp=${tsCheck?.timestamp}, reason=${tsCheck?.reason || tsCheck?.debug}`);
  if (tsCheck && !tsCheck.isTarget && tsCheck.timestamp) {
    await execMain(tabId, clearSearchBox);
    return { skipped: true, reason: `最終チャットが${expectedDayOfWeek}ではない（${tsCheck.timestamp}: ${tsCheck.reason}）` };
  }

  // 3. 「メッセージを検索」→ 最初の結果をクリック
  const msgSearchPos = await execMain(tabId, getMessageSearchLinkPosition);
  if (msgSearchPos) {
    await cdpClick(tabId, msgSearchPos.x, msgSearchPos.y);
    await sleep(5000); // メッセージ検索結果の読み込みに5秒必要

    // メッセージ検索結果でも未読チェック
    const unreadCheck2 = await execMain(tabId, checkUnreadInSearchResult);
    logger.info(`[未読チェック2] hasUnread=${unreadCheck2?.hasUnread}, debug=${unreadCheck2?.debug}`);
    if (unreadCheck2?.hasUnread) {
      await execMain(tabId, clearSearchBox);
      return { skipped: true, reason: '未読メッセージあり（既読防止）' };
    }
  }

  const firstPos = await execMain(tabId, getFirstSearchResultPosition);
  if (!firstPos) return { error: 'ユーザーが見つかりません' };
  await cdpClick(tabId, firstPos.x, firstPos.y);
  await sleep(2000);

  // 4. チャット内容がロードされるまで待つ
  await waitForChatContent(tabId, 10000);

  // 4.5. スクロール前に「ここから未読メッセージ」チェック
  const unreadMarker = await execMain(tabId, checkUnreadMarkerInChat);
  logger.info(`[未読マーカー] hasUnread=${unreadMarker?.hasUnread}, debug=${JSON.stringify(unreadMarker)}`);
  if (unreadMarker?.hasUnread) {
    logger.info(`未読マーカー検出: ${unreadMarker.marker} → チャットを閉じてスキップ`);
    return { skipped: true, reason: '未読メッセージあり（ここから未読メッセージ検出）' };
  }

  await execMain(tabId, scrollChatToBottom);
  await sleep(1500);

  // 5. 資格チェック
  const eligibility = await execMain(tabId, checkKonpokitEligibility);
  if (!eligibility?.eligible) {
    return { skipped: true, reason: eligibility?.reason || 'unknown' };
  }

  // 6. テンプレートメッセージ送信（DOM click版 - リトライ付き）
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

  // 7. タグ付与（API方式）
  let tagged = false;
  try {
    tagged = await applyTagViaAPI(tabId, tagId, tagName, logger);
  } catch (e) {
    logger.info(`タグ付与スキップ: ${e.message}`);
  }

  return { success: true, tagged };
}

/** タグ付与（API方式 — UI操作不要） */
async function applyTagViaAPI(tabId, tagId, tagName, logger) {
  logger.info(`タグ付与(API): ${tagName}`);

  if (!tagId) {
    logger.error(`タグID未取得（タグ「${tagName}」がLINE Chatに存在しない可能性）`);
    return false;
  }

  // 現在開いているチャットのchatIdを取得（URLから）
  const chatId = await execMain(tabId, function() {
    var match = location.pathname.match(/\/chat\/([^/]+)/);
    return match ? match[1] : null;
  }, [], 5000);

  if (!chatId) {
    logger.error('chatIdを取得できません（チャットが開いていない可能性）');
    return false;
  }

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
