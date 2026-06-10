/* app.js — ピアノレッスン録音アプリ メインロジック */
'use strict';

/* ======================================================
   状態管理
====================================================== */
const state = {
  // 録音
  recState: 'idle',       // 'idle' | 'recording'
  mediaRecorder: null,
  audioChunks: [],
  recStartTime: null,
  recTimerInterval: null,
  activeItemId: null,     // 現在録音中の項目ID
  currentSegmentStart: null, // 現在区間の開始時刻(Date)
  markers: [],            // [{itemId, startTime(Date)}]
  recStopTime: null,
  holdTimer: null,
  holdInterval: null,

  // 再生
  audioElement: null,
  currentRecording: null,
  currentSegment: null,   // 再生対象のセグメント（項目再生時）
  isPlaying: false,
  silenceSkip: false,
  seekUpdateInterval: null,
  favStartSec: null,
  favEndSec: null,

  // データ
  items: [],
  editingItemId: null,
  measureBarChecked: false,
};

/* ======================================================
   ユーティリティ
====================================================== */
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const week = ['日','月','火','水','木','金','土'];
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日(${week[d.getDay()]})`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function showToast(msg, dur = 2000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), dur);
}

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
function hideModal(id) { document.getElementById(id).classList.add('hidden'); }

/* ======================================================
   ページ遷移
====================================================== */
function initNavigation() {
  // タブ切替（1回だけ登録）
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  document.getElementById('btn-goto-play').addEventListener('click', async () => {
    showPage('page-play');
    await renderPlayPage();
  });
  document.getElementById('btn-goto-items').addEventListener('click', () => {
    renderItemsManage();
    showPage('page-items');
  });
  document.getElementById('btn-goto-settings').addEventListener('click', () => {
    renderSettings();
    showPage('page-settings');
  });
  document.getElementById('btn-back-play').addEventListener('click', () => showPage('page-home'));
  document.getElementById('btn-back-player').addEventListener('click', () => {
    stopAudio();
    showPage('page-play');
  });
  document.getElementById('btn-back-items').addEventListener('click', () => showPage('page-home'));
  document.getElementById('btn-back-settings').addEventListener('click', () => showPage('page-home'));
}

/* ======================================================
   録音機能
====================================================== */
function initRecording() {
  document.getElementById('btn-rec-start').addEventListener('click', startRecording);

  const endBtn = document.getElementById('btn-rec-end');
  // 長押し1.5秒で録音終了
  function onHoldStart(e) {
    e.preventDefault();
    let progress = 0;
    const progressEl = document.getElementById('rec-end-progress');
    state.holdInterval = setInterval(() => {
      progress += (50 / 1500) * 100;
      progressEl.style.width = Math.min(progress, 100) + '%';
    }, 50);
    state.holdTimer = setTimeout(() => {
      clearInterval(state.holdInterval);
      progressEl.style.width = '0%';
      stopRecording();
    }, 1500);
  }
  function onHoldEnd() {
    clearTimeout(state.holdTimer);
    clearInterval(state.holdInterval);
    document.getElementById('rec-end-progress').style.width = '0%';
  }
  endBtn.addEventListener('mousedown', onHoldStart);
  endBtn.addEventListener('touchstart', onHoldStart, { passive: false });
  endBtn.addEventListener('mouseup', onHoldEnd);
  endBtn.addEventListener('mouseleave', onHoldEnd);
  endBtn.addEventListener('touchend', onHoldEnd);
  endBtn.addEventListener('touchcancel', onHoldEnd);
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // 対応フォーマット選択（iOS Safari対応）
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';

    state.mediaRecorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    state.audioChunks = [];
    state.recStartTime = Date.now();
    state.markers = [];
    state.activeItemId = null;
    state.currentSegmentStart = null;

    state.mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) state.audioChunks.push(e.data);
    };
    state.mediaRecorder.onstop = onRecordingStopped;
    state.mediaRecorder.start(1000);

    state.recState = 'recording';
    updateRecordingUI();

    // タイマー開始
    state.recTimerInterval = setInterval(() => {
      const elapsed = (Date.now() - state.recStartTime) / 1000;
      document.getElementById('rec-timer').textContent = fmtTime(elapsed);
    }, 500);

  } catch (err) {
    console.error(err);
    if (err.name === 'NotAllowedError') {
      showToast('マイクの許可が必要です');
    } else {
      showToast('録音を開始できませんでした');
    }
  }
}

async function stopRecording() {
  if (!state.mediaRecorder || state.recState !== 'recording') return;
  // 終了時刻をここで確定（onstop発火前に最後の区間を閉じる）
  state.recStopTime = Date.now();
  state.mediaRecorder.stop();
  state.mediaRecorder.stream.getTracks().forEach(t => t.stop());
  clearInterval(state.recTimerInterval);
}

async function onRecordingStopped() {
  const stopTime = state.recStopTime || Date.now();
  const totalSec = (stopTime - state.recStartTime) / 1000;
  const blob = new Blob(state.audioChunks, {
    type: state.mediaRecorder.mimeType || 'audio/webm'
  });

  // 最後のセグメントを閉じる（stopRecordingで確定した時刻を使用）
  if (state.activeItemId && state.currentSegmentStart) {
    state.markers.push({
      itemId: state.activeItemId,
      startTime: state.currentSegmentStart,
      endTime: stopTime
    });
  }

  const blobKey = 'audio_' + Date.now();
  await DB.saveAudioBlob(blobKey, blob);

  const recId = 'rec_' + Date.now();
  const rec = {
    id: recId,
    lesson_date: todayStr(),
    audio_blob_key: blobKey,
    duration_seconds: totalSec,
    last_position_seconds: 0,
    created_at: new Date().toISOString()
  };
  await DB.saveRecording(rec);

  // セグメント保存
  for (let i = 0; i < state.markers.length; i++) {
    const m = state.markers[i];
    const startSec = (m.startTime - state.recStartTime) / 1000;
    const endSec = m.endTime ? (m.endTime - state.recStartTime) / 1000 : totalSec;
    await DB.saveSegment({
      recording_id: recId,
      item_id: m.itemId,
      start_seconds: startSec,
      end_seconds: endSec,
      last_position_seconds: 0
    });
  }

  state.recState = 'idle';
  state.activeItemId = null;
  state.currentSegmentStart = null;
  state.markers = [];

  updateRecordingUI();
  showToast('保存しました');
}

function updateRecordingUI() {
  const isRec = state.recState === 'recording';

  document.getElementById('rec-banner').classList.toggle('hidden', !isRec);
  document.getElementById('btn-rec-start').classList.toggle('hidden', isRec);
  // 録音終了ボタンは常時表示。録音中かどうかでスタイルだけ切替
  const endBtn = document.getElementById('btn-rec-end');
  endBtn.classList.toggle('btn-rec-end--idle', !isRec);
  endBtn.classList.toggle('btn-rec-end--active', isRec);

  // ナビボタン無効化
  ['btn-goto-play','btn-goto-items','btn-goto-settings'].forEach(id => {
    document.getElementById(id).classList.toggle('disabled', isRec);
  });

  if (!isRec) {
    document.getElementById('now-banner').classList.add('hidden');
  }

  renderHomeItems();
}

/* ======================================================
   項目ボタン（ホーム）
====================================================== */
function renderHomeItems() {
  const list = document.getElementById('items-list');
  list.innerHTML = '';

  // ⑤ 曲目未登録時はサンプルを薄い色で表示（データ登録はしない）
  if (state.items.length === 0 && state.recState !== 'recording') {
    const samples = ['ハノン', 'ピアノテクニック', 'ブルグミュラー', '発表会曲'];
    samples.forEach(name => {
      const btn = document.createElement('button');
      btn.className = 'item-btn item-btn--sample';
      btn.disabled = true;
      btn.innerHTML = `
        <span class="item-icon"><svg viewBox="0 0 24 24" fill="currentColor" style="opacity:0.2"><circle cx="12" cy="12" r="8"/></svg></span>
        <span class="item-name">${name}</span>
      `;
      list.appendChild(btn);
    });
    return;
  }

  state.items.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'item-btn';
    btn.dataset.id = item.id;

    const iconEl = document.createElement('span');
    iconEl.className = 'item-icon';

    const nameEl = document.createElement('span');
    nameEl.className = 'item-name';
    nameEl.textContent = item.name;

    if (state.recState === 'recording') {
      if (item.id === state.activeItemId) {
        btn.classList.add('active');
        iconEl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
      } else if (state.markers.some(m => m.itemId === item.id)) {
        btn.classList.add('done');
        iconEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
      } else {
        iconEl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" style="opacity:0.25"><circle cx="12" cy="12" r="8"/></svg>';
      }
      btn.addEventListener('click', () => tapItemButton(item.id));
    } else {
      iconEl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" style="opacity:0.2"><circle cx="12" cy="12" r="8"/></svg>';
    }

    btn.appendChild(iconEl);
    btn.appendChild(nameEl);
    list.appendChild(btn);
  });
}

function tapItemButton(itemId) {
  if (state.recState !== 'recording') return;

  // 同一項目の連続タップ無視
  if (itemId === state.activeItemId) {
    const btn = document.querySelector(`.item-btn[data-id="${itemId}"]`);
    if (btn) {
      btn.classList.add('item-btn-shake');
      setTimeout(() => btn.classList.remove('item-btn-shake'), 350);
    }
    return;
  }

  const now = Date.now();

  // 前の区間を閉じる
  if (state.activeItemId && state.currentSegmentStart) {
    state.markers.push({
      itemId: state.activeItemId,
      startTime: state.currentSegmentStart,
      endTime: now
    });
  }

  // 新しい区間を開始
  state.activeItemId = itemId;
  state.currentSegmentStart = now;

  // いま練習中バナー更新
  const elapsed = (now - state.recStartTime) / 1000;
  const item = state.items.find(i => i.id === itemId);
  document.getElementById('now-banner-name').textContent = item ? item.name : '';
  document.getElementById('now-banner-since').textContent = fmtTime(elapsed) + ' から';
  document.getElementById('now-banner').classList.remove('hidden');

  renderHomeItems();
}

/* ======================================================
   再生画面
====================================================== */
async function renderPlayPage() {
  const recordings = await DB.getAllRecordings();
  const items = state.items;

  // 録音日タブ
  const datePane = document.getElementById('tab-date');
  datePane.innerHTML = '';

  if (recordings.length === 0) {
    datePane.innerHTML = '<div class="empty-state">録音がまだありません</div>';
  } else {
    // 削除ツールバー
    const toolbar = document.createElement('div');
    toolbar.className = 'delete-toolbar';
    toolbar.innerHTML = `
      <span class="delete-toolbar-count" id="delete-count">0件選択中</span>
      <button class="delete-toolbar-btn" id="btn-delete-selected" disabled aria-label="選択した録音を削除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
        削除
      </button>
    `;
    datePane.appendChild(toolbar);

    const selectedIds = new Set();

    function updateToolbar() {
      const count = selectedIds.size;
      document.getElementById('delete-count').textContent = count + '件選択中';
      const btn = document.getElementById('btn-delete-selected');
      btn.disabled = count === 0;
    }

    for (const rec of recordings) {
      const segs = await DB.getSegmentsByRecording(rec.id);
      const itemNames = [...new Set(
        segs.map(s => items.find(i => i.id === s.item_id)?.name).filter(Boolean)
      )].join('・');

      const row = document.createElement('div');
      row.className = 'list-item';
      row.dataset.recId = rec.id;
      row.innerHTML = `
        <label class="rec-checkbox" onclick="event.stopPropagation()">
          <input type="checkbox" class="rec-check-input" data-id="${rec.id}" aria-label="${fmtDate(rec.lesson_date)}を選択">
          <span class="rec-check-box"></span>
        </label>
        <div class="list-item-main">
          <div class="list-item-title">${fmtDate(rec.lesson_date)}</div>
          <div class="list-item-sub">${itemNames || '（項目なし）'} · ${fmtTime(rec.duration_seconds)}</div>
        </div>
        <span class="list-item-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></span>
      `;

      const checkbox = row.querySelector('.rec-check-input');
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedIds.add(rec.id);
          row.classList.add('selected');
        } else {
          selectedIds.delete(rec.id);
          row.classList.remove('selected');
        }
        updateToolbar();
      });

      // チェックボックス以外のタップで再生
      row.addEventListener('click', (e) => {
        if (e.target.closest('.rec-checkbox')) return;
        openPlayer(rec, null, 'date');
      });

      datePane.appendChild(row);
    }

    // 削除ボタンのイベント登録
    document.getElementById('btn-delete-selected').addEventListener('click', async () => {
      if (selectedIds.size === 0) return;
      const count = selectedIds.size;
      document.getElementById('confirm-title').textContent = '録音を削除';
      document.getElementById('confirm-msg').textContent =
        '選択した' + count + '件の録音を削除しますか？\n関連する区間・お気に入りデータも削除されます。';
      showModal('modal-confirm');
      const okBtn = document.getElementById('btn-confirm-ok');
      const cancelBtn = document.getElementById('btn-confirm-cancel');
      const cleanup = () => {
        hideModal('modal-confirm');
        okBtn.onclick = null;
        cancelBtn.onclick = null;
      };
      okBtn.onclick = async () => {
        cleanup();
        for (const id of selectedIds) {
          await DB.deleteRecording(id);
        }
        showToast(count + '件の録音を削除しました');
        await renderPlayPage();  // 全タブ（録音日・曲目・お気に入り）を再描画
      };
      cancelBtn.onclick = cleanup;
    });
  }

  // 項目タブ
  const itemPane = document.getElementById('tab-item');
  itemPane.innerHTML = '';
  for (const item of items) {
    const segs = await DB.getSegmentsByItem(item.id);
    if (segs.length === 0) continue;
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `
      <div class="list-item-main">
        <div class="list-item-title">${item.name}</div>
        <div class="list-item-sub">${segs.length}件の録音</div>
      </div>
      <span class="list-item-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></span>
    `;
    row.addEventListener('click', () => openItemHistory(item));
    itemPane.appendChild(row);
  }
  if (itemPane.children.length === 0) {
    itemPane.innerHTML = '<div class="empty-state">録音がまだありません</div>';
  }

  // お気に入りタブ
  await renderFavTab();

}

async function renderFavTab() {
  const favPane = document.getElementById('tab-fav');
  const favs = await DB.getAllFavorites();
  favPane.innerHTML = '';
  if (favs.length === 0) {
    favPane.innerHTML = '<div class="empty-state">お気に入りはまだありません<br>再生中に★ボタンで登録できます</div>';
    return;
  }
  for (const fav of favs) {
    const rec = await DB.getRecording(fav.recording_id);
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `
      <div class="list-item-main">
        <div class="list-item-title">${fav.title}</div>
        <div class="list-item-sub">${rec ? fmtDate(rec.lesson_date) : ''} · ${fmtTime(fav.start_seconds)}〜${fmtTime(fav.end_seconds)}</div>
      </div>
      <span class="list-item-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></span>
    `;
    row.addEventListener('click', () => {
      if (rec) openPlayer(rec, null, 'fav', fav.start_seconds, fav.end_seconds);
    });
    // 長押しで削除
    let delTimer;
    row.addEventListener('touchstart', () => {
      delTimer = setTimeout(() => confirmDeleteFav(fav.id), 700);
    }, { passive: true });
    row.addEventListener('touchend', () => clearTimeout(delTimer));
    row.addEventListener('touchcancel', () => clearTimeout(delTimer));
    favPane.appendChild(row);
  }
}

async function openItemHistory(item) {
  const itemPane = document.getElementById('tab-item');
  itemPane.innerHTML = '';

  // 戻るヘッダー
  const header = document.createElement('div');
  header.className = 'section-header';
  header.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>${item.name}`;
  header.addEventListener('click', () => renderPlayPage());
  itemPane.appendChild(header);

  // DBから最新のセグメントを毎回取得（続きから再生の位置が正しく反映される）
  const segs = await DB.getSegmentsByItem(item.id);
  if (segs.length === 0) {
    itemPane.innerHTML += '<div class="empty-state">録音がまだありません</div>';
    return;
  }

  // recording_id ごとにグループ化
  const recIds = [...new Set(segs.map(s => s.recording_id))];
  const recsWithDate = [];
  for (const recId of recIds) {
    const rec = await DB.getRecording(recId);
    if (!rec) continue;
    const recSegs = segs.filter(s => s.recording_id === recId);
    recsWithDate.push({ rec, recSegs });
  }
  // 新しい日付順にソート
  recsWithDate.sort((a, b) => b.rec.lesson_date.localeCompare(a.rec.lesson_date));

  for (const { rec, recSegs } of recsWithDate) {
    for (const seg of recSegs) {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `
        <div class="list-item-main">
          <div class="list-item-title">${fmtDate(rec.lesson_date)}</div>
          <div class="list-item-sub">${fmtTime(seg.start_seconds)}〜${fmtTime(seg.end_seconds)}</div>
        </div>
        <span class="list-item-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></span>
      `;
      // タップごとにDBから最新segを取得してopenPlayerに渡す
      row.addEventListener('click', async () => {
        const freshSegs = await DB.getSegmentsByItem(item.id);
        const freshSeg = freshSegs.find(s => s.id === seg.id) || seg;
        openPlayer(rec, freshSeg, 'item');
      });
      itemPane.appendChild(row);
    }
  }
}

