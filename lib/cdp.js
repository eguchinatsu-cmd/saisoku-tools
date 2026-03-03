/**
 * Chrome DevTools Protocol (CDP) ヘルパー
 * isTrusted:true のクリック・スクロール・入力を提供
 */

export async function attachDebugger(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
}

export async function detachDebugger(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

export async function cdpClick(tabId, x, y) {
  const rx = Math.round(x);
  const ry = Math.round(y);
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: rx, y: ry, button: 'left', clickCount: 1,
  });
  await new Promise(r => setTimeout(r, 50));
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: rx, y: ry, button: 'left', clickCount: 1,
  });
}

export async function cdpScroll(tabId, x, y, deltaY = 800) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(x), y: Math.round(y),
    deltaX: 0, deltaY,
  });
}

/** Ctrl+A で全選択 */
export async function cdpSelectAll(tabId) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    modifiers: 2, // Ctrl
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
    modifiers: 2,
  });
}

/** CDP insertText でテキスト入力（isTrusted: true） */
export async function cdpType(tabId, text) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
}

/**
 * CDP Runtime.evaluate経由でチャットリストをスクロール
 * chrome.scripting.executeScript(execMain)はバックグラウンドタブで
 * scrollTop変更が効かない場合があるため、CDPデバッガー経由で実行する。
 * デバッガーがアタッチされている間はタブの凍結が防止される。
 */
export async function cdpScrollChatList(tabId, delta) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function() {
      var el = document.querySelector('div.flex-fill.overflow-y-auto');
      if (!el) return null;
      var before = el.scrollTop;
      el.scrollTop += ${delta};
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, moved: el.scrollTop !== before };
    })()`,
    returnByValue: true,
  });
  return result?.result?.value;
}

/**
 * CDP Runtime.evaluate経由でチャットリストを最上部にスクロール
 */
export async function cdpScrollChatListToTop(tabId) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function() {
      var el = document.querySelector('div.flex-fill.overflow-y-auto');
      if (el) { el.scrollTop = 0; return true; }
      return false;
    })()`,
    returnByValue: true,
  });
  return result?.result?.value;
}

/**
 * 背面タブでもレンダリングを継続させるモード
 *
 * 問題: Chromeは背面タブでrequestAnimationFrameを停止するため、
 * LINE Chatの仮想スクロールが新しいアイテムをレンダリングしない。
 *
 * 対策:
 * 1. Page.setWebLifecycleState で強制active化
 * 2. rAFにsetTimeoutフォールバックを注入（rAFが停止してもsetTimeoutで代替実行）
 * 3. document.hidden / visibilityState を上書き（ページ側の自主的なスロットリングを防止）
 */
export async function cdpEnableBackgroundMode(tabId) {
  // CDP: ページライフサイクルを強制active化（frozen/hidden防止）
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.setWebLifecycleState', { state: 'active' });
  } catch (_) {}

  // ページ内にrAFパッチ + visibility上書きを注入
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function(){
      if(window.__bgMode) return;
      window.__bgMode = true;

      // rAFパッチ: rAFとsetTimeoutを両方スケジュールし、先に発火した方で実行
      var _raf = window.requestAnimationFrame;
      var _caf = window.cancelAnimationFrame;
      var pending = new Map();
      var nextId = 9000000;

      window.requestAnimationFrame = function(cb) {
        var id = ++nextId;
        var done = false;
        var rafId = _raf(function(ts) {
          if (!done) { done = true; pending.delete(id); cb(ts); }
        });
        var tid = setTimeout(function() {
          if (!done) { done = true; pending.delete(id); _caf(rafId); cb(performance.now()); }
        }, 32);
        pending.set(id, function() { done = true; _caf(rafId); clearTimeout(tid); });
        return id;
      };

      window.cancelAnimationFrame = function(id) {
        var cancel = pending.get(id);
        if (cancel) { cancel(); pending.delete(id); } else { _caf(id); }
      };

      // visibility API上書き（ページの自主スロットリング防止）
      Object.defineProperty(document, 'hidden', {get:function(){return false}, configurable:true});
      Object.defineProperty(document, 'visibilityState', {get:function(){return 'visible'}, configurable:true});
    })()`,
  });
}
