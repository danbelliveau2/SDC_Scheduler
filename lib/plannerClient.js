'use strict';
require('dotenv').config();

// Read-only client for the SDC ETC Planner app's server-to-server integration
// API (/api/integration/jobs). Lets the scheduler build a project from the
// planner's authoritative job list and pull, per job:
//   - release/delivery estimate dates (poStartDate / startDate / completeDate)
//   - billable vs non-billable
//   - actuals vs execution ETC
//
// Mirrors etoDb.js's optional-integration contract: CONFIGURED is false unless
// BOTH env vars are set, and every function throws a clear "not configured"
// error when it isn't — so the feature stays dormant and harmless until the
// planner URL + shared token are provisioned on both apps.
//
// Env:
//   ETC_PLANNER_URL        base URL of the ETC Planner app, e.g. http://localhost:3010
//   SCHEDULER_SHARED_TOKEN bearer token; MUST match the planner app's own value

const BASE = (process.env.ETC_PLANNER_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.SCHEDULER_SHARED_TOKEN || '';
const CONFIGURED = Boolean(BASE && TOKEN);
const TIMEOUT_MS = 8000;

function assertConfigured() {
  if (!CONFIGURED) {
    throw new Error('ETC Planner integration not configured (set ETC_PLANNER_URL and SCHEDULER_SHARED_TOKEN)');
  }
}

async function call(path) {
  assertConfigured();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { _status: 404 };
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ETC Planner ${res.status}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Connectivity probe — resolves truthy if the planner answers with data.
async function ping() {
  const data = await call('/api/integration/jobs?status=Active');
  return { ok: true, jobCount: Array.isArray(data.jobs) ? data.jobs.length : 0 };
}

// Job list for the picker. Optional { q, status } narrow the results.
async function getJobs({ q, status } = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  const qs = params.toString();
  const data = await call(`/api/integration/jobs${qs ? `?${qs}` : ''}`);
  return Array.isArray(data.jobs) ? data.jobs : [];
}

// Full detail for one job. Returns null if the planner has no such job.
async function getJobDetail(jobId) {
  const id = encodeURIComponent(String(jobId));
  const data = await call(`/api/integration/jobs/${id}`);
  if (data && data._status === 404) return null;
  return data;
}

module.exports = { CONFIGURED, ping, getJobs, getJobDetail };
