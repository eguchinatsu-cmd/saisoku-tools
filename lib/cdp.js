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
