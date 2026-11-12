import { newId } from '../services.js';

// In-process job runner. Jobs are persisted (so GET /v1/jobs/{id} survives restarts for
// finished jobs) and executed one at a time: syncs share one GitHub token and the
// clusterer holds the whole corpus in memory, so serial execution is the safe default.
// A job left `running` by a crash is marked failed on startup.
export class JobRunner {
  constructor(store, log = () => {}) {
    this.store = store;
    this.log = log;
    this.tail = Promise.resolve();
    store.db
      .prepare(`UPDATE jobs SET status = 'failed', error = 'Interrupted by a server restart.', finished_at = ?
                WHERE status IN ('queued', 'running')`)
      .run(new Date().toISOString());
  }

  /** @param {string} type @param {object} params @param {() => Promise<object>} work */
  enqueue(type, params, work) {
    const job = { id: newId('job'), type, params, created_at: new Date().toISOString() };
    this.store.createJob(job);
    this.tail = this.tail.then(() => this.run(job.id, work));
    return this.store.getJob(job.id);
  }

  async run(id, work) {
    this.store.updateJob(id, { status: 'running', started_at: new Date().toISOString() });
    try {
      const result = await work();
      this.store.updateJob(id, { status: 'succeeded', result, finished_at: new Date().toISOString() });
      this.log({ msg: 'job.succeeded', job_id: id });
    } catch (err) {
      this.store.updateJob(id, { status: 'failed', error: String(err.message ?? err), finished_at: new Date().toISOString() });
      this.log({ msg: 'job.failed', job_id: id, error: String(err.message ?? err) });
    }
  }

  /** Resolves when every queued job has finished (used by tests and the ingest CLI). */
  idle() {
    return this.tail;
  }
}
