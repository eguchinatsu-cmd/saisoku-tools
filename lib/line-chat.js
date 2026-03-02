/**
 * LINE Chat DOM操作関数群
 *
 * 全て execMain() 経由で実行される純粋関数。
 * 座標やブール値を返し、実際のクリックは呼び出し側で CDP 経由で行う。
 */

// ========== チャットリスト操作 ==========

/** チャットリストのスクロールコンテナ中央座標を返す（CDPスクロール用） */
export function getChatListCenter() {
  const first = document.querySelector('.list-group-item-chat');
  if (!first) return null;
  let container = first.parentElement;
  while (container && container.scrollHeight <= container.clientHeight) {
    container = container.parentElement;
  }
  if (container) {
    const r = container.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  const r = first.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** チャットリストに戻るボタン（la-chat-all）の座標 */
export function getChatClosePosition() {
  const icon = document.querySelector('i.lar.la-chat-all');
  if (!icon) return null;
  const btn = icon.closest('a, button') || icon.parentElement;
  if (!btn) return null;
  const r = btn.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** チャットリストを最上部にスクロール */
export function scrollChatListToTop() {
  const el = document.querySelector('div.flex-fill.overflow-y-auto');
  if (el) { el.scrollTop = 0; return true; }
  return false;
}

/** チャットリストを指定ピクセル分スクロール */
export function scrollChatList(delta) {
  const el = document.querySelector('div.flex-fill.overflow-y-auto');
  if (el) {
    const before = el.scrollTop;
    el.scrollTop += delta;
    // 仮想スクロール再描画のためscrollイベントを発火
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, moved: el.scrollTop !== before };
  }
  return null;
}

// ========== 検索 ==========

/** 検索ボックスの座標を返す */
export function getSearchBoxPosition() {
  // role="textbox" で name="検索" を探す
  const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
  for (const inp of inputs) {
    const ph = inp.placeholder || '';
    const label = inp.getAttribute('aria-label') || '';
    if (ph.includes('検索') || label.includes('検索')) {
      const r = inp.getBoundingClientRect();
      if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
}

/** 検索ボックスをクリアする */
export function clearSearchBox() {
  const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
  for (const inp of inputs) {
    const ph = inp.placeholder || '';
    const label = inp.getAttribute('aria-label') || '';
    if (ph.includes('検索') || label.includes('検索')) {
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }
  return false;
}

/** 「メッセージを検索」リンクの座標 */
export function getMessageSearchLinkPosition() {
  const links = document.querySelectorAll('a');
  for (const a of links) {
    if (a.textContent.includes('メッセージを検索') && a.offsetParent !== null) {
      const r = a.getBoundingClientRect();
      if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
}

/** 検索結果の最初のチャットリンク座標 */
export function getFirstSearchResultPosition() {
  const panel = document.querySelector('div.flex-fill.overflow-y-auto');
  if (!panel) return null;
  // list-group-item内のユーザー名h6を持つリンクを探す
  // NOTE: item内のaは2つ: 1番目=ドロップダウン(a.dropdown-toggle), 2番目=チャットリンク(a.d-flex)
  const items = panel.querySelectorAll('.list-group-item');
  for (const item of items) {
    if (item.getBoundingClientRect().height <= 0) continue;
    const h6 = item.querySelector('h6');
    if (!h6) continue;
    if (h6.textContent.includes('メッセージ')) continue;
    const link = item.querySelector('a.d-flex') || item.querySelector('a[href="#"]');
    if (link) {
      const r = link.getBoundingClientRect();
      if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  // フォールバック: h6を含む最初のリンク（ユーザー名h6）
  const link = document.querySelector('.list-group-item a:has(h6)');
  if (link) {
    const r = link.getBoundingClientRect();
    if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return null;
}

// ========== 未読防止 ==========

/** 検索結果の最初のチャットに未読マーク（緑●）があるか */
export function checkUnreadInSearchResult() {
  const panel = document.querySelector('div.flex-fill.overflow-y-auto');
  if (!panel) return false;
  const firstItem = panel.querySelector('.list-group-item');
  if (!firstItem) return false;
  const els = firstItem.querySelectorAll('*');
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width >= 5 && r.width <= 20 && r.height >= 5 && r.height <= 20) {
      if (window.getComputedStyle(el).backgroundColor === 'rgb(6, 199, 85)') return true;
    }
    if (el.className && typeof el.className === 'string' &&
        (el.className.includes('badge') || el.className.includes('unread'))) {
      const t = el.textContent.trim();
      if (t && /^\d+$/.test(t) && parseInt(t) > 0) return true;
    }
  }
  return false;
}

/** 指定チャットアイテムに未読マーク（緑●）があるか（karisatei用） */
export function checkUnreadInChatItem(index) {
  const items = document.querySelectorAll('.list-group-item-chat, a');
  const el = document.querySelector('div.flex-fill.overflow-y-auto');
  if (!el) return false;
  const links = el.querySelectorAll('a');
  const link = links[index];
  if (!link) return false;
  let container = link;
  for (let i = 0; i < 5; i++) {
    if (!container.parentElement || container.parentElement === el) break;
    container = container.parentElement;
  }
  const children = container.querySelectorAll('*');
  for (const child of children) {
    const r = child.getBoundingClientRect();
    if (r.width >= 5 && r.width <= 20 && r.height >= 5 && r.height <= 20) {
      if (window.getComputedStyle(child).backgroundColor === 'rgb(6, 199, 85)') return true;
    }
  }
  return false;
}

// ========== チャット内容操作 ==========

/** チャットを最下部までスクロール（検索結果クリック後に最新メッセージをロードするため） */
export function scrollChatToBottom() {
  return new Promise((resolve) => {
    const dateSep = document.querySelector('.chatsys-date');
    if (!dateSep) return resolve(false);
    let container = dateSep.parentElement;
    while (container && container !== document.body) {
      const s = window.getComputedStyle(container);
      if (s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflow === 'auto' || s.overflow === 'scroll') {
        let count = 0;
        const iv = setInterval(() => {
          container.scrollTop = container.scrollHeight;
          count++;
          if (count >= 25) { clearInterval(iv); resolve(true); }
        }, 200);
        return;
      }
      container = container.parentElement;
    }
    resolve(false);
  });
}

// ========== テンプレートメッセージ送信 ==========

/** 定型文パネルを開くアイコン（la-chat-plus）の座標 */
export function getTemplatePanelPosition() {
  const icon =
    document.querySelector('i.lar.la-chat-plus') ||
    document.querySelector('i[class*="chat-plus"]') ||
    document.querySelector('i[class*="la-comment-plus"]') ||
    document.querySelector('i[class*="canned"]');
  if (!icon) return null;
  const r = icon.getBoundingClientRect();
  if (r.width === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** テンプレート名（h5テキスト）の座標を返す */
export function findTemplatePosition(name) {
  const h5s = document.querySelectorAll('h5');
  for (const h5 of h5s) {
    if (h5.textContent.trim() === name) {
      const r = h5.getBoundingClientRect();
      if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
}

/** 「選択」ボタンの座標 */
export function getSelectButtonPosition() {
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    if (btn.textContent.trim() === '選択' && btn.offsetParent !== null) {
      const r = btn.getBoundingClientRect();
      if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
}

/** 送信ボタンの座標（input.btn.btn-sm.btn-primary または button「送信」） */
export function getSendButtonPosition() {
  const inp = document.querySelector('input.btn.btn-sm.btn-primary');
  if (inp && inp.offsetParent !== null) {
    const r = inp.getBoundingClientRect();
    if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    if (btn.textContent.trim() === '送信' && btn.offsetParent !== null) {
      const r = btn.getBoundingClientRect();
      if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
}

/**
 * 定型文アイコンのクリックターゲットを探す
 * 間違った要素をクリックすると LINE Chat が予期せぬ状態になるため、
 * セレクターは既知の特定のものだけを使用する。
 */
function findTemplateIconTarget() {
  // 既知の定型文アイコン（la-chat-plus）のみ試す。曖昧なセレクターは使わない。
  const icon =
    document.querySelector('i.lar.la-chat-plus') ||
    document.querySelector('i.las.la-chat-plus'); // solid バリアント

  if (icon) {
    const target = icon.closest('a') || icon.closest('button') || icon.parentElement;
    return { target: target || icon };
  }

  // aria-label/title で定型文ボタンを探す（完全一致または「定型文」）
  const interactives = document.querySelectorAll('button, a[role="button"]');
  for (const b of interactives) {
    const label = (b.title || b.getAttribute('aria-label') || '');
    if (label === '定型文' || label === 'Canned messages') {
      return { target: b };
    }
  }

  // 見つからない場合: 診断情報を収集（la- プレフィックスのアイコン一覧 + ツールバーボタン）
  const iconClasses = Array.from(document.querySelectorAll('i[class]'))
    .map(i => i.className).filter(c => /\bla-/.test(c)).slice(0, 20).join(' | ');
  const btnLabels = Array.from(document.querySelectorAll('button[title], button[aria-label], a[aria-label]'))
    .map(b => (b.title || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 10).join(' | ');
  return { target: null, debug: `icons=[${iconClasses}] buttons=[${btnLabels}]` };
}

/**
 * テンプレートメッセージを送信（DOM click版）
 * CDP座標クリックではなくelement.click()を使用し、Reactイベントを確実に発火させる。
 * 全操作をページコンテキスト内で完結させることでタイミング問題を回避。
 */
export function sendTemplateMessageByDOM(templateName) {
  return new Promise(async (resolve) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // 内部タイムアウト: 予期せぬハングを防ぐ（外部60秒タイムアウトより短く設定）
    const localTimer = setTimeout(() => resolve({ error: 'sendTemplate内部タイムアウト(15s)' }), 15000);

    // 1. 定型文アイコンをクリック
    // NOTE: executeScript は呼び出し元の関数のみをシリアライズするため、
    // findTemplateIconTarget() 等の外部関数はページコンテキストで参照不可。
    // アイコン検索ロジックをここにインライン化する。
    let iconTarget = null;
    const chatPlusIcon = document.querySelector('i.lar.la-chat-plus') || document.querySelector('i.las.la-chat-plus');
    if (chatPlusIcon) {
      iconTarget = chatPlusIcon.closest('a') || chatPlusIcon.closest('button') || chatPlusIcon.parentElement;
    }
    if (!iconTarget) {
      const btns = document.querySelectorAll('button, a[role="button"]');
      for (const b of btns) {
        const lbl = b.title || b.getAttribute('aria-label') || '';
        if (lbl === '定型文' || lbl === 'Canned messages') { iconTarget = b; break; }
      }
    }
    if (!iconTarget) {
      const icClasses = Array.from(document.querySelectorAll('i[class]')).map(i => i.className).filter(c => /\bla-/.test(c)).slice(0, 20).join(' | ');
      clearTimeout(localTimer);
      return resolve({ error: `テンプレートアイコンが見つかりません (icons=[${icClasses}])` });
    }
    iconTarget.click();
    await sleep(2000);

    // 2. テンプレートパネルのh5を探す（リトライ3回）
    let templateEl = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const h5s = document.querySelectorAll('h5');
      for (const h5 of h5s) {
        if (h5.textContent.trim() === templateName) {
          templateEl = h5;
          break;
        }
      }
      if (templateEl) break;
      await sleep(1000);
    }
    if (!templateEl) return resolve({ error: `テンプレート「${templateName}」が見つかりません` });

    // 3. テンプレートをクリック
    const tplClickTarget = templateEl.closest('a') || templateEl.closest('[role="button"]') || templateEl.parentElement;
    if (tplClickTarget) tplClickTarget.click(); else templateEl.click();
    await sleep(1000);

    // 4. 「選択」ボタンをクリック（リトライ3回）
    let selectBtn = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === '選択' && btn.offsetParent !== null) {
          selectBtn = btn;
          break;
        }
      }
      if (selectBtn) break;
      await sleep(800);
    }
    if (!selectBtn) return resolve({ error: '「選択」ボタンが見つかりません' });
    selectBtn.click();
    await sleep(2000);

    // 5. 送信ボタンをクリック（リトライ3回）
    let sendBtn = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // input[type="submit"]形式
      const inp = document.querySelector('input.btn.btn-sm.btn-primary');
      if (inp && inp.offsetParent !== null) { sendBtn = inp; break; }
      // button「送信」形式
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === '送信' && btn.offsetParent !== null) {
          sendBtn = btn;
          break;
        }
      }
      if (sendBtn) break;
      await sleep(800);
    }
    if (!sendBtn) { clearTimeout(localTimer); return resolve({ error: '送信ボタンが見つかりません' }); }
    sendBtn.click();
    await sleep(2000);

    // 6. 送信確認：テキストエリアが空 or 消えていれば成功
    const ta = document.querySelector('textarea[class*="form-control"]');
    const sent = !ta || ta.value.trim() === '';

    clearTimeout(localTimer);
    resolve({ messageSent: true, verified: sent });
  });
}

/**
 * テンプレートを選択してテキストエリアに反映（送信はしない）（DOM click版）
 * 1000円以上の本査定で引き取り文を削除してから送信するケース用。
 */
export function selectTemplateByDOM(templateName) {
  return new Promise(async (resolve) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // 内部タイムアウト: 予期せぬハングを防ぐ
    const localTimer = setTimeout(() => resolve({ error: 'selectTemplate内部タイムアウト(15s)' }), 15000);

    // 1. 定型文アイコンをクリック
    // NOTE: executeScript は呼び出し元の関数のみをシリアライズするため、
    // findTemplateIconTarget() 等の外部関数はページコンテキストで参照不可。
    // アイコン検索ロジックをここにインライン化する。
    let iconTarget = null;
    const chatPlusIcon = document.querySelector('i.lar.la-chat-plus') || document.querySelector('i.las.la-chat-plus');
    if (chatPlusIcon) {
      iconTarget = chatPlusIcon.closest('a') || chatPlusIcon.closest('button') || chatPlusIcon.parentElement;
    }
    if (!iconTarget) {
      const btns = document.querySelectorAll('button, a[role="button"]');
      for (const b of btns) {
        const lbl = b.title || b.getAttribute('aria-label') || '';
        if (lbl === '定型文' || lbl === 'Canned messages') { iconTarget = b; break; }
      }
    }
    if (!iconTarget) {
      const icClasses = Array.from(document.querySelectorAll('i[class]')).map(i => i.className).filter(c => /\bla-/.test(c)).slice(0, 20).join(' | ');
      clearTimeout(localTimer);
      return resolve({ error: `テンプレートアイコンが見つかりません (icons=[${icClasses}])` });
    }
    iconTarget.click();
    await sleep(2000);

    // 2. テンプレートを探す（リトライ3回）
    let templateEl = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const h5s = document.querySelectorAll('h5');
      for (const h5 of h5s) {
        if (h5.textContent.trim() === templateName) { templateEl = h5; break; }
      }
      if (templateEl) break;
      await sleep(1000);
    }
    if (!templateEl) return resolve({ error: `テンプレート「${templateName}」が見つかりません` });
    const tplClickTarget = templateEl.closest('a') || templateEl.closest('[role="button"]') || templateEl.parentElement;
    if (tplClickTarget) tplClickTarget.click(); else templateEl.click();
    await sleep(1000);

    // 3. 「選択」ボタンをクリック
    let selectBtn = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === '選択' && btn.offsetParent !== null) { selectBtn = btn; break; }
      }
      if (selectBtn) break;
      await sleep(800);
    }
    if (!selectBtn) { clearTimeout(localTimer); return resolve({ error: '「選択」ボタンが見つかりません' }); }
    selectBtn.click();
    await sleep(1500);

    clearTimeout(localTimer);
    resolve({ selected: true });
  });
}

/**
 * テキストを直接入力して送信（DOM click版）
 * 0円メッセージの直接入力用。
 */
export function sendDirectMessageByDOM(text) {
  return new Promise(async (resolve) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const ta = document.querySelector('textarea[class*="form-control"]');
    if (!ta) return resolve({ error: 'テキストエリアが見つかりません' });
    ta.focus();
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);

    // 送信ボタンをクリック
    let sendBtn = null;
    const inp = document.querySelector('input.btn.btn-sm.btn-primary');
    if (inp && inp.offsetParent !== null) { sendBtn = inp; }
    if (!sendBtn) {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === '送信' && btn.offsetParent !== null) { sendBtn = btn; break; }
      }
    }
    if (!sendBtn) return resolve({ error: '送信ボタンが見つかりません' });
    sendBtn.click();
    await sleep(2000);

    resolve({ messageSent: true });
  });
}

