#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { notifyError, notifyResult } = require('../lib/slack-notify');

// 認証情報を読み込む
let LOGIN_CREDENTIALS;
try {
  const credentialsPath = path.join(__dirname, 'credentials.local.json');
  LOGIN_CREDENTIALS = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
} catch (error) {
  console.error('[ERROR] credentials.local.jsonが見つかりません。');
  console.error('[INFO] credentials.local.jsonを作成してください:');
  console.error('{ "email": "your-email@example.com", "password": "your-password" }');
  process.exit(1);
}

// コマンドライン引数を解析
const args = process.argv.slice(2);
const isHeadless = args.includes('--headless') || args.includes('--background') || args.includes('-b');
const isForce = args.includes('--force') || args.includes('-f');
const showHelp = args.includes('--help') || args.includes('-h');

// --exclude オプション: カンマ区切りで除外するユーザー名を指定
const excludeIdx = args.findIndex(a => a === '--exclude');
const excludeNames = excludeIdx >= 0 && args[excludeIdx + 1]
  ? args[excludeIdx + 1].split(',').map(n => n.trim())
  : [];

if (showHelp) {
  console.log(`
仮査定後催促 CLIツール

使い方:
  node cli.js [オプション]

オプション:
  --headless, --background, -b  ブラウザを非表示で実行（バックグラウンド）
  --exclude "名前1,名前2"       指定ユーザーを除外
  --force, -f                   タグチェックをスキップして強制実行
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
  templateName: '仮査定中の方へ',
  getTagName: () => {
    const now = new Date();
    return `仮査定後催促${now.getFullYear()}/${now.getMonth() + 1}`;
  },
  // セッション保存用ディレクトリ
  sessionDir: path.join(__dirname, '.playwright-session'),
  // headlessモード（コマンドライン引数で指定）
  headless: isHeadless,
  // 1人あたりのタイムアウト（ミリ秒）
  userTimeoutMs: 60000
};

// 昨日の日付情報（LINE Chatが「昨日」ではなく「水曜日」等の曜日で表示する場合に対応）
const YESTERDAY_INFO = (() => {
  const weekdays = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return {
    weekday: weekdays[yesterday.getDay()],  // e.g., '水曜日'
    short: `${yesterday.getMonth() + 1}/${yesterday.getDate()}`, // e.g., '2/26'
  };
})();

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

// ファイルログ（永続化）
const LOG_FILE = path.join(__dirname, 'karisatei-saisoku.log');
function fileLog(level, msg) {
  const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const line = `[${timestamp}] [${level}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

const log = {
  info: (msg) => { console.log(`[INFO] ${msg}`); fileLog('INFO', msg); },
  success: (msg) => { console.log(`[SUCCESS] ✓ ${msg}`); fileLog('SUCCESS', msg); },
  error: (msg) => { console.error(`[ERROR] ✗ ${msg}`); fileLog('ERROR', msg); },
  user: (msg) => { console.log(`[USER] ${msg}`); fileLog('USER', msg); }
};

// ログイン済みかチェック
async function checkIfLoggedIn(page) {
  try {
    // LINE Chatのチャットリストが表示されているか確認
    const chatList = await page.$('div.flex-fill.overflow-y-auto');
    if (chatList) return true;

    // 代替: ログインボタンがあるかチェック
    const loginButton = await page.$('button:has-text("ログイン")');
    if (loginButton) return false;

    // 代替: チャットへのリンクがあるか
    const chatLink = await page.$('a[href*="/chat/"]');
    if (chatLink) return true;

    return false;
  } catch (e) {
    return false;
  }
}

// ログイン成功を待機（URLの変化を監視）
async function waitForLoginSuccess(page, timeoutMs) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // まず401エラーをチェック（最優先）
    const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (pageText.includes('401') || pageText.includes('Unauthorized')) {
      log.info('401エラーを検出（ログイン待機中）');
      return false;
    }

    const currentUrl = page.url();

    // ログイン画面から離れ、チャットリスト要素が存在する場合のみ成功
    if (!currentUrl.includes('account.line.biz') &&
        (currentUrl.includes('chat.line.biz') ||
         currentUrl.includes('manager.line.biz'))) {
      // 追加チェック: 実際にコンテンツがあるか
      const hasContent = await page.evaluate(() => {
        const chatList = document.querySelector('div.flex-fill.overflow-y-auto');
        const accountLinks = document.querySelectorAll('a[href*="/chat/"]');
        return chatList !== null || accountLinks.length > 0;
      }).catch(() => false);

      if (hasContent) {
        return true;
      }
      // コンテンツがなければまだ待機
    }

    await sleep(2000);
  }

  return false;
}

// メイン処理
async function main() {
  log.info('仮査定後催促ツール起動');
  if (isForce) log.info('--force モード: タグチェックをスキップします');

  // セッションディレクトリを確認
  if (!fs.existsSync(CONFIG.sessionDir)) {
    fs.mkdirSync(CONFIG.sessionDir, { recursive: true });
    log.info('セッションディレクトリを作成しました');
  }

  // 永続コンテキストでブラウザを起動（セッション保存）
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
    // Step 1: LINE Chatに直接アクセス（セッションがあればログイン済み）
    log.info('LINE Chat にアクセス中...');
    await page.goto(CONFIG.lineUrl);
    await sleep(3000);

    // ログイン済みかチェック
    const isLoggedIn = await checkIfLoggedIn(page);

    if (!isLoggedIn) {
      log.info('ログインが必要です。ログイン画面に移動...');
      await page.goto(CONFIG.loginUrl);
      await sleep(2000);
      await handleLogin(page);
    } else {
      log.success('セッションが有効です。ログインをスキップします');
    }

    // ログイン後、chat.line.bizに確実に遷移
    let currentUrl = page.url();
    if (!currentUrl.includes('chat.line.biz')) {
      log.info('chat.line.biz に遷移中...');
      await page.goto('https://chat.line.biz/');
      await sleep(5000);
    }

    // 401エラーチェックと処理
    const pageText = await page.evaluate(() => document.body.innerText || '');
    if (pageText.includes('401') || pageText.includes('Unauthorized') || pageText.includes('400') || pageText.includes('Bad Request')) {
      log.info('エラーページを検出。Go Homeボタンをクリックします...');

      // Go Homeボタンをクリック（button または a タグ）
      let goHomeClicked = false;
      try {
        // 方法1: ボタンとして探す
        const goHomeBtn = page.locator('button:has-text("Go Home")');
        if (await goHomeBtn.isVisible({ timeout: 3000 })) {
          await goHomeBtn.click();
          goHomeClicked = true;
          log.info('Go Homeボタンをクリックしました（button）');
        }
      } catch (e) {
        // 次の方法を試す
      }

      if (!goHomeClicked) {
        try {
          // 方法2: リンクとして探す
          const goHomeLink = page.locator('a:has-text("Go Home")');
          if (await goHomeLink.isVisible({ timeout: 3000 })) {
            await goHomeLink.click();
            goHomeClicked = true;
            log.info('Go Homeリンクをクリックしました（a）');
          }
        } catch (e) {
          // 次の方法を試す
        }
      }

      if (!goHomeClicked) {
        try {
          // 方法3: 座標でクリック（緑のボタンを探す）
          const greenBtn = await page.evaluate(() => {
            const elements = document.querySelectorAll('button, a');
            for (const el of elements) {
              if (el.textContent && el.textContent.includes('Go Home')) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }
              }
            }
            return null;
          });
          if (greenBtn) {
            await page.mouse.click(greenBtn.x, greenBtn.y);
            goHomeClicked = true;
            log.info('Go Homeを座標でクリックしました');
          }
        } catch (e) {
          log.info('Go Homeボタンが見つかりません: ' + e.message);
        }
      }

      if (goHomeClicked) {
        await sleep(5000);
        // Go Home後のページを確認
        currentUrl = page.url();
        log.info('Go Home後のURL: ' + currentUrl);

        // まだ401なら再ログイン
        const newPageText = await page.evaluate(() => document.body.innerText || '');
        if (newPageText.includes('401') || newPageText.includes('Unauthorized') || newPageText.includes('400') || newPageText.includes('Bad Request')) {
          log.info('まだ401エラーです。再ログインします...');
          await page.goto(CONFIG.loginUrl);
          await sleep(2000);
          await handleLogin(page);
        }
      } else {
        // Go Homeが見つからない場合は再ログイン
        log.info('Go Homeボタンが見つかりません。再ログインします...');
        await page.goto(CONFIG.loginUrl);
        await sleep(2000);
        await handleLogin(page);
      }

      // 再度chat.line.bizに遷移
      currentUrl = page.url();
      if (!currentUrl.includes('chat.line.biz')) {
        await page.goto('https://chat.line.biz/');
        await sleep(5000);
      }
    }

    // アカウント選択画面の場合、最初のアカウントを選択
    try {
      const accountLink = await page.$('a[href*="/chat/U"]');
      if (accountLink) {
        log.info('アカウントを選択中...');
        await accountLink.click();
        await sleep(3000);
      }
    } catch (e) {
      // アカウント選択不要
    }

    // 最終401チェック
    const finalPageText = await page.evaluate(() => document.body.innerText || '');
    if (finalPageText.includes('401') || finalPageText.includes('Unauthorized') || finalPageText.includes('400') || finalPageText.includes('Bad Request')) {
      log.error('ログインに失敗しました（エラーページ）。スマホで認証を完了してください。');
      await page.screenshot({ path: 'login-failed-401.png' });
      throw new Error('ログインに失敗しました（401エラー）');
    }

    // Step 2: ウィンドウサイズ確認
    log.info(`ウィンドウサイズ: ${CONFIG.width}x${CONFIG.height}`);

    // Step 3: チャットリストの表示を待機
    log.info('チャットリストの表示を待機中...');
    try {
      await page.waitForSelector('div.flex-fill.overflow-y-auto', { timeout: 30000 });
      log.success('チャットリストが表示されました');
    } catch (e) {
      // セレクターで見つからない場合、代替セレクターを試す
      log.info('代替セレクターを試しています...');
      const alternatives = ['[class*="overflow-y"]', 'a[href*="/chat/"]'];
      let found = false;
      for (const sel of alternatives) {
        try {
          await page.waitForSelector(sel, { timeout: 10000 });
          log.success(`代替セレクター ${sel} で要素が見つかりました`);
          found = true;
          break;
        } catch (err) {
          // 次のセレクターを試す
        }
      }
      if (!found) {
        log.error('チャットリストが見つかりません。ページのスクリーンショットを確認してください。');
        await page.screenshot({ path: 'chat-page-error.png' });
        throw new Error('チャットリストが見つかりません');
      }
    }

    await sleep(3000); // 追加の待機

    // Step 4: 昨日までスクロール
    log.info('チャットリストを昨日までスクロール中...');
    await scrollToYesterday(page);

    // Step 4: 対象ユーザー取得
    log.info('対象ユーザーを検索中...');
    let targets = await getTargetUsers(page);
    log.info(`対象ユーザー: ${targets.length}人`);
    console.log(targets);

    // 除外リストを適用
    if (excludeNames.length > 0) {
      log.info(`除外リスト: ${excludeNames.join(', ')}`);
      const beforeCount = targets.length;
      targets = targets.filter(name => {
        const nameLower = name.toLowerCase();
        const shouldExclude = excludeNames.some(ex =>
          nameLower.includes(ex.toLowerCase())
        );
        if (shouldExclude) log.info(`除外: ${name}（除外リストに一致）`);
        return !shouldExclude;
      });
      if (targets.length < beforeCount) {
        log.info(`除外後: ${targets.length}人（${beforeCount - targets.length}人除外）`);
      }
    }

    if (targets.length === 0) {
      log.info('対象ユーザーがいません。終了します。');
      await context.close();
      return;
    }

    // Step 5: 連続処理
    log.info('連続処理を開始します...');
    const processed = [];
    const skipped = [];
    const errors = [];
    const timedOut = [];
    const sentUsers = new Set(); // 送信済みユーザー追跡（重複送信防止）

    for (let i = 0; i < targets.length; i++) {
      const userName = targets[i];
      log.info(`[${i + 1}/${targets.length}] ${userName} を処理中...`);

      try {
        const result = await withTimeout(
          () => processUser(page, userName, processed, sentUsers),
          CONFIG.userTimeoutMs,
          userName
        );

        if (result.success) {
          processed.push(userName);
          log.success(`${userName} - メッセージ送信・タグ付与完了`);
        } else if (result.skipped) {
          skipped.push({ name: userName, reason: result.reason });
          log.info(`${userName} - スキップ (${result.reason})`);
        } else if (result.error) {
          errors.push({ name: userName, error: result.error });
          log.error(`${userName} - エラー: ${result.error}`);
        }
      } catch (e) {
        if (e.message.startsWith('TIMEOUT:')) {
          timedOut.push(userName);
          log.error(`${userName} - タイムアウト（${CONFIG.userTimeoutMs / 1000}秒）→ スキップ`);
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
          errors.push({ name: userName, error: e.message });
          log.error(`${userName} - エラー: ${e.message}`);
        }
      }

      await sleep(1000);
    }

    // 結果サマリー
    console.log('\n========================================');
    log.success(`処理完了: ${processed.length}人`);
    log.info(`スキップ: ${skipped.length}人`);
    if (timedOut.length > 0) log.info(`タイムアウト: ${timedOut.length}人`);
    log.error(`エラー: ${errors.length}人`);
    console.log('========================================\n');

    if (processed.length > 0) {
      log.info('--- 処理完了 ---');
      processed.forEach(name => log.info(`  完了: ${name}`));
    }

    if (skipped.length > 0) {
      log.info('--- スキップ ---');
      skipped.forEach(({ name, reason }) => log.info(`  スキップ: ${name} (${reason})`));
    }

    if (timedOut.length > 0) {
      log.info('--- タイムアウト ---');
      timedOut.forEach(name => log.info(`  タイムアウト: ${name} (${CONFIG.userTimeoutMs / 1000}秒超過)`));
    }

    if (errors.length > 0) {
      log.info('--- エラー ---');
      errors.forEach(({ name, error }) => log.info(`  エラー: ${name}: ${error}`));
    }

    // Slack通知
    await notifyResult('仮査定催促', {
      processed: processed.map(name => ({ name })),
      skipped: skipped,
      timedOut: timedOut.map(name => ({ name })),
      errors: errors.map(e => ({ name: e.name, reason: e.error })),
    });

  } catch (error) {
    log.error(`予期しないエラー: ${error.message}`);
    console.error(error);
    await notifyError('仮査定催促', error.message, { detail: error.stack });
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
      log.info('チャットを閉じる処理をスキップしました: ' + e.message);
    }

    log.info('ブラウザを閉じます（5秒後）...');
    await sleep(5000);
    await context.close();
  }
}

