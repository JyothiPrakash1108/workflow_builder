// aerojob-console dashboard logic

const API_BASE = '';
let token = localStorage.getItem('aerojob_token') || '';
let currentUser = null;
let healthIntervalId = null;

// DOM Elements
const authScreen = document.getElementById('auth-screen');
const appLayout = document.getElementById('app-layout');
const authForm = document.getElementById('auth-form');
const authTitle = document.getElementById('auth-title');
const authSubtitle = document.getElementById('auth-subtitle');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const authToggleLink = document.getElementById('auth-toggle-link');
const authToggleText = document.getElementById('auth-toggle-text');
const roleContainer = document.getElementById('role-container');
const btnLogout = document.getElementById('btn-logout');

// Dashboard Tabs
const navItems = document.querySelectorAll('.nav-item');
const tabPanes = document.querySelectorAll('.tab-pane');
const pageTitle = document.getElementById('page-title');
const pageSubtitle = document.getElementById('page-subtitle');

// Controls
const btnRefresh = document.getElementById('btn-refresh');
const btnNewJob = document.getElementById('btn-new-job');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnCancelJob = document.getElementById('btn-cancel-job');
const jobModal = document.getElementById('job-modal');
const jobForm = document.getElementById('job-form');

// Job Form Dynamic Fields
const jobType = document.getElementById('job-type');
const jobTaskType = document.getElementById('job-task-type');
const jobScheduleType = document.getElementById('job-schedule-type');
const scheduleValueContainer = document.getElementById('schedule-value-container');
const jobScheduleValue = document.getElementById('job-schedule-value');

// Payload Sections
const payloadHttpSection = document.getElementById('payload-http-section');
const payloadEmailSection = document.getElementById('payload-email-section');
const payloadComputationSection = document.getElementById('payload-computation-section');

// Logs Modal
const logsModal = document.getElementById('logs-modal');
const btnCloseLogsModal = document.getElementById('btn-close-logs-modal');
const btnCloseLogsFooter = document.getElementById('btn-close-logs-footer');
const logsModalTitle = document.getElementById('logs-modal-title');
const logsModalSubtitle = document.getElementById('logs-modal-subtitle');
const logsConsoleBody = document.getElementById('logs-console-body');

// Notifications Tab
const notificationsList = document.getElementById('notifications-list');
const btnClearAlerts = document.getElementById('btn-clear-alerts');
const notifBadge = document.getElementById('notif-badge');

// Toast Element
const toast = document.getElementById('toast');

// Authentication mode state ('login' or 'register')
let authMode = 'login';

// ----------------------------------------------------
// Toast Helper
// ----------------------------------------------------
function showToast(message, type = 'success') {
  toast.innerText = message;
  toast.className = `toast-notification show ${type}`;
  setTimeout(() => {
    toast.classList.remove('show');
  }, 4000);
}

// ----------------------------------------------------
// Authentication Handler
// ----------------------------------------------------
async function checkAuth() {
  if (!token) {
    showAuthScreen();
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.ok) {
      currentUser = await res.json();
      setupAppView();
    } else {
      localStorage.removeItem('aerojob_token');
      token = '';
      showAuthScreen();
    }
  } catch (error) {
    console.error('Auth check error:', error);
    showToast('Failed to connect to authentication server.', 'error');
    showAuthScreen();
  }
}

function showAuthScreen() {
  authScreen.classList.remove('hidden');
  appLayout.classList.add('hidden');
  stopMonitoring();
}

function setupAppView() {
  authScreen.classList.add('hidden');
  appLayout.classList.remove('hidden');
  
  // Set User Profile UI
  document.getElementById('user-display-email').innerText = currentUser.email;
  document.getElementById('user-display-role').innerText = currentUser.role;
  document.getElementById('user-avatar-letters').innerText = currentUser.email.substring(0, 2).toUpperCase();

  // Reset to overview tab
  switchTab('overview');
  
  // Fetch initial telemetry and jobs list
  refreshTelemetry();
  startMonitoring();
}

