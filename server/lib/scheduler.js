// Minimal job scheduler (stand-in for node-cron): fixed-interval jobs that never
// overlap, run once at start-up, and log their duration and failures.
import { createLogger } from '../logger.js';

const log = createLogger('scheduler');
const jobs = new Map();

export function schedule(name, everySeconds, fn, { runNow = true } = {}) {
  const job = { name, everySeconds, running: false, lastRun: null, lastError: null, timer: null };
  const tick = async () => {
    if (job.running) return; // skip if the previous run is still busy
    job.running = true;
    const t0 = Date.now();
    try {
      await fn();
      job.lastError = null;
      log.debug('job done', { job: name, ms: Date.now() - t0 });
    } catch (err) {
      job.lastError = err.message;
      log.error('job failed', { job: name, err });
    } finally {
      job.running = false;
      job.lastRun = Date.now();
    }
  };
  job.timer = setInterval(tick, everySeconds * 1000);
  job.timer.unref?.();
  job.run = tick;
  jobs.set(name, job);
  if (runNow) setTimeout(tick, 10);
  return job;
}

export const jobStatus = () => [...jobs.values()].map(({ name, everySeconds, running, lastRun, lastError }) => ({ name, everySeconds, running, lastRun, lastError }));
export const runJob = (name) => jobs.get(name)?.run();
export const stopAll = () => { for (const j of jobs.values()) clearInterval(j.timer); };
