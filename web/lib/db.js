// IndexedDB persistence for the backend-free build. Two stores, both keyed by
// the file's SHA-256 (so re-importing the same PDF replaces it, like the Ruby
// pipeline's idempotent import):
//   pdfs    { sha256, filename, blob, importedAt }  — originals, for reprocessing
//   reports { sha256, reportDoc, patientSlug }      — parsed per-report documents
//
// On load the app reads all report docs and rebuilds the payload in memory
// (aggregate.js); nothing else persists.

const DB_NAME = "pethud";
const DB_VERSION = 2;

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("pdfs")) db.createObjectStore("pdfs", { keyPath: "sha256" });
      if (!db.objectStoreNames.contains("reports")) db.createObjectStore("reports", { keyPath: "sha256" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