// ログイン処理
async function handleLogin(page) {
  log.info('LINEアカウントでログイン中...');

  // ページの完全なロードを待つ
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(2000);

  // スクリーンショットを保存
  await page.screenshot({ path: 'login-screen-debug.png' });
  log.info('ログイン画面のスクリーンショットを保存: login-screen-debug.png');

  // Step 1: ログイン方法選択画面かチェック（「LINEアカウント」ボタンがあるか）
  try {
    const lineAccountBtn = page.locator('button:has-text("LINEアカウント")');
    if (await lineAccountBtn.isVisible({ timeout: 5000 })) {
      log.info('ログイン方法選択画面を検出。「LINEアカウント」をクリック...');
      await lineAccountBtn.click();
      await sleep(3000);

      // スクリーンショット
      await page.screenshot({ path: 'after-line-account-click.png' });
      log.info('LINEアカウントクリック後のスクリーンショットを保存');
    }
  } catch (e) {
    log.info('ログイン方法選択画面ではありません: ' + e.message);
  }

  // Step 2: 簡易ログイン画面（クイックログイン）をチェック
  await sleep(2000);
  try {
    // 簡易ログイン画面の特徴: 「次のアカウントでログイン」または名前表示
    const pageText = await page.evaluate(() => document.body.innerText || '');

    if (pageText.includes('次のアカウントでログイン') ||
        pageText.includes('えぐち') ||
        pageText.includes('ログインを続行')) {
      log.info('簡易ログイン画面を検出');

      // スクリーンショット
      await page.screenshot({ path: 'quick-login-screen.png' });

      // 緑の「ログイン」ボタンを探す
      const quickLoginBtn = await page.evaluate(() => {
        // button要素で「ログイン」テキストを持つものを探す
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent || '';
          if (text.trim() === 'ログイン') {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 50 && rect.height > 20) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
          }
        }

        // 代替: 背景色が緑のボタンを探す
        for (const btn of buttons) {
          const style = window.getComputedStyle(btn);
          const bgColor = style.backgroundColor;
          // LINE緑 rgb(6, 199, 85) または類似色
          if (bgColor.includes('rgb(6,') || bgColor.includes('rgb(0,') ||
              bgColor.includes('199') || bgColor.includes('200')) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 100) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
          }
        }
        return null;
      });

      if (quickLoginBtn) {
        log.info(`簡易ログインボタンをクリック: (${quickLoginBtn.x}, ${quickLoginBtn.y})`);
        await page.mouse.click(quickLoginBtn.x, quickLoginBtn.y);
        await sleep(3000);

        // 認証番号が表示されたかチェック
        const authCheckText = await page.evaluate(() => document.body.innerText || '');
        if (authCheckText.includes('認証番号') || authCheckText.includes('本人確認')) {
          log.info('認証画面を検出。5秒待機します...');
          await sleep(5000);
          // 認証番号を抽出して表示
          const authNumber = await page.evaluate(() => {
            const text = document.body.innerText || '';
            const match = text.match(/(\d{4})/);
            return match ? match[1] : null;
          });
          if (authNumber) {
            log.user('認証番号: ' + authNumber);
          }
          log.user('本人確認が必要です。スマホのLINEアプリで認証してください。');
        }

        log.user('スマホで認証してください（最大90秒待機）...');

        // ログイン成功を検出（URLの変化を監視）
        const loginSuccess = await waitForLoginSuccess(page, 90000);
        if (loginSuccess) {
          log.success('ログイン完了');
          return;
        } else {
          log.info('ログインがタイムアウトしました。続行します...');
        }
      } else {
        log.info('簡易ログインボタンが見つかりません。メール/パスワードログインへ...');
      }
    }
  } catch (e) {
    log.info('簡易ログイン画面チェックエラー: ' + e.message);
  }

  // メールアドレスとパスワードでログイン
  log.info('メールアドレスでログインします...');

  try {
    // 簡易ログインタイムアウト後はページ状態が変わっているため、ログインページに戻す
    const currentInputs = await page.locator('input[name="tid"]').count();
    if (currentInputs === 0) {
      log.info('ログインフォームが見つかりません。ログインページに遷移...');
      await page.goto(CONFIG.loginUrl);
      await sleep(3000);
      // LINEアカウントボタンがあればクリック
      try {
        const lineBtn = page.locator('button:has-text("LINEアカウント")');
        if (await lineBtn.isVisible({ timeout: 5000 })) {
          await lineBtn.click();
          await sleep(3000);
        }
      } catch (e) { /* ignore */ }
    }

    // ページが完全にロードされるまで待機
    await sleep(3000);

    // デバッグ: ページ内の全input要素を確認
    const inputs = await page.evaluate(() => {
      const allInputs = document.querySelectorAll('input');
      return Array.from(allInputs).map(input => ({
        type: input.type,
        name: input.name,
        placeholder: input.placeholder,
        id: input.id,
        className: input.className
      }));
    });
    log.info('ページ内のinput要素:');
    console.log(JSON.stringify(inputs, null, 2));

    // スクリーンショット
    await page.screenshot({ path: 'login-form-debug.png' });
    log.info('スクリーンショットを保存しました: login-form-debug.png');

    // メールアドレス入力フィールドを待機（name="tid"）
    await page.waitForSelector('input[name="tid"]', { timeout: 10000 });

    // メールアドレス入力（name="tid"を使用）
    const emailInput = page.locator('input[name="tid"]');
    await emailInput.click();
    await sleep(500);
    await emailInput.fill(LOGIN_CREDENTIALS.email);
    log.info(`メールアドレスを入力: ${LOGIN_CREDENTIALS.email}`);
    await sleep(1000);

    // 入力値確認
    const emailValue = await emailInput.inputValue();
    log.info(`入力確認: ${emailValue}`);

    // パスワード入力（name="tpasswd"を試す）
    const passwordInput = page.locator('input[name="tpasswd"], input[type="password"]:visible').first();
    await passwordInput.click();
    await sleep(500);
    await passwordInput.fill(LOGIN_CREDENTIALS.password);
    log.info('パスワードを入力しました');
    await sleep(1000);

    // パスワード入力値確認
    const passwordValue = await passwordInput.inputValue();
    log.info(`パスワード入力確認: ${passwordValue.length}文字`);

    // ログインボタンをクリック
    const submitButton = page.locator('button:has-text("ログイン")').first();
    await submitButton.click();
    await sleep(3000);

    // 認証番号が表示されたかチェック
    const authCheckText = await page.evaluate(() => document.body.innerText || '');
    if (authCheckText.includes('認証番号') || authCheckText.includes('本人確認')) {
      log.info('認証画面を検出。5秒待機します...');
      await sleep(5000);
      // 認証番号を抽出して表示
      const authNumber = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const match = text.match(/(\d{4})/);
        return match ? match[1] : null;
      });
      if (authNumber) {
        log.user('認証番号: ' + authNumber);
      }
      log.user('本人確認が必要です。スマホのLINEアプリで認証してください。');
    }

    log.user('スマホで認証してください（90秒待機）...');
    await sleep(90000);

  } catch (loginError) {
    log.error('自動ログインに失敗しました: ' + loginError.message);
    log.user('手動でログインしてください（60秒待機）...');
    await sleep(60000);
  }

  // チャット画面への遷移を待つ
  try {
    await page.waitForURL('**/chat.line.biz/**', { timeout: 60000 });
    log.success('ログイン完了');
  } catch (e) {
    // タイムアウトしても現在のURLを確認
    const currentUrl = page.url();
    if (currentUrl.includes('chat.line.biz')) {
      log.success('ログイン完了（タイムアウトしましたがチャット画面に到達）');
    } else if (currentUrl.includes('manager.line.biz')) {
      // manager.line.bizに遷移した場合、chat.line.bizに移動
      log.info('manager.line.bizに遷移しました。chat.line.bizに移動します...');
      await page.goto('https://chat.line.biz/');
      await sleep(3000);
      log.success('chat.line.bizに移動完了');
    } else {
      throw new Error('ログインに失敗しました。現在のURL: ' + currentUrl);
    }
  }
}