// Toggle Login / Register forms
authToggleLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (authMode === 'login') {
    authMode = 'register';
    authTitle.innerText = 'Create Launchpad Account';
    authSubtitle.innerText = 'Join and run scheduled workflows in seconds';
    authSubmitBtn.innerText = 'Create Account';
    authToggleText.innerText = 'Already have an account?';
    authToggleLink.innerText = 'Sign In';
    roleContainer.classList.remove('hidden');
  } else {
    authMode = 'login';
    authTitle.innerText = 'Welcome to the Launchpad';
    authSubtitle.innerText = 'Sign in to manage your distributed jobs';
    authSubmitBtn.innerText = 'Sign In';
    authToggleText.innerText = "Don't have an account?";
    authToggleLink.innerText = 'Create Account';
    roleContainer.classList.add('hidden');
  }
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('auth-email').value;
  const password = document.getElementById('auth-password').value;
  
  const payload = { email, password };
  let endpoint = '/api/auth/login';

  if (authMode === 'register') {
    payload.role = document.getElementById('auth-role').value;
    endpoint = '/api/auth/register';
  }

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Authentication failed');
    }

    token = data.token;
    localStorage.setItem('aerojob_token', token);
    currentUser = data.user;
    
    showToast(data.message || 'Login successful!');
    authForm.reset();
    setupAppView();
  } catch (error) {
    showToast(error.message, 'error');
  }
});

btnLogout.addEventListener('click', () => {
  localStorage.removeItem('aerojob_token');
  token = '';
  currentUser = null;
  showToast('Logged out successfully', 'info');
  showAuthScreen();
});

// ----------------------------------------------------
// Tabs Navigation
// ----------------------------------------------------
function switchTab(tabId) {
  navItems.forEach(item => {
    if (item.getAttribute('data-tab') === tabId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  tabPanes.forEach(pane => {
    if (pane.id === `tab-${tabId}`) {
      pane.classList.add('active');
    } else {
      pane.classList.remove('active');
    }
  });

  // Headers configuration
  if (tabId === 'overview') {
    pageTitle.innerText = 'Dashboard Overview';
    pageSubtitle.innerText = 'Real-time distributed system performance & monitoring stats';
  } else if (tabId === 'jobs') {
    pageTitle.innerText = 'Job Manager';
    pageSubtitle.innerText = 'View, submit, pause, resume, and cancel scheduled workloads';
    loadAllJobsList();
  } else if (tabId === 'notifications') {
    pageTitle.innerText = 'Failure Alerts';
    pageSubtitle.innerText = 'System failure logs and terminal warnings reports';
    loadAlertsList();
  }
}

navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const tabId = item.getAttribute('data-tab');
    switchTab(tabId);
  });
});

document.getElementById('btn-view-all-jobs').addEventListener('click', () => {
  switchTab('jobs');
});

// ----------------------------------------------------
// Telemetry & Monitoring Polling
// ----------------------------------------------------
async function refreshTelemetry() {
  if (!token) return;

  try {
    const res = await fetch(`${API_BASE}/api/system/health`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      if (res.status === 401) {
        btnLogout.click();
      }
      return;
    }

    const data = await res.json();
    updateTelemetryUI(data);
  } catch (error) {
    console.error('Telemetry fetch error:', error);
  }
}

function updateTelemetryUI(data) {
  // Server Status
  const statusLabel = document.getElementById('server-status-label');
  const indicator = document.querySelector('.pulse-indicator');
  if (data.status === 'OK') {
    statusLabel.innerText = 'ONLINE';
    statusLabel.style.color = '#34d399';
    indicator.className = 'pulse-indicator status-green';
  } else {
    statusLabel.innerText = 'DEGRADED';
    statusLabel.style.color = '#f87171';
    indicator.className = 'pulse-indicator status-red';
  }

  // Stats Counters
  document.getElementById('stat-active-workers').innerText = data.active_workers;
  document.getElementById('stat-total-jobs').innerText = data.job_stats.total;
  document.getElementById('stat-success-rate').innerText = `${data.execution_stats.success_rate_percent}%`;
  document.getElementById('stat-failed-jobs').innerText = data.execution_stats.failures_last_24h;

  // Breakdown Distribution
  document.getElementById('dist-running').innerText = data.job_stats.running;
  document.getElementById('dist-queued').innerText = data.job_stats.queued;
  document.getElementById('dist-completed').innerText = data.job_stats.completed;
  document.getElementById('dist-failed').innerText = data.job_stats.failed;
  document.getElementById('dist-paused').innerText = data.job_stats.paused;

  // Telemetry details
  document.getElementById('sys-node-ver').innerText = data.system.node_version;
  document.getElementById('sys-platform').innerText = `${data.system.platform} (${data.system.arch})`;
  document.getElementById('sys-cores').innerText = `${data.system.cpu_cores} Cores`;
  document.getElementById('sys-uptime').innerText = formatUptime(data.system.uptime_seconds);
  document.getElementById('sys-db-status').innerText = data.database.toUpperCase();
  document.getElementById('sys-db-status').className = data.database === 'connected' ? 'sys-val text-green' : 'sys-val text-red';
  document.getElementById('sys-total-tries').innerText = data.execution_stats.total;

  // Heap Allocation Memory Slider
  const usedHeap = data.system.process_memory_mb.heapUsed;
  const totalHeap = data.system.process_memory_mb.heapTotal;
  const memoryPercent = Math.min(100, Math.round((usedHeap / totalHeap) * 100));

  document.getElementById('sys-memory-label').innerText = `${usedHeap} MB / ${totalHeap} MB`;
  document.getElementById('sys-memory-progress').style.width = `${memoryPercent}%`;

  // Fetch recent jobs for overview list
  loadRecentJobs();
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const dDisplay = d > 0 ? `${d}d ` : '';
  const hDisplay = h > 0 ? `${h}h ` : '';
  const mDisplay = m > 0 ? `${m}m ` : '';
  const sDisplay = `${s}s`;

  return dDisplay + hDisplay + mDisplay + sDisplay;
}

