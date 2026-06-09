/**
 * Automated Verification Script
 * Launches the application, registers a user, submits various jobs,
 * validates scheduler execution, retry backoff, and logs updates.
 */

const assert = require('assert').strict;
const app = require('../src/app');
const { initDB, db, dbQuery } = require('../src/config/db');
const { startScheduler, stopScheduler } = require('../src/services/scheduler');

const PORT = 3002;
const BASE_URL = `http://localhost:${PORT}`;
let server;
let jwtToken = '';

// Helper to delay execution
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runTests() {
  console.log('\n==================================================');
  console.log('STARTING INTEGRATION VERIFICATION TESTS');
  console.log('==================================================\n');

  // 1. Initialize Database
  console.log('1. Initializing SQLite Database...');
  await initDB();

  // Clean tables for fresh test runs
  await dbQuery.run('DELETE FROM users');
  await dbQuery.run('DELETE FROM jobs');
  await dbQuery.run('DELETE FROM job_logs');
  await dbQuery.run('DELETE FROM notifications');

  // 2. Start Express Server
  console.log(`2. Starting server on test port ${PORT}...`);
  server = app.listen(PORT);
  
  // 3. Start Scheduler
  console.log('3. Triggering Scheduler Polling...');
  startScheduler();

  try {
    // 4. Test User Registration
    console.log('\n4. Testing /api/auth/register...');
    const registerRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test@airtribe.com',
        password: 'password123',
        role: 'user'
      })
    });

    const registerData = await registerRes.json();
    assert.equal(registerRes.status, 201, 'Registration should return status 201');
    assert.ok(registerData.token, 'Registration response should contain a JWT token');
    console.log('✓ Registration successful!');

    // 5. Test User Login
    console.log('\n5. Testing /api/auth/login...');
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test@airtribe.com',
        password: 'password123'
      })
    });

    const loginData = await loginRes.json();
    assert.equal(loginRes.status, 200, 'Login should return status 200');
    assert.ok(loginData.token, 'Login response should contain a JWT token');
    jwtToken = loginData.token;
    console.log('✓ Login successful! Token retrieved.');

    // 6. Test Profile Me Endpoint
    console.log('\n6. Testing Authenticated Route /api/auth/me...');
    const profileRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${jwtToken}` }
    });
    const profileData = await profileRes.json();
    assert.equal(profileRes.status, 200);
    assert.equal(profileData.email, 'test@airtribe.com');
    console.log('✓ Auth Profile validated!');

    // 7. Submit Job 1: Computation Task (Runs Immediately, One-time)
    console.log('\n7. Submitting One-time Computation Job (Immediate)...');
    const job1Res = await fetch(`${BASE_URL}/api/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwtToken}`
      },
      body: JSON.stringify({
        name: 'Prime Counter Job',
        type: 'one-time',
        task_type: 'computation',
        payload: { type: 'primes', iterations: 2000 },
        run_immediately: true,
        max_retries: 2
      })
    });

    const job1Data = await job1Res.json();
    assert.equal(job1Res.status, 201);
    const job1Id = job1Data.job.id;
    console.log(`✓ Job submitted! ID: ${job1Id}`);

    // 8. Submit Job 2: HTTP Fail Task (One-time, Immediate, pointing to dead port)
    console.log('\n8. Submitting Job designed to fail (HTTP callback on closed port)...');
    const job2Res = await fetch(`${BASE_URL}/api/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwtToken}`
      },
      body: JSON.stringify({
        name: 'Failing Webhook Job',
        type: 'one-time',
        task_type: 'http',
        payload: { url: 'http://localhost:59999/dead-path', method: 'POST' },
        run_immediately: true,
        max_retries: 1 // Only 1 retry to speed up test run
      })
    });

    const job2Data = await job2Res.json();
    assert.equal(job2Res.status, 201);
    const job2Id = job2Data.job.id;
    console.log(`✓ Failed target job submitted! ID: ${job2Id}`);

    // 9. Wait for execution and retry cycles
    console.log('\n9. Sleeping for 14 seconds to let scheduler loop process jobs & retries...');
    await sleep(14000);

    // 10. Verify Job 1 Status
    console.log('\n10. Checking Status of Computation Job...');
    const verifyJob1Res = await fetch(`${BASE_URL}/api/jobs/${job1Id}`, {
      headers: { 'Authorization': `Bearer ${jwtToken}` }
    });
    const verifyJob1 = await verifyJob1Res.json();
    console.log(`Job 1 status: ${verifyJob1.status}`);
    assert.equal(verifyJob1.status, 'completed', 'Computation job should be marked "completed"');
    
    // Check logs for Job 1
    const logs1Res = await fetch(`${BASE_URL}/api/jobs/${job1Id}/logs`, {
      headers: { 'Authorization': `Bearer ${jwtToken}` }
    });
    const logs1 = await logs1Res.json();
    assert.ok(logs1.length > 0, 'Should have at least 1 log entry');
    assert.equal(logs1[0].status, 'success');
    console.log('✓ Job 1 executed successfully with logs recorded!');

    // 11. Verify Job 2 Status (Should have failed, retried, and terminally failed)
    console.log('\n11. Checking Status of Failing Webhook Job...');
    const verifyJob2Res = await fetch(`${BASE_URL}/api/jobs/${job2Id}`, {
      headers: { 'Authorization': `Bearer ${jwtToken}` }
    });
    const verifyJob2 = await verifyJob2Res.json();
    console.log(`Job 2 status: ${verifyJob2.status}`);
    console.log(`Job 2 retry count: ${verifyJob2.retry_count}/${verifyJob2.max_retries}`);
    assert.equal(verifyJob2.status, 'failed', 'Failing job should be terminally marked "failed"');
    
    // Check logs for Job 2
    const logs2Res = await fetch(`${BASE_URL}/api/jobs/${job2Id}/logs`, {
      headers: { 'Authorization': `Bearer ${jwtToken}` }
    });
    const logs2 = await logs2Res.json();
    // Should have 2 logs (attempt 0, and retry 1)
    console.log(`Number of logged execution attempts for Job 2: ${logs2.length}`);
    assert.ok(logs2.length >= 2, 'Should have registered initial failure and retry failure logs');
    assert.ok(logs2[0].error_message.includes('fetch failed') || logs2[0].error_message.includes('ECONNREFUSED'), 'Logs should report connection error');
    console.log('✓ Job 2 correctly triggered auto-retries and reported terminal failure!');

    // 12. Check System Notifications (Terminal failures should trigger notification alerts)
    console.log('\n12. Fetching user notifications for terminal failures...');
    const notifRes = await fetch(`${BASE_URL}/api/jobs/notifications/all`, {
      headers: { 'Authorization': `Bearer ${jwtToken}` }
    });
    const notifs = await notifRes.json();
    console.log(`Total alerts found: ${notifs.length}`);
    assert.ok(notifs.length > 0, 'A notification alert should have been recorded');
    assert.ok(notifs[0].message.includes('Failing Webhook Job'), 'Notification should mention the failed job name');
    console.log(`Notification message: "${notifs[0].message}"`);
    console.log('✓ Terminal failure warning alert successfully verified!');

    // 13. Check System Telemetry API
    console.log('\n13. Testing System Telemetry API /api/system/health...');
    const sysRes = await fetch(`${BASE_URL}/api/system/health`, {
      headers: { 'Authorization': `Bearer ${jwtToken}` }
    });
    const sysData = await sysRes.json();
    assert.equal(sysRes.status, 200);
    assert.equal(sysData.database, 'connected');
    assert.equal(sysData.job_stats.completed, 1);
    assert.equal(sysData.job_stats.failed, 1);
    console.log(`System reports success rate: ${sysData.execution_stats.success_rate_percent}%`);
    console.log('✓ Telemetry metrics checked out perfectly!');

    console.log('\n==================================================');
    console.log('ALL TESTS COMPLETED SUCCESSFULLY! ✓');
    console.log('==================================================\n');
    cleanup(0);

  } catch (err) {
    console.error('\n❌ TEST SUITE FAILURE:', err);
    cleanup(1);
  }
}

function cleanup(exitCode) {
  console.log('Stopping Scheduler Polling...');
  stopScheduler();

  if (server) {
    console.log('Stopping test server...');
    server.close();
  }

  console.log('Closing database...');
  db.close(() => {
    console.log(`Database closed. Exiting process with code ${exitCode}.`);
    process.exit(exitCode);
  });
}

// Run the script
runTests().catch(err => {
  console.error('Test framework unhandled error:', err);
  process.exit(1);
});