/**
 * テキストエリアの内容を編集して送信（DOM click版）
 * テンプレート選択後に引き取り文を削除して送信するケース用。
 */
export function editAndSendByDOM(removePattern) {
  return new Promise(async (resolve) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const ta = document.querySelector('textarea[class*="form-control"]');
    if (!ta) return resolve({ error: 'テキストエリアが見つかりません' });

    // 引き取り文を削除
    const newText = ta.value.replace(
      /また、ご不要な場合は弊社にて【引き取り】をすることも可能でございます。\s*/g, ''
    );
    ta.value = newText;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);

    // 送信ボタンをクリック
    let sendBtn = null;
    const inp = document.querySelector('input.btn.btn-sm.btn-primary');
    if (inp && inp.offsetParent !== null) { sendBtn = inp; }
    if (!sendBtn) {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim() === '送信' && btn.offsetParent !== null) { sendBtn = btn; break; }
      }
    }
    if (!sendBtn) return resolve({ error: '送信ボタンが見つかりません' });
    sendBtn.click();
    await sleep(2000);

    resolve({ messageSent: true });
  });
}

/** テキストエリアに値を直接設定（0円メッセージ用） */
export function setTextareaValue(text) {
  const ta = document.querySelector('textarea[class*="form-control"]');
  if (!ta) return false;
  ta.focus();
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** テキストエリアから引き取り文を削除（1000円以上用） */
export function removeHikitoriText() {
  const ta = document.querySelector('textarea[class*="form-control"]');
  if (!ta) return false;
  const newText = ta.value.replace(
    /また、ご不要な場合は弊社にて【引き取り】をすることも可能でございます。\s*/g, ''
  );
  ta.value = newText;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

// ========== タグ操作 ==========

/** タグ編集を開く（3つの方法をフォールバック） */
export function openTagEditor() {
  // 方法1: 「タグを追加」リンク
  const links = document.querySelectorAll('a');
  for (const a of links) {
    if (a.textContent.includes('タグを追加') && a.offsetParent !== null) {
      a.click();
      return { opened: true, method: 'link' };
    }
  }
  // 方法2: 「タグ」テキスト近くのペンアイコン
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode.textContent.trim() === 'タグ') {
      let parent = walker.currentNode.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        const pen = parent.querySelector('i[class*="la-pen"], i[class*="pen"]');
        if (pen) {
          const target = pen.closest('a') || pen.closest('button') || pen.parentElement;
          target.click();
          return { opened: true, method: 'pen_label' };
        }
        parent = parent.parentElement;
      }
    }
  }
  // 方法3: 右パネルのペンアイコン（2番目）
  const pens = document.querySelectorAll('i[class*="la-pen"]');
  const rightPens = [];
  for (const pen of pens) {
    const r = pen.getBoundingClientRect();
    if (r.left > 1000 && r.width > 0) rightPens.push(pen);
  }
  if (rightPens.length >= 2) {
    const target = rightPens[1].closest('a') || rightPens[1].parentElement;
    target.click();
    return { opened: true, method: 'pen_2nd' };
  } else if (rightPens.length === 1) {
    const target = rightPens[0].closest('a') || rightPens[0].parentElement;
    target.click();
    return { opened: true, method: 'pen_1st' };
  }
  return { opened: false };
}

