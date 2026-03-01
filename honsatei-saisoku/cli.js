#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { notifyError, notifyResult } = require('../lib/slack-notify');

// 認証情報を読み込む
let CREDENTIALS;
try {
  const credentialsPath = path.join(__dirname, 'credentials.local.json');
  CREDENTIALS = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
} catch (error) {
  console.error('[ERROR] credentials.local.jsonが見つかりません。');
  console.error('[INFO] credentials.local.jsonを作成してください:');
  console.error(`{
  "line": {
    "email": "your-email@example.com",
    "password": "your-password"
  },
  "kintone": {
    "domain": "japanconsulting.cybozu.com",
    "appId": "11",
    "apiToken": "your-kintone-api-token"
  }
}`);
  process.exit(1);
}

// コマンドライン引数を解析
const args = process.argv.slice(2);
const isHeadless = args.includes('--headless') || args.includes('--background') || args.includes('-b');
const showHelp = args.includes('--help') || args.includes('-h');
// --records 339066,344972 のように指定すると、そのレコードのみ処理（タグチェックをスキップ）
const recordsArgIdx = args.findIndex(a => a === '--records');
const forceRecords = recordsArgIdx >= 0 && args[recordsArgIdx + 1]
  ? args[recordsArgIdx + 1].split(',').map(s => s.trim())
  : null;

if (showHelp) {
  console.log(`
本査定後催促 CLIツール

使い方:
  node cli.js [オプション]

オプション:
  --headless, --background, -b  ブラウザを非表示で実行（バックグラウンド）
  --help, -h                    このヘルプを表示

例:
  node cli.js              # ブラウザを表示して実行
  node cli.js --headless   # バックグラウンドで実行
  node cli.js -b           # バックグラウンドで実行（短縮形）
`);
  process.exit(0);
}

// 設定
const CONFIG = {
  lineUrl: 'https://chat.line.biz/',
  loginUrl: 'https://account.line.biz/login?redirectUri=https%3A%2F%2Faccount.line.biz%2Foauth2%2Fcallback%3Fclient_id%3D9%26code_challenge%3DpgB_1K3kYbhX9B7epLwiHdi36LuM9B4NOr7oEwuMlNo%26code_challenge_method%3DS256%26redirect_uri%3Dhttps%253A%252F%252Fchat.line.biz%252Foauth2%252Flinebiz%252Fcallback%26response_type%3Dcode%26state%3DCre6Bu7AQPrglQqSBCiYsoBjJsruiHmZn2gUOCqi0T4',
  width: 2200,
  height: 900,
  templateName: '本査定後の催促',
  getTagName: () => {
    const now = new Date();
    return `本査定後催促済${now.getFullYear()}/${now.getMonth() + 1}`;
  },
  // karisatei-saisokuと同じセッションディレクトリを使用（ログイン情報を共有）
  sessionDir: path.join(__dirname, '..', 'karisatei-saisoku', '.playwright-session'),
  headless: isHeadless,
  // kintone設定
  kintone: {
    domain: CREDENTIALS.kintone?.domain || 'japanconsulting.cybozu.com',
    appId: CREDENTIALS.kintone?.appId || '11',
    apiToken: CREDENTIALS.kintone?.apiToken || '',
    auth: CREDENTIALS.kintone?.auth || ''
  },
  // 低価格の閾値（これ以下は引き取り文を残す。数百円 = 1〜999円）
  lowPriceThreshold: 999,
  // 1人あたりのタイムアウト（ミリ秒）
  userTimeoutMs: 60000
};

