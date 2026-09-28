// Serves several searches from one network (the KataGo worker's loop): each
// round the most urgent searches fill one batch, and each gets its outputs back.
// No DOM or TF.js here; the worker supplies the evaluator, `post` and `yieldFn`.
export class Scheduler {
  constructor({ post, yieldFn }) {
    this.post = post;          // sends a message to the page
    this.yieldFn = yieldFn;    // lets 'stop' and new searches in between rounds
    this.evaluator = null;     // set once the network has loaded
    this.jobs = new Map();     // engine name -> job
    this.pumping = false;
    this.broken = null;        // why the network failed; then every search ends at once
    this.turn = 0;
  }

  // job: { engine, id, search, target, maxTime, reportMs, priority, batch?, started, lastReport }
  // batch caps the job's leaves per round (an AI level reads as it was calibrated).
  add(job) {
    this.jobs.delete(job.engine);
    if (this.broken) { this.post({ type: 'done', engine: job.engine, id: job.id, results: null }); return; }
    this.jobs.set(job.engine, job);
    this.pump();
  }

  stop(engine) { this.jobs.delete(engine); }

  async pump() {
    if (this.pumping || this.broken) return;
    this.pumping = true;
    try {
      while (this.jobs.size) {
        let live = [...this.jobs.values()];
        // The AI's move goes first: background reads wait while one is outstanding.
        const top = Math.max(...live.map(j => j.priority || 0));
        live = live.filter(j => (j.priority || 0) === top);
        // No more leaves than one batch holds: with more searches than that, they take turns.
        const cap = this.evaluator.maxBatch;
        if (live.length > cap) {
          const s = this.turn++ % live.length;
          live = [...live.slice(s), ...live.slice(0, s)].slice(0, cap);
        }
        const share = Math.max(1, Math.floor(cap / live.length));
        const parts = live.map(j => ({ j, sels: j.search.gather(Math.min(share, j.batch || cap, j.target - j.search.playouts)) }));
        const all = parts.flatMap(p => p.sels);
        const outs = all.length ? await this.evaluator.evaluate(all.map(s => s.pos)) : [];
        let at = 0;
        const now = performance.now();
        for (const { j, sels } of parts) {
          const mine = outs.slice(at, at += sels.length);
          if (this.jobs.get(j.engine) !== j) continue;   // stopped or replaced while the net ran
          j.search.apply(sels, mine);
          const done = j.search.playouts >= j.target || now - j.started > j.maxTime;
          if (done || (j.reportMs && now - j.lastReport > j.reportMs)) {
            j.lastReport = now;
            const results = j.search.results(done ? 40 : 12);
            results.engine = 'katago';
            if (!done) { delete results.allMoves; delete results.policy; }
            this.post({ type: done ? 'done' : 'progress', engine: j.engine, id: j.id, results, elapsed: now - j.started });
          }
          if (done) this.jobs.delete(j.engine);
        }
        await this.yieldFn();
      }
    } catch (err) {
      // The network failed (a lost GPU device, a backend error): every search is over.
      this.broken = String(err && err.message || err);
      for (const j of this.jobs.values()) this.post({ type: 'done', engine: j.engine, id: j.id, results: null });
      this.jobs.clear();
      this.post({ type: 'fatal', message: this.broken });
    } finally {
      this.pumping = false;
    }
  }
}
