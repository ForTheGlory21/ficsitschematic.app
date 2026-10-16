// Saved factories: one record per factory (name, dates, stats, thumbnail, the plan itself) in IndexedDB, which
// has room for big plans; falls back to localStorage when IndexedDB is unavailable. Everything stays in this browser.
(function (SF) {
  const DB = 'sf-planner', STORE = 'factories';
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    if (!window.indexedDB) { rej(new Error('no IndexedDB')); return; }
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => { rq.result.createObjectStore(STORE, { keyPath: 'id' }); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error || new Error('IndexedDB blocked'));
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode), st = t.objectStore(STORE);
      const rq = fn(st);
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = () => rej(t.error);
    });
  };
  // localStorage fallback (small quota: fine for a handful of plans)
  const LS = 'sf-planner-factories';
  const lsAll = () => { try { return JSON.parse(localStorage.getItem(LS) || '[]'); } catch (_) { return []; } };
  const lsSave = list => { localStorage.setItem(LS, JSON.stringify(list)); };
  let useLS = false;
  const guard = async (idb, ls) => {
    if (!useLS) { try { return await idb(); } catch (_) { useLS = true; } }
    return ls();
  };

  SF.store = {
    // every record without its plan (cheap enough for the home grid), newest first
    async list() {
      const all = await guard(() => tx('readonly', st => st.getAll()), () => lsAll());
      return (all || []).map(({ doc, ...meta }) => meta).sort((a, b) => b.updated - a.updated);
    },
    get: id => guard(() => tx('readonly', st => st.get(id)), () => lsAll().find(r => r.id === id) || null),
    async put(rec) {
      return guard(() => tx('readwrite', st => st.put(rec)), () => {
        const list = lsAll().filter(r => r.id !== rec.id); list.push(rec); lsSave(list);
      });
    },
    del: id => guard(() => tx('readwrite', st => st.delete(id)), () => lsSave(lsAll().filter(r => r.id !== id))),
    persistent: () => !useLS,
  };
})(window.SF);
