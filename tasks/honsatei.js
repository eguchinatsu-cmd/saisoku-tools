/**
 * 本査定後催促タスク
 *
 * kintone APIで昨日「本査定完了」になったレコードを取得し、
 * LINE Chatでレコード番号検索 → 価格に応じた3パターンのメッセージ送信 → タグ付与。
 *
 * 価格パターン（2パターン）:
 *   0円: 専用メッセージ（返送・引き取り案内付き）
 *   1円以上: テンプレートテキスト直接入力
 *
 * NOTE: テンプレートアイコン(la-chat-plus)のDOM検索が背景モードで失敗するため、
 *       全パターンsendDirectMessageByDOM（テキスト直接入力）方式に統一。(2026-03-27)
 */

import { cdpClick, cdpSelectAll, cdpType, attachDebugger, cdpEnableBackgroundMode, cdpDisableBackgroundMode } from '../lib/cdp.js';
import { sleep, execMain, withTimeout, waitForTabLoad, waitForLineChatReady, waitForChatContent, navigateToLineChat, reEnableBackgroundMode, ensureWindowVisible, getYesterdayJST, getCurrentMonthTag } from '../lib/utils.js';
import { getKintoneRecords } from '../lib/kintone-api.js';
import {
  getFilterStatus, getFilterAllOptionPosition,
  getSearchBoxPosition, clearSearchBox, getMessageSearchLinkPosition,
  getFirstSearchResultPosition, checkUnreadInSearchResult, checkSearchResultTimestamp,
  checkUnreadMarkerInChat,
  scrollChatToBottom, checkHonsateiEligibility,
  sendDirectMessageByDOM,
  getChatClosePosition,
} from '../lib/line-chat.js';

const BOT_ID = 'U6d15f79f9d4634a23b9a085612b087b5';
const TAG_PREFIX = '本査定後催促済';
const USER_TIMEOUT_MS = 60000;

const ZERO_PRICE_MESSAGE = [
  '本査定結果についてご検討いただけましたでしょうか。',
  '',
  '【返送】をご希望の場合はその旨ご連絡ください。',
  'また、ご不要な場合は弊社にて【引き取り】をすることも可能でございます。',
  '',
  'ご確認のほどよろしくお願いいたします。',
].join('\n');

// テンプレート「本査定後の催促」のテキスト（{name}を顧客名で置換して使用）
const TEMPLATE_MESSAGE = [
  '{name}様',
  '',
  'お世話になっております。',
  '',
  '本査定結果についてご検討いただけましたでしょうか。',
  '',
  '買取をご希望の場合は、以下のテンプレートをコピー、情報をご記入いただきペーストして送信をお願いします。',
  '',
  '銀行名：',
  '金融機関コード：',
  '支店名：',
  '支店コード：',
  '口座種別：',
  '口座番号：',
  'ご名義（カナ）：',
  '買取方法：特急買取/高額買取（お選びください）',
  '',
  '※別途、本人確認書類のお写真の送信をお願いします。',
  '',
  '※市場価格の変動により買取価格が低下してしまう場合もございますため、',
  '　お早めにご確認いただきますようお願い申し上げます。',
].join('\n');

function buildMessage(name) {
  return TEMPLATE_MESSAGE.replace('{name}', name);
}

