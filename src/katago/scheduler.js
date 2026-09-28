// Serves several searches from one network (the KataGo worker's loop): each
// round the most urgent searches fill one batch, and each gets its outputs back.
// No DOM or TF.js here; the worker supplies the evaluator, `post` and `yieldFn`.
export class Scheduler {
  // now: the clock (tests pass a fake one).
  constructor({ post, yieldFn, now = () => performance.now() }) {
    this.now = now;
    this.post = post;          // sends a message to the page
    this.yieldFn = yieldFn;    // lets 'stop' and new searches in between rounds
    this.evaluator = null;     // set once the network has loaded
    this.jobs = new Map();     // engine name -> job
    this.pumping = false;
    this.broken = null;        // why the network failed; then every search ends at once
    this.turn = 0;
  }

  // job: { engine, id, search, target, maxTime, reportMs, priority, batch?, started, lastReport }
  // batch caps the job's leaves per round (an AI level reads as it was calibrated);
  // paused, added here, is time spent held back by a higher-priority job.
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
        const round = this.now();
        let live = [...this.jobs.values()];
        // The AI's move goes first: background reads wait while one is outstanding,
        // and the time they wait doesn't count against their own time limit.
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
        const now = this.now();
        // Held back this round, including jobs that arrived while the net ran.
        for (const j of this.jobs.values()) if ((j.priority || 0) < top) j.paused = (j.paused || 0) + now - Math.max(round, j.started);
        for (const { j, sels } of parts) {
          const mine = outs.slice(at, at += sels.length);
          if (this.jobs.get(j.engine) !== j) continue;   // stopped or replaced while the net ran
          j.search.apply(sels, mine);
          const done = j.search.playouts >= j.target || now - j.started - (j.paused || 0) > j.maxTime;
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
      // 'fatal' first: the page must know KataGo failed before any search
      // ends, or it takes an AI move that ended empty as done and never retries it.
      this.broken = String(err && err.message || err);
      this.post({ type: 'fatal', message: this.broken });
      for (const j of this.jobs.values()) this.post({ type: 'done', engine: j.engine, id: j.id, results: null });
      this.jobs.clear();
    } finally {
      this.pumping = false;
    }
  }
}