/* ======================================================
   プレーヤー
====================================================== */
async function openPlayer(rec, seg, fromType, favStart, favEnd) {
  state.currentRecording = rec;
  state.currentSegment = seg || null;
  state.favStartSec = null;
  state.favEndSec = null;

  const blob = await DB.getAudioBlob(rec.audio_blob_key);
  if (!blob) { showToast('音声データが見つかりません'); return; }

  stopAudio();

  const url = URL.createObjectURL(blob);
  state.audioElement = new Audio(url);
  state.audioElement.playbackRate = parseFloat(
    document.querySelector('.speed-btn.active')?.dataset.speed || '1'
  );

  // 再生範囲の計算
  const rangeStart = seg ? seg.start_seconds : (favStart ?? 0);
  const rangeEnd = seg ? seg.end_seconds : (favEnd ?? rec.duration_seconds);

  document.getElementById('player-header-title').textContent = fmtDate(rec.lesson_date);
  document.getElementById('player-item-name').textContent = seg
    ? (state.items.find(i => i.id === seg.item_id)?.name || '')
    : (fromType === 'fav' ? '（お気に入り）' : '録音全体');
  document.getElementById('player-date').textContent = fmtDate(rec.lesson_date);
  document.getElementById('seek-dur').textContent = fmtTime(rangeEnd - rangeStart);
  document.getElementById('play-icon').innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
  state.isPlaying = false;

  showPage('page-player');

  // デバッグログ：SEGMENTSの実データと再生範囲を出力
  console.log('[openPlayer] fromType:', fromType);
  console.log('[openPlayer] seg:', seg ? { id: seg.id, start_seconds: seg.start_seconds, end_seconds: seg.end_seconds, last_position_seconds: seg.last_position_seconds } : null);
  console.log('[openPlayer] rangeStart:', rangeStart, '/ rangeEnd:', rangeEnd);

  // 続きから再生の判定
  const lastPos = seg
    ? (seg.last_position_seconds || 0)
    : (rec.last_position_seconds || 0);

  console.log('[openPlayer] lastPos:', lastPos);

  // canplayイベント後にシーク（iOS Safari対応：未ロード状態でのcurrentTime設定を防ぐ）
  const seekAndPlay = (seekTo) => {
    console.log('[openPlayer] seekTo（audio.currentTime設定値）:', seekTo);
    const doSeek = () => {
      state.audioElement.currentTime = seekTo;
      updateSeekDisplay(seekTo, rangeStart, rangeEnd);
      playAudio();
    };
    if (state.audioElement.readyState >= 2) {
      // 既にロード済みならすぐシーク
      doSeek();
    } else {
      // ロード待ちしてからシーク
      state.audioElement.addEventListener('canplay', doSeek, { once: true });
    }
  };

  if (lastPos > rangeStart + 3 && lastPos < rangeEnd - 3) {
    const toast = document.getElementById('resume-toast');
    document.getElementById('resume-toast-msg').textContent =
      `前回 ${fmtTime(lastPos - rangeStart)} まで再生しました`;
    toast.classList.remove('hidden');

    document.getElementById('btn-resume-yes').onclick = () => {
      toast.classList.add('hidden');
      seekAndPlay(lastPos);
    };
    document.getElementById('btn-resume-no').onclick = () => {
      toast.classList.add('hidden');
      seekAndPlay(rangeStart);
    };
  } else {
    document.getElementById('resume-toast').classList.add('hidden');
    seekAndPlay(rangeStart);
  }

  // シークバー更新
  state.seekUpdateInterval = setInterval(() => {
    if (!state.audioElement) return;
    const cur = state.audioElement.currentTime;
    updateSeekDisplay(cur, rangeStart, rangeEnd);

    // 区間終了で停止
    if (cur >= rangeEnd - 0.5) {
      state.audioElement.pause();
      state.isPlaying = false;
      document.getElementById('play-icon').innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
      clearInterval(state.seekUpdateInterval);
    }
  }, 500);

  // 停止時に位置を保存
  state.audioElement.onpause = async () => {
    const cur = state.audioElement.currentTime;
    if (seg) {
      await DB.updateSegmentLastPosition(seg.id, cur);
    } else {
      await DB.updateRecordingLastPosition(rec.id, cur);
    }
  };

  state._rangeStart = rangeStart;
  state._rangeEnd = rangeEnd;
}