function startMonitoring() {
  if (healthIntervalId) clearInterval(healthIntervalId);
  healthIntervalId = setInterval(() => {
    refreshTelemetry();
    // Refresh alerts badge
    updateAlertsBadge();
  }, 4000);
  updateAlertsBadge();
}

function stopMonitoring() {
  if (healthIntervalId) {
    clearInterval(healthIntervalId);
    healthIntervalId = null;
  }
}

btnRefresh.addEventListener('click', () => {
  refreshTelemetry();
  showToast('Telemetry data refreshed', 'info');
});

// ----------------------------------------------------
// Recent Jobs (Overview)
// ----------------------------------------------------
async function loadRecentJobs() {
  try {
    const res = await fetch(`${API_BASE}/api/jobs`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) return;
    const jobs = await res.json();
    const tableBody = document.querySelector('#recent-jobs-table tbody');
    tableBody.innerHTML = '';

    const recent = jobs.slice(0, 5); // limit to 5 recent items

    if (recent.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center text-muted">No jobs submitted yet. Use "Submit Job" to queue one.</td>
        </tr>`;
      return;
    }

    recent.forEach(job => {
      const nextRunStr = job.next_run_at 
        ? new Date(job.next_run_at).toLocaleString() 
        : '<span class="text-muted">—</span>';

      const row = document.createElement('tr');
      row.innerHTML = `
        <td>
          <div class="job-name-main">${escapeHtml(job.name)}</div>
          <div class="job-id-sub">${job.id}</div>
        </td>
        <td><span class="text-mono">${job.task_type.toUpperCase()}</span></td>
        <td>
          <div>${job.type === 'recurring' ? 'Recurring' : 'One-time'}</div>
          <div class="text-muted text-sm">${job.schedule_type === 'none' ? 'Immediate' : `${job.schedule_type} (${job.schedule_value})`}</div>
        </td>
        <td>${nextRunStr}</td>
        <td><span class="status-badge badge-${job.status}">${job.status}</span></td>
        <td>
          <div class="action-buttons-cell">
            <button class="btn btn-secondary btn-sm" onclick="triggerJob('${job.id}')" title="Trigger Now">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            </button>
            <button class="btn btn-secondary btn-sm" onclick="viewJobLogs('${job.id}', '${escapeHtml(job.name)}')" title="Logs">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
            </button>
          </div>
        </td>
      `;
      tableBody.appendChild(row);
    });
  } catch (error) {
    console.error('Recent jobs loading failed:', error);
  }
}

// ----------------------------------------------------
// All Jobs (Manager Tab)
// ----------------------------------------------------
const jobSearch = document.getElementById('job-search');
const filterStatus = document.getElementById('filter-status');
const filterTaskType = document.getElementById('filter-task-type');

async function loadAllJobsList() {
  const searchVal = jobSearch.value;
  const statusVal = filterStatus.value;
  const taskTypeVal = filterTaskType.value;

  let url = `${API_BASE}/api/jobs?`;
  if (searchVal) url += `search=${encodeURIComponent(searchVal)}&`;
  if (statusVal) url += `status=${encodeURIComponent(statusVal)}&`;
  if (taskTypeVal) url += `task_type=${encodeURIComponent(taskTypeVal)}&`;

  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) return;
    const jobs = await res.json();
    const tableBody = document.querySelector('#all-jobs-table tbody');
    tableBody.innerHTML = '';

    if (jobs.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="8" class="text-center text-muted py-4">No jobs matching selected filters.</td>
        </tr>`;
      return;
    }

    jobs.forEach(job => {
      const nextRunStr = job.next_run_at 
        ? new Date(job.next_run_at).toLocaleString() 
        : '<span class="text-muted">—</span>';

      const updateStr = new Date(job.updated_at).toLocaleString();

      const pauseResumeBtn = job.status === 'paused'
        ? `<button class="btn btn-secondary btn-sm" onclick="resumeJob('${job.id}')" title="Resume Job">Resume</button>`
        : `<button class="btn btn-secondary btn-sm" onclick="pauseJob('${job.id}')" title="Pause Job" ${job.status === 'completed' || job.status === 'failed' ? 'disabled' : ''}>Pause</button>`;

      const row = document.createElement('tr');
      row.innerHTML = `
        <td>
          <div class="job-name-main">${escapeHtml(job.name)}</div>
          <div class="job-id-sub">${job.id}</div>
        </td>
        <td><span style="text-transform: capitalize;">${job.type}</span></td>
        <td><span class="text-mono">${job.task_type.toUpperCase()}</span></td>
        <td>
          <div>${job.schedule_type === 'none' ? 'None' : job.schedule_type}</div>
          <div class="text-muted text-sm">${job.schedule_value || ''}</div>
        </td>
        <td><span class="status-badge badge-${job.status}">${job.status}</span></td>
        <td>${job.retry_count} / ${job.max_retries}</td>
        <td class="text-sm">${updateStr}</td>
        <td>
          <div class="action-buttons-cell">
            <button class="btn btn-primary btn-sm" onclick="triggerJob('${job.id}')" title="Run Instantly">Run</button>
            ${pauseResumeBtn}
            <button class="btn btn-secondary btn-sm" onclick="viewJobLogs('${job.id}', '${escapeHtml(job.name)}')" title="View Log Console">Logs</button>
            <button class="btn btn-secondary btn-sm text-red" onclick="deleteJob('${job.id}')" title="Cancel/Delete Job">Delete</button>
          </div>
        </td>
      `;
      tableBody.appendChild(row);
    });
  } catch (error) {
    console.error('All jobs load failed:', error);
  }
}

