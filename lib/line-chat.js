/**
 * LINE Chat DOM操作関数群
 *
 * 全て execMain() 経由で実行される純粋関数。
 * 座標やブール値を返し、実際のクリックは呼び出し側で CDP 経由で行う。
 */

// ========== ヘルパー ==========

/**
 * LINE Chatのメッセージ入力欄（textarea）を取得する。
 * LINE Chatは <textarea-ex id="editor"> というカスタムWebComponent（Shadow DOM）を使用。
 * 通常の document.querySelector('textarea') ではShadow DOM内の要素は見つからない。
 */
function getMessageTextarea() {
  // 1. Shadow DOM内のtextareaを探す（LINE Chat標準）
  const editorEx = document.querySelector('textarea-ex#editor');
  if (editorEx?.shadowRoot) {
    const ta = editorEx.shadowRoot.querySelector('textarea');
    if (ta) return ta;
  }
  // 2. フォールバック: 通常のtextarea
  const ta = document.querySelector('textarea.form-control') || document.querySelector('textarea');
  if (ta) return ta;
  // 3. フォールバック: contenteditable
  return document.querySelector('div[contenteditable="true"]');
}

/** 送信ボタンを取得する */
function getSendButton() {
  // input[type="submit"]形式（LINE Chat標準）
  const inp = document.querySelector('input.btn.btn-sm.btn-primary');
  if (inp && inp.offsetParent !== null) return inp;
  // button「送信」形式
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    if (btn.textContent.trim() === '送信' && btn.offsetParent !== null) return btn;
  }
  return null;
}

// ========== チャットリスト操作 ==========

/**
 * チャットリストのフィルターを「すべて」に切り替える。
 * 「未読」フィルターがかかっていると検索が正しく動かないため、催促タスク開始前に呼ぶ。
 * NOTE: execMain()で実行されるため、Promiseベース（クリック後のDOM更新待ちが必要）。
 */
/** フィルターの現在状態を取得し、「すべて」でなければフィルターボタンの座標を返す */
export function getFilterStatus() {
  const allEls = document.querySelectorAll('button, a, [role="button"], span, div');
  for (const el of allEls) {
    const txt = el.textContent.trim();
    if (txt.length <= 10 && (txt.includes('未読') || txt === 'すべて' || txt === 'All' ||
        txt.includes('受信') || txt.includes('要対応') || txt.includes('対応済み'))) {
      const clickable = el.closest('button, a, [role="button"]') || el;
      const rect = clickable.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (txt === 'すべて' || txt === 'All') {
        return { isAll: true, current: txt };
      }
      return { isAll: false, current: txt, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
  }
  return null;
}

/** ドロップダウンが開いた状態で「すべて」オプションの座標を返す */
export function getFilterAllOptionPosition() {
  // 方法1: a/li/button の直接テキストノードで「すべて」を探す
  // （バッジやアイコンがあっても、テキストノード自体は「すべて」のまま）
  const candidates = document.querySelectorAll('a, li, button, [role="option"], [role="menuitem"]');
  for (const el of candidates) {
    let directText = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) directText += node.textContent; // TEXT_NODE
    }
    directText = directText.trim();
    if (directText === 'すべて' || directText === 'All') {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, debug: `directText: "${directText}"` };
      }
    }
  }

  // 方法2: textContent が「すべて」で始まる要素（バッジ数字を含む場合 例: "すべて5"）
  for (const el of candidates) {
    const txt = el.textContent.trim();
    if ((txt.startsWith('すべて') || txt.startsWith('All')) && txt.length <= 15) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.height < 80) {
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, debug: `startsWith: "${txt}"` };
      }
    }
  }

  // 方法3: リーフノードで「すべて」完全一致
  const allEls = document.querySelectorAll('*');
  for (const el of allEls) {
    if (el.childElementCount > 0) continue;
    const txt = el.textContent.trim();
    if (txt === 'すべて' || txt === 'All') {
      const clickTarget = el.closest('a, button, li, [role="option"]') || el;
      const rect = clickTarget.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, debug: `leaf: "${txt}"` };
      }
    }
  }

  // デバッグ: 見つからなかった場合も座標0で返す（ログで診断用）
  const diag = [];
  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const txt = el.textContent.trim().substring(0, 20);
      if (txt) diag.push(`${el.tagName}:"${txt}"`);
    }
  }
  return { x: 0, y: 0, debug: `not found [${diag.slice(0, 8).join(', ')}]` };
}

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

