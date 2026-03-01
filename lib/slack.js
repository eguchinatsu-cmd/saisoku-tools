/**
 * Slack通知モジュール（Chrome拡張機能用）
 *
 * エラー・結果サマリーをSlackチャンネルに自動送信。
 * スタッフがログを手動で取得する必要がなくなる。
 *
 * トークンはchrome.storage.localに保存（initSlackConfig()で初期化）
 */

const SLACK_CHANNEL = 'C0A2PM9H4LX'; // #開発

/**
 * 拡張機能インストール時にトークンを設定する
 * background.jsのonInstalledから呼ぶ
 */
export async function initSlackConfig(token) {
  await chrome.storage.local.set({ slackBotToken: token });
}

async function getToken() {
  const data = await chrome.storage.local.get('slackBotToken');
  return data.slackBotToken || '';
}

async function postToSlack(text) {
  const token = await getToken();
  if (!token) {
    console.warn('[SLACK] トークン未設定。通知スキップ');
    return { ok: false };
  }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: SLACK_CHANNEL, text }),
    });
    const json = await res.json();
    if (!json.ok) console.error(`[SLACK] 送信失敗: ${json.error}`);
    return json;
  } catch (e) {
    console.error(`[SLACK] 通信エラー: ${e.message}`);
    return { ok: false };
  }
}

/**
 * タスク完了時のサマリー通知
 */
export async function notifyResult(taskName, summary) {
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const lines = [`【催促ツール ${taskName}】${now}`];

  if (summary.sent > 0) lines.push(`✓ 送信: ${summary.sent}件`);
  if (summary.skipped > 0) lines.push(`- スキップ: ${summary.skipped}件`);
  if (summary.errors > 0) lines.push(`✗ エラー: ${summary.errors}件`);
  if (summary.sent === 0 && summary.skipped === 0 && summary.errors === 0) {
    lines.push('対象なし');
  }

  await postToSlack(lines.join('\n'));
}

/**
 * エラー通知（致命的エラー発生時）
 */
export async function notifyError(taskName, errorMsg) {
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const text = `【催促ツール エラー】${taskName}\n${errorMsg}\n時刻: ${now}`;
  await postToSlack(text);
}

/**
 * 全タスク完了時のまとめ通知
 */
export async function notifyAllResults(results) {
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const lines = [`【催促ツール 全実行完了】${now}`];

  const taskNames = { karisatei: '仮査定', honsatei: '本査定', konpokit: '梱包キット' };
  for (const [key, name] of Object.entries(taskNames)) {
    const r = results[key];
    if (!r) continue;
    if (r.error) {
      lines.push(`✗ ${name}: エラー - ${r.error}`);
    } else if (r.summary) {
      const s = r.summary;
      lines.push(`${name}: ${s.sent}送信 / ${s.skipped}スキップ / ${s.errors}エラー`);
    }
  }

  await postToSlack(lines.join('\n'));
}
