/**
 * Job Executor Service
 * Runs individual job tasks and returns execution metrics.
 */

async function executeJob(job) {
  const start = Date.now();
  let payload;

  try {
    payload = JSON.parse(job.payload);
  } catch (err) {
    return {
      status: 'failed',
      duration_ms: Date.now() - start,
      error_message: 'Invalid payload JSON structure: ' + err.message,
      output: ''
    };
  }

  try {
    let output = '';

    switch (job.task_type) {
      case 'http':
        output = await handleHttpTask(payload);
        break;

      case 'email':
        output = await handleEmailTask(payload);
        break;

      case 'computation':
        output = await handleComputationTask(payload);
        break;

      default:
        throw new Error(`Unsupported task type: ${job.task_type}`);
    }

    return {
      status: 'success',
      duration_ms: Date.now() - start,
      output: typeof output === 'object' ? JSON.stringify(output) : String(output),
      error_message: null
    };

  } catch (error) {
    console.error(`Execution error for job ${job.id} (${job.name}):`, error);
    return {
      status: 'failed',
      duration_ms: Date.now() - start,
      error_message: error.message || String(error),
      output: ''
    };
  }
}

/**
 * Handle HTTP callbacks
 */
async function handleHttpTask(payload) {
  const { url, method = 'GET', headers = {}, body = null } = payload;

  if (!url) {
    throw new Error('Missing "url" in HTTP task payload.');
  }

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  };

  if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
    options.body = typeof body === 'object' ? JSON.stringify(body) : String(body);
  }

  // Set a timeout of 10 seconds for the request
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  options.signal = controller.signal;

  try {
    const res = await fetch(url, options);
    clearTimeout(timeoutId);

    const responseText = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP Request failed with status ${res.status}: ${responseText.substring(0, 200)}`);
    }

    return {
      statusCode: res.status,
      statusText: res.statusText,
      response: responseText.substring(0, 1000) // limit output length
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('HTTP Request timed out after 10 seconds');
    }
    throw err;
  }
}

/**
 * Handle Simulated Emails
 */
async function handleEmailTask(payload) {
  const { to, subject, body } = payload;

  if (!to || !subject || !body) {
    throw new Error('Email tasks require "to", "subject", and "body" parameters.');
  }

  // Simulate network latency
  await new Promise(resolve => setTimeout(resolve, 200));

  const logMessage = `
[MOCK EMAIL SENT]
Timestamp: ${new Date().toISOString()}
To: ${to}
Subject: ${subject}
Message Body:
--------------------------------------------
${body}
--------------------------------------------
`;
  console.log(logMessage);

  return {
    sent: true,
    to,
    subject,
    timestamp: Date.now(),
    message: 'Mock email logged to server output.'
  };
}

/**
 * Handle Simulated Heavy Computations
 */
async function handleComputationTask(payload) {
  const { type = 'fibonacci', iterations = 10000 } = payload;

  if (iterations > 10000000) {
    throw new Error('Iterations parameter is too high. Max iteration count is 10,000,000 to prevent system crash.');
  }

  if (type === 'fibonacci') {
    let a = 0, b = 1, temp;
    for (let i = 0; i < iterations; i++) {
      temp = a + b;
      a = b;
      b = temp;
    }
    return {
      type: 'fibonacci',
      iterations,
      result: `Completed ${iterations} steps of Fibonacci sequence simulation.`
    };
  } else if (type === 'primes') {
    // Basic prime counter
    let count = 0;
    const isPrime = (num) => {
      if (num <= 1) return false;
      for (let i = 2; i <= Math.sqrt(num); i++) {
        if (num % i === 0) return false;
      }
      return true;
    };

    for (let i = 2; i < iterations; i++) {
      if (isPrime(i)) count++;
    }

    return {
      type: 'primes',
      iterations,
      primesFound: count,
      result: `Completed search for primes up to ${iterations}. Found ${count} primes.`
    };
  } else {
    throw new Error(`Unknown computation type: ${type}. Supported types: "fibonacci", "primes".`);
  }
}

module.exports = {
  executeJob
};
