const app = require('./app');
const { initDB, db } = require('./config/db');
const { startScheduler, stopScheduler } = require('./services/scheduler');

const PORT = process.env.PORT || 3000;

async function startServer() {
  console.log('Starting Job Scheduling System...');

  // Initialize DB Tables
  await initDB();

  // Start Express Server
  const server = app.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`Server listening on port ${PORT}`);
    console.log(`Dashboard available at http://localhost:${PORT}`);
    console.log(`===============================================`);
  });

  // Start Scheduler Daemon
  startScheduler();

  // Graceful Shutdown Handler
  const shutdown = async (signal) => {
    console.log(`\n[SHUTDOWN] Received ${signal}. Shutting down gracefully...`);
    
    // Stop Scheduler Polling
    stopScheduler();

    // Close Express Server
    server.close(() => {
      console.log('[SHUTDOWN] Express server closed.');
    });

    // Close Database
    db.close((err) => {
      if (err) {
        console.error('[SHUTDOWN] Error closing SQLite database:', err);
      } else {
        console.log('[SHUTDOWN] SQLite database connection closed.');
      }
      process.exit(0);
    });

    // Timeout fallback force close
    setTimeout(() => {
      console.error('[SHUTDOWN] Force terminating process after timeout.');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