function updateSeekDisplay(cur, rangeStart, rangeEnd) {
  const rel = cur - rangeStart;
  const total = rangeEnd - rangeStart;
  document.getElementById('seek-cur').textContent = fmtTime(Math.max(0, rel));
  const pct = total > 0 ? Math.min(1000, Math.round((rel / total) * 1000)) : 0;
  document.getElementById('seek-bar').value = pct;
}

function playAudio() {
  if (!state.audioElement) return;
  state.audioElement.play().catch(e => console.error(e));
  state.isPlaying = true;
  document.getElementById('play-icon').innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
}

function stopAudio() {
  if (state.audioElement) {
    state.audioElement.pause();
    state.audioElement.src = '';
    state.audioElement = null;
  }
  clearInterval(state.seekUpdateInterval);
  state.isPlaying = false;
}

function initPlayer() {
  document.getElementById('btn-play').addEventListener('click', () => {
    if (!state.audioElement) return;
    if (state.isPlaying) {
      state.audioElement.pause();
      state.isPlaying = false;
      document.getElementById('play-icon').innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
    } else {
      playAudio();
    }
  });

  document.getElementById('seek-bar').addEventListener('input', e => {
    if (!state.audioElement) return;
    const pct = e.target.value / 1000;
    const rangeStart = state._rangeStart || 0;
    const rangeEnd = state._rangeEnd || state.currentRecording?.duration_seconds || 0;
    const newTime = rangeStart + pct * (rangeEnd - rangeStart);
    state.audioElement.currentTime = newTime;
    updateSeekDisplay(newTime, rangeStart, rangeEnd);
  });

  [
    ['btn-skip-m30', -30], ['btn-skip-m10', -10],
    ['btn-skip-p10', 10], ['btn-skip-p30', 30]
  ].forEach(([id, sec]) => {
    document.getElementById(id).addEventListener('click', () => {
      if (!state.audioElement) return;
      const rangeStart = state._rangeStart || 0;
      const rangeEnd = state._rangeEnd || 0;
      const newTime = Math.max(rangeStart, Math.min(rangeEnd, state.audioElement.currentTime + sec));
      state.audioElement.currentTime = newTime;
      updateSeekDisplay(newTime, rangeStart, rangeEnd);
    });
  });

  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (state.audioElement) state.audioElement.playbackRate = parseFloat(btn.dataset.speed);
    });
  });

  document.getElementById('silence-toggle').addEventListener('click', () => {
    const tog = document.getElementById('silence-toggle');
    state.silenceSkip = !state.silenceSkip;
    tog.classList.toggle('on', state.silenceSkip);
  });

  initFavoriteModal();
}

