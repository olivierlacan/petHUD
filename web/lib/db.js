// IndexedDB persistence for the backend-free build. Two stores, both keyed by
// the file's SHA-256 (so re-importing the same PDF replaces it, like the Ruby
// pipeline's idempotent import):
//   pdfs    { sha256, filename, blob, importedAt }  — originals, for reprocessing
//   reports { sha256, reportDoc, patientSlug }      — parsed per-report documents
//
// On load the app reads all report docs and rebuilds the payload in memory
// (aggregate.js); nothing else persists.

const DB_NAME = "pethud";
const LEGACY_DB_NAME = "indexx"; // pre-rename database; migrated once, then left as a backup
const DB_VERSION = 2;
const STORES = ["pdfs", "reports", "settings"];

let dbPromise = null;

// Open DB_NAME, creating the object stores on first use (or version bump).
function openWithStores(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("pdfs")) db.createObjectStore("pdfs", { keyPath: "sha256" });
      if (!db.objectStoreNames.contains("reports")) db.createObjectStore("reports", { keyPath: "sha256" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// One-time copy of the pre-rename "indexx" database into "pethud" (PDFs, parsed
// reports, journal, patient aliases, theme — everything). Non-destructive: the
// legacy DB is left untouched as a safety net. No-op for fresh installs.
async function migrateLegacy() {
  if (typeof indexedDB === "undefined") return;
  // Where supported, databases() lets us leave brand-new installs entirely alone.
  if (indexedDB.databases) {
    let names = [];
    try { names = (await indexedDB.databases()).map((d) => d.name); } catch (e) { return; }
    if (!names.includes(LEGACY_DB_NAME) || names.includes(DB_NAME)) return;
  }
  // Open the legacy DB without forcing a version; detect a freshly-created (empty) one.
  let legacy, created = false;
  try {
    legacy = await new Promise((resolve, reject) => {
      const req = indexedDB.open(LEGACY_DB_NAME);
      req.onupgradeneeded = () => { created = true; };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return; }
  const hasData = !created && STORES.some((s) => legacy.objectStoreNames.contains(s));
  if (!hasData) {
    legacy.close();
    if (created) { try { indexedDB.deleteDatabase(LEGACY_DB_NAME); } catch (e) { /* ignore */ } }
    return;
  }
  // Read every store out of the legacy DB.
  const data = {};
  for (const s of STORES) {
    data[s] = legacy.objectStoreNames.contains(s)
      ? await reqToPromise(legacy.transaction(s, "readonly").objectStore(s).getAll())
      : [];
  }
  legacy.close();
  // Write into the new DB, but never clobber data already there.
  const ndb = await openWithStores(DB_NAME);
  const reportCount = await reqToPromise(ndb.transaction("reports", "readonly").objectStore("reports").count());
  if (reportCount === 0) {
    for (const s of STORES) {
      if (!data[s].length) continue;
      const t = ndb.transaction(s, "readwrite");
      data[s].forEach((rec) => t.objectStore(s).put(rec));
      await txDone(t);
    }
  }
  ndb.close();
}

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    try { await migrateLegacy(); } catch (e) { /* migration is best-effort; never block startup */ }
    return openWithStores(DB_NAME);
  })();
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function hasReport(sha256) {
  const db = await open();
  return (await reqToPromise(tx(db, "reports", "readonly").getKey(sha256))) != null;
}

export async function putPdf(record) {
  const db = await open();
  return reqToPromise(tx(db, "pdfs", "readwrite").put(record));
}

export async function putReport(record) {
  const db = await open();
  return reqToPromise(tx(db, "reports", "readwrite").put(record));
}

export async function getAllReports() {
  const db = await open();
  return reqToPromise(tx(db, "reports", "readonly").getAll());
}

export async function getAllPdfs() {
  const db = await open();
  return reqToPromise(tx(db, "pdfs", "readonly").getAll());
}

export async function deleteReport(sha256) {
  const db = await open();
  await reqToPromise(tx(db, "reports", "readwrite").delete(sha256));
  await reqToPromise(tx(db, "pdfs", "readwrite").delete(sha256));
}

export async function clearAll() {
  const db = await open();
  await reqToPromise(tx(db, "reports", "readwrite").clear());
  await reqToPromise(tx(db, "pdfs", "readwrite").clear());
}

// --- key/value settings (e.g. user patient overrides) ---------------------

export async function getSetting(key) {
  const db = await open();
  const rec = await reqToPromise(tx(db, "settings", "readonly").get(key));
  return rec ? rec.value : null;
}

export async function putSetting(key, value) {
  const db = await open();
  return reqToPromise(tx(db, "settings", "readwrite").put({ key, value }));
}