/** 緑系の色かチェック（未読バッジ検出用）。rgb/rgba両対応 */
function isGreenColor(bg) {
  if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' || bg === 'rgb(255, 255, 255)') return false;
  const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  const [, r, g, b] = m.map(Number);
  return g > 120 && r < 120 && b < 170;
}

/** コンテナ内の未読バッジを検出（緑●、擬似要素、クラスベース） */
function detectUnreadInContainer(container, name) {
  const els = container.querySelectorAll('*');
  const colorEls = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.width > 40 || r.height > 40) continue;
    // 1. backgroundColor 直接チェック
    const bg = window.getComputedStyle(el).backgroundColor;
    if (isGreenColor(bg)) {
      return { hasUnread: true, debug: `green dot: ${name} ${bg}` };
    }
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg !== 'rgb(255, 255, 255)') {
      colorEls.push(`${el.tagName}.${(el.className || '').toString().substring(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)} bg=${bg}`);
    }
    // 2. 擬似要素 (::before, ::after) チェック
    for (const pseudo of ['::before', '::after']) {
      try {
        const ps = window.getComputedStyle(el, pseudo);
        if (ps.content && ps.content !== 'none' && ps.content !== 'normal') {
          if (isGreenColor(ps.backgroundColor)) {
            return { hasUnread: true, debug: `green pseudo ${pseudo}: ${name} ${ps.backgroundColor}` };
          }
        }
      } catch (_) {}
    }
    // 3. badge/unread/count クラス
    const cn = (el.className || '').toString();
    if (cn.includes('badge') || cn.includes('unread') || cn.includes('count') || cn.includes('notification')) {
      const t = el.textContent.trim();
      // 数字バッジ（件数表示）
      if (t && /^\d+$/.test(t) && parseInt(t) > 0) {
        return { hasUnread: true, debug: `badge: ${name} class=${cn} text=${t}` };
      }
      // テキストなしでも緑背景 or 小さい丸（ドットバッジ）
      if (r.width <= 15 && r.height <= 15 && r.width >= 4 && r.height >= 4) {
        const borderRadius = window.getComputedStyle(el).borderRadius;
        if (borderRadius === '50%' || parseFloat(borderRadius) >= r.width / 2) {
          return { hasUnread: true, debug: `dot badge: ${name} class=${cn} ${Math.round(r.width)}x${Math.round(r.height)}` };
        }
      }
      colorEls.push(`BADGE: ${el.tagName}.${cn.substring(0, 30)} text="${t}"`);
    }
  }
  return { hasUnread: false, diag: colorEls };
}

/** 検索結果のチャットに未読マーク（緑●）があるか（全結果をチェック・診断付き）
 * NOTE: execMain()で実行されるため、外部関数は参照不可。全ロジックをインライン化。 */