// ユーティリティ関数
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// タイムアウト付きで非同期関数を実行
function withTimeout(asyncFn, timeoutMs, label) {
  return Promise.race([
    asyncFn(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT: ${label} - ${timeoutMs / 1000}秒超過`)), timeoutMs)
    )
  ]);
}

const log = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  success: (msg) => console.log(`[SUCCESS] ✓ ${msg}`),
  error: (msg) => console.error(`[ERROR] ✗ ${msg}`),
  user: (msg) => console.log(`[USER] ${msg}`)
};

// 昨日の日付を取得（JST）
function getYesterday() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

  // JSTで日付を計算（UTC+9）
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstDate = new Date(yesterday.getTime() + jstOffset);

  const year = jstDate.getUTCFullYear();
  const month = String(jstDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jstDate.getUTCDate()).padStart(2, '0');

  return { year, month, day, formatted: `${year}-${month}-${day}` };
}

// kintone REST APIでレコードを取得
async function getKintoneRecords() {
  let queryStr;

  if (forceRecords) {
    // --records 指定時: レコード番号で直接取得
    const conditions = forceRecords.map(r => `レコード番号 = "${r}"`).join(' or ');
    queryStr = conditions;
    log.info(`指定レコード: ${forceRecords.join(', ')}`);
  } else {
    const yesterday = getYesterday();
    log.info(`昨日の日付: ${yesterday.formatted}`);
    queryStr =
      `progress in ("本査定完了") and ` +
      `更新日時 >= "${yesterday.formatted}T00:00:00+09:00" and ` +
      `更新日時 <= "${yesterday.formatted}T23:59:59+09:00"`;
  }

  const query = encodeURIComponent(queryStr);

  const url = `https://${CONFIG.kintone.domain}/k/v1/records.json?app=${CONFIG.kintone.appId}&totalCount=false&query=${query}`;

  log.info('kintone APIからレコードを取得中...');
  log.info(`クエリ: ${decodeURIComponent(query)}`);

  return new Promise((resolve, reject) => {
    const options = {
      method: 'GET',
      headers: {
        ...(CONFIG.kintone.apiToken ? { 'X-Cybozu-API-Token': CONFIG.kintone.apiToken } : { 'X-Cybozu-Authorization': CONFIG.kintone.auth })
      }
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            const records = json.records.map(r => ({
              recordNumber: r['レコード番号']?.value || r['$id']?.value,
              name: r['username']?.value || r['氏名']?.value || 'Unknown',
              // 最高高額買取価格を取得
              price: parseInt(r['max_expensive_price']?.value || '0', 10)
            }));
            resolve(records);
          } catch (e) {
            reject(new Error('JSONパースエラー: ' + e.message));
          }
        } else {
          reject(new Error(`kintone API エラー: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.end();
  });
}

// ログイン状態をチェック
async function checkIfLoggedIn(page) {
  try {
    const chatList = await page.$('div.flex-fill.overflow-y-auto');
    if (chatList) return true;
    const loginButton = await page.$('button:has-text("ログイン")');
    if (loginButton) return false;
    const chatLink = await page.$('a[href*="/chat/"]');
    if (chatLink) return true;
    return false;
  } catch (e) {
    return false;
  }
}

// ログイン成功を待機
async function waitForLoginSuccess(page, timeoutMs) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (pageText.includes('401') || pageText.includes('Unauthorized')) {
      return false;
    }
    const currentUrl = page.url();
    if (!currentUrl.includes('account.line.biz') &&
        (currentUrl.includes('chat.line.biz') || currentUrl.includes('manager.line.biz'))) {
      const hasContent = await page.evaluate(() => {
        const chatList = document.querySelector('div.flex-fill.overflow-y-auto');
        const accountLinks = document.querySelectorAll('a[href*="/chat/"]');
        return chatList !== null || accountLinks.length > 0;
      }).catch(() => false);
      if (hasContent) return true;
    }
    await sleep(2000);
  }
  return false;
}

// メイン処理
async function main() {
  log.info('本査定後催促ツール起動');

  // Step 1: kintoneから対象レコードを取得
  let targets;
  try {
    targets = await getKintoneRecords();
    log.info(`kintoneから取得した対象レコード: ${targets.length}件`);
    if (targets.length > 0) {
      console.log(targets);
    }
  } catch (e) {
    log.error(`kintone API エラー: ${e.message}`);
    log.info('kintone APIトークンを確認してください。');
    process.exit(1);
  }

  if (targets.length === 0) {
    log.info('対象レコードがありません。終了します。');
    return;
  }

  // セッションディレクトリを確認
  if (!fs.existsSync(CONFIG.sessionDir)) {
    fs.mkdirSync(CONFIG.sessionDir, { recursive: true });
    log.info('セッションディレクトリを作成しました');
  }

  // ブラウザを起動
  if (CONFIG.headless) {
    log.info('headlessモードで実行中（ブラウザ非表示）');
  }
  const context = await chromium.launchPersistentContext(CONFIG.sessionDir, {
    headless: CONFIG.headless,
    channel: 'chrome',
    viewport: { width: CONFIG.width, height: CONFIG.height }
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    // Step 2: LINE Chatにアクセス
    log.info('LINE Chat にアクセス中...');
    await page.goto(CONFIG.lineUrl);
    await sleep(3000);

    // ログイン確認
    const isLoggedIn = await checkIfLoggedIn(page);
    if (!isLoggedIn) {
      log.info('ログインが必要です。ログイン画面に移動...');
      await page.goto(CONFIG.loginUrl);
      await sleep(2000);
      const loginResult = await handleLogin(page);
      if (loginResult === 'AUTH_REQUIRED') {
        log.info('本人確認が必要なため、ブラウザを閉じます。');
        await context.close();
        process.exit(0);
      }
    } else {
      log.success('セッションが有効です。ログインをスキップします');
    }

    // chat.line.bizに遷移
    let currentUrl = page.url();
    if (!currentUrl.includes('chat.line.biz')) {
      log.info('chat.line.biz に遷移中...');
      await page.goto('https://chat.line.biz/');
      await sleep(5000);
    }

    // チャットリストが表示されるまで待機
    log.info('チャットリストの表示を待機中...');
    await page.waitForSelector('div.flex-fill.overflow-y-auto', { timeout: 30000 });
    log.success('チャットリストが表示されました');

    // 結果を格納
    const results = {
      completed: [],
      skipped: [],
      errors: []
    };

    // Step 3: 各対象者を処理
    log.info('連続処理を開始します...');
    results.timedOut = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      log.info(`[${i + 1}/${targets.length}] レコード番号 ${target.recordNumber} (${target.name}) を処理中...`);

      try {
        const result = await withTimeout(
          () => processTarget(page, target, !!forceRecords),
          CONFIG.userTimeoutMs,
          `${target.recordNumber} (${target.name})`
        );
        if (result.success) {
          log.success(`${target.name} - メッセージ送信・タグ付与完了`);
          results.completed.push(target);
        } else if (result.skipped) {
          log.info(`${target.name} - スキップ (${result.reason})`);
          results.skipped.push({ ...target, reason: result.reason });
        } else if (result.error) {
          log.error(`${target.name} - エラー: ${result.error}`);
          results.errors.push({ ...target, error: result.error });
        }
      } catch (e) {
        if (e.message.startsWith('TIMEOUT:')) {
          results.timedOut.push(target);
          log.error(`${target.name} - タイムアウト（${CONFIG.userTimeoutMs / 1000}秒）→ スキップ`);
          // ページをリセット（ハング中の操作をキャンセル）
          try {
            await page.goto(CONFIG.lineUrl, { timeout: 15000 });
            await page.waitForSelector('div.flex-fill.overflow-y-auto', { timeout: 15000 });
            await sleep(2000);
            log.info('ページリセット完了');
          } catch (resetErr) {
            log.info('ページリセット中にエラー: ' + resetErr.message);
          }
        } else {
          log.error(`${target.name} - エラー: ${e.message}`);
          results.errors.push({ ...target, error: e.message });
        }
      }

      // 次の処理前に少し待機
      await sleep(1000);
    }

    // 結果サマリー
    console.log('\n========================================');
    log.success(`処理完了: ${results.completed.length}人`);
    log.info(`スキップ: ${results.skipped.length}人`);
    if (results.timedOut.length > 0) log.info(`タイムアウト: ${results.timedOut.length}人`);
    log.error(`エラー: ${results.errors.length}人`);
    console.log('========================================\n');

    if (results.completed.length > 0) {
      console.log('処理完了:');
      results.completed.forEach(t => console.log(`  - ${t.recordNumber}: ${t.name}`));
    }
    if (results.skipped.length > 0) {
      console.log('\nスキップ:');
      results.skipped.forEach(t => console.log(`  - ${t.recordNumber}: ${t.name} (${t.reason})`));
    }
    if (results.timedOut.length > 0) {
      console.log('\nタイムアウト:');
      results.timedOut.forEach(t => console.log(`  - ${t.recordNumber}: ${t.name} (${CONFIG.userTimeoutMs / 1000}秒超過)`));
    }
    if (results.errors.length > 0) {
      console.log('\nエラー:');
      results.errors.forEach(t => console.log(`  - ${t.recordNumber}: ${t.name}: ${t.error}`));
    }

    // Slack通知
    await notifyResult('本査定催促', {
      processed: results.completed.map(t => ({ record: t.recordNumber, name: t.name })),
      skipped: results.skipped.map(t => ({ record: t.recordNumber, name: t.name, reason: t.reason })),
      timedOut: results.timedOut.map(t => ({ record: t.recordNumber, name: t.name })),
      errors: results.errors.map(t => ({ record: t.recordNumber, name: t.name, reason: t.error })),
    });

  } catch (e) {
    log.error(`予期しないエラー: ${e.message}`);
    console.error(e);
    await notifyError('本査定催促', e.message, { detail: e.stack });
  } finally {
    // チャットを閉じる（既読防止のため）
    log.info('チャットを閉じています...');
    try {
      await page.evaluate(() => {
        const chatIcon = document.querySelector('i.lar.la-chat-all');
        if (chatIcon) chatIcon.parentElement.click();
        return 'chat closed';
      });
      await sleep(1000);
      log.success('チャットを閉じました');
    } catch (e) {
      log.info('チャットを閉じる処理をスキップしました');
    }

    log.info('ブラウザを閉じます（5秒後）...');
    await sleep(5000);
    await context.close();
  }
}

// ログイン処理
async function handleLogin(page) {
  log.info('LINEアカウントでログイン中...');
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(2000);

  // LINE Business ID画面で「LINEアカウント」ボタンをクリック
  try {
    const lineAccountBtn = page.locator('button:has-text("LINEアカウント")');
    if (await lineAccountBtn.isVisible({ timeout: 3000 })) {
      log.info('LINEアカウントボタンをクリック');
      await lineAccountBtn.click();
      await sleep(3000);
    }
  } catch (e) {}

  // 簡易ログイン画面をチェック（えぐち なつ）
  try {
    const pageText = await page.evaluate(() => document.body.innerText || '');
    if (pageText.includes('次のアカウントでログイン') ||
        pageText.includes('えぐち') ||
        pageText.includes('ログインを続行')) {
      log.info('簡易ログイン画面を検出');

      const quickLoginBtn = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.trim() === 'ログイン') {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 50) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
        }
        return null;
      });

      if (quickLoginBtn) {
        log.info('簡易ログインボタンをクリック');
        await page.mouse.click(quickLoginBtn.x, quickLoginBtn.y);
        await sleep(3000);

        // 認証番号が表示されたかチェック
        const authCheckText = await page.evaluate(() => document.body.innerText || '');
        if (authCheckText.includes('認証番号') || authCheckText.includes('本人確認')) {
          log.user('本人確認が必要です。スマホのLINEアプリで認証してください。');
          log.info('ブラウザを閉じて終了します。認証完了後に再実行してください。');
          return 'AUTH_REQUIRED';
        }

        log.info('ログイン処理中...');

        // 「ホームへ戻る」（go Home）ボタンを探してクリック
        try {
          const goHomeBtn = page.locator('button:has-text("ホームへ戻る"), button:has-text("go Home"), a:has-text("ホームへ戻る"), a:has-text("go Home")');
          if (await goHomeBtn.first().isVisible({ timeout: 5000 })) {
            log.info('「ホームへ戻る」ボタンをクリック');
            await goHomeBtn.first().click();
            await sleep(3000);
          }
        } catch (e) {
          log.info('「ホームへ戻る」ボタンが見つかりませんでした');
        }

        const loginSuccess = await waitForLoginSuccess(page, 30000);
        if (loginSuccess) {
          log.success('ログイン完了');
          return;
        }
      }
    }
  } catch (e) {}

  // ログイン完了を待機
  log.user('ログイン画面を確認してください（120秒待機）...');
  const loginSuccess = await waitForLoginSuccess(page, 120000);
  if (loginSuccess) {
    log.success('ログイン完了');
  } else {
    log.error('ログインがタイムアウトしました');
  }
}

// 対象者を処理
async function processTarget(page, target, skipTagCheck = false) {
  try {
    const searchBox = page.getByRole('textbox', { name: '検索', exact: true });

    // 1. 未読チェック: ユーザー名で検索してチャットを開く前に未読バッジを確認
    log.info(`${target.name} の未読チェック中...`);
    await searchBox.clear();
    await searchBox.fill(target.name);
    await searchBox.press('Enter');
    await sleep(2000);

    const hasUnread = await page.evaluate(() => {
      const panel = document.querySelector('div.flex-fill.overflow-y-auto');
      if (!panel) return false;
      // list-group-item内の最初のチャットアイテムを探す（href="#"のVueリンク）
      const firstItem = panel.querySelector('.list-group-item');
      if (!firstItem) return false;
      const allEls = firstItem.querySelectorAll('*');
      for (const el of allEls) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 5 && rect.width <= 20 && rect.height >= 5 && rect.height <= 20) {
          const style = window.getComputedStyle(el);
          if (style.backgroundColor === 'rgb(6, 199, 85)') return true;
        }
        if (el.className && typeof el.className === 'string' &&
            (el.className.includes('badge') || el.className.includes('unread'))) {
          const text = el.textContent.trim();
          if (text && /^\d+$/.test(text) && parseInt(text) > 0) return true;
        }
      }
      return false;
    });

    if (hasUnread) {
      log.info('未読メッセージあり → 既読防止のためスキップ');
      await searchBox.clear();
      await sleep(500);
      return { skipped: true, reason: '未読メッセージあり（既読防止）' };
    }

    // 2. チャットをクリック（名前検索 → メッセージ検索のフォールバック）
    // NOTE: item.querySelector('a') はドロップダウンメニューを返す。
    // チャットリンクは a.d-flex（2番目のa）なので必ずこちらを使う。
    let clickResult = await page.evaluate((targetName) => {
      const panel = document.querySelector('div.flex-fill.overflow-y-auto');
      if (!panel) return { error: 'chat list not found' };
      const items = panel.querySelectorAll('.list-group-item');
      for (const item of items) {
        const h6 = item.querySelector('h6');
        if (h6 && h6.textContent.trim() === targetName) {
          const link = item.querySelector('a.d-flex') || item.querySelectorAll('a')[1] || item.querySelector('a');
          if (link) link.click();
          return { clicked: true, method: 'h6-exact' };
        }
      }
      for (const item of items) {
        const h6 = item.querySelector('h6');
        if (h6 && h6.textContent.trim().includes(targetName)) {
          const link = item.querySelector('a.d-flex') || item.querySelectorAll('a')[1] || item.querySelector('a');
          if (link) link.click();
          return { clicked: true, method: 'h6-partial' };
        }
      }
      for (const item of items) {
        if (item.textContent.includes(targetName)) {
          const link = item.querySelector('a.d-flex') || item.querySelectorAll('a')[1] || item.querySelector('a');
          if (link) link.click();
          return { clicked: true, method: 'text-match' };
        }
      }
      return { error: 'not found', itemCount: items.length };
    }, target.name);

    // フォールバック: 名前でヒットしない場合、「メッセージを検索」でメッセージ内容を検索
    if (!clickResult || !clickResult.clicked) {
      log.info(`名前検索でヒットなし → メッセージ内容を検索`);
      // レコード番号で検索（メッセージ内に含まれている可能性が高い）
      await searchBox.clear();
      await searchBox.fill(target.recordNumber);
      await searchBox.press('Enter');
      await sleep(2000);

      // 「メッセージを検索」ボタンをクリック
      const msgBtnClicked = await page.evaluate(() => {
        const btn = document.querySelector('a.btn-outline-primary');
        if (btn && btn.textContent.includes('メッセージを検索')) {
          btn.click();
          return true;
        }
        return false;
      });
      if (msgBtnClicked) {
        await sleep(5000);
        // メッセージ検索結果から最初のアイテムをクリック
        clickResult = await page.evaluate(() => {
          const panel = document.querySelector('div.flex-fill.overflow-y-auto');
          if (!panel) return { error: 'panel not found' };
          const items = panel.querySelectorAll('.list-group-item');
          for (const item of items) {
            if (item.getBoundingClientRect().height > 0) {
              const link = item.querySelector('a.d-flex') || item.querySelectorAll('a')[1] || item.querySelector('a');
              const h6 = item.querySelector('h6');
              if (link) {
                link.click();
                return { clicked: true, method: 'message-search', lineName: h6?.textContent?.trim() || '' };
              }
            }
          }
          return { error: 'no message search results', itemCount: items.length };
        });
      }
    }

    if (!clickResult || !clickResult.clicked) {
      return { error: 'ユーザーが見つかりません' };
    }
    log.info(`クリック方法: ${clickResult.method}${clickResult.lineName ? ' (LINE名: ' + clickResult.lineName + ')' : ''}`);
    await sleep(2000);

    // 2. チャットを最下部にスクロール（最新メッセージを読み込むため）
    // 検索結果クリック後はチャットが古い位置で開くため、最下部にスクロールして
    // 最新のメッセージ・日付セパレータをDOMに読み込ませる必要がある
    await page.evaluate(() => {
      return new Promise((resolve) => {
        const dateSep = document.querySelector('.chatsys-date');
        if (!dateSep) return resolve();
        let container = dateSep.parentElement;
        while (container && container !== document.body) {
          const style = window.getComputedStyle(container);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll' ||
              style.overflow === 'auto' || style.overflow === 'scroll') {
            // 複数回スクロールして確実に最新メッセージを読み込む
            let count = 0;
            const interval = setInterval(() => {
              container.scrollTop = container.scrollHeight;
              count++;
              if (count >= 25) {
                clearInterval(interval);
                resolve();
              }
            }, 200);
            return;
          }
          container = container.parentElement;
        }
        resolve();
      });
    });
    await sleep(5000);

    // 3. 履歴確認: 本査定結果送信後にお客さんからのメッセージがあるか確認
    // ロジック:
    //   スタッフ送信（本査定結果）→ スタッフ送信（査定写真等）= 催促対象 ✓
    //   スタッフ送信（本査定結果）→ お客さん返信 = スキップ ✗
    //   スタッフ送信（本査定結果）→ お客さん返信 → スタッフ送信 = スキップ ✗
    // 判定方法: メッセージバブルの視覚的位置（左=お客さん / 右=スタッフ）
    const eligibilityCheck = await page.evaluate((opts) => {
      const fullText = document.body.innerText || '';

      // タグチェック: 既に催促済みタグがあればスキップ（--records指定時はスキップ）
      if (!opts.skipTagCheck) {
        const tagElements = document.querySelectorAll('a, span, div');
        for (const el of tagElements) {
          if (el.textContent.includes('本査定後催促済')) {
            return { eligible: false, reason: 'タグ付与済み' };
          }
        }
      }

      // 本査定結果が送信されているか確認
      const hasResult = fullText.includes('本査定が完了いたしました') ||
                        fullText.includes('査定結果は以下') ||
                        fullText.includes('本査定結果') ||
                        fullText.includes('査定金額');
      if (!hasResult) {
        return { eligible: false, reason: 'no_assessment_result_found' };
      }

      // 日付セパレータで今日の活動を確認（--records指定時はスキップ）
      if (!opts.skipTagCheck) {
        const dates = document.querySelectorAll('.chatsys-date');
        const dateTexts = Array.from(dates).map(d => d.textContent.trim()).filter(t => t);
        if (dateTexts.some(d => d === '今日')) {
          return { eligible: false, reason: 'activity_today' };
        }
      }

      // チャットスクロールコンテナを取得
      const firstDate = document.querySelector('.chatsys-date');
      let chatContainer = null;
      if (firstDate) {
        let el = firstDate.parentElement;
        while (el && el !== document.body) {
          const style = window.getComputedStyle(el);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll' ||
              style.overflow === 'auto' || style.overflow === 'scroll') {
            chatContainer = el;
            break;
          }
          el = el.parentElement;
        }
      }
      if (!chatContainer) {
        // .chatsys-date が見つからない場合（LINE Chat UI変更等）
        // タグチェック・本査定結果テキストチェック・当日活動チェックは通過済みなので
        // 顧客返信チェックをスキップしてeligibleとして処理
        return { eligible: true, extractedPrice: null, allPrices: [], debug: 'chat_container_not_found_fallback' };
      }

      // 査定結果固有のフレーズのみ使用
      // ※ 汎用的な挨拶文（「ご連絡お待ちしております」等）はスタッフの
      //   フォローアップメッセージでも使われるため、アンカーに含めない
      const assessmentPhrases = [
        '本査定が完了いたしました',
        '査定結果は以下',
        '査定金額',
        '買取金額'
      ];

      // チャットコンテナ内のテキストノードを収集
      const textNodes = [];
      const walker = document.createTreeWalker(chatContainer, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent.trim();
        if (text.length >= 2) {
          textNodes.push({
            element: walker.currentNode.parentElement,
            text: text
          });
        }
      }

      // 査定結果メッセージの位置を見つける（最後に出現したものを使用）
      let assessmentEndIndex = -1;
      for (let i = textNodes.length - 1; i >= 0; i--) {
        for (const phrase of assessmentPhrases) {
          if (textNodes[i].text.includes(phrase)) {
            assessmentEndIndex = i;
            break;
          }
        }
        if (assessmentEndIndex >= 0) break;
      }

      if (assessmentEndIndex < 0) {
        return { eligible: false, reason: 'assessment_not_found_in_dom（安全のためスキップ）' };
      }

      // 査定結果以降のテキストノードをチェック
      // 各テキストの親要素の視覚的位置で送受信を判定
      const containerRect = chatContainer.getBoundingClientRect();
      const containerCenterX = containerRect.left + containerRect.width / 2;

      let customerMessageFound = false;
      const debugMessages = [];

      for (let i = assessmentEndIndex + 1; i < textNodes.length; i++) {
        const { element, text } = textNodes[i];

        // ノイズを除外
        if (/^\d{1,2}:\d{2}$/.test(text)) continue;          // 時刻
        if (text === '既読') continue;
        if (text === '送信') continue;
        if (text === 'メッセージを入力') continue;
        if (/^(今日|昨日)$/.test(text)) continue;
        if (/^\d{1,2}月\d{1,2}日/.test(text)) continue;       // 日付
        if (/^(月|火|水|木|金|土|日)曜日$/.test(text)) continue;
        if (/^\d{4}[\/年]/.test(text)) continue;               // 年付き日付
        if (text.length < 3) continue;                          // 短すぎるテキスト

        // メッセージバブルの位置を取得（親要素を辿る）
        let bubble = element;
        while (bubble && bubble !== chatContainer) {
          const rect = bubble.getBoundingClientRect();
          if (rect.width > 100 && rect.height > 20) break;
          bubble = bubble.parentElement;
        }
        if (!bubble || bubble === chatContainer) continue;

        const bubbleRect = bubble.getBoundingClientRect();
        const bubbleCenterX = bubbleRect.left + bubbleRect.width / 2;

        // コンテナ中央より十分左 = お客さんからのメッセージ
        if (bubbleCenterX < containerCenterX - 50) {
          customerMessageFound = true;
          debugMessages.push(`customer: "${text.substring(0, 30)}" x=${Math.round(bubbleCenterX)}`);
          break;
        } else {
          debugMessages.push(`staff: "${text.substring(0, 30)}" x=${Math.round(bubbleCenterX)}`);
        }
      }

      if (customerMessageFound) {
        return { eligible: false, reason: 'customer_responded_after_result', debug: debugMessages.join('; ') };
      }

      // 査定結果メッセージ周辺から価格を抽出
      // パターン: 「高額買取価格（...）：9800円」「特急買取価格（...）：7600円」
      const extractedPrices = [];
      const priceSearchStart = Math.max(0, assessmentEndIndex - 10);
      const priceSearchEnd = Math.min(textNodes.length - 1, assessmentEndIndex + 50);
      for (let i = priceSearchStart; i <= priceSearchEnd; i++) {
        const text = textNodes[i].text;
        // 「〇〇円」パターンを抽出（レコード番号などの数字のみは除外）
        const priceMatches = text.match(/(\d[\d,]*)円/g);
        if (priceMatches) {
          priceMatches.forEach(m => {
            const num = parseInt(m.replace(/[円,]/g, ''), 10);
            if (!isNaN(num)) extractedPrices.push(num);
          });
        }
      }
      const maxPrice = extractedPrices.length > 0 ? Math.max(...extractedPrices) : null;

      return {
        eligible: true,
        extractedPrice: maxPrice,
        allPrices: extractedPrices,
        debug: debugMessages.length > 0 ? 'staff_only: ' + debugMessages.join('; ') : 'no_messages_after_assessment'
      };
    }, { skipTagCheck });

    if (!eligibilityCheck.eligible) {
      if (eligibilityCheck.debug) {
        log.info(`スキップ詳細: "${eligibilityCheck.debug}"`);
      }
      return { skipped: true, reason: eligibilityCheck.reason };
    }

    // 3. メッセージ送信（価格に応じて3パターン）
    // LINEメッセージから抽出した価格を優先、取れなければkintoneの値をフォールバック
    const price = eligibilityCheck.extractedPrice !== null ? eligibilityCheck.extractedPrice : target.price;
    const priceSource = eligibilityCheck.extractedPrice !== null ? 'LINE' : 'kintone';
    log.info(`価格: ${price}円（${priceSource}から取得, LINE抽出: ${JSON.stringify(eligibilityCheck.allPrices)}）`);
    // 0円: 買取対象外 → 返送/引き取りのみの専用メッセージ（テンプレート不使用）
    // 1〜999円（数百円）: テンプレートそのまま（引き取り文あり）
    // 1000円以上: テンプレートから引き取り文を削除
    const isZeroPrice = price === 0;
    const isLowPrice = price > 0 && price <= CONFIG.lowPriceThreshold;

    if (isZeroPrice) {
      // 0円専用: テンプレートを使わず直接入力
      log.info(`価格 0円 のため専用メッセージを直接入力`);
      const zeroMsg = [
        `本査定結果についてご検討いただけましたでしょうか。`,
        ``,
        `【返送】をご希望の場合はその旨ご連絡ください。`,
        `また、ご不要な場合は弊社にて【引き取り】をすることも可能でございます。`,
        ``,
        `ご確認のほどよろしくお願いいたします。`
      ].join('\n');

      await page.evaluate((msg) => {
        const textbox = document.querySelector('textarea[class*="form-control"]');
        if (textbox) {
          textbox.value = msg;
          textbox.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, zeroMsg);
      await sleep(500);
    } else {
      // 数百円 or 1000円以上: テンプレートを使用
      const result = await page.evaluate((templateName) => {
        return new Promise(async (resolve) => {
          const sleep = ms => new Promise(r => setTimeout(r, ms));

          // 定型文アイコンをクリック（複数セレクタでフォールバック）
          const chatIcon =
            document.querySelector('i.lar.la-chat-plus') ||
            document.querySelector('i[class*="la-chat-plus"]') ||
            document.querySelector('i[class*="chat-plus"]') ||
            document.querySelector('button[title*="定型文"]') ||
            document.querySelector('button[aria-label*="定型文"]') ||
            document.querySelector('a[title*="定型文"]') ||
            document.querySelector('[data-testid*="template"]') ||
            document.querySelector('i[class*="la-comment-plus"]') ||
            document.querySelector('i[class*="la-comment-alt"]');
          if (!chatIcon) {
            // 存在するアイコン・ボタンを全収集（診断用）
            const allIcons = document.querySelectorAll('i[class]');
            const allIconClasses = Array.from(allIcons).map(i => i.className).slice(0, 30);
            // textarea 周辺のボタンも収集
            const textarea = document.querySelector('textarea');
            let nearbyButtons = [];
            if (textarea) {
              let container = textarea;
              for (let j = 0; j < 5 && container; j++) container = container.parentElement;
              if (container) {
                nearbyButtons = Array.from(container.querySelectorAll('button, a[role="button"], i, svg')).map(b => ({
                  tag: b.tagName, cls: b.className, title: b.title || b.getAttribute('aria-label') || '', text: b.textContent.trim().substring(0, 20)
                })).slice(0, 15);
              }
            }
            return resolve({ error: 'chat icon not found', debug: { allIconClasses, nearbyButtons, url: location.href } });
          }
          chatIcon.click();
          await sleep(1500);

          // テンプレートを選択
          const h5s = document.querySelectorAll('h5');
          let found = false;
          for (const h5 of h5s) {
            if (h5.textContent.trim() === templateName) {
              h5.click();
              found = true;
              break;
            }
          }
          if (!found) return resolve({ error: 'template not found' });
          await sleep(800);

          // 「選択」ボタンをクリック
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            if (btn.textContent.trim() === '選択') {
              btn.click();
              break;
            }
          }
          await sleep(1500);

          resolve({ selected: true });
        });
      }, CONFIG.templateName);

      if (result.error) {
        // エラー種別に関わらずスクリーンショットとデバッグ情報を保存
        await page.screenshot({ path: path.join(__dirname, 'debug-icon-not-found.png') });
        log.info(`スクリーンショット保存: debug-icon-not-found.png`);
        if (result.debug) {
          const debugPath = path.join(__dirname, 'debug-icon-classes.json');
          fs.writeFileSync(debugPath, JSON.stringify(result.debug, null, 2), 'utf8');
          const icons = result.debug.allIconClasses || result.debug;
          log.info(`存在するアイコン(${icons.length}個): ${JSON.stringify(icons.slice(0, 8))}`);
          if (result.debug.nearbyButtons && result.debug.nearbyButtons.length > 0) {
            log.info(`テキスト周辺ボタン: ${JSON.stringify(result.debug.nearbyButtons.slice(0, 5))}`);
          }
        }
        return result;
      }

      // 1000円以上: 「引き取り」の文を削除
      if (!isLowPrice) {
        log.info(`価格 ${price}円 > ${CONFIG.lowPriceThreshold}円 のため引き取り文を削除`);
        await page.evaluate(() => {
          const textbox = document.querySelector('textarea[class*="form-control"]');
          if (textbox) {
            const currentText = textbox.value;
            const newText = currentText.replace(/また、ご不要な場合は弊社にて【引き取り】をすることも可能でございます。\s*/g, '');
            textbox.value = newText;
            textbox.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
        await sleep(500);
      }
    }

    // 送信ボタンをクリック
    const sendBtn = page.getByRole('button', { name: '送信' });
    await sendBtn.click();
    await sleep(2000);

    // 4. タグ付与
    const tagSuccess = await applyTag(page, CONFIG.getTagName());

    // 5. チャットを閉じる（次の検索のため）
    await page.evaluate(() => {
      const chatIcon = document.querySelector('i.lar.la-chat-all');
      if (chatIcon && chatIcon.parentElement) {
        chatIcon.parentElement.click();
      }
    });
    await sleep(1500);

    return { success: true };

  } catch (e) {
    return { error: e.message };
  }
}

// タグ付与（Playwright locator API使用で確実に動作）
async function applyTag(page, tagName) {
  log.info(`タグ付与中: ${tagName}`);

  let opened = false;

  // 方法1: 「タグを追加」リンクをクリック
  try {
    const addTagLink = page.locator('a').filter({ hasText: 'タグを追加' });
    if (await addTagLink.first().isVisible({ timeout: 2000 })) {
      await addTagLink.first().click();
      opened = true;
      log.info('「タグを追加」をクリック');
    }
  } catch (e) {}

  // 方法2: 「タグ」ラベル近くのペンアイコンを探す
  if (!opened) {
    try {
      const result = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.trim() === 'タグ') {
            let parent = walker.currentNode.parentElement;
            for (let i = 0; i < 5 && parent; i++) {
              const pen = parent.querySelector('i[class*="la-pen"], i[class*="pen"]');
              if (pen) {
                const target = pen.closest('a') || pen.closest('button') || pen.parentElement;
                target.click();
                return { clicked: true, method: 'label' };
              }
              parent = parent.parentElement;
            }
          }
        }
        const pens = document.querySelectorAll('i[class*="la-pen"]');
        const rightPens = [];
        for (const pen of pens) {
          const rect = pen.getBoundingClientRect();
          if (rect.left > 1000 && rect.width > 0) rightPens.push(pen);
        }
        if (rightPens.length >= 2) {
          const target = rightPens[1].closest('a') || rightPens[1].parentElement;
          target.click();
          return { clicked: true, method: 'pen_2nd', count: rightPens.length };
        } else if (rightPens.length === 1) {
          const target = rightPens[0].closest('a') || rightPens[0].parentElement;
          target.click();
          return { clicked: true, method: 'pen_1st', count: rightPens.length };
        }
        return { clicked: false, count: rightPens.length };
      });
      if (result.clicked) {
        opened = true;
        log.info(`タグ編集を開きました（${result.method}）`);
      } else {
        log.error(`タグ編集ボタンが見つかりません（ペンアイコン: ${result.count}個）`);
      }
    } catch (e) {
      log.error('タグ編集エラー: ' + e.message);
    }
  }

  if (!opened) {
    log.error('タグ編集を開けませんでした');
    return false;
  }

  await sleep(2000);

  let tagClicked = false;
  try {
    tagClicked = await page.evaluate((targetTag) => {
      const labels = document.querySelectorAll('label');
      for (const label of labels) {
        if (label.textContent.trim() === targetTag) { label.click(); return true; }
      }
      for (const label of labels) {
        if (label.textContent.includes(targetTag)) { label.click(); return true; }
      }
      const elements = document.querySelectorAll('span, div, a');
      for (const el of elements) {
        if (el.textContent.trim() === targetTag && el.childNodes.length <= 3) { el.click(); return true; }
      }
      return false;
    }, tagName);
    if (tagClicked) { log.info(`タグ「${tagName}」を選択`); }
    else { log.error(`タグ「${tagName}」が見つかりません`); }
  } catch (e) { log.error('タグ選択エラー: ' + e.message); }

  if (!tagClicked) {
    try { await page.locator('button:has-text("キャンセル")').click({ timeout: 2000 }); } catch (e) {}
    return false;
  }

  await sleep(1000);

  let saved = false;
  try {
    await page.locator('button:has-text("保存")').click({ timeout: 5000 });
    saved = true;
    log.info('タグを保存');
  } catch (e) {
    log.error('保存ボタンのクリックに失敗: ' + e.message);
    // 保存失敗時はダイアログを閉じる（次のユーザー処理がブロックされるのを防止）
    try { await page.locator('button:has-text("キャンセル")').click({ timeout: 3000 }); } catch (_) {}
    await sleep(500);
  }

  await sleep(1500);

  if (saved) {
    const verified = await page.evaluate((tag) => (document.body.innerText || '').includes(tag), tagName);
    if (verified) { log.success(`タグ「${tagName}」を付与しました`); return true; }
    else { log.error(`タグ「${tagName}」の検証に失敗`); return false; }
  }
  return false;
}

// 実行
main().catch(error => {
  log.error(`Fatal error: ${error.message}`);
  console.error(error);
  process.exit(1);
});