export async function runHonsatei(tabId, popupWindowId, logger, kintoneConfig, testOptions = null) {
  const isTest = !!testOptions;
  const summary = { sent: 0, skipped: 0, errors: 0 };
  const tagName = getCurrentMonthTag(TAG_PREFIX);
  const yesterday = getYesterdayJST();

  if (isTest) logger.info('=== テストモード ===');
  logger.info(`対象日: ${yesterday.formatted}（昨日）`);
  logger.info(`タグ: ${tagName}`);

  await cdpEnableBackgroundMode(tabId);

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
    targets = await getKintoneRecords(kintoneConfig, 'honsatei', yesterday.formatted);
  } catch (e) {
    logger.error(`kintone APIエラー: ${e.message}`);
    await cdpDisableBackgroundMode(tabId);
    return { error: e.message, summary };
  }

  if (targets.length === 0) {
    logger.info('対象レコードなし');
    await cdpDisableBackgroundMode(tabId);
    return { summary };
  }

  // テストモード: 「テスト用」タグを取得（本番タグの代わりに使用）
  let testTagId = null;
  const TEST_TAG_NAME = 'テスト用';
  if (isTest) {
    try {
      testTagId = await execMain(tabId, async function(botId, tName) {
        var res = await fetch('/api/v1/bots/' + botId + '/tags');
        var data = await res.json();
        var tag = data.list.find(function(t) { return t.name === tName; });
        return tag ? tag.tagId : null;
      }, [BOT_ID, TEST_TAG_NAME], 15000);
      logger.info(testTagId ? `テスト用タグID: ${testTagId}` : 'テスト用タグ未検出');
    } catch (e) {
      logger.info(`テスト用タグ取得失敗: ${e.message}`);
    }
  }

  // テストモード: 最大件数制限
  if (isTest && testOptions.maxTargets && targets.length > testOptions.maxTargets) {
    logger.info(`テストモード: ${targets.length}件 → ${testOptions.maxTargets}件に制限`);
    targets = targets.slice(0, testOptions.maxTargets);
  }
  logger.info(`対象: ${targets.length}件 - ${targets.map(t => `${t.recordNumber}(${t.price}円)`).join(', ')}`);

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
      const effectiveTagName = isTest ? TEST_TAG_NAME : tagName;
      const effectiveTagId = isTest ? testTagId : tagId;
      const result = await withTimeout(
        () => processTarget(tabId, target, effectiveTagName, effectiveTagId, logger, testOptions),
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
      // デバッガ外れ or タイムアウト → 再接続してから続行
      if (e.message.includes('Debugger is not attached') || e.message.toLowerCase().includes('timeout')) {
        try {
          logger.info('デバッガ再接続中...');
          await attachDebugger(tabId);
          logger.info('デバッガ再接続完了');
        } catch (attachErr) {
          // 既にアタッチ済みの場合もある
          if (!attachErr.message?.toLowerCase().includes('already attached') && !attachErr.message?.includes('Another debugger')) {
            logger.error(`デバッガ再接続失敗: ${attachErr.message}`);
          }
        }
        if (e.message.toLowerCase().includes('timeout')) {
          await chrome.tabs.update(tabId, { url: 'https://chat.line.biz/' });
          await sleep(2000);
          await reEnableBackgroundMode(tabId);
          await waitForLineChatReady(tabId, 10000);
        }
      }
    }

    // チャットを閉じる
    try {
      const closePos = await execMain(tabId, getChatClosePosition);
      if (closePos) await cdpClick(tabId, closePos.x, closePos.y);
      await sleep(1500);
    } catch (_) {}
  }

  await cdpDisableBackgroundMode(tabId);

  logger.success(`完了: ${summary.sent}送信, ${summary.skipped}スキップ, ${summary.errors}エラー`);
  return { summary };
}

