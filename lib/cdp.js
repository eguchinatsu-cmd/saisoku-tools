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
