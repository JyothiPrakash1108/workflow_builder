# AeroJob Console & Distributed Job Scheduler

A robust, database-backed distributed job scheduling system implemented in Node.js. It features a complete RESTful API, secure JWT authentication, automatic job execution, exponential backoff retries, user notification logs, and an embedded modern dark-mode monitoring dashboard.

---

## Key Features

1. **Job Submission & Dispatching**: Allows scheduling tasks to run immediately or at specific times in the future.
2. **Recurring Workloads**: Full support for intervals (e.g. `30s`, `10m`, `1d`) and standard Cron expressions (e.g. `*/5 * * * *`).
3. **Optimistic Distributed Locking**: Built-in state-machine transitions that prevent duplicate execution across multiple scaled backend instances.
4. **Resilient Failure Handling**: Automatic retries with exponential backoff delays. Generates alert warnings upon terminal failures.
5. **Real-time Monitoring & Dashboard**: Displays system telemetry, CPU cores, process memory, job distribution pools, execution counts, success rates, and interactive job creation and control options (pause, resume, delete, trigger).

---

## Tech Stack

* **Runtime**: Node.js (v18+)
* **Framework**: Express (REST APIs, Static Serving)
* **Database**: SQLite3 (Promisified local database)
* **Cron Parsing**: `cron-parser`
* **Security**: `bcryptjs` (passwords) & `jsonwebtoken` (JWT auth token verification)

---

## Getting Started

### 1. Installation

From the project root directory, install the required packages:
```bash
npm install
```

### 2. Configure Environment

Create a `.env` file in the root directory (one is pre-created by default):
```env
PORT=3000
JWT_SECRET=launchpad-job-scheduler-super-secret-key-2026
POLL_INTERVAL_MS=2000
NODE_ENV=development
```

### 3. Start the Server

Run the start script to initialize the database schema and launch the application:
```bash
npm start
```
Once started:
* The REST API is active.
* The scheduler daemon begins polling.
* The visual dashboard is served at: **`http://localhost:3000`**

---

## Core System Architecture Decisions

### 1. Database-backed Scheduler
Rather than keeping schedules in-memory (which are lost during server restarts), AeroJob persists all state in SQLite tables (`jobs`, `job_logs`, `notifications`, `users`). If a node crashes, it recovers state instantly on startup.

### 2. Horizontal Concurrency & Optimistic Locking
To make the scheduler scale horizontally across multiple instances (processes or nodes):
- Instead of standard `SELECT` then `UPDATE`, we use an atomic SQL state transition:
  ```sql
  UPDATE jobs 
  SET status = 'running', updated_at = ? 
  WHERE id = ? AND status = 'queued' AND next_run_at <= ?
  ```
- If the database returns `changes = 1`, this specific worker instance has acquired the lock and runs the task. If another worker got it first, `changes = 0`, and the worker skips execution. This avoids double-execution without requiring external locks like Redis.

### 3. Exponential Backoff Retries
When a job fails, the scheduler checks if `retry_count < max_retries`. If yes:
- It schedules the next attempt at `current_time + (2 ^ retry_count) * 5 seconds` (Attempt 1 = 10s delay, Attempt 2 = 20s delay, etc.).
- It sets the status back to `queued`.
- Once retries are exhausted, status updates to `failed` and an alert is logged to `notifications`.

---

## Database Schema (SQLite)

Below are the main database tables and key columns used by the application. This is provided as plain Markdown (no Mermaid) so it renders reliably.

- **users**
    - `id` TEXT PRIMARY KEY
    - `email` TEXT UNIQUE NOT NULL
    - `password` TEXT NOT NULL
    - `role` TEXT (e.g. `user`, `admin`)
    - `created_at` INTEGER (epoch ms)