async function processTarget(tabId, target, tagName, tagId, logger, testOptions = null) {
  const isTest = !!testOptions;
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

  // 2. 「メッセージを検索」→ 結果表示後に未読チェック
  // NOTE: Enter直後のパネルはチャットリスト（検索結果ではない）ので
  //       先に「メッセージを検索」をクリックしてから未読チェックする
  const msgSearchPos = await execMain(tabId, getMessageSearchLinkPosition);
  if (msgSearchPos) {
    await cdpClick(tabId, msgSearchPos.x, msgSearchPos.y);
    await sleep(5000); // メッセージ検索結果の読み込みに5秒必要

    // メッセージ検索結果で未読チェック
    const unreadCheck = await execMain(tabId, checkUnreadInSearchResult);
    logger.info(`[未読チェック] hasUnread=${unreadCheck?.hasUnread}, debug=${unreadCheck?.debug}`);
    if (unreadCheck?.hasUnread) {
      await execMain(tabId, clearSearchBox);
      return { skipped: true, reason: '未読メッセージあり（既読防止）' };
    }
  }

  // 3. タイムスタンプチェック（「昨日」以外ならスキップ）
  const tsCheck = await execMain(tabId, checkSearchResultTimestamp);
  if (tsCheck && !tsCheck.isYesterday) {
    logger.info(`タイムスタンプ不一致: ${tsCheck.timestamp} (${tsCheck.reason}) → スキップ`);
    await execMain(tabId, clearSearchBox);
    return { skipped: true, reason: `タイムスタンプ不一致: ${tsCheck.timestamp}` };
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

  // 同期scrollを複数回実行（バックグラウンドタブのsetIntervalスロットル回避）
  for (let i = 0; i < 5; i++) {
    await execMain(tabId, scrollChatToBottom);
    await sleep(500);
  }

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

  // 7. テストモード時 → テストchatに切り替えて送信
  if (isTest) {
    logger.info(`テストモード: 送信先をテストchatに切替`);
    const testChatUrl = `https://chat.line.biz/${BOT_ID}/chat/${testOptions.testChatId}`;
    await navigateToLineChat(tabId, testChatUrl);
  }

  // メッセージ送信（2パターン）— テキスト直接入力方式
  let priceInfo;
  let message;
  if (isZeroPrice) {
    logger.info('0円 → 専用メッセージ直接入力');
    message = ZERO_PRICE_MESSAGE;
    priceInfo = '0円・専用メッセージ';
  } else {
    logger.info(`${price}円 → テンプレートテキスト直接入力`);
    message = buildMessage(target.name);
    priceInfo = `${price}円・テンプレートテキスト`;
  }

  const sendResult = await execMain(tabId, sendDirectMessageByDOM, [message], 30000);
  if (sendResult?.error) return sendResult;
  if (!sendResult?.messageSent) return { error: 'メッセージ送信に失敗しました' };

  // 8. タグ付与（API方式）
  let tagged = false;
  try {
    tagged = await applyTagViaAPI(tabId, tagId, tagName, logger, isTest ? testOptions.testChatId : null);
  } catch (e) {
    logger.info(`タグ付与スキップ: ${e.message}`);
  }

  // テストモード: タグを即削除（クリーンアップ）
  if (isTest && tagged) {
    try {
      await removeTagViaAPI(tabId, tagId, logger, testOptions.testChatId);
    } catch (_) {}
  }

  return { success: true, tagged, priceInfo };
}

/** タグ付与（API方式 — UI操作不要） */
async function applyTagViaAPI(tabId, tagId, tagName, logger, overrideChatId = null) {
  logger.info(`タグ付与(API): ${tagName}`);

  if (!tagId) {
    logger.error(`タグID未取得（タグ「${tagName}」がLINE Chatに存在しない可能性）`);
    return false;
  }

  // chatIdを取得（override or URLから）
  const chatId = overrideChatId || await execMain(tabId, function() {
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

/** テストモード用: タグ削除（クリーンアップ） */
async function removeTagViaAPI(tabId, tagId, logger, chatId) {
  const result = await execMain(tabId, async function(botId, cId, tId) {
    try {
      var chatRes = await fetch('/api/v1/bots/' + botId + '/chats/' + cId);
      var chatData = await chatRes.json();
      var currentTags = (chatData.tagIds || []).filter(function(id) { return id !== tId; });
      var res = await fetch('/api/v1/bots/' + botId + '/chats/' + cId + '/tags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ tagIds: currentTags }),
      });
      return res.ok ? { success: true } : { error: res.status };
    } catch (e) {
      return { error: e.message };
    }
  }, [BOT_ID, chatId, tagId], 15000);

  if (result?.success) {
    logger.info('テストタグ削除完了（クリーンアップ）');
  } else {
    logger.info(`テストタグ削除失敗: ${result?.error}`);
  }
}
