const KAKI_URL = 'https://kaki.southeastasia.cloudapp.azure.com';

const WAKE_LIMIT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const STATUS_TIMEOUT_MS = 10000;
const WAKE_TIMEOUT_MS = 15000;

const wakeBox = document.getElementById('wake');
const statusText = document.getElementById('wake-status');
const statusDetail = document.getElementById('wake-detail');
const elapsedText = document.getElementById('wake-elapsed');
const retryButton = document.getElementById('wake-retry');
const inviteForm = document.getElementById('invite-form');
const inviteInput = document.getElementById('invite-code');
const inviteGo = document.getElementById('invite-go');
const goButtons = [...document.querySelectorAll('.landing-go')];

/** idle: at the landing page; waking: WAKE in progress; failed: gave up. */
let phase = 'idle';
let healthy = false;
let destination = null;
let wakeStartedAt = 0;
let pollTimer = null;
let elapsedTimer = null;

function showStatus(state, message, detail = '') {
  wakeBox.dataset.state = state;
  statusText.textContent = message;
  statusDetail.textContent = detail;
  statusDetail.hidden = detail === '';
}

function showElapsed() {
  const seconds = Math.min(Math.floor((Date.now() - wakeStartedAt) / 1000), WAKE_LIMIT_MS / 1000);
  elapsedText.textContent = `${seconds}s elapsed`;
  elapsedText.hidden = false;
}

function stopTimers() {
  clearTimeout(pollTimer);
  clearInterval(elapsedTimer);
  pollTimer = null;
  elapsedTimer = null;
}

function setBusy(busy) {
  for (const button of goButtons) button.disabled = busy;
  updateJoinButton();
}

function updateJoinButton() {
  inviteGo.disabled = phase === 'waking' || inviteInput.value.trim() === '';
}

async function requestJson(path, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

function go() {
  window.location.assign(KAKI_URL + destination);
}

function giveUp(reason) {
  stopTimers();
  elapsedText.hidden = true;
  phase = 'failed';
  setBusy(false);
  showStatus('failed', 'Kaki could not be woken. Try again in a minute, or contact the team.', reason);
  retryButton.hidden = false;
}

function finish() {
  stopTimers();
  phase = 'idle';
  healthy = true;
  showStatus('ready', 'Kaki is ready.');
  go();
}

function schedulePoll(delay) {
  const remaining = WAKE_LIMIT_MS - (Date.now() - wakeStartedAt);
  if (remaining <= 0) {
    giveUp('');
    return;
  }
  pollTimer = setTimeout(poll, Math.min(delay, remaining));
}

async function poll() {
  if (phase !== 'waking') return;
  const result = await requestJson('/api/status', { method: 'GET' }, STATUS_TIMEOUT_MS);
  if (phase !== 'waking') return;
  if (result.ok && result.data?.healthy === true) {
    finish();
    return;
  }
  schedulePoll(POLL_INTERVAL_MS);
}

async function beginWake(target) {
  stopTimers();
  destination = target;
  phase = 'waking';
  healthy = false;
  setBusy(true);
  retryButton.hidden = true;
  showStatus('waking', 'Waking Kaki up, about 2 minutes');
  wakeStartedAt = Date.now();
  showElapsed();
  elapsedTimer = setInterval(showElapsed, 1000);

  const result = await requestJson('/api/wake', { method: 'POST' }, WAKE_TIMEOUT_MS);
  if (phase !== 'waking') return;
  if (!result.ok) {
    const reason = result.data?.error ?? (result.status === 0 ? 'Could not reach the wake service.' : '');
    giveUp(reason);
    return;
  }
  schedulePoll(0);
}

function start(target) {
  if (phase === 'waking') return;
  retryButton.hidden = true;
  if (healthy) {
    destination = target;
    go();
    return;
  }
  beginWake(target);
}

async function checkStatus() {
  const result = await requestJson('/api/status', { method: 'GET' }, STATUS_TIMEOUT_MS);
  if (phase !== 'idle') return;
  if (result.ok && result.data?.healthy === true) {
    healthy = true;
    showStatus('ready', 'Kaki is ready.');
    return;
  }
  healthy = false;
  if (result.ok) {
    showStatus('asleep', 'Kaki is asleep — it will start when you choose an option.');
  } else {
    const reason = result.data?.error ?? 'Could not reach the status service.';
    showStatus('asleep', 'Could not check Kaki — choosing an option will try to wake it.', reason);
  }
}

for (const button of goButtons) {
  button.addEventListener('click', () => start(button.dataset.path));
}

inviteInput.addEventListener('input', () => {
  const upper = inviteInput.value.toUpperCase();
  if (inviteInput.value !== upper) inviteInput.value = upper;
  updateJoinButton();
});

inviteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (phase === 'waking') return;
  const code = inviteInput.value.trim().toUpperCase();
  if (code === '') return;
  start(`/join?code=${encodeURIComponent(code)}`);
});

retryButton.addEventListener('click', () => {
  if (destination === null) return;
  beginWake(destination);
});

// A restored page has stale timers, so start clean.
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  stopTimers();
  phase = 'idle';
  healthy = false;
  destination = null;
  setBusy(false);
  retryButton.hidden = true;
  elapsedText.hidden = true;
  checkStatus();
});

checkStatus();
