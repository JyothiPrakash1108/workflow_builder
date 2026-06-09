const cronParser = require('cron-parser');
const crypto = require('crypto');
const { dbQuery } = require('../config/db');
const { executeJob } = require('./executor');

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 2000;
const RETRY_BASE_DELAY_MS = 5000; // 5 seconds initial retry delay
const MAX_CONCURRENT_JOBS = 10;

let intervalId = null;
let activeWorkersCount = 0;

/**
 * Parses shorthand interval strings to milliseconds (e.g. "30s", "5m", "2h", "1d")
 */
function parseIntervalToMs(value) {
  const match = value.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) {
    throw new Error(`Invalid interval: "${value}". Use formats like "10s", "5m", "2h", "1d".`);
  }
  const quantity = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's': return quantity * 1000;
    case 'm': return quantity * 60 * 1000;
    case 'h': return quantity * 60 * 60 * 1000;
    case 'd': return quantity * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown interval unit: ${unit}`);
  }
}

/**
 * Calculates the next execution time for a job
 */
function calculateNextRunAt(job, forceNow = false) {
  if (forceNow) {
    return Date.now();
  }

  if (job.schedule_type === 'none') {
    return null;
  }

  if (job.schedule_type === 'interval') {
    const ms = parseIntervalToMs(job.schedule_value);
    return Date.now() + ms;
  }

  if (job.schedule_type === 'cron') {
    try {
      const interval = cronParser.parseExpression(job.schedule_value);
      return interval.next().toDate().getTime();
    } catch (err) {
      throw new Error(`Invalid cron expression: "${job.schedule_value}". Error: ${err.message}`);
    }
  }

  return null;
}

/**
 * Main polling function to check and run due jobs
 */
async function pollAndExecuteJobs() {
  if (activeWorkersCount >= MAX_CONCURRENT_JOBS) {
    return; // Max concurrency limit reached
  }

  try {
    const now = Date.now();
    // Fetch all jobs that are due
    const dueJobs = await dbQuery.all(
      `SELECT * FROM jobs 
       WHERE status = 'queued' AND next_run_at IS NOT NULL AND next_run_at <= ?
       LIMIT ?`,
      [now, MAX_CONCURRENT_JOBS - activeWorkersCount]
    );

    for (const job of dueJobs) {
      // Optimistic concurrency locking: update state to 'running'
      // Only 1 process/thread will successfully match next_run_at and status = 'queued'
      const lockTime = Date.now();
      const updateResult = await dbQuery.run(
        `UPDATE jobs 
         SET status = 'running', updated_at = ? 
         WHERE id = ? AND status = 'queued' AND next_run_at <= ?`,
        [lockTime, job.id, now]
      );

      if (updateResult.changes === 1) {
        // Successfully locked! Run the job in background
        activeWorkersCount++;
        runJobWorker(job).finally(() => {
          activeWorkersCount = Math.max(0, activeWorkersCount - 1);
        });
      }
    }
  } catch (error) {
    console.error('Error in scheduler polling loop:', error);
  }
}

/**
 * Asynchronous worker that executes the task and processes results (success/failure/retry/reschedule)
 */
async function runJobWorker(job) {
  console.log(`[SCHEDULER] Executing job ${job.id} ("${job.name}")...`);
  const result = await executeJob(job);
  const now = Date.now();

  try {
    // Write execution log
    const logId = crypto.randomUUID();
    await dbQuery.run(
      `INSERT INTO job_logs (id, job_id, status, executed_at, duration_ms, error_message, output)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [logId, job.id, result.status, now, result.duration_ms, result.error_message, result.output]
    );

    if (result.status === 'success') {
      console.log(`[SCHEDULER] Job ${job.id} ("${job.name}") completed successfully in ${result.duration_ms}ms.`);
      
      if (job.type === 'recurring') {
        // Reschedule recurring job
        try {
          const nextRunAt = calculateNextRunAt(job);
          await dbQuery.run(
            `UPDATE jobs 
             SET status = 'queued', next_run_at = ?, retry_count = 0, updated_at = ?
             WHERE id = ?`,
            [nextRunAt, now, job.id]
          );
          console.log(`[SCHEDULER] Rescheduled job ${job.id} ("${job.name}") for ${new Date(nextRunAt).toISOString()}`);
        } catch (err) {
          // If scheduling parsing fails, fail the job terminally
          await handleTerminalFailure(job, `Rescheduling parsing failed: ${err.message}`, now);
        }
      } else {
        // One-time job is complete
        await dbQuery.run(
          `UPDATE jobs SET status = 'completed', next_run_at = null, updated_at = ? WHERE id = ?`,
          [now, job.id]
        );
      }
    } else {
      // Job failed. Let's see if we should retry or fail terminally
      const nextRetryCount = job.retry_count + 1;
      
      if (nextRetryCount <= job.max_retries) {
        // Exponential backoff
        const backoffMs = Math.pow(2, nextRetryCount) * RETRY_BASE_DELAY_MS;
        const nextRunAt = now + backoffMs;

        await dbQuery.run(
          `UPDATE jobs 
           SET status = 'queued', retry_count = ?, next_run_at = ?, updated_at = ?
           WHERE id = ?`,
          [nextRetryCount, nextRunAt, now, job.id]
        );
        console.warn(`[SCHEDULER] Job ${job.id} failed. Retrying (Attempt ${nextRetryCount}/${job.max_retries}) in ${backoffMs / 1000}s. Error: ${result.error_message}`);
      } else {
        // Retries exhausted
        await handleTerminalFailure(job, result.error_message, now);
      }
    }
  } catch (dbError) {
    console.error(`[SCHEDULER] Database update error after executing job ${job.id}:`, dbError);
  }
}

