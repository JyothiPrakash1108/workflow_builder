const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const cronParser = require('cron-parser');
const { dbQuery } = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { calculateNextRunAt, triggerJobImmediately, parseIntervalToMs } = require('../services/scheduler');

// Helper to validate schedule
function validateSchedule(scheduleType, scheduleValue) {
  if (scheduleType === 'none') return;

  if (scheduleType === 'interval') {
    if (!scheduleValue) throw new Error('Interval schedule value is required.');
    parseIntervalToMs(scheduleValue); // will throw if invalid
  } else if (scheduleType === 'cron') {
    if (!scheduleValue) throw new Error('Cron expression schedule value is required.');
    try {
      cronParser.parseExpression(scheduleValue);
    } catch (err) {
      throw new Error(`Invalid cron expression: ${err.message}`);
    }
  } else {
    throw new Error(`Unsupported schedule type: ${scheduleType}`);
  }
}

// 1. Submit Job
router.post('/', authMiddleware, async (req, res) => {
  const {
    name,
    type, // 'one-time' | 'recurring'
    task_type, // 'http' | 'email' | 'computation'
    payload,
    schedule_type = 'none', // 'none' | 'interval' | 'cron'
    schedule_value = null,
    max_retries = 3,
    run_immediately = false
  } = req.body;

  if (!name || !type || !task_type || !payload) {
    return res.status(400).json({ error: 'Missing required fields: name, type, task_type, payload' });
  }

  if (type === 'recurring' && schedule_type === 'none') {
    return res.status(400).json({ error: 'Recurring jobs must have a schedule_type ("interval" or "cron")' });
  }

  try {
    validateSchedule(schedule_type, schedule_value);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const jobId = crypto.randomUUID();
    const payloadStr = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
    const now = Date.now();

    // Setup temporary job object to calculate schedule
    const tempJob = { schedule_type, schedule_value, type };
    let nextRunAt = null;

    if (run_immediately) {
      nextRunAt = now;
    } else if (type === 'recurring' || schedule_type !== 'none') {
      nextRunAt = calculateNextRunAt(tempJob);
    }

    const status = 'queued';

    await dbQuery.run(
      `INSERT INTO jobs (
        id, name, type, task_type, payload, schedule_type, schedule_value,
        status, next_run_at, retry_count, max_retries, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        jobId, name, type, task_type, payloadStr, schedule_type, schedule_value,
        status, nextRunAt, max_retries, req.user.id, now, now
      ]
    );

    res.status(201).json({
      message: 'Job submitted successfully',
      job: {
        id: jobId,
        name,
        type,
        task_type,
        status,
        next_run_at: nextRunAt ? new Date(nextRunAt).toISOString() : null,
        max_retries
      }
    });
  } catch (error) {
    console.error('Submit job error:', error);
    res.status(500).json({ error: 'Failed to submit job' });
  }
});

// 2. View Jobs (with filters & search)
router.get('/', authMiddleware, async (req, res) => {
  const { status, type, task_type, search } = req.query;
  let sql = 'SELECT * FROM jobs WHERE 1=1';
  const params = [];

  // Standard users only see their own jobs, admins see all
  if (req.user.role !== 'admin') {
    sql += ' AND created_by = ?';
    params.push(req.user.id);
  }

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }

  if (task_type) {
    sql += ' AND task_type = ?';
    params.push(task_type);
  }

  if (search) {
    sql += ' AND name LIKE ?';
    params.push(`%${search}%`);
  }

  sql += ' ORDER BY created_at DESC';

  try {
    const jobs = await dbQuery.all(sql, params);
    // Parse payloads back to objects for API cleanliness
    const parsedJobs = jobs.map(j => ({
      ...j,
      payload: (() => {
        try { return JSON.parse(j.payload); } catch { return j.payload; }
      })(),
      next_run_at_iso: j.next_run_at ? new Date(j.next_run_at).toISOString() : null
    }));

    res.json(parsedJobs);
  } catch (error) {
    console.error('Fetch jobs error:', error);
    res.status(500).json({ error: 'Failed to retrieve jobs' });
  }
});

// 3. View Job Details
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const job = await dbQuery.get('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (req.user.role !== 'admin' && job.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized to view this job' });
    }

    job.payload = (() => {
      try { return JSON.parse(job.payload); } catch { return job.payload; }
    })();
    job.next_run_at_iso = job.next_run_at ? new Date(job.next_run_at).toISOString() : null;

    res.json(job);
  } catch (error) {
    console.error('Fetch job error:', error);
    res.status(500).json({ error: 'Failed to retrieve job details' });
  }
});

// 4. Update/Reschedule Job
router.put('/:id', authMiddleware, async (req, res) => {
  const { name, payload, schedule_type, schedule_value, max_retries } = req.body;

  try {
    const job = await dbQuery.get('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (req.user.role !== 'admin' && job.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized to update this job' });
    }

    const updates = [];
    const params = [];
    const now = Date.now();

    if (name) {
      updates.push('name = ?');
      params.push(name);
    }

    if (payload) {
      updates.push('payload = ?');
      params.push(typeof payload === 'object' ? JSON.stringify(payload) : String(payload));
    }

    if (max_retries !== undefined) {
      updates.push('max_retries = ?');
      params.push(max_retries);
    }

    // Handle rescheduling logic
    let tempJob = { ...job };
    let scheduleChanged = false;

    if (schedule_type && schedule_type !== job.schedule_type) {
      validateSchedule(schedule_type, schedule_value || job.schedule_value);
      updates.push('schedule_type = ?');
      params.push(schedule_type);
      tempJob.schedule_type = schedule_type;
      scheduleChanged = true;
    }

    if (schedule_value !== undefined && schedule_value !== job.schedule_value) {
      validateSchedule(schedule_type || job.schedule_type, schedule_value);
      updates.push('schedule_value = ?');
      params.push(schedule_value);
      tempJob.schedule_value = schedule_value;
      scheduleChanged = true;
    }

    if (scheduleChanged) {
      const nextRunAt = calculateNextRunAt(tempJob);
      updates.push('next_run_at = ?');
      params.push(nextRunAt);
      updates.push('status = "queued"'); // reset to queued since schedule changed
      updates.push('retry_count = 0');
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No update parameters provided' });
    }

    updates.push('updated_at = ?');
    params.push(now);

    params.push(req.params.id);

    await dbQuery.run(`UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`, params);

    res.json({ message: 'Job updated successfully' });
  } catch (error) {
    console.error('Update job error:', error);
    res.status(500).json({ error: error.message || 'Failed to update job' });
  }
});

// 5. Delete/Cancel Job
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const job = await dbQuery.get('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (req.user.role !== 'admin' && job.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized to delete this job' });
    }

    await dbQuery.run('DELETE FROM jobs WHERE id = ?', [req.params.id]);

    res.json({ message: 'Job cancelled and deleted successfully' });
  } catch (error) {
    console.error('Delete job error:', error);
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

// 6. View Execution Logs
router.get('/:id/logs', authMiddleware, async (req, res) => {
  try {
    const job = await dbQuery.get('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (req.user.role !== 'admin' && job.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized to view logs' });
    }

    const logs = await dbQuery.all(
      'SELECT * FROM job_logs WHERE job_id = ? ORDER BY executed_at DESC LIMIT 100',
      [req.params.id]
    );

    res.json(logs.map(l => ({
      ...l,
      executed_at_iso: new Date(l.executed_at).toISOString()
    })));
  } catch (error) {
    console.error('Fetch job logs error:', error);
    res.status(500).json({ error: 'Failed to retrieve logs' });
  }
});

// 7. Trigger Job Immediately
router.post('/:id/trigger', authMiddleware, async (req, res) => {
  try {
    const job = await dbQuery.get('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (req.user.role !== 'admin' && job.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized to trigger this job' });
    }

    const result = await triggerJobImmediately(job.id, req.user.id);
    res.json(result);
  } catch (error) {
    console.error('Trigger job error:', error);
    res.status(500).json({ error: error.message || 'Failed to trigger job' });
  }
});

// 8. Pause Job
router.post('/:id/pause', authMiddleware, async (req, res) => {
  try {
    const job = await dbQuery.get('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (req.user.role !== 'admin' && job.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized to pause this job' });
    }

    await dbQuery.run(
      'UPDATE jobs SET status = "paused", next_run_at = null, updated_at = ? WHERE id = ?',
      [Date.now(), req.params.id]
    );

    res.json({ message: 'Job paused successfully' });
  } catch (error) {
    console.error('Pause job error:', error);
    res.status(500).json({ error: 'Failed to pause job' });
  }
});

// 9. Resume Job
router.post('/:id/resume', authMiddleware, async (req, res) => {
  try {
    const job = await dbQuery.get('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (req.user.role !== 'admin' && job.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized to resume this job' });
    }

    const nextRunAt = calculateNextRunAt(job, true); // force run immediately or queue up
    await dbQuery.run(
      'UPDATE jobs SET status = "queued", next_run_at = ?, retry_count = 0, updated_at = ? WHERE id = ?',
      [nextRunAt, Date.now(), req.params.id]
    );

    res.json({ message: 'Job resumed successfully', next_run_at: new Date(nextRunAt).toISOString() });
  } catch (error) {
    console.error('Resume job error:', error);
    res.status(500).json({ error: error.message || 'Failed to resume job' });
  }
});

// 10. Fetch User Notifications
router.get('/notifications/all', authMiddleware, async (req, res) => {
  try {
    const notifications = await dbQuery.all(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json(notifications.map(n => ({
      ...n,
      created_at_iso: new Date(n.created_at).toISOString()
    })));
  } catch (error) {
    console.error('Fetch notifications error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// 11. Mark Notification as Read
router.post('/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    const notification = await dbQuery.get('SELECT * FROM notifications WHERE id = ?', [req.params.id]);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    if (notification.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    await dbQuery.run('UPDATE notifications SET read = 1 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    console.error('Read notification error:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

module.exports = router;
