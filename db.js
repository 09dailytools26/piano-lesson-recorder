/* db.js — IndexedDB操作 */
'use strict';

const DB_NAME = 'PianoLessonDB';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;

      // ITEMS
      if (!db.objectStoreNames.contains('items')) {
        const s = db.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('sort_order', 'sort_order', { unique: false });
      }
      // RECORDINGS
      if (!db.objectStoreNames.contains('recordings')) {
        const s = db.createObjectStore('recordings', { keyPath: 'id' });
        s.createIndex('lesson_date', 'lesson_date', { unique: false });
      }
      // AUDIO_BLOBS
      if (!db.objectStoreNames.contains('audio_blobs')) {
        db.createObjectStore('audio_blobs', { keyPath: 'key' });
      }
      // SEGMENTS
      if (!db.objectStoreNames.contains('segments')) {
        const s = db.createObjectStore('segments', { keyPath: 'id' });
        s.createIndex('recording_id', 'recording_id', { unique: false });
        s.createIndex('item_id', 'item_id', { unique: false });
      }
      // FAVORITES
      if (!db.objectStoreNames.contains('favorites')) {
        const s = db.createObjectStore('favorites', { keyPath: 'id' });
        s.createIndex('recording_id', 'recording_id', { unique: false });
      }
      // BAR_INDEX (将来実装用 — スキーマのみ定義)
      if (!db.objectStoreNames.contains('bar_index')) {
        const s = db.createObjectStore('bar_index', { keyPath: 'id' });
        s.createIndex('segment_id', 'segment_id', { unique: false });
        s.createIndex('bar_number', 'bar_number', { unique: false });
      }
    };

    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = e => reject(e.target.error);
  });
}

function uuid() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}

function tx(stores, mode = 'readonly') {
  return _db.transaction(stores, mode);
}