// Attach filters listeners
[jobSearch, filterStatus, filterTaskType].forEach(el => {
  el.addEventListener('input', () => {
    loadAllJobsList();
  });
});

// ----------------------------------------------------
// Job Submission / Modal Flow
// ----------------------------------------------------
btnNewJob.addEventListener('click', () => {
  jobModal.classList.remove('hidden');
});

function hideJobModal() {
  jobModal.classList.add('hidden');
  jobForm.reset();
  toggleFormSections();
}

[btnCloseModal, btnCancelJob].forEach(btn => {
  btn.addEventListener('click', hideJobModal);
});

// Watch Task Category selection
jobTaskType.addEventListener('change', toggleFormSections);

function toggleFormSections() {
  const selected = jobTaskType.value;
  payloadHttpSection.classList.add('hidden');
  payloadEmailSection.classList.add('hidden');
  payloadComputationSection.classList.add('hidden');

  if (selected === 'http') {
    payloadHttpSection.classList.remove('hidden');
  } else if (selected === 'email') {
    payloadEmailSection.classList.remove('hidden');
  } else if (selected === 'computation') {
    payloadComputationSection.classList.remove('hidden');
  }
}

// Watch Schedule selection
jobScheduleType.addEventListener('change', () => {
  const type = jobScheduleType.value;
  if (type === 'none') {
    scheduleValueContainer.style.display = 'none';
    jobScheduleValue.removeAttribute('required');
  } else {
    scheduleValueContainer.style.display = 'block';
    jobScheduleValue.setAttribute('required', 'true');
    if (type === 'interval') {
      jobScheduleValue.placeholder = 'e.g. 10s, 5m, 2h';
    } else {
      jobScheduleValue.placeholder = 'e.g. */5 * * * *';
    }
  }
});

