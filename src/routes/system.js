const express = require('express');
const router = express.Router();
const os = require('os');
const { dbQuery } = require('../config/db');
const authMiddleware = require('../middleware/auth');
const { getActiveWorkersCount } = require('../services/scheduler');

// Health Check & Stats endpoint (requires auth to view detailed metrics)
router.get('/health', authMiddleware, async (req, res) => {
  try {
    // 1. Verify Database
    let dbStatus = 'connected';
    try {
      await dbQuery.get('SELECT 1');
    } catch (err) {
      dbStatus = 'disconnected';
    }

    // 2. Fetch Job Counts by Status
    // If user is not admin, only show stats for their own jobs
    let jobsQuery = 'SELECT status, count(*) as count FROM jobs';
    let logsQuery = 'SELECT status, count(*) as count FROM job_logs';
    let logs24hQuery = 'SELECT count(*) as count FROM job_logs WHERE status = "failed" AND executed_at >= ?';
    const params = [];
    const logsParams = [];
    const logs24hParams = [Date.now() - 24 * 60 * 60 * 1000];

    if (req.user.role !== 'admin') {
      jobsQuery += ' WHERE created_by = ?';
      logsQuery += ' WHERE job_id IN (SELECT id FROM jobs WHERE created_by = ?)';
      logs24hQuery += ' AND job_id IN (SELECT id FROM jobs WHERE created_by = ?)';
      params.push(req.user.id);
      logsParams.push(req.user.id);
      logs24hParams.push(req.user.id);
    }

    jobsQuery += ' GROUP BY status';
    logsQuery += ' GROUP BY status';

    const jobsCountRows = await dbQuery.all(jobsQuery, params);
    const logsCountRows = await dbQuery.all(logsQuery, logsParams);
    const failed24hRow = await dbQuery.get(logs24hQuery, logs24hParams);

    // Parse Job Counts
    const jobStats = {
      total: 0,
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      paused: 0
    };

    jobsCountRows.forEach(row => {
      jobStats[row.status] = row.count;
      jobStats.total += row.count;
    });

    // Parse Log/Execution counts
    let totalExecutions = 0;
    let successfulExecutions = 0;
    let failedExecutions = 0;

    logsCountRows.forEach(row => {
      const count = row.count;
      totalExecutions += count;
      if (row.status === 'success') {
        successfulExecutions = count;
      } else if (row.status === 'failed') {
        failedExecutions = count;
      }
    });

    const successRate = totalExecutions > 0 
      ? parseFloat(((successfulExecutions / totalExecutions) * 100).toFixed(2)) 
      : 100.0;

    // 3. Process & OS Metrics
    const memoryUsage = process.memoryUsage();
    const systemMetrics = {
      uptime_seconds: process.uptime(),
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu_cores: os.cpus().length,
      free_memory_gb: parseFloat((os.freemem() / 1024 / 1024 / 1024).toFixed(2)),
      total_memory_gb: parseFloat((os.totalmem() / 1024 / 1024 / 1024).toFixed(2)),
      process_memory_mb: {
        rss: parseFloat((memoryUsage.rss / 1024 / 1024).toFixed(2)),
        heapTotal: parseFloat((memoryUsage.heapTotal / 1024 / 1024).toFixed(2)),
        heapUsed: parseFloat((memoryUsage.heapUsed / 1024 / 1024).toFixed(2))
      }
    };

    res.json({
      status: dbStatus === 'connected' ? 'OK' : 'DEGRADED',
      database: dbStatus,
      active_workers: getActiveWorkersCount(),
      system: systemMetrics,
      job_stats: jobStats,
      execution_stats: {
        total: totalExecutions,
        success: successfulExecutions,
        failed: failedExecutions,
        success_rate_percent: successRate,
        failures_last_24h: failed24hRow ? failed24hRow.count : 0
      }
    });

  } catch (error) {
    console.error('System health route error:', error);
    res.status(500).json({ error: 'Failed to retrieve system status metrics' });
  }
});

module.exports = router;
