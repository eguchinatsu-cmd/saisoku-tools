/**
 * 本査定後催促タスク
 *
 * kintone APIで昨日「本査定完了」になったレコードを取得し、
 * LINE Chatでレコード番号検索 → 価格に応じた3パターンのメッセージ送信 → タグ付与。
 *
 * 価格パターン:
 *   0円: テンプレート不使用、直接テキスト入力
 *   1-999円: テンプレート「本査定後の催促」そのまま
 *   1000円以上: テンプレートから「引き取り」文を削除して送信
 */

import { cdpClick, cdpSelectAll, cdpType } from '../lib/cdp.js';
import { sleep, execMain, withTimeout, waitForLineChatReady, waitForChatContent, ensureWindowVisible, getYesterdayJST, getCurrentMonthTag } from '../lib/utils.js';
import { getKintoneRecords } from '../lib/kintone-api.js';
import {
  getSearchBoxPosition, clearSearchBox, getMessageSearchLinkPosition,
  getFirstSearchResultPosition, checkUnreadInSearchResult,
  scrollChatToBottom, checkHonsateiEligibility,
  sendTemplateMessageByDOM, selectTemplateByDOM, sendDirectMessageByDOM, editAndSendByDOM,
  openTagEditor, clickTag, getSaveButtonPosition, getCancelButtonPosition, verifyTag,
  getChatClosePosition,
} from '../lib/line-chat.js';

const TEMPLATE_NAME = '本査定後の催促';
const TAG_PREFIX = '本査定後催促済';
const LOW_PRICE_THRESHOLD = 999;
const USER_TIMEOUT_MS = 60000;

const ZERO_PRICE_MESSAGE = [
  '本査定結果についてご検討いただけましたでしょうか。',
  '',
  '【返送】をご希望の場合はその旨ご連絡ください。',
  'また、ご不要な場合は弊社にて【引き取り】をすることも可能でございます。',
  '',
  'ご確認のほどよろしくお願いいたします。',
].join('\n');

export async function runHonsatei(tabId, popupWindowId, logger, kintoneConfig) {
  const summary = { sent: 0, skipped: 0, errors: 0 };
  const tagName = getCurrentMonthTag(TAG_PREFIX);
  const yesterday = getYesterdayJST();

  logger.info(`対象日: ${yesterday.formatted}（昨日）`);
  logger.info(`タグ: ${tagName}`);

  // Step 1: kintoneからレコード取得
  logger.info('kintone APIからレコード取得中...');
  let targets;
  try {
    targets = await getKintoneRecords(kintoneConfig, 'honsatei', yesterday.formatted);
  } catch (e) {
    logger.error(`kintone APIエラー: ${e.message}`);
    return { error: e.message, summary };
  }

  if (targets.length === 0) {
    logger.info('対象レコードなし');
    return { summary };
  }
  logger.info(`対象: ${targets.length}件 - ${targets.map(t => `${t.recordNumber}(${t.price}円)`).join(', ')}`);

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
        logger.success(`${target.recordNumber}: 送信完了 (${result.priceInfo || ''})`);
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
      await sleep(1500);
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

  // 3. 「メッセージを検索」→ 結果をクリック
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

  // 5. 資格チェック（タグ・本査定結果・顧客返信・価格抽出）
  const eligibility = await execMain(tabId, checkHonsateiEligibility, [{ skipTagCheck: false }]);
  if (!eligibility?.eligible) {
    if (eligibility?.debug) logger.info(`スキップ詳細: ${eligibility.debug}`);
    return { skipped: true, reason: eligibility?.reason || 'unknown' };
  }

  // 6. 価格決定（LINE抽出 → kintoneフォールバック）
  const price = eligibility.extractedPrice !== null ? eligibility.extractedPrice : target.price;
  const priceSource = eligibility.extractedPrice !== null ? 'LINE' : 'kintone';
  logger.info(`価格: ${price}円 (${priceSource}), LINE抽出: ${JSON.stringify(eligibility.allPrices)}`);

  const isZeroPrice = price === 0;
  const isLowPrice = price > 0 && price <= LOW_PRICE_THRESHOLD;

  // 7. メッセージ送信（3パターン）（DOM click版 - Reactイベント確実発火）
  let priceInfo;
  if (isZeroPrice) {
    // === 0円: 直接テキスト入力（テンプレート不使用） ===
    logger.info('0円 → 専用メッセージ直接入力');
    const sendResult = await execMain(tabId, sendDirectMessageByDOM, [ZERO_PRICE_MESSAGE]);
    if (sendResult?.error) return sendResult;
    if (!sendResult?.messageSent) return { error: 'メッセージ送信に失敗しました' };
    priceInfo = '0円・専用メッセージ';

  } else if (isLowPrice) {
    // === 1-999円: テンプレートそのまま ===
    logger.info(`${price}円 → テンプレートそのまま（引き取り文あり）`);
    const sendResult = await execMain(tabId, sendTemplateMessageByDOM, [TEMPLATE_NAME]);
    if (sendResult?.error) return sendResult;
    if (!sendResult?.messageSent) return { error: 'メッセージ送信に失敗しました' };
    priceInfo = `${price}円・テンプレートそのまま`;

  } else {
    // === 1000円以上: テンプレートから引き取り文削除 ===
    logger.info(`${price}円 → テンプレート + 引き取り文削除`);

    // テンプレート選択（送信前に停止）
    const selectResult = await execMain(tabId, selectTemplateByDOM, [TEMPLATE_NAME]);
    if (selectResult?.error) return selectResult;
    if (!selectResult?.selected) return { error: 'テンプレート選択に失敗しました' };

    // 引き取り文を削除して送信
    const sendResult = await execMain(tabId, editAndSendByDOM);
    if (sendResult?.error) return sendResult;
    if (!sendResult?.messageSent) return { error: 'メッセージ送信に失敗しました' };
    priceInfo = `${price}円・引き取り文削除`;
  }

  // 8. タグ付与
  const tagged = await applyTag(tabId, tagName, logger);

  return { success: true, tagged, priceInfo };
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