export function checkUnreadInSearchResult() {
  // --- インライン: isGreenColor ---
  function _isGreen(bg) {
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' || bg === 'rgb(255, 255, 255)') return false;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const [, r, g, b] = m.map(Number);
    return g > 120 && r < 120 && b < 170;
  }
  // --- インライン: detectUnreadInContainer ---
  function _detect(container, name) {
    const els = container.querySelectorAll('*');
    const colorEls = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.width > 40 || r.height > 40) continue;
      const bg = window.getComputedStyle(el).backgroundColor;
      if (_isGreen(bg)) {
        return { hasUnread: true, debug: `green dot: ${name} ${bg}` };
      }
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg !== 'rgb(255, 255, 255)') {
        colorEls.push(`${el.tagName}.${(el.className || '').toString().substring(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)} bg=${bg}`);
      }
      for (const pseudo of ['::before', '::after']) {
        try {
          const ps = window.getComputedStyle(el, pseudo);
          if (ps.content && ps.content !== 'none' && ps.content !== 'normal') {
            if (_isGreen(ps.backgroundColor)) {
              return { hasUnread: true, debug: `green pseudo ${pseudo}: ${name} ${ps.backgroundColor}` };
            }
          }
        } catch (_) {}
      }
      const cn = (el.className || '').toString();
      if (cn.includes('badge') || cn.includes('unread') || cn.includes('count') || cn.includes('notification')) {
        const t = el.textContent.trim();
        if (t && /^\d+$/.test(t) && parseInt(t) > 0) {
          return { hasUnread: true, debug: `badge: ${name} class=${cn} text=${t}` };
        }
        if (r.width <= 15 && r.height <= 15 && r.width >= 4 && r.height >= 4) {
          const borderRadius = window.getComputedStyle(el).borderRadius;
          if (borderRadius === '50%' || parseFloat(borderRadius) >= r.width / 2) {
            return { hasUnread: true, debug: `dot badge: ${name} class=${cn} ${Math.round(r.width)}x${Math.round(r.height)}` };
          }
        }
        colorEls.push(`BADGE: ${el.tagName}.${cn.substring(0, 30)} text="${t}"`);
      }
    }
    return { hasUnread: false, diag: colorEls };
  }

  // --- メイン処理 ---
  // 最初の検索結果のみチェック（パネル全体をスキャンすると無関係なユーザーの
  // 未読バッジを誤検知する — 佑香の緑●で全件スキップになった事故 2026-03-09）
  const panel = document.querySelector('div.flex-fill.overflow-y-auto');
  if (!panel) return { hasUnread: false, debug: 'panel not found' };
  const items = panel.querySelectorAll('.list-group-item');

  if (items.length === 0) {
    const links = panel.querySelectorAll('a');
    for (const link of links) {
      const h6 = link.querySelector('h6');
      if (!h6) continue;
      const name = h6.textContent.trim();
      let container = link;
      for (let i = 0; i < 5; i++) {
        if (!container.parentElement || container.parentElement === panel) break;
        container = container.parentElement;
      }
      const result = _detect(container, name);
      // 最初のリンクのみチェック
      return result.hasUnread
        ? result
        : { hasUnread: false, debug: `first link "${name}" no unread` };
    }
    return { hasUnread: false, debug: 'no .list-group-item, no links' };
  }

  // 最初の表示中アイテムのみチェック（クリック対象のユーザーだけ見ればよい）
  for (const item of items) {
    if (item.getBoundingClientRect().height <= 0) continue;
    const h6 = item.querySelector('h6');
    const name = h6 ? h6.textContent.trim() : '?';
    const result = _detect(item, name);
    return result.hasUnread
      ? result
      : { hasUnread: false, debug: `first item "${name}" no unread` };
  }
  return { hasUnread: false, debug: 'no visible items' };
}

/** 検索結果の最初の項目のタイムスタンプが「昨日」かチェック（本査定用）
 * kintoneで昨日絞りしているのに最終チャットが昨日でない = やりとりがあった = スキップ対象 */
export function checkSearchResultTimestamp() {
  // タイムスタンプパターン判定（インライン）
  function _matchTimestamp(txt) {
    if (txt === '昨日') return { isYesterday: true, timestamp: '昨日' };
    if (txt === '今日') return { isYesterday: false, timestamp: '今日', reason: '今日の活動あり' };
    if (/^\d{1,2}:\d{2}$/.test(txt)) return { isYesterday: false, timestamp: txt, reason: '今日の時刻表示' };
    if (/^[月火水木金土日]曜日$/.test(txt)) return { isYesterday: false, timestamp: txt, reason: '曜日表示（2日以上前）' };
    if (/^\d{1,2}\/\d{1,2}$/.test(txt)) return { isYesterday: false, timestamp: txt, reason: '日付表示' };
    return null;
  }

  const panel = document.querySelector('div.flex-fill.overflow-y-auto');
  if (!panel) return { isYesterday: false, debug: 'panel not found' };

  // 方法1: .list-group-item または a 要素内のh6+リーフノード検索
  const items = panel.querySelectorAll('.list-group-item');
  const targetItems = items.length > 0 ? Array.from(items) : Array.from(panel.querySelectorAll('a'));

  for (const item of targetItems) {
    if (item.getBoundingClientRect().height <= 0) continue;
    const h6 = item.querySelector('h6');
    if (!h6) continue;
    const name = h6.textContent.trim();
    if (name.includes('メッセージ')) continue;

    const leaves = item.querySelectorAll('*');
    for (const el of leaves) {
      if (el.childElementCount > 0) continue;
      const txt = el.textContent.trim();
      if (!txt || txt.length > 20 || txt.length < 1) continue;
      if (txt === name) continue;
      const m = _matchTimestamp(txt);
      if (m) return { ...m, name };
    }
  }

  // 方法2: パネル全体のリーフノードからタイムスタンプパターンを直接検索（DOM構造変更に対応）
  const allLeaves = panel.querySelectorAll('*');
  const diagTexts = [];
  for (const el of allLeaves) {
    if (el.childElementCount > 0) continue;
    const txt = el.textContent.trim();
    if (!txt || txt.length > 20 || txt.length < 1) continue;
    const m = _matchTimestamp(txt);
    if (m) return { ...m, name: '(broadSearch)' };
    // 診断用: 短いテキストを収集
    if (txt.length <= 15) diagTexts.push(txt);
  }

  return { isYesterday: false, debug: `タイムスタンプが見つかりません [leafTexts: ${diagTexts.slice(0, 15).join(', ')}]` };
}