/** タグをクリック（完全一致 → 部分一致 → span/divフォールバック） */
export function clickTag(tagName) {
  const labels = document.querySelectorAll('label');
  for (const l of labels) {
    if (l.textContent.trim() === tagName) { l.click(); return true; }
  }
  for (const l of labels) {
    if (l.textContent.includes(tagName)) { l.click(); return true; }
  }
  const els = document.querySelectorAll('span, div, a');
  for (const el of els) {
    if (el.textContent.trim() === tagName && el.childNodes.length <= 3) { el.click(); return true; }
  }
  return false;
}

/** 「保存」ボタンの座標 */
export function getSaveButtonPosition() {
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    if (btn.textContent.trim() === '保存' && btn.offsetParent !== null) {
      const r = btn.getBoundingClientRect();
      if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
}

/** 「キャンセル」ボタンの座標 */
export function getCancelButtonPosition() {
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    if (btn.textContent.trim() === 'キャンセル' && btn.offsetParent !== null) {
      const r = btn.getBoundingClientRect();
      if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
}

/** タグが付与されたか検証 */
export function verifyTag(tagName) {
  return (document.body.innerText || '').includes(tagName);
}

// ========== karisatei用: 昨日セクションスキャン ==========

/** チャットリストから「昨日」セクションを探す（曜日表示にも対応） */
export function findYesterdaySection() {
  // 昨日の曜日・日付を計算（LINE Chatが「昨日」→「水曜日」等に表示変更した場合に対応）
  const weekdays = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayWeekday = weekdays[yesterday.getDay()];
  const yesterdayShort = `${yesterday.getMonth() + 1}/${yesterday.getDate()}`;

  const el = document.querySelector('div.flex-fill.overflow-y-auto');
  if (!el) return { found: false };

  const sampleTexts = []; // 診断用: 見つかったリーフノードのテキスト

  // リーフノード（子要素なし）を全走査。<a> 内外を問わず検索。
  // タイムスタンプは <a> 内 or 外のどちらにある場合もある。
  // 長いテキスト（メッセージプレビュー）は除外してタイムスタンプのみ検出。
  const allEls = el.querySelectorAll('*');
  for (const elem of allEls) {
    if (elem.childElementCount > 0) continue; // リーフノードのみ
    const txt = elem.textContent.trim();
    if (!txt || txt.length > 25) continue; // 空または長すぎるテキストはスキップ
    if (sampleTexts.length < 10 && txt.length > 1) sampleTexts.push(txt);
    // 日付ラベルの判定（完全一致 + 含む の両方）
    if (txt === '昨日' || txt === yesterdayWeekday || txt === yesterdayShort ||
        txt.indexOf('昨日') > -1) {
      elem.scrollIntoView({ block: 'center' });
      return { found: true };
    }
  }
  return { found: false, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, sampleTexts };
}

/** 昨日セクションの対象ユーザーをスキャン（仮想スクロール対応・曜日表示にも対応） */
export function scanKarisateiTargets() {
  // 昨日の曜日・日付を計算（LINE Chatが「昨日」→「水曜日」等に表示変更した場合に対応）
  const weekdays = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayWeekday = weekdays[yesterday.getDay()];
  const yesterdayShort = `${yesterday.getMonth() + 1}/${yesterday.getDate()}`;

  const el = document.querySelector('div.flex-fill.overflow-y-auto');
  if (!el) return { targets: [], hasYesterday: false, hasOlderDates: false, sampleItems: [] };

  const targets = [];
  let hasYesterday = false;
  let hasOlderDates = false;
  const sampleItems = [];
  // 日付セパレーターを DOM 順に追跡する。
  // 日付ラベル: 「昨日」「今日」「木曜日」「2/26」など
  // チャットアイテム: <a> タグ内に <h6> ユーザー名がある
  let currentDateLabel = '';
  const processedLinks = new Set();

  const allEls = el.querySelectorAll('*');
  for (const elem of allEls) {
    // 日付セパレータ検出: 葉ノードで <a> の外にある日付テキスト
    if (elem.childElementCount === 0) {
      const txt = elem.textContent.trim();
      if (txt === '昨日' || txt === yesterdayWeekday || txt === yesterdayShort ||
          txt === '今日' || /^[月火水木金土日]曜日$/.test(txt) ||
          /^\d+\/\d+$/.test(txt)) {
        // <a> タグ内部にある場合はスキップ（チャット項目のタイムスタンプと区別）
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
      if (!h6) continue;
      processedLinks.add(elem);
      const name = h6.textContent.trim();
      const text = elem.textContent.replace(/\s+/g, ' ').trim();

      // 方法1: 日付セパレータ追跡（<a> 外の独立要素）
      const isYesterdayByLabel = currentDateLabel === '昨日' ||
                                  currentDateLabel === yesterdayWeekday ||
                                  currentDateLabel === yesterdayShort;
      const isTodayByLabel = currentDateLabel === '今日';

      // 方法2: テキスト内容検索（タイムスタンプが <a> 内にある場合のフォールバック）
      const isYesterdayByText = text.indexOf('昨日') > -1 ||
                                  text.indexOf(yesterdayWeekday) > -1 ||
                                  text.indexOf(yesterdayShort) > -1;
      const isTodayByText = /\d{1,2}:\d{2}/.test(text) &&
                              text.indexOf('昨日') === -1 &&
                              text.indexOf(yesterdayWeekday) === -1 &&
                              text.indexOf(yesterdayShort) === -1;

      const isYesterday = isYesterdayByLabel || isYesterdayByText;
      const isToday = isTodayByLabel || isTodayByText;
      const isOlderDate = (currentDateLabel && !isYesterdayByLabel && !isTodayByLabel) ||
                            (/(?:月|火|水|木|金|土|日)曜日/.test(text) &&
                             text.indexOf('昨日') === -1 && !isTodayByText &&
                             text.indexOf(yesterdayWeekday) === -1);

      if (isYesterday && !isToday) hasYesterday = true;
      if (isOlderDate && !isYesterday && !isToday) hasOlderDates = true;

      if (sampleItems.length < 3) {
        const ts = currentDateLabel || (isYesterdayByText ? '昨日テキスト' : (isTodayByText ? '今日テキスト' : '?'));
        sampleItems.push(`[${ts}] ${name}: ${text.substring(0, 50)}`);
      }
      if (text.indexOf('本査定のご案内') > -1 &&
          isYesterday && !isToday &&
          name.indexOf('Unknown') === -1 && name.length > 0) {
        targets.push(name);
      }
    }
  }
  return { targets, hasYesterday, hasOlderDates, sampleItems };
}

/** karisatei: チャットリストでユーザー名をクリック（未読チェック付き） */
export function clickUserInChatList(targetName) {
  const el = document.querySelector('div.flex-fill.overflow-y-auto');
  if (!el) return { error: 'chat list not found' };
  const links = el.querySelectorAll('a');
  for (const link of links) {
    const h6 = link.querySelector('h6');
    if (!h6) continue;
    if (h6.textContent.trim() === targetName) {
      // 未読チェック
      let container = link;
      for (let i = 0; i < 5; i++) {
        if (!container.parentElement || container.parentElement === el) break;
        container = container.parentElement;
      }
      const children = container.querySelectorAll('*');
      for (const child of children) {
        const r = child.getBoundingClientRect();
        if (r.width >= 5 && r.width <= 20 && r.height >= 5 && r.height <= 20) {
          if (window.getComputedStyle(child).backgroundColor === 'rgb(6, 199, 85)') {
            return { hasUnread: true };
          }
        }
      }
      link.click();
      return { clicked: true };
    }
  }
  return { notFound: true };
}

/** karisatei: 資格チェック（タグ・日付セパレータ） */
export function checkKarisateiEligibility(tagPrefix) {
  const now = new Date();
  const currentMonthTag = tagPrefix + now.getFullYear() + '/' + (now.getMonth() + 1);
  // タグチェック
  const allElements = document.querySelectorAll('a, span, div, label');
  for (const el of allElements) {
    const text = el.textContent || '';
    if (text.includes(currentMonthTag) && el.textContent.length < 50) {
      return { eligible: false, reason: 'already_tagged: ' + currentMonthTag };
    }
  }
  // 日付セパレータ
  const dates = document.querySelectorAll('.chatsys-date');
  const dateTexts = [];
  for (const d of dates) { const t = d.textContent.trim(); if (t) dateTexts.push(t); }
  let yesterdayIdx = -1;
  for (let j = 0; j < dateTexts.length; j++) {
    if (dateTexts[j] === '昨日') { yesterdayIdx = j; break; }
  }
  if (yesterdayIdx < 0) return { eligible: false, reason: 'no_yesterday' };
  if (yesterdayIdx === 0) return { eligible: true };
  const prev = dateTexts[yesterdayIdx - 1];
  const days = ['日曜日','月曜日','火曜日','水曜日','木曜日','金曜日','土曜日'];
  if (days.some(d => prev === d)) return { eligible: false, reason: 'within_week: ' + prev };
  return { eligible: true };
}

// ========== honsatei/konpokit用: 資格チェック ==========

/** honsatei: 資格チェック（タグ・本査定結果・顧客返信・価格抽出） */
export function checkHonsateiEligibility(opts) {
  const fullText = document.body.innerText || '';
  // タグチェック
  if (!opts.skipTagCheck) {
    const tagEls = document.querySelectorAll('a, span, div');
    for (const el of tagEls) {
      if (el.textContent.includes('本査定後催促済')) {
        return { eligible: false, reason: 'タグ付与済み' };
      }
    }
  }
  // 本査定結果存在チェック
  const hasResult = fullText.includes('本査定が完了いたしました') ||
                    fullText.includes('査定結果は以下') ||
                    fullText.includes('本査定結果') ||
                    fullText.includes('査定金額');
  if (!hasResult) return { eligible: false, reason: 'no_assessment_result_found' };
  // 今日の活動
  if (!opts.skipTagCheck) {
    const dates = document.querySelectorAll('.chatsys-date');
    if (Array.from(dates).some(d => d.textContent.trim() === '今日')) {
      return { eligible: false, reason: 'activity_today' };
    }
  }
  // チャットコンテナ
  const firstDate = document.querySelector('.chatsys-date');
  let chatContainer = null;
  if (firstDate) {
    let el = firstDate.parentElement;
    while (el && el !== document.body) {
      const s = window.getComputedStyle(el);
      if (s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflow === 'auto' || s.overflow === 'scroll') {
        chatContainer = el; break;
      }
      el = el.parentElement;
    }
  }
  if (!chatContainer) {
    // .chatsys-date が見つからない場合（LINE Chat UI変更等）
    // タグチェック・本査定結果テキストチェックは通過済みなので
    // 顧客返信チェックをスキップしてeligibleとして処理
    return { eligible: true, extractedPrice: null, allPrices: [], debug: 'chat_container_not_found_fallback' };
  }
  // 査定結果フレーズ
  const phrases = ['本査定が完了いたしました','査定結果は以下','査定金額','買取金額'];
  const textNodes = [];
  const walker = document.createTreeWalker(chatContainer, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent.trim();
    if (t.length >= 2) textNodes.push({ element: walker.currentNode.parentElement, text: t });
  }
  let assessmentIdx = -1;
  for (let i = textNodes.length - 1; i >= 0; i--) {
    for (const p of phrases) {
      if (textNodes[i].text.includes(p)) { assessmentIdx = i; break; }
    }
    if (assessmentIdx >= 0) break;
  }
  if (assessmentIdx < 0) return { eligible: false, reason: 'assessment_not_found_in_dom' };
  // 顧客返信チェック
  const cRect = chatContainer.getBoundingClientRect();
  const centerX = cRect.left + cRect.width / 2;
  let customerFound = false;
  const debug = [];
  for (let i = assessmentIdx + 1; i < textNodes.length; i++) {
    const { element, text } = textNodes[i];
    if (/^\d{1,2}:\d{2}$/.test(text) || text === '既読' || text === '送信' ||
        text === 'メッセージを入力' || /^(今日|昨日)$/.test(text) ||
        /^\d{1,2}月\d{1,2}日/.test(text) || /^(月|火|水|木|金|土|日)曜日$/.test(text) ||
        /^\d{4}[\/年]/.test(text) || text.length < 3) continue;
    let bubble = element;
    while (bubble && bubble !== chatContainer) {
      const r = bubble.getBoundingClientRect();
      if (r.width > 100 && r.height > 20) break;
      bubble = bubble.parentElement;
    }
    if (!bubble || bubble === chatContainer) continue;
    const bx = bubble.getBoundingClientRect().left + bubble.getBoundingClientRect().width / 2;
    if (bx < centerX - 50) {
      customerFound = true;
      debug.push(`customer: "${text.substring(0, 30)}"`);
      break;
    } else {
      debug.push(`staff: "${text.substring(0, 30)}"`);
    }
  }
  if (customerFound) {
    return { eligible: false, reason: 'customer_responded', debug: debug.join('; ') };
  }
  // 価格抽出
  const prices = [];
  const start = Math.max(0, assessmentIdx - 10);
  const end = Math.min(textNodes.length - 1, assessmentIdx + 50);
  for (let i = start; i <= end; i++) {
    const m = textNodes[i].text.match(/(\d[\d,]*)円/g);
    if (m) m.forEach(pm => {
      const n = parseInt(pm.replace(/[円,]/g, ''), 10);
      if (!isNaN(n)) prices.push(n);
    });
  }
  return {
    eligible: true,
    extractedPrice: prices.length > 0 ? Math.max(...prices) : null,
    allPrices: prices,
    debug: debug.length > 0 ? debug.join('; ') : 'no_msgs_after_assessment',
  };
}

/** konpokit: 資格チェック */
export function checkKonpokitEligibility() {
  const fullText = document.body.innerText || '';
  // タグチェック
  const tagEls = document.querySelectorAll('a, span, div');
  for (const el of tagEls) {
    if (el.textContent.includes('梱包キット催促完了')) {
      return { eligible: false, reason: 'タグ付与済み' };
    }
  }
  // キットメッセージ存在
  const hasKit = fullText.includes('無料梱包キットの手配を承りました') ||
                 fullText.includes('梱包キットをお届け') ||
                 fullText.includes('梱包キット発送');
  if (!hasKit) return { eligible: false, reason: 'no_kit_message' };
  // 今日の活動
  const dates = document.querySelectorAll('.chatsys-date');
  if (Array.from(dates).some(d => d.textContent.trim() === '今日')) {
    return { eligible: false, reason: 'activity_today' };
  }
  return { eligible: true };
}

// ========== タグ作成（月初用） ==========

/** LINE Chat設定のタグ管理ページかどうかを確認 */
export function isTagSettingsPage() {
  return window.location.href.includes('/setting/tag') ||
         document.querySelector('[class*="tag-setting"]') !== null;
}

/** タグ作成フォームの「＋」ボタンまたは「タグを追加」ボタンの座標 */
export function getAddTagButtonPosition() {
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const t = btn.textContent.trim();
    if ((t === '＋' || t === '+' || t.includes('タグを追加') || t.includes('追加')) && btn.offsetParent !== null) {
      const r = btn.getBoundingClientRect();
      if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
}

/** タグ名入力フィールドの座標 */
export function getTagInputPosition() {
  const inputs = document.querySelectorAll('input[type="text"], input:not([type])');
  for (const inp of inputs) {
    const ph = inp.placeholder || '';
    if (ph.includes('タグ') || ph.includes('入力')) {
      const r = inp.getBoundingClientRect();
      if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  // フォールバック: 最後のinput
  const all = document.querySelectorAll('input[type="text"]');
  if (all.length > 0) {
    const last = all[all.length - 1];
    const r = last.getBoundingClientRect();
    if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return null;
}

/** 既存タグ名のリストを取得 */
export function getExistingTags() {
  const tags = [];
  const labels = document.querySelectorAll('label, span, div');
  for (const el of labels) {
    const t = el.textContent.trim();
    if (t && t.length < 40 && (t.includes('催促') || t.includes('査定'))) {
      tags.push(t);
    }
  }
  return [...new Set(tags)];
}