/**
 * Handles marking a job as failed terminally and creating a notification
 */
async function handleTerminalFailure(job, errorMessage, timestamp) {
  console.error(`[SCHEDULER] Job ${job.id} ("${job.name}") failed terminally. Error: ${errorMessage}`);
  
  await dbQuery.run(
    `UPDATE jobs 
     SET status = 'failed', next_run_at = null, updated_at = ?
     WHERE id = ?`,
    [timestamp, job.id]
  );

  // Add notification
  const notifId = crypto.randomUUID();
  const msg = `Job "${job.name}" failed terminally. Reason: ${errorMessage || 'Unknown error'}`;
  await dbQuery.run(
    `INSERT INTO notifications (id, user_id, job_id, job_name, message, read, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    [notifId, job.created_by, job.id, job.name, msg, timestamp]
  );
}

/**
 * Start the scheduler polling daemon
 */
function startScheduler() {
  if (intervalId) return;
  console.log(`[SCHEDULER] Starting scheduler polling loop every ${POLL_INTERVAL_MS}ms...`);
  intervalId = setInterval(pollAndExecuteJobs, POLL_INTERVAL_MS);
}

/**
 * Stop the scheduler polling daemon
 */
function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[SCHEDULER] Stopped scheduler polling loop.');
  }
}

/**
 * Trigger a job immediately (bypass schedule, run in background right away)
 */
async function triggerJobImmediately(jobId, userId) {
  const job = await dbQuery.get('SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) {
    throw new Error('Job not found.');
  }

  // Set next_run_at to now, set status to queued, and force run it
  await dbQuery.run(
    `UPDATE jobs 
     SET status = 'queued', next_run_at = ?, retry_count = 0, updated_at = ? 
     WHERE id = ?`,
    [Date.now(), Date.now(), jobId]
  );

  // Prompt polling immediately to process it
  setImmediate(pollAndExecuteJobs);
  return { message: 'Job triggered successfully.' };
}

function getActiveWorkersCount() {
  return activeWorkersCount;
}

module.exports = {
  startScheduler,
  stopScheduler,
  calculateNextRunAt,
  triggerJobImmediately,
  parseIntervalToMs,
  getActiveWorkersCount
};
