const KAKI_URL = 'https://kaki.southeastasia.cloudapp.azure.com';

const WAKE_LIMIT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const STATUS_TIMEOUT_MS = 10000;
const WAKE_TIMEOUT_MS = 15000;
const TICK_MS = 250;
const READY_PAUSE_MS = 1200;
/** How long a running VM may keep an unhealthy app before the page says plainly it is in trouble. */
const APP_START_LIMIT_MS = 90 * 1000;
/** The most the cup may rise per tick, so a new wake step eases it up instead of jumping. */
const MAX_RISE_PER_TICK = 0.012;
/** Height of the cup's coffee shape in SVG units: moved down by this much, the cup is empty. */
const CUP_FILL_HEIGHT = 46;
/**
 * The cup fills by the wake steps the status API really reports. Within a step it creeps towards that step's
 * top so it never looks frozen, and only a healthy Kaki fills it to the brim.
 */
const STAGES = {
  switchingOn: { floor: 0.05, top: 0.6, tauSeconds: 25, message: 'Waking Kaki up: switching the server on, about a minute or two' },
  startingUp: { floor: 0.6, top: 0.92, tauSeconds: 20, message: 'Almost there: starting Kaki' },
};

const wakeBox = document.getElementById('wake');
const statusText = document.getElementById('wake-status');
const statusDetail = document.getElementById('wake-detail');
const elapsedText = document.getElementById('wake-elapsed');
const retryButton = document.getElementById('wake-retry');
const inviteForm = document.getElementById('invite-form');
const inviteInput = document.getElementById('invite-code');
const inviteGo = document.getElementById('invite-go');
const goButtons = [...document.querySelectorAll('.landing-go')];
const cup = document.getElementById('cup');
const cupFill = document.getElementById('cup-fill');

/** idle: at the landing page; waking: WAKE in progress; failed: gave up. */
let phase = 'idle';
let healthy = false;
let destination = null;
let wakeStartedAt = 0;
let pollTimer = null;
let tickTimer = null;
let cupLevel = 0;
let stage = null;
let stageStartedAt = 0;
let stageFloor = 0;
let unhealthySince = 0;

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

function drawCup(state) {
  cup.dataset.state = state;
  cupFill.style.transform = `translateY(${((1 - cupLevel) * CUP_FILL_HEIGHT).toFixed(2)}px)`;
}

function enterStage(name) {
  if (stage === name) return;
  stage = name;
  stageStartedAt = Date.now();
  stageFloor = Math.max(cupLevel, STAGES[name].floor);
  showStatus('waking', STAGES[name].message);
}

function tick() {
  showElapsed();
  if (stage === null) return;
  const { top, tauSeconds } = STAGES[stage];
  const seconds = (Date.now() - stageStartedAt) / 1000;
  const target = stageFloor + (top - stageFloor) * (1 - Math.exp(-seconds / tauSeconds));
  cupLevel += Math.min(Math.max((target - cupLevel) * 0.15, 0), MAX_RISE_PER_TICK);
  drawCup('waking');
}

function stopTimers() {
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  pollTimer = null;
  tickTimer = null;
  stage = null;
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
  drawCup('failed');
  showStatus('failed', 'Kaki could not be woken. Try again in a minute, or contact the team.', reason);
  retryButton.hidden = false;
}

/** The plain truth while the VM is on but Kaki's app has not answered. */
function showStartingOrTrouble(detail = '') {
  showStatus(
    'waking',
    'Kaki is starting or having trouble; try again in a minute',
    detail,
  );
}

/** Stop waiting on an unhealthy app and offer a retry, instead of spinning or claiming it is ready. */
function trouble(detail = '') {
  stopTimers();
  elapsedText.hidden = true;
  phase = 'failed';
  healthy = false;
  setBusy(false);
  drawCup('failed');
  showStatus('failed', 'Kaki is starting or having trouble; try again in a minute', detail);
  retryButton.hidden = false;
}

function finish() {
  stopTimers();
  phase = 'idle';
  healthy = true;
  cupLevel = 1;
  drawCup('ready');
  showStatus('ready', 'Kaki is ready.');
  // A short pause so the full, steaming cup is seen before the page moves on.
  setTimeout(go, READY_PAUSE_MS);
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
  if (result.ok && (result.data?.state === 'ready' || result.data?.healthy === true)) {
    unhealthySince = 0;
    finish();
    return;
  }
  // The VM is on but its app is not answering. Keep the cup moving for a short while, then say
  // plainly that Kaki is having trouble and offer a retry, rather than waiting the whole wake limit.
  if (
    result.ok &&
    (result.data?.state === 'unhealthy' ||
      (result.data?.power === 'running' && result.data?.healthy !== true))
  ) {
    if (unhealthySince === 0) unhealthySince = Date.now();
    showStartingOrTrouble('The server is on, but the Kaki app has not answered yet.');
    if (Date.now() - unhealthySince >= APP_START_LIMIT_MS) {
      trouble('The server is on, but the Kaki app has not answered yet.');
      return;
    }
    schedulePoll(POLL_INTERVAL_MS);
    return;
  }
  if (result.ok && result.data?.state === 'starting') enterStage('startingUp');
  schedulePoll(POLL_INTERVAL_MS);
}

async function beginWake(target) {
  stopTimers();
  destination = target;
  phase = 'waking';
  healthy = false;
  setBusy(true);
  retryButton.hidden = true;
  wakeStartedAt = Date.now();
  unhealthySince = 0;
  cupLevel = 0;
  drawCup('waking');
  enterStage('switchingOn');
  showElapsed();
  tickTimer = setInterval(tick, TICK_MS);

  const result = await requestJson('/api/wake', { method: 'POST' }, WAKE_TIMEOUT_MS);
  if (phase !== 'waking') return;
  if (!result.ok) {
    const reason = result.data?.error ?? (result.status === 0 ? 'Could not reach the wake service.' : '');
    giveUp(reason);
    return;
  }
  // The VM was already on when this wake arrived and its app is still unhealthy: the caller must
  // not wait another app-start window before being offered a retry.
  if (result.data?.started === false && result.data?.power === 'running') {
    unhealthySince = Date.now() - APP_START_LIMIT_MS;
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
  unhealthySince = 0;
  if (result.ok && (result.data?.state === 'ready' || result.data?.healthy === true)) {
    retryButton.hidden = true;
    healthy = true;
    cupLevel = 1;
    drawCup('ready');
    showStatus('ready', 'Kaki is ready.');
    return;
  }
  healthy = false;
  cupLevel = 0;
  if (result.ok && result.data?.state === 'unhealthy') {
    drawCup('failed');
    showStatus(
      'failed',
      'Kaki is starting or having trouble; try again in a minute',
      "The server is on, but Kaki's app is not answering yet.",
    );
    retryButton.hidden = false;
    return;
  }
  drawCup('asleep');
  if (result.ok && result.data?.state === 'starting') {
    showStatus('asleep', 'Kaki is starting — choosing an option will wait for it.');
  } else if (result.ok) {
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
  retryButton.hidden = true;
  if (destination !== null) {
    beginWake(destination);
    return;
  }
  // No option was chosen yet: re-check whether the app is answering now.
  drawCup('checking');
  checkStatus();
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
  cupLevel = 0;
  unhealthySince = 0;
  drawCup('checking');
  checkStatus();
});

checkStatus();