/** 検索結果のタイムスタンプが指定の曜日かチェック（梱包キット催促用）
 * 5日前にキット発送 → タイムスタンプが5日前の曜日なら活動なし → 催促対象
 * @param {string} expectedDayOfWeek - 期待する曜日（例: "金曜日"）
 * @returns {{ isTarget: boolean, timestamp?: string, reason?: string, debug?: string }}
 */
export function checkSearchResultTimestampForKonpokit(expectedDayOfWeek) {
  function _classify(txt) {
    if (txt === '今日') return { isTarget: false, timestamp: '今日', reason: '今日の活動あり' };
    if (/^\d{1,2}:\d{2}$/.test(txt)) return { isTarget: false, timestamp: txt, reason: '今日の時刻表示' };
    if (txt === '昨日') return { isTarget: false, timestamp: '昨日', reason: '昨日の活動あり' };
    if (/^[月火水木金土日]曜日$/.test(txt)) {
      if (txt === expectedDayOfWeek) return { isTarget: true, timestamp: txt };
      return { isTarget: false, timestamp: txt, reason: `${txt}（期待: ${expectedDayOfWeek}）` };
    }
    if (/^\d{1,2}\/\d{1,2}$/.test(txt)) return { isTarget: true, timestamp: txt, reason: '7日以上前（活動なし）' };
    return null;
  }

  const panel = document.querySelector('div.flex-fill.overflow-y-auto');
  if (!panel) return { isTarget: false, debug: 'panel not found' };

  // 方法1: .list-group-item または a 要素内のh6+リーフノード検索
  const items = panel.querySelectorAll('.list-group-item');
  const targetItems = items.length > 0 ? Array.from(items) : Array.from(panel.querySelectorAll('a'));

  for (const item of targetItems) {
    if (item.getBoundingClientRect().height <= 0) continue;
    const h6 = item.querySelector('h6');
    if (!h6) continue;
    const name = h6.textContent.trim();
    if (name.includes('メッセージ')) continue;

    const leaves = item.querySelectorAll('*');
    for (const el of leaves) {
      if (el.childElementCount > 0) continue;
      const txt = el.textContent.trim();
      if (!txt || txt.length > 20 || txt.length < 1) continue;
      if (txt === name) continue;
      const m = _classify(txt);
      if (m) return { ...m, name };
    }
  }

  // 方法2: パネル全体のリーフノード検索
  const allLeaves = panel.querySelectorAll('*');
  const diagTexts = [];
  for (const el of allLeaves) {
    if (el.childElementCount > 0) continue;
    const txt = el.textContent.trim();
    if (!txt || txt.length > 20 || txt.length < 1) continue;
    const m = _classify(txt);
    if (m) return { ...m, name: '(broadSearch)' };
    if (txt.length <= 15) diagTexts.push(txt);
  }

  return { isTarget: false, debug: `タイムスタンプが見つかりません [leafTexts: ${diagTexts.slice(0, 15).join(', ')}]` };
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

/** チャット内に「ここから未読メッセージ」マーカーがあるか（waitForChatContent後に呼ぶ） */
export function checkUnreadMarkerInChat() {
  // 方法1: textContentで全テキスト検索（非表示要素含む）
  const text = document.body.textContent || '';
  if (text.includes('ここから未読メッセージ')) {
    return { hasUnread: true, marker: 'ここから未読メッセージ(textContent)' };
  }
  if (text.includes('Unread messages')) {
    return { hasUnread: true, marker: 'Unread messages(textContent)' };
  }

  // 方法2: チャットコンテナ内のテキストノードを直接走査
  const dateSep = document.querySelector('.chatsys-date');
  if (dateSep) {
    let container = dateSep.parentElement;
    while (container && container !== document.body) {
      const s = window.getComputedStyle(container);
      if (s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflow === 'auto' || s.overflow === 'scroll') {
        break;
      }
      container = container.parentElement;
    }
    if (container && container !== document.body) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = walker.currentNode.textContent.trim();
        if (t.includes('ここから未読メッセージ') || t.includes('未読メッセージ')) {
          return { hasUnread: true, marker: `TreeWalker: "${t}"` };
        }
      }
      // 方法3: 特定のクラスやdata属性で未読セパレータを検索
      const allEls = container.querySelectorAll('*');
      for (const el of allEls) {
        const cn = (el.className || '').toString();
        const t = el.textContent.trim();
        if (t.length < 30 && (t.includes('未読') || cn.includes('unread'))) {
          return { hasUnread: true, marker: `element: ${el.tagName}.${cn.substring(0, 30)} "${t}"` };
        }
      }
    }
  }

  return { hasUnread: false };
}