// 昨日までスクロール（上→下方式: 仮想スクロール対応）
async function scrollToYesterday(page) {
  // まずトップ（最新）に戻す
  await page.evaluate(() => {
    const el = document.querySelector('div.flex-fill.overflow-y-auto');
    if (el) el.scrollTop = 0;
  });
  await sleep(1000);

  log.info(`昨日の曜日表示: ${YESTERDAY_INFO.weekday} (${YESTERDAY_INFO.short})`);

  // 上から下に段階的にスクロールして「昨日」or「水曜日」等を探す
  let found = false;
  for (let i = 0; i < 60; i++) {
    const result = await page.evaluate(({ weekday, short }) => {
      const el = document.querySelector('div.flex-fill.overflow-y-auto');
      if (!el) return { found: false };
      // 日付セパレータは <a> タグではなく独立した要素（div/span 等）にある
      // 全要素を検索し、葉ノードで日付テキストが完全一致するものを探す
      const allElements = el.querySelectorAll('*');
      for (const elem of allElements) {
        if (elem.childElementCount > 0) continue;
        const txt = elem.textContent.trim();
        if (txt === '昨日' || txt === weekday || txt === short) {
          elem.scrollIntoView({ block: 'center' });
          return { found: true };
        }
      }
      return { found: false, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    }, { weekday: YESTERDAY_INFO.weekday, short: YESTERDAY_INFO.short });

    if (result.found) {
      found = true;
      log.info(`昨日セクションを発見（${i + 1}回目のスクロールで）`);
      break;
    }

    // まだ見つからない → 下にスクロール
    await page.evaluate(() => {
      const el = document.querySelector('div.flex-fill.overflow-y-auto');
      if (el) el.scrollTop += 400;
    });
    await sleep(300);
  }

  if (!found) {
    log.info('「昨日」セクションが見つかりませんでした（チャットリストの終端に到達）');
  }

  await sleep(1000);
}

// 対象ユーザー取得（仮想スクロール対応：複数パスでスキャン）
async function getTargetUsers(page) {
  const allTargets = new Set();
  let totalScans = 0;

  // scrollToYesterday で昨日の境界付近に位置している前提
  // 昨日セクション全体をカバーするため、まず少し上（今日寄り）にスクロール
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const el = document.querySelector('div.flex-fill.overflow-y-auto');
      if (el) el.scrollTop -= 500;
    });
    await sleep(400);
  }

  // 上から下に向かってスキャン（昨日と一昨日の境目が見えるまで）
  let everFoundYesterday = false;
  let debugYesterdayLogged = false;
  for (let scan = 0; scan < 100; scan++) {  // 安全上限のみ
    totalScans++;

    const result = await page.evaluate(({ weekday, short }) => {
      const el = document.querySelector('div.flex-fill.overflow-y-auto');
      if (!el) return { targets: [], hasYesterday: false, hasOlderDates: false, sampleItems: [] };

      const targets = [];
      let hasYesterday = false;
      let hasOlderDates = false;
      let debugYesterday = null;
      const sampleItems = [];
      const processedLinks = new Set();

      // 日付セパレータは <a> 外の独立要素にある。
      // DOM順に全要素を走査し、日付ラベルを追跡しながらチャット項目を判定する。
      let currentDateLabel = null;
      const allElements = el.querySelectorAll('*');

      for (const elem of allElements) {
        // 日付セパレータ検出: 葉ノードで <a> の外にある日付テキスト
        if (elem.childElementCount === 0) {
          const txt = elem.textContent.trim();
          if (txt === '昨日' || txt === weekday || txt === short ||
              txt === '今日' || /^[月火水木金土日]曜日$/.test(txt) ||
              /^\d+\/\d+$/.test(txt)) {
            // <a> タグ内部にある場合はスキップ（チャット項目のタイムスタンプ表示と区別）
            let isInsideLink = false;
            let p = elem.parentElement;
            for (let i = 0; i < 6 && p && p !== el; i++) {
              if (p.tagName === 'A') { isInsideLink = true; break; }
              p = p.parentElement;
            }
            if (!isInsideLink) currentDateLabel = txt;
          }
        }

        // チャット項目検出: <a> タグで h6 を含むもの
        if (elem.tagName === 'A' && !processedLinks.has(elem)) {
          const h6 = elem.querySelector('h6');
          if (h6) {
            processedLinks.add(elem);
            const name = h6.textContent.trim();
            const text = elem.textContent.replace(/\s+/g, ' ').trim(); // 切り詰めなし・完全テキスト

            // 方法1: 日付セパレータ追跡（<a> 外の独立要素）
            const isYesterdayByLabel = currentDateLabel === '昨日' ||
                                       currentDateLabel === weekday ||
                                       currentDateLabel === short;
            const isTodayByLabel = currentDateLabel === '今日';

            // 方法2: テキスト内容検索（タイムスタンプが <a> 内にある場合のフォールバック）
            // 今日のチャットは HH:MM 形式、昨日は「昨日」または曜日名
            const isYesterdayByText = text.indexOf('昨日') > -1 ||
                                       text.indexOf(weekday) > -1 ||
                                       text.indexOf(short) > -1;
            const isTodayByText = /\d{1,2}:\d{2}/.test(text) && // HH:MM パターン
                                   text.indexOf('昨日') === -1 &&
                                   text.indexOf(weekday) === -1 &&
                                   text.indexOf(short) === -1;

            const isYesterday = isYesterdayByLabel || isYesterdayByText;
            const isToday = isTodayByLabel || isTodayByText;
            const isOlderDate = (currentDateLabel && !isYesterdayByLabel && !isTodayByLabel) ||
                                 (/(?:月|火|水|木|金|土|日)曜日/.test(text) &&
                                  text.indexOf('昨日') === -1 && !isTodayByText &&
                                  text.indexOf(weekday) === -1);

            if (sampleItems.length < 3) {
              // ラベルまたはテキスト末尾からタイムスタンプを抽出して表示
              const ts = currentDateLabel || (isYesterdayByText ? '昨日テキスト' : (isTodayByText ? '今日テキスト' : '?'));
              sampleItems.push(`[${ts}] ${name}: ${text.substring(0, 50)}`);
            }

            if (isYesterday && !isToday) {
              hasYesterday = true;
              if (!debugYesterday) debugYesterday = [];
              if (debugYesterday.length < 5) {
                debugYesterday.push({ name, preview: text.substring(0, 80) });
              }
            }

            if (isOlderDate && !isYesterday && !isToday) hasOlderDates = true;

            // 条件: 「本査定のご案内」+ 昨日判定 + 「今日」なし
            if (text.indexOf('本査定のご案内') > -1 &&
                isYesterday && !isToday &&
                name.indexOf('Unknown') === -1 &&
                name.length > 0) {
              targets.push(name);
            }
          }
        }
      }

      return { targets, hasYesterday, hasOlderDates, debugYesterday, sampleItems };
    }, { weekday: YESTERDAY_INFO.weekday, short: YESTERDAY_INFO.short });

    for (const name of result.targets) {
      allTargets.add(name);
    }

    // スキャン1回目: 見えているチャット項目のサンプルを表示（診断用）
    if (totalScans === 1 && result.sampleItems && result.sampleItems.length > 0) {
      log.info(`チャット項目サンプル（診断用）:`);
      result.sampleItems.forEach((s, i) => log.info(`  [${i + 1}] ${s}`));
    }

    if (result.hasYesterday) {
      everFoundYesterday = true;
      if (result.debugYesterday && !debugYesterdayLogged) {
        debugYesterdayLogged = true;
        log.info(`昨日のチャット（サンプル）:`);
        result.debugYesterday.forEach(d => log.info(`  ${d.name}: ${d.preview}`));
      }
    }

    // 終了条件: 「昨日」を見つけた後に曜日表示（一昨日以前）が見えた → 境目到達
    if (everFoundYesterday && result.hasOlderDates) {
      log.info(`昨日/一昨日の境目を検出（${totalScans}回目のスキャン）`);
      break;
    }

    // 下にスクロール
    await page.evaluate(() => {
      const el = document.querySelector('div.flex-fill.overflow-y-auto');
      if (el) el.scrollTop += 400;
    });
    await sleep(600);
  }

  log.info(`スキャン完了: ${totalScans}回スキャン, 対象${allTargets.size}人検出`);
  const targetList = [...allTargets];
  if (targetList.length > 0) {
    console.log('検出されたユーザー:', targetList);
  }
  return targetList;
}

