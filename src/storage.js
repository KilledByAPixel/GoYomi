// The page's storage, for everything the page keeps: getItem, setItem and
// removeItem as the browser's, and `durable`: whether what is written will
// still be there after the page is closed. From the Backgammon app.
//
// With site data blocked, or in a sandboxed frame, reading `localStorage`
// itself throws: then a stand-in that keeps things in memory until the page
// is closed, so the page runs as usual and only forgets on a reload (durable:
// false, always).
//
// A storage that can be read may still refuse to be written (it is full, or
// the browser allows no writes): it is used, so an earlier save is still read,
// and a throwaway key written and removed at the start says whether writes
// work. After that `durable` follows the last write: false when setItem threw
// (which the caller still sees), true again when one worked.
// get: where the storage comes from (a test's own).
const PROBE = 'goYomi.probe';
export function safeStorage(get = () => globalThis.localStorage) {
  let real = null;
  try {
    real = get();
    real.getItem(PROBE); // some browsers hand the object over and refuse its calls
  } catch { real = null; /* blocked or missing */ }
  if (real) {
    const s = {
      durable: false,
      getItem: k => real.getItem(k),
      setItem: (k, v) => {
        try { real.setItem(k, v); } catch (e) { s.durable = false; throw e; }
        s.durable = true;
      },
      removeItem: k => real.removeItem(k),
    };
    try { s.setItem(PROBE, '1'); s.removeItem(PROBE); } catch { s.durable = false; }
    return s;
  }
  const kept = new Map();
  return {
    durable: false,
    getItem: k => kept.has(String(k)) ? kept.get(String(k)) : null,
    setItem: (k, v) => { kept.set(String(k), String(v)); },
    removeItem: k => { kept.delete(String(k)); },
  };
}
