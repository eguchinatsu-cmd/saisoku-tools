/**
 * Slack エラー通知モジュール（催促CLI共通）
 *
 * 使い方:
 *   const { notifyError, notifyResult } = require('../../lib/slack-notify');
 *   await notifyError('karisatei', 'ログイン失敗', { record: '345001', name: '太郎' });
 *   await notifyResult('karisatei', results);
 */

const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');

// slack-config.json からトークンと送信先を読み込む
let SLACK_BOT_TOKEN = '';
let NOTIFY_CHANNEL = '';
try {
  const configPath = path.join(__dirname, '..', 'slack-config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  SLACK_BOT_TOKEN = config.token;
  NOTIFY_CHANNEL = config.channel;
} catch (e) {
  console.error('[SLACK] slack-config.json が見つかりません。Slack通知は無効です。');
}

function postToSlack(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ channel: NOTIFY_CHANNEL, text });
    const options = {
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (!json.ok) {
            console.error(`[SLACK] 送信失敗: ${json.error}`);
          }
          resolve(json);
        } catch (e) {
          resolve({ ok: false });
        }
      });
    });
    req.on('error', (e) => {
      console.error(`[SLACK] 通信エラー: ${e.message}`);
      resolve({ ok: false });
    });
    req.write(data);
    req.end();
  });
}

/**
 * エラー通知（個別エラー発生時）
 */
async function notifyError(skillName, errorMsg, context = {}) {
  const pcName = os.hostname();
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  let text = `【${skillName} エラー】${errorMsg}\nPC: ${pcName}\n時刻: ${now}`;
  if (context.record) text += `\nレコード: ${context.record}`;
  if (context.name) text += `\n名前: ${context.name}`;
  if (context.detail) text += `\n詳細: ${context.detail}`;
  await postToSlack(text);
}

/**
 * 結果サマリー通知（処理完了時）
 */
async function notifyResult(skillName, results) {
  const pcName = os.hostname();
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const lines = [`【${skillName} 完了】PC: ${pcName} / ${now}`];

  if (results.processed && results.processed.length > 0) {
    lines.push(`✓ 処理完了: ${results.processed.length}件`);
  }
  if (results.skipped && results.skipped.length > 0) {
    lines.push(`- スキップ: ${results.skipped.length}件`);
  }
  if (results.errors && results.errors.length > 0) {
    lines.push(`✗ エラー: ${results.errors.length}件`);
    for (const e of results.errors) {
      lines.push(`  ${e.record || ''} ${e.name || ''}: ${e.reason || e.error || '不明'}`);
    }
  }
  if (results.timedOut && results.timedOut.length > 0) {
    lines.push(`⏱ タイムアウト: ${results.timedOut.length}件`);
    for (const t of results.timedOut) {
      lines.push(`  ${t.record || ''} ${t.name || ''}`);
    }
  }

  await postToSlack(lines.join('\n'));
}

module.exports = { notifyError, notifyResult, postToSlack };