// ========== チャット内容操作 ==========

/** チャットを最下部までスクロール（検索結果クリック後に最新メッセージをロードするため） */
/**
 * チャットを最下部にスクロール（同期版）
 * 旧版はsetInterval(200ms)を使っていたが、バックグラウンドタブでは
 * Chromeが1Hzにスロットルし、25回×1s=25sでexecMain timeout。
 * 同期的にscrollTopを設定し、呼び出し側で複数回実行する方式に変更。
 */
export function scrollChatToBottom() {
  const dateSep = document.querySelector('.chatsys-date');
  if (!dateSep) return false;
  let container = dateSep.parentElement;
  while (container && container !== document.body) {
    const s = window.getComputedStyle(container);
    if (s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflow === 'auto' || s.overflow === 'scroll') {
      container.scrollTop = container.scrollHeight;
      return true;
    }
    container = container.parentElement;
  }
  return false;
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
    // NOTE: getSendButton() はモジュールスコープの関数でページコンテキストには存在しない。インライン化必須。
    let sendBtn = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const _inp = document.querySelector('input.btn.btn-sm.btn-primary');
      if (_inp && _inp.offsetParent !== null) { sendBtn = _inp; break; }
      const _btns = document.querySelectorAll('button');
      for (const _b of _btns) { if (_b.textContent.trim() === '送信' && _b.offsetParent !== null) { sendBtn = _b; break; } }
      if (sendBtn) break;
      await sleep(800);
    }
    if (!sendBtn) { clearTimeout(localTimer); return resolve({ error: '送信ボタンが見つかりません' }); }
    sendBtn.click();
    await sleep(2000);

    // 6. 送信確認：入力欄が空 or 消えていれば成功
    // NOTE: getMessageTextarea() もインライン化必須。
    let _ta = null;
    const _edEx = document.querySelector('textarea-ex#editor');
    if (_edEx?.shadowRoot) _ta = _edEx.shadowRoot.querySelector('textarea');
    if (!_ta) _ta = document.querySelector('textarea.form-control') || document.querySelector('textarea');
    const sent = !_ta || (_ta.value ?? _ta.textContent ?? '').trim() === '';

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

    // Shadow DOM対応: textarea-ex#editor 内のtextareaを取得
    // NOTE: getMessageTextarea() はモジュールスコープでページコンテキストには存在しない。インライン化必須。
    let ta = null;
    const edEx = document.querySelector('textarea-ex#editor');
    if (edEx?.shadowRoot) ta = edEx.shadowRoot.querySelector('textarea');
    if (!ta) ta = document.querySelector('textarea.form-control') || document.querySelector('textarea');
    if (!ta) ta = document.querySelector('div[contenteditable="true"]');
    if (!ta) return resolve({ error: 'テキストエリアが見つかりません（Shadow DOM含む）' });
    ta.focus();
    // React/Lit互換: native value setter を使用
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter && ta.tagName === 'TEXTAREA') {
      nativeSetter.call(ta, text);
    } else if (ta.tagName === 'TEXTAREA' || ta.tagName === 'INPUT') {
      ta.value = text;
    } else {
      ta.textContent = text;
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // カスタム要素のホストにもイベントを伝播
    const host = ta.getRootNode()?.host;
    if (host) host.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);

    // 送信ボタンをクリック（インライン化）
    let sendBtn = null;
    const inp = document.querySelector('input.btn.btn-sm.btn-primary');
    if (inp && inp.offsetParent !== null) { sendBtn = inp; }
    if (!sendBtn) {
      const btns = document.querySelectorAll('button');
      for (const b of btns) { if (b.textContent.trim() === '送信' && b.offsetParent !== null) { sendBtn = b; break; } }
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

    // Shadow DOM対応: textarea-ex#editor 内のtextareaを取得
    // NOTE: getMessageTextarea() はモジュールスコープでページコンテキストには存在しない。インライン化必須。
    let ta = null;
    const edEx = document.querySelector('textarea-ex#editor');
    if (edEx?.shadowRoot) ta = edEx.shadowRoot.querySelector('textarea');
    if (!ta) ta = document.querySelector('textarea.form-control') || document.querySelector('textarea');
    if (!ta) ta = document.querySelector('div[contenteditable="true"]');
    if (!ta) return resolve({ error: 'テキストエリアが見つかりません（Shadow DOM含む）' });

    // 引き取り文を削除
    const currentText = (ta.tagName === 'TEXTAREA' || ta.tagName === 'INPUT') ? ta.value : ta.textContent;
    const newText = currentText.replace(
      /また、ご不要な場合は弊社にて【引き取り】をすることも可能でございます。\s*/g, ''
    );
    // React/Lit互換: native value setter を使用
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter && ta.tagName === 'TEXTAREA') {
      nativeSetter.call(ta, newText);
    } else if (ta.tagName === 'TEXTAREA' || ta.tagName === 'INPUT') {
      ta.value = newText;
    } else {
      ta.textContent = newText;
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const host = ta.getRootNode()?.host;
    if (host) host.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);

    // 送信ボタンをクリック（インライン化）
    let sendBtn = null;
    const inp = document.querySelector('input.btn.btn-sm.btn-primary');
    if (inp && inp.offsetParent !== null) { sendBtn = inp; }
    if (!sendBtn) {
      const btns = document.querySelectorAll('button');
      for (const b of btns) { if (b.textContent.trim() === '送信' && b.offsetParent !== null) { sendBtn = b; break; } }
    }
    if (!sendBtn) return resolve({ error: '送信ボタンが見つかりません' });
    sendBtn.click();
    await sleep(2000);

    resolve({ messageSent: true });
  });
}

