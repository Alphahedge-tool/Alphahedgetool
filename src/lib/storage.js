// Instrument-master IndexedDB cache + parquet-ish JSON serialization + misc.
// Pure / browser-API helpers — no app state.

import { INSTRUMENT_DB, INSTRUMENT_STORE } from "./constants.js";

// Writes rows as a JSON file (saved with .parquet extension).
// Each row is a plain object; field names match the CSV headers.
export function writeParquet(_columns, rows) {
  return new TextEncoder().encode(JSON.stringify(rows));
}

// Reads a JSON file written by writeParquet above.
export function readParquet(buffer) {
  const text = new TextDecoder().decode(buffer);
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("No data rows found in file.");
  return rows;
}

export function openInstrumentDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INSTRUMENT_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(INSTRUMENT_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open instrument cache."));
  });
}

export async function readInstrumentCache(key) {
  const db = await openInstrumentDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INSTRUMENT_STORE, "readonly");
    const request = tx.objectStore(INSTRUMENT_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Unable to read instrument cache."));
    tx.oncomplete = () => db.close();
  });
}

export async function writeInstrumentCache(record) {
  const db = await openInstrumentDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(INSTRUMENT_STORE, "readwrite");
    tx.objectStore(INSTRUMENT_STORE).put(record);
    tx.oncomplete = () => {
      db.close();
      resolve(record);
    };
    tx.onerror = () => reject(tx.error || new Error("Unable to write instrument cache."));
  });
}

export function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function deviceIdForPhone(phone) {
  return `Nubra-OSS-${digits(phone)}`;
}
