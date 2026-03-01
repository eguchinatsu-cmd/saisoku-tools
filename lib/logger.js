/**
 * ロガー: console + popup へリアルタイム中継 + chrome.storage.local に永続化
 */

// メモリ上のログバッファ（background service worker内で保持）
const _logBuffer = [];
const MAX_LOG_ENTRIES = 500;

export function getLogBuffer() {
  return _logBuffer;
}

export function clearLogBuffer() {
  _logBuffer.length = 0;
  chrome.storage.local.set({ saisokuLogs: [] }).catch(() => {});
}

/** 起動時にストレージからログを復元 */
export async function restoreLogBuffer() {
  try {
    const { saisokuLogs } = await chrome.storage.local.get('saisokuLogs');
    if (Array.isArray(saisokuLogs)) {
      _logBuffer.push(...saisokuLogs);
    }
  } catch (_) {}
}

function persistLogs() {
  chrome.storage.local.set({ saisokuLogs: _logBuffer.slice(-MAX_LOG_ENTRIES) }).catch(() => {});
}

export function createLogger(taskName) {
  function send(level, data) {
    const msg = typeof data === 'string' ? data : JSON.stringify(data);
    console.log(`[${taskName}] [${level}] ${msg}`);

    const entry = {
      type: 'log',
      level,
      taskName,
      data,
      timestamp: Date.now(),
    };

    // メモリバッファに追加
    _logBuffer.push(entry);
    if (_logBuffer.length > MAX_LOG_ENTRIES) _logBuffer.splice(0, _logBuffer.length - MAX_LOG_ENTRIES);

    // ストレージに永続化（非同期、失敗OK）
    persistLogs();

    // popupへリアルタイム中継
    chrome.runtime.sendMessage(entry).catch(() => {});
  }
  return {
    info:     (msg) => send('info', msg),
    success:  (msg) => send('success', msg),
    error:    (msg) => send('error', msg),
    progress: (current, total, detail) => send('progress', { current, total, detail }),
  };
}