/* ======================================================
   お気に入り機能
====================================================== */
function initFavoriteModal() {
  document.getElementById('btn-add-fav').addEventListener('click', () => {
    document.getElementById('fav-title-input').value = '';
    document.getElementById('fav-start-label').textContent = '開始位置を設定';
    document.getElementById('fav-end-label').textContent = '終了位置を設定';
    document.getElementById('btn-fav-start').classList.remove('set');
    document.getElementById('btn-fav-end').classList.remove('set');
    state.favStartSec = null;
    state.favEndSec = null;
    showModal('modal-fav');
  });

  document.getElementById('modal-fav-close').addEventListener('click', () => hideModal('modal-fav'));

  document.getElementById('btn-fav-start').addEventListener('click', () => {
    if (!state.audioElement) return;
    state.favStartSec = state.audioElement.currentTime;
    document.getElementById('fav-start-label').textContent = '開始: ' + fmtTime(state.favStartSec);
    document.getElementById('btn-fav-start').classList.add('set');
  });

  document.getElementById('btn-fav-end').addEventListener('click', () => {
    if (!state.audioElement) return;
    state.favEndSec = state.audioElement.currentTime;
    document.getElementById('fav-end-label').textContent = '終了: ' + fmtTime(state.favEndSec);
    document.getElementById('btn-fav-end').classList.add('set');
  });

  document.getElementById('btn-save-fav').addEventListener('click', async () => {
    const title = document.getElementById('fav-title-input').value.trim();
    if (!title) { showToast('タイトルを入力してください'); return; }
    if (state.favStartSec === null) { showToast('開始位置を設定してください'); return; }
    if (state.favEndSec === null) { showToast('終了位置を設定してください'); return; }
    if (state.favEndSec <= state.favStartSec) { showToast('終了位置は開始より後にしてください'); return; }

    await DB.saveFavorite({
      recording_id: state.currentRecording.id,
      title,
      start_seconds: state.favStartSec,
      end_seconds: state.favEndSec
    });
    hideModal('modal-fav');
    showToast('お気に入りに保存しました');
  });
}

