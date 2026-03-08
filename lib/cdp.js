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
 * チャットリストのスクロールコンテナを検出するJS式。
 * h6（ユーザー名）を含む最初のaタグから親を辿り、
 * scrollHeight > clientHeight + 50 の要素をスクロールコンテナとみなす。
 * フォールバック: div.flex-fill.overflow-y-auto
 */
const FIND_CHAT_SCROLL_EXPR = `(function() {
  // 方法1: チャットアイテムから親を辿って実際にスクロール可能な要素を見つける
  var h6 = document.querySelector('h6');
  if (h6) {
    var el = h6.closest('a');
    if (el) {
      var p = el.parentElement;
      for (var i = 0; i < 15 && p && p !== document.body; i++) {
        if (p.scrollHeight > p.clientHeight + 50) return p;
        p = p.parentElement;
      }
    }
  }
  // 方法2: overflow-y-auto で実際にスクロールできる要素
  var candidates = document.querySelectorAll('.overflow-y-auto, .overflow-auto');
  for (var j = 0; j < candidates.length; j++) {
    if (candidates[j].scrollHeight > candidates[j].clientHeight + 50) return candidates[j];
  }
  // フォールバック
  return document.querySelector('div.flex-fill.overflow-y-auto');
})()`;

/**
 * CDP mouseWheel経由でチャットリストをスクロール（isTrusted: true）
 * scrollTop直接変更では仮想スクロールが反応しないため、
 * ネイティブmouseWheelイベントで確実にトリガーする。
 */
export async function cdpScrollChatList(tabId, delta) {
  // 1. チャットリストのスクロールコンテナの中心座標を取得
  const posResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function() {
      var el = ${FIND_CHAT_SCROLL_EXPR};
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return {
        x: r.left + r.width / 2, y: r.top + r.height / 2,
        cls: (el.className || '').substring(0, 60),
        tag: el.tagName
      };
    })()`,
    returnByValue: true,
  });
  const pos = posResult?.result?.value;
  if (!pos) return null;

  // 2. ネイティブmouseWheelイベントを送信
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(pos.x), y: Math.round(pos.y),
    deltaX: 0, deltaY: delta,
  });

  // 3. スクロール位置を読み取って返す
  await new Promise(r => setTimeout(r, 100));
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function() {
      var el = ${FIND_CHAT_SCROLL_EXPR};
      if (!el) return null;
      return {
        scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
        cls: (el.className || '').substring(0, 60)
      };
    })()`,
    returnByValue: true,
  });
  return result?.result?.value;
}

/**
 * CDP mouseWheel経由でチャットリストを最上部にスクロール
 * 大きなdeltaYで一気に上にスクロールし、scrollTop=0を補助で設定
 */
export async function cdpScrollChatListToTop(tabId) {
  // チャットリストのスクロールコンテナの中心座標を取得
  const posResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function() {
      var el = ${FIND_CHAT_SCROLL_EXPR};
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
    returnByValue: true,
  });
  const pos = posResult?.result?.value;
  if (!pos) return false;

  // ネイティブmouseWheelで大きく上スクロール（3回）
  for (let i = 0; i < 3; i++) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(pos.x), y: Math.round(pos.y),
      deltaX: 0, deltaY: -100000,
    });
    await new Promise(r => setTimeout(r, 200));
  }

  // 補助: scrollTop = 0 を直接設定
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `(function() {
      var el = ${FIND_CHAT_SCROLL_EXPR};
      if (el) el.scrollTop = 0;
    })()`,
  });
  return true;
}

/**
 * 背面タブでもレンダリングを継続させるモード
 *
 * 問題: Chromeは背面/遮蔽タブでレイアウト更新・rAF・ペイントを停止するため、
 * scrollTop変更が効かず、仮想スクロールも動作しない。
 *
 * 対策: CDP Page.startScreencast でフレームキャプチャを強制開始する。
 * Chromeはスクリーンキャスト中、背面でもレンダリングパイプラインを
 * 完全に動作させる（layout, rAF, paint, compositing）。
 * 最小サイズ・最低品質で負荷を抑える。
 */
export async function cdpEnableBackgroundMode(tabId) {
  // screencastフレーム応答リスナーを設定（ackしないとChromeが停止する）
  if (!cdpEnableBackgroundMode._listenerSet) {
    cdpEnableBackgroundMode._listenerSet = true;
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (method === 'Page.screencastFrame') {
        try {
          chrome.debugger.sendCommand(source, 'Page.screencastFrameAck', {
            sessionId: params.sessionId,
          });
        } catch (_) {}
      }
    });
  }

  // スクリーンキャスト開始（最小サイズ・最低品質・低頻度）
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', {
      format: 'jpeg',
      quality: 1,
      maxWidth: 1,
      maxHeight: 1,
      everyNthFrame: 30,
    });
  } catch (_) {}

  // visibility API上書き（ページの自主スロットリング防止）
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(function(){
        if(window.__bgMode) return;
        window.__bgMode = true;
        Object.defineProperty(document, 'hidden', {get:function(){return false}, configurable:true});
        Object.defineProperty(document, 'visibilityState', {get:function(){return 'visible'}, configurable:true});
      })()`,
    });
  } catch (_) {}
}

/** 背面モードを停止 */
export async function cdpDisableBackgroundMode(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast');
  } catch (_) {}
}