function promisifyRequest(req) {
  return new Promise((res, rej) => {
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

/* ---- ITEMS ---- */
const DB = {
  async getAllItems() {
    await openDB();
    return new Promise((res, rej) => {
      const t = tx('items');
      const index = t.objectStore('items').index('sort_order');
      const req = index.getAll();
      req.onsuccess = e => res(e.target.result);
      req.onerror = e => rej(e.target.error);
    });
  },

  async saveItem(item) {
    await openDB();
    if (!item.id) {
      item.id = uuid();
      item.created_at = new Date().toISOString();
    }
    const t = tx('items', 'readwrite');
    return promisifyRequest(t.objectStore('items').put(item));
  },

  async deleteItem(id) {
    await openDB();
    const t = tx('items', 'readwrite');
    return promisifyRequest(t.objectStore('items').delete(id));
  },

  /* ---- RECORDINGS ---- */
  async getAllRecordings() {
    await openDB();
    return new Promise((res, rej) => {
      const t = tx('recordings');
      const req = t.objectStore('recordings').getAll();
      req.onsuccess = e => {
        const arr = e.target.result;
        arr.sort((a, b) => b.lesson_date.localeCompare(a.lesson_date));
        res(arr);
      };
      req.onerror = e => rej(e.target.error);
    });
  },

  async getRecording(id) {
    await openDB();
    const t = tx('recordings');
    return promisifyRequest(t.objectStore('recordings').get(id));
  },

  async saveRecording(rec) {
    await openDB();
    if (!rec.id) {
      rec.id = uuid();
      rec.created_at = new Date().toISOString();
    }
    const t = tx('recordings', 'readwrite');
    return promisifyRequest(t.objectStore('recordings').put(rec));
  },

  async deleteRecording(id) {
    await openDB();
    // 関連データも一括削除
    const segments = await this.getSegmentsByRecording(id);
    const rec = await this.getRecording(id);
    const t = _db.transaction(['recordings', 'audio_blobs', 'segments', 'favorites'], 'readwrite');
    t.objectStore('recordings').delete(id);
    if (rec && rec.audio_blob_key) {
      t.objectStore('audio_blobs').delete(rec.audio_blob_key);
    }
    for (const seg of segments) {
      t.objectStore('segments').delete(seg.id);
    }
    return new Promise((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = e => rej(e.target.error);
    });
  },

  /* ---- AUDIO_BLOBS ---- */
  async saveAudioBlob(key, blob) {
    await openDB();
    const t = tx('audio_blobs', 'readwrite');
    return promisifyRequest(t.objectStore('audio_blobs').put({ key, blob }));
  },

  async getAudioBlob(key) {
    await openDB();
    const t = tx('audio_blobs');
    const result = await promisifyRequest(t.objectStore('audio_blobs').get(key));
    return result ? result.blob : null;
  },

  /* ---- SEGMENTS ---- */
  async getSegmentsByRecording(recordingId) {
    await openDB();
    return new Promise((res, rej) => {
      const t = tx('segments');
      const index = t.objectStore('segments').index('recording_id');
      const req = index.getAll(recordingId);
      req.onsuccess = e => res(e.target.result);
      req.onerror = e => rej(e.target.error);
    });
  },

  async getSegmentsByItem(itemId) {
    await openDB();
    return new Promise((res, rej) => {
      const t = tx('segments');
      const index = t.objectStore('segments').index('item_id');
      const req = index.getAll(itemId);
      req.onsuccess = e => res(e.target.result);
      req.onerror = e => rej(e.target.error);
    });
  },

  async saveSegment(seg) {
    await openDB();
    if (!seg.id) {
      seg.id = uuid();
      seg.created_at = new Date().toISOString();
    }
    const t = tx('segments', 'readwrite');
    return promisifyRequest(t.objectStore('segments').put(seg));
  },

  async updateSegmentLastPosition(segId, posSeconds) {
    await openDB();
    const t = tx('segments', 'readwrite');
    const store = t.objectStore('segments');
    return new Promise((res, rej) => {
      const req = store.get(segId);
      req.onsuccess = e => {
        const seg = e.target.result;
        if (seg) {
          seg.last_position_seconds = posSeconds;
          const put = store.put(seg);
          put.onsuccess = () => res();
          put.onerror = e2 => rej(e2.target.error);
        } else res();
      };
      req.onerror = e => rej(e.target.error);
    });
  },

  async updateRecordingLastPosition(recId, posSeconds) {
    await openDB();
    const t = tx('recordings', 'readwrite');
    const store = t.objectStore('recordings');
    return new Promise((res, rej) => {
      const req = store.get(recId);
      req.onsuccess = e => {
        const rec = e.target.result;
        if (rec) {
          rec.last_position_seconds = posSeconds;
          const put = store.put(rec);
          put.onsuccess = () => res();
          put.onerror = e2 => rej(e2.target.error);
        } else res();
      };
      req.onerror = e => rej(e.target.error);
    });
  },

  /* ---- FAVORITES ---- */
  async getAllFavorites() {
    await openDB();
    return new Promise((res, rej) => {
      const t = tx('favorites');
      const req = t.objectStore('favorites').getAll();
      req.onsuccess = e => {
        const arr = e.target.result;
        arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
        res(arr);
      };
      req.onerror = e => rej(e.target.error);
    });
  },

  async saveFavorite(fav) {
    await openDB();
    if (!fav.id) {
      fav.id = uuid();
      fav.created_at = new Date().toISOString();
    }
    const t = tx('favorites', 'readwrite');
    return promisifyRequest(t.objectStore('favorites').put(fav));
  },

  async deleteFavorite(id) {
    await openDB();
    const t = tx('favorites', 'readwrite');
    return promisifyRequest(t.objectStore('favorites').delete(id));
  },

  /* ---- 設定 (localStorageで軽量管理) ---- */
  getSettings() {
    try {
      return JSON.parse(localStorage.getItem('plr_settings') || '{}');
    } catch { return {}; }
  },

  saveSettings(s) {
    localStorage.setItem('plr_settings', JSON.stringify(s));
  }
};