async function confirmDeleteFav(id) {
  return new Promise(resolve => {
    document.getElementById('confirm-title').textContent = 'お気に入りを削除';
    document.getElementById('confirm-msg').textContent = 'このお気に入りを削除しますか？';
    showModal('modal-confirm');
    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');
    const cleanup = () => { hideModal('modal-confirm'); okBtn.onclick = null; cancelBtn.onclick = null; };
    okBtn.onclick = async () => {
      await DB.deleteFavorite(id);
      cleanup();
      renderFavTab();
      showToast('削除しました');
      resolve(true);
    };
    cancelBtn.onclick = () => { cleanup(); resolve(false); };
  });
}

/* ======================================================
   項目管理機能
====================================================== */
async function loadItems() {
  state.items = await DB.getAllItems();
  // 初回デフォルト項目
  if (state.items.length === 0) {
    const defaults = ['ハノン', 'ピアノテクニック', 'ブルグミュラー', '発表会曲'];
    for (let i = 0; i < defaults.length; i++) {
      await DB.saveItem({ name: defaults[i], measure_bar: false, sort_order: i });
    }
    state.items = await DB.getAllItems();
  }
}

function renderItemsManage() {
  const list = document.getElementById('items-manage-list');
  list.innerHTML = '';
  state.items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'manage-item';
    row.innerHTML = `
      <span class="drag-handle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/></svg></span>
      <div class="manage-item-main">
        <div class="manage-item-name">${item.name}</div>
        <span class="manage-item-badge ${item.measure_bar ? 'badge-bar' : 'badge-nobar'}">${item.measure_bar ? '小節管理ON' : '小節管理OFF'}</span>
      </div>
      <button class="edit-btn" aria-label="編集">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
    `;
    row.querySelector('.edit-btn').addEventListener('click', () => openItemModal(item));
    list.appendChild(row);
  });
}