/** テキストエリアに値を直接設定（0円メッセージ用） */
export function setTextareaValue(text) {
  // NOTE: getMessageTextarea() はモジュールスコープでページコンテキストには存在しない。インライン化必須。
  let ta = null;
  const edEx = document.querySelector('textarea-ex#editor');
  if (edEx?.shadowRoot) ta = edEx.shadowRoot.querySelector('textarea');
  if (!ta) ta = document.querySelector('textarea.form-control') || document.querySelector('textarea');
  if (!ta) ta = document.querySelector('div[contenteditable="true"]');
  if (!ta) return false;
  ta.focus();
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (nativeSetter && ta.tagName === 'TEXTAREA') {
    nativeSetter.call(ta, text);
  } else if (ta.tagName === 'TEXTAREA' || ta.tagName === 'INPUT') {
    ta.value = text;
  } else {
    ta.textContent = text;
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const host = ta.getRootNode()?.host;
  if (host) host.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** テキストエリアから引き取り文を削除（1000円以上用） */
export function removeHikitoriText() {
  // NOTE: getMessageTextarea() はモジュールスコープでページコンテキストには存在しない。インライン化必須。
  let ta = null;
  const edEx = document.querySelector('textarea-ex#editor');
  if (edEx?.shadowRoot) ta = edEx.shadowRoot.querySelector('textarea');
  if (!ta) ta = document.querySelector('textarea.form-control') || document.querySelector('textarea');
  if (!ta) ta = document.querySelector('div[contenteditable="true"]');
  if (!ta) return false;
  const currentText = (ta.tagName === 'TEXTAREA' || ta.tagName === 'INPUT') ? ta.value : ta.textContent;
  const newText = currentText.replace(
    /また、ご不要な場合は弊社にて【引き取り】をすることも可能でございます。\s*/g, ''
  );
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (nativeSetter && ta.tagName === 'TEXTAREA') {
    nativeSetter.call(ta, newText);
  } else if (ta.tagName === 'TEXTAREA' || ta.tagName === 'INPUT') {
    ta.value = newText;
  } else {
    ta.textContent = newText;
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const host = ta.getRootNode()?.host;
  if (host) host.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

// ========== タグ操作 ==========

/** タグ編集を開く（3つの方法をフォールバック） */
/**
 * 右パネル（ユーザー詳細）が閉じている場合、チャットヘッダーのユーザー名をクリックして開く。
 * @returns {{ expanded: boolean, method?: string, debug?: string }}
 */
export function expandRightPanel() {
  // 「タグを追加」or「＋タグ」がvisibleなら既に開いている
  const allEls = document.querySelectorAll('a, button, span');
  for (const el of allEls) {
    const txt = el.textContent.trim();
    if ((txt.includes('タグを追加') || txt === '＋タグ' || txt === '+タグ') && el.offsetParent !== null) {
      return { expanded: true, method: 'already_open' };
    }
  }

  // チャットヘッダーのユーザー名（h5 or h4）をクリックして右パネルを展開
  const headerNames = document.querySelectorAll('h4, h5');
  for (const h of headerNames) {
    const r = h.getBoundingClientRect();
    // ヘッダー領域（画面上部、チャットリスト右側）にあるユーザー名
    if (r.top < 150 && r.left > 200 && r.width > 0) {
      const clickable = h.closest('a') || h.closest('button') || h;
      clickable.click();
      return { expanded: true, method: 'header_name', text: h.textContent.trim(), pos: `${Math.round(r.left)},${Math.round(r.top)}` };
    }
  }

  // フォールバック: スピーカーアイコンの左のユーザー名リンク
  const chatHeader = document.querySelector('.chat-header, [class*="chat-header"]');
  if (chatHeader) {
    const link = chatHeader.querySelector('a');
    if (link) {
      link.click();
      return { expanded: true, method: 'chat_header_link' };
    }
  }

  return { expanded: false, debug: 'ヘッダーにクリック可能なユーザー名が見つかりません' };
}

export function openTagEditor() {
  // 診断情報
  const diag = {
    url: location.href,
    bodyWidth: document.body.scrollWidth,
    tagLinks: 0,
    tagText: 0,
    penIcons: 0,
    rightPens: 0,
    rightPanelVisible: false,
  };

  // 右パネル存在チェック（チャット詳細エリア）
  const rightPanel = document.querySelector('.chat-detail, [class*="detail"], [class*="profile"]');
  if (rightPanel) {
    const r = rightPanel.getBoundingClientRect();
    diag.rightPanelVisible = r.width > 0;
    diag.rightPanelRect = `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  }

  // 方法1: 「タグを追加」or「＋タグ」（a/button/span全対応）
  const clickables = document.querySelectorAll('a, button, span, div');
  for (const el of clickables) {
    if (el.childElementCount > 5) continue;
    const txt = el.textContent.trim();
    if (txt.includes('タグを追加') || txt === '＋タグ' || txt === '+タグ' || txt === '＋ タグ' || txt === '+ タグ') {
      diag.tagLinks++;
      if (el.offsetParent !== null) {
        el.click();
        return { opened: true, method: 'link', matchedText: txt, tag: el.tagName, diag };
      }
    }
  }
  // 方法2: 「タグ」テキスト近くのペンアイコン
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode.textContent.trim() === 'タグ') {
      diag.tagText++;
      let parent = walker.currentNode.parentElement;
      for (let i = 0; i < 8 && parent; i++) {
        const pen = parent.querySelector('i[class*="la-pen"], i[class*="pen"], svg[class*="pen"], [class*="edit"]');
        if (pen) {
          const target = pen.closest('a') || pen.closest('button') || pen.parentElement;
          target.click();
          return { opened: true, method: 'pen_label', diag };
        }
        parent = parent.parentElement;
      }
    }
  }
  // 方法3: 右パネルのペンアイコン（ページ幅の60%より右）
  const pens = document.querySelectorAll('i[class*="la-pen"], i[class*="pen"], svg[class*="pen"]');
  diag.penIcons = pens.length;
  const rightThreshold = window.innerWidth * 0.6;
  diag.rightThreshold = Math.round(rightThreshold);
  const rightPens = [];
  const penPositions = [];
  for (const pen of pens) {
    const r = pen.getBoundingClientRect();
    if (r.width > 0) {
      penPositions.push(Math.round(r.left));
      if (r.left > rightThreshold) rightPens.push(pen);
    }
  }
  diag.rightPens = rightPens.length;
  diag.penPositions = penPositions;
  if (rightPens.length >= 2) {
    const target = rightPens[1].closest('a') || rightPens[1].closest('button') || rightPens[1].parentElement;
    target.click();
    return { opened: true, method: 'pen_2nd', diag };
  } else if (rightPens.length === 1) {
    const target = rightPens[0].closest('a') || rightPens[0].closest('button') || rightPens[0].parentElement;
    target.click();
    return { opened: true, method: 'pen_1st', diag };
  }
  return { opened: false, diag };
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

/**
 * 検索結果が複数ある場合に、タイムスタンプとメッセージプレビューで正しいチャットを特定してクリック。
 * clickUserInChatList の強化版。
 *
 * @param {string} targetName - 対象ユーザー名（完全一致）
 * @param {{ timestamp?: string, messageKeyword?: string }} hints - 絞り込みヒント
 *   timestamp: "昨日" など、タイムスタンプの期待値
 *   messageKeyword: "本査定のご案内" など、メッセージプレビューに含まれるべきキーワード
 * @returns {{ clicked: true } | { hasUnread: true } | { notFound: true } | { multipleFound: number }}
 */
export function clickBestMatchInChatList(targetName, hints) {
  const el = document.querySelector('div.flex-fill.overflow-y-auto');
  if (!el) return { error: 'chat list not found' };

  // --- インライン: 未読チェック ---
  function _checkUnread(container) {
    const children = container.querySelectorAll('*');
    for (const child of children) {
      const r = child.getBoundingClientRect();
      if (r.width >= 5 && r.width <= 20 && r.height >= 5 && r.height <= 20) {
        if (window.getComputedStyle(child).backgroundColor === 'rgb(6, 199, 85)') {
          return true;
        }
      }
    }
    return false;
  }

  // --- インライン: アイテムからタイムスタンプとプレビューを抽出 ---
  function _extractInfo(item) {
    const leaves = item.querySelectorAll('*');
    let timestamp = null;
    let preview = null;
    const h6 = item.querySelector('h6');
    const nameText = h6 ? h6.textContent.trim() : '';

    for (const leaf of leaves) {
      if (leaf.childElementCount > 0) continue;
      const txt = leaf.textContent.trim();
      if (!txt || txt.length < 1 || txt.length > 100) continue;
      if (txt === nameText) continue;

      // タイムスタンプ判定
      if (!timestamp) {
        if (txt === '昨日' || txt === '今日' ||
            /^\d{1,2}:\d{2}$/.test(txt) ||
            /^[月火水木金土日]曜日$/.test(txt) ||
            /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(txt) ||
            /^\d{1,2}\/\d{1,2}$/.test(txt)) {
          timestamp = txt;
          continue;
        }
      }

      // メッセージプレビュー（タイムスタンプでも名前でもない短い～中程度テキスト）
      if (!preview && txt.length > 3 && txt !== nameText) {
        preview = txt;
      }
    }
    return { timestamp, preview };
  }

  // 全 .list-group-item から名前一致するものを収集
  const items = el.querySelectorAll('.list-group-item');
  const candidates = [];

  for (const item of items) {
    if (item.getBoundingClientRect().height <= 0) continue;
    const h6 = item.querySelector('h6');
    if (!h6) continue;
    if (h6.textContent.trim() !== targetName) continue;

    const link = item.querySelector('a.d-flex') || item.querySelector('a[href="#"]');
    if (!link) continue;

    const info = _extractInfo(item);
    candidates.push({ item, link, ...info });
  }

  // a要素ベースのフォールバック（.list-group-itemがない場合）
  if (candidates.length === 0) {
    const links = el.querySelectorAll('a');
    for (const link of links) {
      const h6 = link.querySelector('h6');
      if (!h6 || h6.textContent.trim() !== targetName) continue;
      let container = link;
      for (let i = 0; i < 5; i++) {
        if (!container.parentElement || container.parentElement === el) break;
        container = container.parentElement;
      }
      const info = _extractInfo(container);
      candidates.push({ item: container, link, ...info });
    }
  }

  if (candidates.length === 0) return { notFound: true };

  // 1件だけなら従来通り
  if (candidates.length === 1) {
    const c = candidates[0];
    let container = c.link;
    for (let i = 0; i < 5; i++) {
      if (!container.parentElement || container.parentElement === el) break;
      container = container.parentElement;
    }
    if (_checkUnread(container)) return { hasUnread: true };
    c.link.click();
    return { clicked: true, matchedBy: 'single', timestamp: c.timestamp, preview: c.preview };
  }

  // 複数件 → hints でスコアリング
  const ts = hints?.timestamp || '昨日';
  const kw = hints?.messageKeyword || null;

  let bestIdx = -1;
  let bestScore = -1;
  const diag = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    let score = 0;
    if (c.timestamp === ts) score += 10;
    if (kw && c.preview && c.preview.includes(kw)) score += 5;
    diag.push(`[${i}] ts=${c.timestamp} preview=${(c.preview || '').substring(0, 30)} score=${score}`);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  // スコア0 = どれもヒントに合わない → multipleFound で返す（chatId fallbackに任せる）
  if (bestScore <= 0) {
    return { notFound: true, multipleFound: candidates.length, diag };
  }

  const best = candidates[bestIdx];
  let container = best.link;
  for (let i = 0; i < 5; i++) {
    if (!container.parentElement || container.parentElement === el) break;
    container = container.parentElement;
  }
  if (_checkUnread(container)) return { hasUnread: true };
  best.link.click();
  return {
    clicked: true,
    matchedBy: 'hints',
    index: bestIdx,
    total: candidates.length,
    timestamp: best.timestamp,
    preview: (best.preview || '').substring(0, 40),
    diag,
  };
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
