// Picks the TF.js backend to run KataGo on. `attempt(name)` sets a backend up,
// builds the network and benchmarks it, returning { backend, rate, gpu,
// dispose } or null when the backend isn't there; a failure at any of those
// steps just moves on to the next backend. Keeps the fastest that worked; a
// GPU fast enough (or any CPU-side backend) ends the search.
export async function chooseBackend(backends, attempt, { enough = 150 } = {}) {
  let best = null;
  for (const name of backends) {
    let got = null;
    try { got = await attempt(name); } catch { got = null; }
    if (!got) continue;
    if (!best || got.rate > best.rate) { if (best) best.dispose(); best = got; }
    else got.dispose();
    if (!got.gpu || got.rate >= enough) break;
  }
  return best;
}