function openItemModal(item = null) {
  state.editingItemId = item ? item.id : null;
  state.measureBarChecked = item ? item.measure_bar : false;

  document.getElementById('modal-item-title').textContent = item ? '項目を編集' : '項目を追加';
  document.getElementById('item-name-input').value = item ? item.name : '';
  document.getElementById('measure-bar-box').classList.toggle('checked', state.measureBarChecked);
  document.getElementById('btn-delete-item').classList.toggle('hidden', !item);
  showModal('modal-item');
}

function initItemModal() {
  document.getElementById('btn-add-item').addEventListener('click', () => openItemModal());

  document.getElementById('modal-item-close').addEventListener('click', () => hideModal('modal-item'));

  document.getElementById('measure-bar-check').addEventListener('click', () => {
    state.measureBarChecked = !state.measureBarChecked;
    document.getElementById('measure-bar-box').classList.toggle('checked', state.measureBarChecked);
  });

  document.getElementById('btn-save-item').addEventListener('click', async () => {
    const name = document.getElementById('item-name-input').value.trim();
    if (!name) { showToast('項目名を入力してください'); return; }

    if (state.editingItemId) {
      const item = state.items.find(i => i.id === state.editingItemId);
      item.name = name;
      item.measure_bar = state.measureBarChecked;
      await DB.saveItem(item);
    } else {
      const maxOrder = state.items.reduce((m, i) => Math.max(m, i.sort_order || 0), -1);
      await DB.saveItem({ name, measure_bar: state.measureBarChecked, sort_order: maxOrder + 1 });
    }

    state.items = await DB.getAllItems();
    hideModal('modal-item');
    renderItemsManage();
    renderHomeItems();
    showToast(state.editingItemId ? '保存しました' : '追加しました');
  });

  document.getElementById('btn-delete-item').addEventListener('click', async () => {
    if (!state.editingItemId) return;
    document.getElementById('confirm-title').textContent = '項目を削除';
    document.getElementById('confirm-msg').textContent = 'この項目を削除しますか？\n録音データは残ります。';
    hideModal('modal-item');
    showModal('modal-confirm');
    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');
    const cleanup = () => { hideModal('modal-confirm'); okBtn.onclick = null; cancelBtn.onclick = null; };
    okBtn.onclick = async () => {
      await DB.deleteItem(state.editingItemId);
      state.items = await DB.getAllItems();
      cleanup();
      renderItemsManage();
      renderHomeItems();
      showToast('削除しました');
    };
    cancelBtn.onclick = cleanup;
  });
}

/* ======================================================
   設定
====================================================== */
function renderSettings() {
  const s = DB.getSettings();
  document.getElementById('settings-silence-toggle').classList.toggle('on', !!s.silenceSkip);
  document.getElementById('settings-speed').value = s.defaultSpeed || '1';
}

function initSettings() {
  document.getElementById('settings-silence-toggle').addEventListener('click', () => {
    const tog = document.getElementById('settings-silence-toggle');
    const s = DB.getSettings();
    s.silenceSkip = !s.silenceSkip;
    tog.classList.toggle('on', s.silenceSkip);
    DB.saveSettings(s);
  });
  document.getElementById('settings-speed').addEventListener('change', e => {
    const s = DB.getSettings();
    s.defaultSpeed = e.target.value;
    DB.saveSettings(s);
  });
  document.getElementById('btn-manage-data').addEventListener('click', () => {
    showToast('録音データはデータ管理から削除できます（将来実装）');
  });
}

/* ======================================================
   起動
====================================================== */
async function init() {
  await loadItems();
  renderHomeItems();
  initNavigation();
  initRecording();
  initPlayer();
  initItemModal();
  initSettings();
}

document.addEventListener('DOMContentLoaded', init);