// Submit job action
jobForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = document.getElementById('job-name').value;
  const type = jobType.value;
  const task_type = jobTaskType.value;
  const schedule_type = jobScheduleType.value;
  const schedule_value = schedule_type === 'none' ? null : jobScheduleValue.value;
  const max_retries = parseInt(document.getElementById('job-retries').value, 10);
  const run_immediately = document.getElementById('job-run-immediately').checked;

  // Build Payload object based on category
  let payload = {};
  if (task_type === 'http') {
    const url = document.getElementById('http-url').value;
    const method = document.getElementById('http-method').value;
    const headersStr = document.getElementById('http-headers').value;
    const bodyStr = document.getElementById('http-body').value;

    if (!url) {
      showToast('Callback URL is required for HTTP tasks.', 'error');
      return;
    }

    let headers = {};
    try {
      if (headersStr) headers = JSON.parse(headersStr);
    } catch {
      showToast('Invalid JSON in HTTP custom headers.', 'error');
      return;
    }

    let body = null;
    try {
      if (bodyStr) body = JSON.parse(bodyStr);
    } catch {
      showToast('Invalid JSON in request body.', 'error');
      return;
    }

    payload = { url, method, headers, body };
  } else if (task_type === 'email') {
    const to = document.getElementById('email-to').value;
    const subject = document.getElementById('email-subject').value;
    const body = document.getElementById('email-body').value;

    if (!to || !subject || !body) {
      showToast('Email To, Subject, and Body are required.', 'error');
      return;
    }
    payload = { to, subject, body };
  } else if (task_type === 'computation') {
    const type = document.getElementById('comp-type').value;
    const iterations = parseInt(document.getElementById('comp-iterations').value, 10);
    payload = { type, iterations };
  }

  const jobSubmission = {
    name,
    type,
    task_type,
    payload,
    schedule_type,
    schedule_value,
    max_retries,
    run_immediately
  };

  try {
    const res = await fetch(`${API_BASE}/api/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(jobSubmission)
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to submit job');
    }

    showToast('Job order submitted successfully!');
    hideJobModal();
    
    // Refresh lists
    refreshTelemetry();
    if (appLayout.querySelector('.nav-item[data-tab="jobs"]').classList.contains('active')) {
      loadAllJobsList();
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
});

// ----------------------------------------------------
// Job Controls Actions
// ----------------------------------------------------
async function triggerJob(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/jobs/${jobId}/trigger`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to trigger job');

    showToast('Job execution triggered instantly');
    refreshTelemetry();
    loadAllJobsList();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function pauseJob(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/jobs/${jobId}/pause`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to pause job');

    showToast('Job schedule paused');
    refreshTelemetry();
    loadAllJobsList();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function resumeJob(jobId) {
  try {
    const res = await fetch(`${API_BASE}/api/jobs/${jobId}/resume`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to resume job');

    showToast('Job schedule resumed');
    refreshTelemetry();
    loadAllJobsList();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteJob(jobId) {
  if (!confirm('Are you sure you want to cancel and delete this job order?')) return;

  try {
    const res = await fetch(`${API_BASE}/api/jobs/${jobId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete job');

    showToast('Job deleted and cancelled');
    refreshTelemetry();
    loadAllJobsList();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Make functions available in window scope for dynamic HTML buttons click handlers
window.triggerJob = triggerJob;
window.pauseJob = pauseJob;
window.resumeJob = resumeJob;
window.deleteJob = deleteJob;

// ----------------------------------------------------
// Logs Execution Console Modal Flow
// ----------------------------------------------------
async function viewJobLogs(jobId, jobName) {
  logsModalTitle.innerText = `Job: ${jobName}`;
  logsModalSubtitle.innerText = `Job ID: ${jobId}`;
  logsConsoleBody.innerHTML = '<div class="console-line text-muted">Fetching console logs...</div>';
  logsModal.classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/jobs/${jobId}/logs`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) throw new Error('Failed to retrieve job logs');
    
    const logs = await res.json();
    logsConsoleBody.innerHTML = '';

    if (logs.length === 0) {
      logsConsoleBody.innerHTML = '<div class="console-line text-muted">No execution runs recorded for this job yet.</div>';
      return;
    }

    logs.forEach(log => {
      // System run separator line
      const systemLine = document.createElement('div');
      systemLine.className = 'console-line system';
      systemLine.innerText = `[RUN TIMESTAMP: ${log.executed_at_iso}] | DURATION: ${log.duration_ms}ms | STATUS: ${log.status.toUpperCase()}`;
      logsConsoleBody.appendChild(systemLine);

      // Output line details
      if (log.output) {
        const outputLine = document.createElement('div');
        outputLine.className = 'console-line success';
        outputLine.innerText = `STDOUT: ${log.output}`;
        logsConsoleBody.appendChild(outputLine);
      }

      // Errors details
      if (log.error_message) {
        const errorLine = document.createElement('div');
        errorLine.className = 'console-line failed';
        errorLine.innerText = `STDERR (ERROR): ${log.error_message}`;
        logsConsoleBody.appendChild(errorLine);
      }
    });

    // Scroll to bottom
    logsConsoleBody.scrollTop = logsConsoleBody.scrollHeight;

  } catch (error) {
    logsConsoleBody.innerHTML = `<div class="console-line failed">Console Error: ${error.message}</div>`;
  }
}

window.viewJobLogs = viewJobLogs;

function hideLogsModal() {
  logsModal.classList.add('hidden');
}

[btnCloseLogsModal, btnCloseLogsFooter].forEach(btn => {
  btn.addEventListener('click', hideLogsModal);
});

// ----------------------------------------------------
// Alerts / Notifications
// ----------------------------------------------------
async function loadAlertsList() {
  try {
    const res = await fetch(`${API_BASE}/api/jobs/notifications/all`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) return;
    const notifs = await res.json();
    
    notificationsList.innerHTML = '';
    
    if (notifs.length === 0) {
      notificationsList.innerHTML = '<div class="text-center py-4 text-muted">No failure alerts reported. All jobs are healthy.</div>';
      btnClearAlerts.classList.add('hidden');
      return;
    }

    btnClearAlerts.classList.remove('hidden');

    notifs.forEach(notif => {
      const item = document.createElement('div');
      item.className = `notification-item ${notif.read === 0 ? 'unread' : ''}`;
      
      const unreadAction = notif.read === 0
        ? `<button class="btn btn-secondary btn-sm" onclick="markAlertRead('${notif.id}')">Mark Read</button>`
        : '';

      item.innerHTML = `
        <div class="notif-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
        </div>
        <div class="notif-content">
          <div class="notif-title">Job Failure Alert</div>
          <div class="notif-msg">${escapeHtml(notif.message)}</div>
          <div class="notif-meta">Alert ID: ${notif.id} | Timestamp: ${notif.created_at_iso}</div>
        </div>
        <div>
          ${unreadAction}
        </div>
      `;
      notificationsList.appendChild(item);
    });
  } catch (error) {
    console.error('Alerts load failed:', error);
  }
}

async function markAlertRead(id) {
  try {
    const res = await fetch(`${API_BASE}/api/jobs/notifications/${id}/read`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.ok) {
      loadAlertsList();
      updateAlertsBadge();
    }
  } catch (error) {
    console.error('Failed to mark alert as read:', error);
  }
}

window.markAlertRead = markAlertRead;

async function updateAlertsBadge() {
  try {
    const res = await fetch(`${API_BASE}/api/jobs/notifications/all`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) return;
    const notifs = await res.json();
    const unread = notifs.filter(n => n.read === 0).length;

    if (unread > 0) {
      notifBadge.innerText = unread;
      notifBadge.classList.remove('hidden');
    } else {
      notifBadge.classList.add('hidden');
    }
  } catch (error) {
    console.error('Failed to get notifications badge count:', error);
  }
}

btnClearAlerts.addEventListener('click', async () => {
  try {
    const res = await fetch(`${API_BASE}/api/jobs/notifications/all`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) return;
    const notifs = await res.json();
    const unread = notifs.filter(n => n.read === 0);

    for (const notif of unread) {
      await fetch(`${API_BASE}/api/jobs/notifications/${notif.id}/read`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    }

    showToast('All alerts marked as read');
    loadAlertsList();
    updateAlertsBadge();
  } catch (error) {
    console.error('Failed to read all alerts:', error);
  }
});

// ----------------------------------------------------
// Utilities
// ----------------------------------------------------
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Boot Check
checkAuth();
