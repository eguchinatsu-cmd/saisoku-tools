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
  getSearchBoxPosition, clearSearchBox, getMessageSearchLinkPosition,
  getFirstSearchResultPosition, checkUnreadInSearchResult,
  scrollChatToBottom, checkKonpokitEligibility,
  sendTemplateMessageByDOM,
  openTagEditor, clickTag, getSaveButtonPosition, getCancelButtonPosition, verifyTag,
  getChatClosePosition,
} from '../lib/line-chat.js';
import { createLogger } from '../lib/logger.js';

const TEMPLATE_NAME = '梱包キット催促';
const TAG_PREFIX = '梱包キット催促完了';
const USER_TIMEOUT_MS = 60000;

export async function runKonpokit(tabId, popupWindowId, logger, kintoneConfig) {
  const summary = { sent: 0, skipped: 0, errors: 0 };
  const tagName = getCurrentMonthTag(TAG_PREFIX);
  const fiveDaysAgo = getFiveDaysAgoJST();

  logger.info(`対象日: ${fiveDaysAgo.formatted}（5日前）`);
  logger.info(`タグ: ${tagName}`);

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

  // Step 2: 各レコードを処理
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    logger.progress(i + 1, targets.length, `${target.recordNumber} ${target.name}`);
    await ensureWindowVisible(popupWindowId);

    try {
      const result = await withTimeout(
        () => processTarget(tabId, target, tagName, logger),
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

async function processTarget(tabId, target, tagName, logger) {
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
  const hasUnread = await execMain(tabId, checkUnreadInSearchResult);
  if (hasUnread) {
    await execMain(tabId, clearSearchBox);
    return { skipped: true, reason: '未読メッセージあり（既読防止）' };
  }

  // 3. 「メッセージを検索」→ 最初の結果をクリック
  const msgSearchPos = await execMain(tabId, getMessageSearchLinkPosition);
  if (msgSearchPos) {
    await cdpClick(tabId, msgSearchPos.x, msgSearchPos.y);
    await sleep(5000); // メッセージ検索結果の読み込みに5秒必要
  }

  const firstPos = await execMain(tabId, getFirstSearchResultPosition);
  if (!firstPos) return { error: 'ユーザーが見つかりません' };
  await cdpClick(tabId, firstPos.x, firstPos.y);
  await sleep(2000);

  // 4. チャット内容がロードされるまで待つ → 最下部にスクロール
  await waitForChatContent(tabId, 10000);
  await execMain(tabId, scrollChatToBottom);
  await sleep(1500);

  // 5. 資格チェック
  const eligibility = await execMain(tabId, checkKonpokitEligibility);
  if (!eligibility?.eligible) {
    return { skipped: true, reason: eligibility?.reason || 'unknown' };
  }

  // 6. テンプレートメッセージ送信（DOM click版 - Reactイベント確実発火）
  logger.info(`テンプレート「${TEMPLATE_NAME}」を送信中...`);
  const sendResult = await execMain(tabId, sendTemplateMessageByDOM, [TEMPLATE_NAME]);
  if (sendResult?.error) return sendResult;
  if (!sendResult?.messageSent) return { error: 'メッセージ送信に失敗しました' };

  // 7. タグ付与
  const tagged = await applyTag(tabId, tagName, logger);

  return { success: true, tagged };
}

async function applyTag(tabId, tagName, logger) {
  logger.info(`タグ付与: ${tagName}`);
  const openResult = await execMain(tabId, openTagEditor);
  if (!openResult?.opened) {
    logger.error('タグ編集を開けませんでした');
    return false;
  }
  await sleep(2000);

  const tagClicked = await execMain(tabId, clickTag, [tagName]);
  if (!tagClicked) {
    logger.error(`タグ「${tagName}」が見つかりません`);
    const cancelPos = await execMain(tabId, getCancelButtonPosition);
    if (cancelPos) await cdpClick(tabId, cancelPos.x, cancelPos.y);
    return false;
  }
  await sleep(1000);

  const savePos = await execMain(tabId, getSaveButtonPosition);
  if (!savePos) { logger.error('保存ボタンが見つかりません'); return false; }
  await cdpClick(tabId, savePos.x, savePos.y);
  await sleep(1500);

  const verified = await execMain(tabId, verifyTag, [tagName]);
  if (verified) { logger.success(`タグ「${tagName}」を付与`); return true; }
  logger.error('タグ付与の検証に失敗');
  return false;
}
