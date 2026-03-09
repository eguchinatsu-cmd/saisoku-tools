// === 設定パネル ===
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const saveBtn = document.getElementById('saveSettings');
const settingsStatus = document.getElementById('settingsStatus');

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

// 設定読み込み
chrome.storage.sync.get(['kintoneApiToken', 'kintoneDomain', 'kintoneAppId', 'testChatId'], (s) => {
  if (s.kintoneApiToken) document.getElementById('apiToken').value = s.kintoneApiToken;
  if (s.kintoneDomain) document.getElementById('domain').value = s.kintoneDomain;
  if (s.kintoneAppId) document.getElementById('appId').value = s.kintoneAppId;
  if (s.testChatId) document.getElementById('testChatId').value = s.testChatId;
});

saveBtn.addEventListener('click', () => {
  chrome.storage.sync.set({
    kintoneApiToken: document.getElementById('apiToken').value,
    kintoneDomain: document.getElementById('domain').value,
    kintoneAppId: document.getElementById('appId').value,
    testChatId: document.getElementById('testChatId').value,
  }, () => {
    settingsStatus.textContent = '保存しました';
    setTimeout(() => { settingsStatus.textContent = ''; }, 2000);
  });
});

// === タスクボタン ===
const taskBtns = document.querySelectorAll('.task-btn');
const runAllBtn = document.getElementById('runAllBtn');
const logBox = document.getElementById('logBox');

function setAllDisabled(disabled) {
  taskBtns.forEach(b => b.disabled = disabled);
  runAllBtn.disabled = disabled;
  document.getElementById('testRunBtn').disabled = disabled;
}

function addLog(level, text, overrideTime) {
  const line = document.createElement('div');
  line.className = level;
  const time = overrideTime || new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = `[${time}] ${text}`;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

function updateStatus(task, text) {
  const el = document.getElementById(`status-${task}`);
  if (el) el.textContent = text;
}

function setButtonState(task, state) {
  const btn = document.querySelector(`.task-btn[data-task="${task}"]`);
  if (!btn) return;
  btn.classList.remove('running', 'done', 'error');
  if (state) btn.classList.add(state);
}

// ボタンクリック: 個別タスク
taskBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const task = btn.dataset.task;
    setAllDisabled(true);
    setButtonState(task, 'running');
    updateStatus(task, '処理中...');
    addLog('info', `${btn.textContent} 開始`);
    chrome.runtime.sendMessage({ type: 'run', task });
  });
});

// ボタンクリック: 全部実行
runAllBtn.addEventListener('click', () => {
  setAllDisabled(true);
  addLog('info', '=== 全部実行 開始 ===');
  chrome.runtime.sendMessage({ type: 'runAll' });
});

// ボタンクリック: テスト全実行
const testRunBtn = document.getElementById('testRunBtn');
testRunBtn.addEventListener('click', () => {
  chrome.storage.sync.get(['testChatId'], (s) => {
    if (!s.testChatId) {
      addLog('error', 'テスト送信先チャットIDが設定されていません。⚙設定で入力してください。');
      return;
    }
    setAllDisabled(true);
    addLog('info', '=== テスト全実行 開始（送信先: テストchat） ===');
    chrome.runtime.sendMessage({ type: 'runAll', testMode: true });
  });
});

// === メッセージ受信（background → popup） ===
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'log') {
    const prefix = msg.taskName ? `[${msg.taskName}] ` : '';
    const text = typeof msg.data === 'string' ? msg.data :
                 msg.data?.detail ? `(${msg.data.current}/${msg.data.total}) ${msg.data.detail}` :
                 JSON.stringify(msg.data);
    addLog(msg.level || 'info', prefix + text);
  }

  if (msg.type === 'taskStart') {
    setButtonState(msg.task, 'running');
    updateStatus(msg.task, '処理中...');
  }

  if (msg.type === 'complete') {
    const r = msg.result || {};
    if (r.error) {
      setButtonState(msg.task, 'error');
      updateStatus(msg.task, `エラー: ${r.error}`);
      addLog('error', `${msg.task}: ${r.error}`);
    } else {
      setButtonState(msg.task, 'done');
      const s = r.summary || {};
      const t = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      updateStatus(msg.task, `${t}完了 ${s.sent || 0}送信/${s.skipped || 0}スキップ`);
      addLog('success', `${msg.task}: ${s.sent || 0}件送信, ${s.skipped || 0}件スキップ, ${s.errors || 0}件エラー`);
    }
    setAllDisabled(false);
  }

  if (msg.type === 'completeAll') {
    setAllDisabled(false);
    addLog('success', '=== 全部実行 完了 ===');
  }
});

// === 起動時: 実行中かチェック + 当日の完了状態を復元 ===
chrome.runtime.sendMessage({ type: 'getStatus' }, (resp) => {
  if (resp?.isRunning && resp.currentTask) {
    setAllDisabled(true);
    setButtonState(resp.currentTask, 'running');
    updateStatus(resp.currentTask, '処理中...');
  }
});

// 当日の完了時刻を復元
{
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  chrome.storage.local.get('taskCompletions', (data) => {
    const completions = data.taskCompletions || {};
    if (completions._date !== dateKey) return; // 今日のデータでなければ無視
    for (const [task, info] of Object.entries(completions)) {
      if (task === '_date') continue;
      if (info.error) {
        updateStatus(task, `${info.time} エラー`);
        setButtonState(task, 'error');
      } else {
        const s = info.summary || {};
        updateStatus(task, `${info.time}完了 ${s.sent || 0}送信/${s.skipped || 0}スキップ`);
        setButtonState(task, 'done');
      }
    }
  });
}

// ログ履歴をbackgroundから取得して表示
chrome.runtime.sendMessage({ type: 'getLogs' }, (resp) => {
  if (!resp?.logs?.length) return;
  for (const entry of resp.logs) {
    const prefix = entry.taskName ? `[${entry.taskName}] ` : '';
    const text = typeof entry.data === 'string' ? entry.data :
                 entry.data?.detail ? `(${entry.data.current}/${entry.data.total}) ${entry.data.detail}` :
                 JSON.stringify(entry.data);
    // タイムスタンプがあれば元の時刻を使用
    const time = entry.timestamp
      ? new Date(entry.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : null;
    addLog(entry.level || 'info', prefix + text, time);
  }
});
