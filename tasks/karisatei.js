/**
 * 仮査定後催促タスク
 *
 * LINE Chatのチャットリストをスキャンし、昨日「本査定のご案内」が
 * 送信されたユーザーにテンプレートメッセージを送信してタグ付与する。
 * kintone不使用。
 */

import { cdpClick, cdpSelectAll, cdpType } from '../lib/cdp.js';
import { sleep, execMain, withTimeout, waitForLineChatReady, ensureWindowVisible, normalizeName, getCurrentMonthTag } from '../lib/utils.js';
import {
  scrollChatListToTop, scrollChatList, findYesterdaySection, scanKarisateiTargets,
  clickUserInChatList, checkKarisateiEligibility,
  sendTemplateMessageByDOM,
  openTagEditor, clickTag, getSaveButtonPosition, getCancelButtonPosition, verifyTag,
  getChatClosePosition, getSearchBoxPosition, clearSearchBox,
} from '../lib/line-chat.js';

const TEMPLATE_NAME = '仮査定中の方へ';
const TAG_PREFIX = '仮査定後催促';
const USER_TIMEOUT_MS = 60000;

export async function runKarisatei(tabId, popupWindowId, logger) {
  const summary = { sent: 0, skipped: 0, errors: 0 };
  const sentUsers = new Set();
  const tagName = getCurrentMonthTag(TAG_PREFIX);

  logger.info(`テンプレート: ${TEMPLATE_NAME}`);
  logger.info(`タグ: ${tagName}`);

  // Step 1: 昨日セクションまでスクロール
  logger.info('チャットリストを最上部にスクロール...');
  await execMain(tabId, scrollChatListToTop);
  await sleep(1000);

  await scrollToYesterday(tabId, logger);

  // Step 2: 対象ユーザーをスキャン
  logger.info('対象ユーザーをスキャン中...');
  const targets = await scanTargets(tabId, logger);

  if (targets.length === 0) {
    logger.info('対象ユーザーなし');
    return { summary };
  }
  logger.info(`対象: ${targets.length}人 - ${targets.join(', ')}`);

  // Step 3: 各ユーザーを処理
  for (let i = 0; i < targets.length; i++) {
    const userName = targets[i];
    if (sentUsers.has(normalizeName(userName))) {
      logger.info(`${userName}: セッション内で送信済み → スキップ`);
      summary.skipped++;
      continue;
    }

    logger.progress(i + 1, targets.length, userName);
    await ensureWindowVisible(popupWindowId);

    try {
      const result = await withTimeout(
        () => processUser(tabId, userName, tagName, sentUsers, logger),
        USER_TIMEOUT_MS,
        userName
      );

      if (result.success) {
        summary.sent++;
        logger.success(`${userName}: 送信完了`);
      } else if (result.skipped) {
        summary.skipped++;
        logger.info(`${userName}: スキップ (${result.reason})`);
      } else if (result.error) {
        summary.errors++;
        logger.error(`${userName}: ${result.error}`);
      }
    } catch (e) {
      summary.errors++;
      logger.error(`${userName}: ${e.message}`);
      // タイムアウト時はページリロード
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

// === 内部関数 ===

async function scrollToYesterday(tabId, logger) {
  let lastResult = null;
  for (let i = 0; i < 60; i++) {
    const result = await execMain(tabId, findYesterdaySection);
    lastResult = result;
    if (result?.found) {
      logger.info(`「昨日」セクションを発見（${i + 1}回目）`);
      await sleep(1000);
      return true;
    }
    await execMain(tabId, scrollChatList, [400]);
    await sleep(300);
  }
  // 診断: 最後のスキャンで見つかったリーフテキストを出力
  if (lastResult?.sampleTexts?.length > 0) {
    logger.info(`[診断] リーフテキスト: ${lastResult.sampleTexts.join(' | ')}`);
  } else {
    logger.info(`[診断] リーフテキストなし (scrollTop=${lastResult?.scrollTop}, scrollHeight=${lastResult?.scrollHeight})`);
  }
  logger.info('「昨日」セクションが見つかりませんでした');
  return false;
}

async function scanTargets(tabId, logger) {
  const allTargets = new Set();
  // 少し上（今日寄り）に戻す
  for (let i = 0; i < 3; i++) {
    await execMain(tabId, scrollChatList, [-500]);
    await sleep(400);
  }
  let everFoundYesterday = false;
  let sampleLogged = false;
  for (let scan = 0; scan < 100; scan++) {
    const result = await execMain(tabId, scanKarisateiTargets);
    if (!result) break;
    // 最初のスキャンでチャット項目のサンプルを出力（診断用）
    if (!sampleLogged && result.sampleItems && result.sampleItems.length > 0) {
      sampleLogged = true;
      logger.info(`チャット項目サンプル: ${result.sampleItems.join(' | ')}`);
    }
    for (const name of result.targets) allTargets.add(name);
    if (result.hasYesterday) everFoundYesterday = true;
    if (everFoundYesterday && result.hasOlderDates) {
      logger.info(`昨日/一昨日の境目を検出（${scan + 1}回目のスキャン）`);
      break;
    }
    await execMain(tabId, scrollChatList, [400]);
    await sleep(600);
  }
  return [...allTargets];
}

async function processUser(tabId, userName, tagName, sentUsers, logger) {
  // Step 1: 昨日位置に戻る
  await scrollToYesterday(tabId, logger);

  // Step 2: ユーザーをクリック（スクロールリトライ + 検索フォールバック）
  let clickResult = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    clickResult = await execMain(tabId, clickUserInChatList, [userName]);
    if (clickResult?.hasUnread) {
      return { skipped: true, reason: '未読メッセージあり（既読防止）' };
    }
    if (clickResult?.clicked) break;
    await execMain(tabId, scrollChatList, [attempt % 2 === 0 ? 400 : -400]);
    await sleep(500);
  }

  // 検索フォールバック
  if (!clickResult?.clicked) {
    logger.info(`${userName} がリストに見つかりません。検索で探します...`);
    const searchPos = await execMain(tabId, getSearchBoxPosition);
    if (searchPos) {
      await cdpClick(tabId, searchPos.x, searchPos.y);
      await sleep(300);
      // CDP で全選択→入力（isTrusted: true でフレームワークに検知させる）
      await cdpSelectAll(tabId);
      await sleep(100);
      await cdpType(tabId, userName);
      await sleep(500);
      // Enter
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      });
      await sleep(2000);

      // 検索結果からクリック
      clickResult = await execMain(tabId, clickUserInChatList, [userName]);
      if (clickResult?.hasUnread) {
        return { skipped: true, reason: '未読メッセージあり（既読防止）' };
      }
    }
  }

  if (!clickResult?.clicked) {
    return { error: 'ユーザーが見つかりません' };
  }

  await sleep(2000);

  // Step 3: 資格チェック（リトライ3回）
  let eligibility;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // チャットパネルの読み込み待ち
      await sleep(500);
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

  // Step 4: テンプレートメッセージ送信（DOM click版 - Reactイベント確実発火）
  logger.info(`テンプレート「${TEMPLATE_NAME}」を送信中...`);
  const sendResult = await execMain(tabId, sendTemplateMessageByDOM, [TEMPLATE_NAME]);
  if (sendResult?.error) return sendResult;
  if (!sendResult?.messageSent) return { error: 'メッセージ送信に失敗しました' };
  logger.info(`メッセージ送信成功${sendResult.verified ? '（確認済み）' : ''}`);

  // 送信成功 → 記録
  sentUsers.add(normalizeName(userName));

  // Step 5: タグ付与
  const tagged = await applyTag(tabId, tagName, logger);

  return { success: true, tagged };
}

/** タグ付与 */
async function applyTag(tabId, tagName, logger) {
  logger.info(`タグ付与: ${tagName}`);

  // タグ編集を開く
  const openResult = await execMain(tabId, openTagEditor);
  if (!openResult?.opened) {
    logger.error('タグ編集を開けませんでした');
    return false;
  }
  await sleep(2000);

  // タグ選択
  const tagClicked = await execMain(tabId, clickTag, [tagName]);
  if (!tagClicked) {
    logger.error(`タグ「${tagName}」が見つかりません`);
    const cancelPos = await execMain(tabId, getCancelButtonPosition);
    if (cancelPos) await cdpClick(tabId, cancelPos.x, cancelPos.y);
    return false;
  }
  await sleep(1000);

  // 保存
  const savePos = await execMain(tabId, getSaveButtonPosition);
  if (!savePos) {
    logger.error('保存ボタンが見つかりません');
    return false;
  }
  await cdpClick(tabId, savePos.x, savePos.y);
  await sleep(1500);

  // 検証
  const verified = await execMain(tabId, verifyTag, [tagName]);
  if (verified) {
    logger.success(`タグ「${tagName}」を付与しました`);
    return true;
  }
  logger.error('タグ付与の検証に失敗');
  return false;
}