- **jobs**
    - `id` TEXT PRIMARY KEY
    - `name` TEXT NOT NULL
    - `type` TEXT (e.g. `one-time`, `recurring`)
    - `task_type` TEXT (e.g. `http`, `email`, `computation`)
    - `payload` TEXT (JSON string)
    - `schedule_type` TEXT (e.g. `none`, `interval`, `cron`)
    - `schedule_value` TEXT
    - `status` TEXT (e.g. `queued`, `running`, `completed`, `failed`, `paused`)
    - `next_run_at` INTEGER (epoch ms)
    - `retry_count` INTEGER
    - `max_retries` INTEGER
    - `created_by` TEXT (FK -> `users.id`)
    - `created_at` INTEGER
    - `updated_at` INTEGER

- **job_logs**
    - `id` TEXT PRIMARY KEY
    - `job_id` TEXT (FK -> `jobs.id`)
    - `status` TEXT (e.g. `success`, `failed`)
    - `executed_at` INTEGER
    - `duration_ms` INTEGER
    - `error_message` TEXT
    - `output` TEXT

- **notifications**
    - `id` TEXT PRIMARY KEY
    - `user_id` TEXT (FK -> `users.id`)
    - `job_id` TEXT
    - `job_name` TEXT
    - `message` TEXT
    - `read` INTEGER (0/1)
    - `created_at` INTEGER

Example CREATE TABLE (simplified):

```sql
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at INTEGER NOT NULL
);
```

Use the above as a quick reference; full schema and constraints are implemented in `src/config/db.js`.

---

## API Endpoints Reference

All API endpoints (except register and login) require the `Authorization: Bearer <token>` header.

### Authentication
* `POST /api/auth/register` - Create a user account.
* `POST /api/auth/login` - Authenticate and return JWT token.
* `GET /api/auth/me` - Validate session and get profile information.

### Job Management
* `POST /api/jobs` - Submit a new job.
* `GET /api/jobs` - List jobs (supports query parameters: `status`, `type`, `task_type`, and `search`).
* `GET /api/jobs/:id` - Fetch details of a specific job.
* `PUT /api/jobs/:id` - Update name, payload, or schedule timings.
* `DELETE /api/jobs/:id` - Cancel and delete a job.
* `POST /api/jobs/:id/trigger` - Force run a job instantly.
* `POST /api/jobs/:id/pause` - Pause a job's schedule.
* `POST /api/jobs/:id/resume` - Resume a paused job.
* `GET /api/jobs/:id/logs` - Fetch past 100 execution runs.

### Alerts & System Telemetry
* `GET /api/jobs/notifications/all` - List failure logs/alerts for the user.
* `POST /api/jobs/notifications/:id/read` - Dismiss an alert.
* `GET /api/system/health` - Retrieve telemetry metrics (uptime, CPU cores, RAM usage, worker counts, job statistics).

---

## Running Integration Tests

To run the automated integration test suite that tests registering, logging in, creating, running, retrying, and auditing job results:
```bash
npm test
```

---

## Docker / Container Deployment

This project can be run inside Docker for easy deployment and isolation. The repository includes a `Dockerfile` and a `docker-compose.yml` for convenience.

Build the image locally:
```bash
docker build -t job-scheduler-backend .
```

Run the container (bind port 3000 and persist the SQLite DB to `./data`):
```bash
# Linux / macOS
docker run --env-file .env -p 3000:3000 -v $(pwd)/data:/usr/src/app/data job-scheduler-backend

# Windows PowerShell
docker run --env-file .env -p 3000:3000 -v ${PWD}\data:/usr/src/app/data job-scheduler-backend
```

Or use docker-compose for a one-command startup (recommended for local development):
```bash
docker-compose up --build -d
```

Notes:
- The SQLite database file is stored in the host `./data` folder and is mounted into the container at `/usr/src/app/data`.
- Keep your `.env` file in the project root and ensure it is not committed to source control (it's included in `.dockerignore`).
- The container exposes port `3000` by default; change `PORT` in your `.env` if needed.