// ユーザー処理（資格チェックとメッセージ送信を分離）
async function processUser(page, userName, processedList, sentUsers) {
  // Step 0: 送信済みチェック（メモリ内追跡 - 最優先）
  if (sentUsers.has(userName)) {
    return { skipped: true, reason: 'already_sent_in_this_session' };
  }

  // Step 1: 昨日の位置まで再スクロール
  await scrollToYesterday(page);

  // Step 2: ユーザーをクリック（スクロールリトライ + 検索フォールバック付き）
  let clickResult = null;

  // まず昨日周辺でスクロールしながら探す
  for (let scrollAttempt = 0; scrollAttempt < 8; scrollAttempt++) {
    clickResult = await page.evaluate((targetName) => {
      const el = document.querySelector('div.flex-fill.overflow-y-auto');
      if (!el) return { error: 'chat list not found' };
      const links = el.querySelectorAll('a');
      for (const link of links) {
        const h6 = link.querySelector('h6');
        if (!h6) continue;
        if (h6.textContent.trim() === targetName) {
          // 未読チェック: チャットアイテム内に緑●があるか確認
          let container = link;
          for (let i = 0; i < 5; i++) {
            if (!container.parentElement || container.parentElement === el) break;
            container = container.parentElement;
          }
          const allEls = container.querySelectorAll('*');
          for (const child of allEls) {
            const rect = child.getBoundingClientRect();
            if (rect.width >= 5 && rect.width <= 20 && rect.height >= 5 && rect.height <= 20) {
              const style = window.getComputedStyle(child);
              if (style.backgroundColor === 'rgb(6, 199, 85)') {
                return { hasUnread: true };
              }
            }
          }
          link.click();
          return { clicked: true };
        }
      }
      return { notFound: true };
    }, userName);

    if (clickResult.hasUnread) {
      log.info(`${userName} - 未読メッセージあり → 既読防止のためスキップ`);
      return { skipped: true, reason: '未読メッセージあり（既読防止）' };
    }
    if (clickResult.clicked) break;

    // 見つからない場合、少しスクロールしてリトライ
    await page.evaluate((dir) => {
      const el = document.querySelector('div.flex-fill.overflow-y-auto');
      if (el) el.scrollTop += dir;
    }, scrollAttempt % 2 === 0 ? 400 : -400);
    await sleep(500);
  }

  // フォールバック: ページリセット→検索ボックスでユーザー名を検索
  if (!clickResult || !clickResult.clicked) {
    log.info(`${userName} がリストに見つかりません。ページリセット後に検索で探します...`);
    try {
      // ページをリセット（開きっぱなしのダイアログ等をクリア）
      await page.goto(CONFIG.lineUrl, { timeout: 15000 });
      await sleep(3000);
      // アカウント選択画面の場合
      try {
        const accountLink = await page.$('a[href*="/chat/U"]');
        if (accountLink) { await accountLink.click(); await sleep(3000); }
      } catch (e) {}
      await page.waitForSelector('div.flex-fill.overflow-y-auto', { timeout: 15000 });
      await sleep(2000);

      // 検索ボックスを探す（複数セレクタ）
      let searchBox = null;
      try {
        searchBox = page.getByRole('textbox', { name: '検索', exact: true });
        await searchBox.waitFor({ timeout: 5000 });
      } catch (e) {
        // 代替: input[type="search"] や placeholder
        try {
          searchBox = page.locator('input[placeholder*="検索"], input[type="search"]').first();
          await searchBox.waitFor({ timeout: 5000 });
        } catch (e2) {
          // 最終手段: evaluate
          const found = await page.evaluate(() => {
            const inputs = document.querySelectorAll('input');
            for (const input of inputs) {
              if (input.placeholder && input.placeholder.includes('検索')) {
                input.focus();
                return true;
              }
            }
            return false;
          });
          if (found) {
            searchBox = page.locator('input:focus');
          }
        }
      }

      if (!searchBox) {
        return { error: 'search box not found after page reset' };
      }

      await searchBox.clear();
      await searchBox.fill(userName);
      await searchBox.press('Enter');
      await sleep(2000);

      // 検索結果からユーザーをクリック
      clickResult = await page.evaluate((targetName) => {
        const links = document.querySelectorAll('a');
        for (const link of links) {
          const h6 = link.querySelector('h6');
          if (h6 && h6.textContent.trim() === targetName) {
            // 未読チェック
            let container = link;
            const panel = document.querySelector('div.flex-fill.overflow-y-auto');
            for (let i = 0; i < 5; i++) {
              if (!container.parentElement || container.parentElement === panel) break;
              container = container.parentElement;
            }
            const allEls = container.querySelectorAll('*');
            for (const child of allEls) {
              const rect = child.getBoundingClientRect();
              if (rect.width >= 5 && rect.width <= 20 && rect.height >= 5 && rect.height <= 20) {
                const style = window.getComputedStyle(child);
                if (style.backgroundColor === 'rgb(6, 199, 85)') {
                  return { hasUnread: true };
                }
              }
            }
            link.click();
            return { clicked: true, method: 'search' };
          }
        }
        return { error: 'user not found in search results' };
      }, userName);

      if (clickResult.hasUnread) {
        log.info(`${userName} - 未読メッセージあり → 既読防止のためスキップ`);
        return { skipped: true, reason: '未読メッセージあり（既読防止）' };
      }
      if (clickResult.clicked) {
        log.info(`検索フォールバックで ${userName} を発見`);
      }
    } catch (searchError) {
      return { error: 'search fallback failed: ' + searchError.message };
    }
  }

  if (!clickResult || clickResult.error || !clickResult.clicked) {
    return { error: clickResult?.error || 'user not found after all attempts' };
  }

  // Step 3: 資格チェック（リトライあり - メッセージは送信しない）
  let eligibility;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.waitForTimeout(2000);
    try {
      await page.waitForSelector('i.lar.la-chat-plus', { timeout: 5000 });
    } catch (e) {
      // タイムアウトしても続行
    }
    await page.waitForTimeout(500);

    try {
      eligibility = await page.evaluate((forceMode) => {
        // タグチェック（今月） ※タグ名は CONFIG.getTagName() と一致させる（「済」なし）
        if (!forceMode) {
          const now = new Date();
          const currentMonthTag = '仮査定後催促' + now.getFullYear() + '/' + (now.getMonth() + 1);

          const allElements = document.querySelectorAll('a, span, div, label');
          for (const el of allElements) {
            const text = el.textContent || '';
            if (text.includes(currentMonthTag) && el.textContent.length < 50) {
              return { eligible: false, reason: 'already_tagged_this_month: ' + currentMonthTag };
            }
          }
        }

        // no_yesterday チェックは廃止:
        // getTargetUsers で既に「昨日」+「本査定のご案内」を確認済み。
        // チャットを開いた後の .chatsys-date チェックは lazyロードで
        // 「昨日」セパレータがDOMに存在せず誤スキップの原因だった。
        // タグがなければ催促対象（チャット内メッセージの有無は関係ない）。
        return { eligible: true };
      }, isForce);
      break; // 成功したらループを抜ける
    } catch (evalError) {
      if (attempt < 3) {
        log.info(`資格チェック リトライ ${attempt}/3: ${evalError.message}`);
        // ユーザーを再クリック
        await page.evaluate((userName) => {
          const el = document.querySelector('div.flex-fill.overflow-y-auto');
          if (!el) return;
          const links = el.querySelectorAll('a');
          for (let i = 0; i < links.length; i++) {
            const h6 = links[i].querySelector('h6');
            if (!h6) continue;
            if (h6.textContent.trim() === userName) {
              links[i].click();
              return;
            }
          }
        }, userName);
      } else {
        return { error: 'eligibility check failed after 3 attempts: ' + evalError.message };
      }
    }
  }

  if (!eligibility) {
    return { error: 'eligibility check returned no result' };
  }

  if (!eligibility.eligible) {
    return { skipped: true, reason: eligibility.reason };
  }

  // Step 4: メッセージ送信（リトライなし！1回だけ実行）
  try {
    const sendResult = await page.evaluate(() => {
      return new Promise(async (resolve) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        // 定型文アイコンをクリック（複数セレクタでフォールバック）
        const chatIcon =
          document.querySelector('i.lar.la-chat-plus') ||
          document.querySelector('i[class*="la-chat-plus"]') ||
          document.querySelector('i[class*="chat-plus"]');
        if (!chatIcon) {
          const allIcons = document.querySelectorAll('i[class*="la-"]');
          const iconClasses = Array.from(allIcons).map(i => i.className).slice(0, 20);
          return resolve({ error: 'chat icon not found', debug: iconClasses });
        }
        chatIcon.click();
        await sleep(1500);

        const h5s = document.querySelectorAll('h5');
        let templateFound = false;
        for (let i = 0; i < h5s.length; i++) {
          if (h5s[i].textContent.trim() === '仮査定中の方へ') {
            h5s[i].click();
            templateFound = true;
            break;
          }
        }
        if (!templateFound) return resolve({ error: 'template not found' });
        await sleep(800);

        let selectClicked = false;
        const buttons = document.querySelectorAll('button');
        for (let i = 0; i < buttons.length; i++) {
          if (buttons[i].textContent.trim() === '選択') {
            buttons[i].click();
            selectClicked = true;
            break;
          }
        }
        if (!selectClicked) return resolve({ error: 'select button not found' });
        await sleep(1500);

        const sendBtn = document.querySelector('input.btn.btn-sm.btn-primary');
        if (!sendBtn) return resolve({ error: 'send button not found' });
        sendBtn.click();
        await sleep(2000);

        resolve({ messageSent: true });
      });
    });

    if (sendResult.error) {
      return sendResult;
    }

    // 送信成功 → メモリに記録（再送防止）
    sentUsers.add(userName);

    // Step 5: タグ付与（--forceモードで既にタグがある場合はスキップ）
    const tagName = CONFIG.getTagName();
    if (isForce) {
      const hasTag = await page.evaluate((tag) => {
        const text = document.body.innerText || '';
        return text.includes(tag);
      }, tagName);
      if (hasTag) {
        log.info(`タグ「${tagName}」は既に付与済み → スキップ`);
        return { success: true, tagged: true };
      }
    }
    const tagSuccess = await applyTag(page, tagName);
    return { success: true, tagged: tagSuccess };
  } catch (sendError) {
    // 送信中のエラー（タイムアウト等）
    // 送信されたかどうか不明 → 安全のため送信済みとして記録し、再送を防止
    sentUsers.add(userName);
    log.error(`メッセージ送信中にエラー（送信済みの可能性あり）: ${sendError.message}`);
    return { error: 'message send error (may have been sent): ' + sendError.message };
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
        // "タグ" テキストを持つ要素を探す
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

        // フォールバック: 右パネルのペンアイコン
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

  // タグを選択
  let tagClicked = false;
  try {
    tagClicked = await page.evaluate((targetTag) => {
      // label要素を優先（チェックボックス形式）
      const labels = document.querySelectorAll('label');
      for (const label of labels) {
        if (label.textContent.trim() === targetTag) {
          label.click();
          return true;
        }
      }
      // 部分一致
      for (const label of labels) {
        if (label.textContent.includes(targetTag)) {
          label.click();
          return true;
        }
      }
      // 代替: span, div, a
      const elements = document.querySelectorAll('span, div, a');
      for (const el of elements) {
        if (el.textContent.trim() === targetTag && el.childNodes.length <= 3) {
          el.click();
          return true;
        }
      }
      return false;
    }, tagName);

    if (tagClicked) {
      log.info(`タグ「${tagName}」を選択`);
    } else {
      log.error(`タグ「${tagName}」が見つかりません`);
    }
  } catch (e) {
    log.error('タグ選択エラー: ' + e.message);
  }

  if (!tagClicked) {
    try { await page.locator('button:has-text("キャンセル")').click({ timeout: 2000 }); } catch (e) {}
    return false;
  }

  await sleep(1000);

  // 保存
  let saved = false;
  try {
    const saveBtn = page.locator('button:has-text("保存")');
    await saveBtn.click({ timeout: 5000 });
    saved = true;
    log.info('タグを保存');
  } catch (e) {
    log.error('保存ボタンのクリックに失敗: ' + e.message);
  }

  await sleep(1500);

  // 検証
  if (saved) {
    const verified = await page.evaluate((tag) => {
      const text = document.body.innerText || '';
      return text.includes(tag);
    }, tagName);

    if (verified) {
      log.success(`タグ「${tagName}」を付与しました`);
      return true;
    } else {
      log.error(`タグ「${tagName}」の検証に失敗`);
      return false;
    }
  }

  return false;
}

// 実行
main().catch(error => {
  log.error(`Fatal error: ${error.message}`);
  console.error(error);
  process.exit(1);
});
