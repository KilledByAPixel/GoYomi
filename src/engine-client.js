// Main-thread handle to an engine worker. search() returns a promise for the
// final results and streams progress; starting a new search cancels the old one.
export class Engine {
  constructor(name) {
    this.name = name;
    this.worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
    this.nextId = 1;
    this.pending = null;
    this.worker.onmessage = e => this.onMessage(e.data);
    this.worker.onerror = e => console.error(`${name} worker error`, e.message);
  }

  search(position, { playouts = 10000, maxTime = 60000, onProgress = null, reportMs = 250 } = {}) {
    this.cancel();
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending = { id, resolve, onProgress };
      this.worker.postMessage({ type: 'search', id, position, playouts, maxTime, reportMs });
    });
  }

  cancel() {
    if (!this.pending) return;
    this.worker.postMessage({ type: 'stop' });
    this.pending.resolve(null);
    this.pending = null;
  }

  get busy() { return !!this.pending; }

  onMessage(msg) {
    const job = this.pending;
    if (!job || msg.id !== job.id) return;
    if (msg.type === 'progress') { if (job.onProgress) job.onProgress(msg.results); return; }
    if (msg.type === 'done') {
      this.pending = null;
      if (job.onProgress) job.onProgress(msg.results, true);
      job.resolve(msg.results);
    }
  }
}
