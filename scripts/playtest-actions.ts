/** Browser-free decisions for the live playtest's `--act` mode. */

/** A card shape the action helpers need; `Task` from the driver is compatible. */
export type ActableTask = {
  id: string;
  title: string;
  status: string;
  assignee?: string;
};

type RobotTaskAction = { task: ActableTask; step: 'claim' | 'approve' };

/** True when a transcript speaker is exactly the robot's seat name, ignoring case and surrounding space. */
export function isRobotSpeakerName(speaker: string, robotSpeaker: string): boolean {
  const wanted = robotSpeaker.trim().toLowerCase();
  return wanted !== '' && speaker.trim().toLowerCase() === wanted;
}

/**
 * Why `--act` cannot run, or undefined when the robot's own environment is safe.
 * Any non-empty `KAKI_DRAFT_ONLY` other than `0` makes every approved action fail, so refuse early.
 */
export function draftOnlyRefusal(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const raw = env.KAKI_DRAFT_ONLY;
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '' || value === '0') return undefined;
  return `--act needs a stack started without KAKI_DRAFT_ONLY (this process has KAKI_DRAFT_ONLY=${raw}); it writes to the local mock tools only.`;
}

/** The next card assigned to `role` that still needs a click: claim it, then approve it once drafted. */
export function nextRobotTaskAction(
  tasks: Iterable<ActableTask>,
  role: string,
  claimed: ReadonlySet<string>,
  approved: ReadonlySet<string>,
): RobotTaskAction | undefined {
  const assigned = [...tasks].filter((task) => task.assignee === role);
  const claim = assigned.find((task) => task.status === 'DISPATCHED' && !claimed.has(task.id));
  if (claim !== undefined) return { task: claim, step: 'claim' };
  const approve = assigned.find((task) => task.status === 'DRAFT_READY' && !approved.has(task.id));
  if (approve !== undefined) return { task: approve, step: 'approve' };
  return undefined;
}

type CardTaskSnapshot = { status: string; artifactUrl?: string; error?: string };
type CardVerdict = { ok: boolean; detail: string };

/** A finished card may be COMPLETED, or already SYNCED back to the panel by the time the robot looks. */
function cardFinished(status: string | undefined): status is 'COMPLETED' | 'SYNCED' {
  return status === 'COMPLETED' || status === 'SYNCED';
}

/** Judge the "Card <title> completed" check from the latest task state after waiting. */
export function judgeCardCompletion(task: CardTaskSnapshot | undefined, timedOut: boolean): CardVerdict {
  if (task?.status === 'FAILED') {
    return { ok: false, detail: `Task failed${task.error === undefined ? '' : `: ${task.error}`}` };
  }
  const status = task?.status;
  if (cardFinished(status)) {
    return task?.artifactUrl === undefined || task.artifactUrl.trim() === ''
      ? { ok: false, detail: `Reached ${status} without an artifactUrl` }
      : { ok: true, detail: `${status} with artifact ${task.artifactUrl}` };
  }
  if (timedOut) {
    return {
      ok: false,
      detail: task === undefined
        ? 'No task update within 60 s of approval'
        : `Still ${task.status} after 60 s${task.error === undefined ? '' : `: ${task.error}`}`,
    };
  }
  return { ok: false, detail: `Task is ${task?.status ?? 'missing'}, not completed` };
}

/** The artifact URL must answer HTTP 2xx or 3xx. */
export function judgeArtifactReachability(url: string, status: number | undefined, error?: string): CardVerdict {
  if (status !== undefined) {
    return { ok: status >= 200 && status < 400, detail: `HTTP ${status} from ${url}` };
  }
  return { ok: false, detail: `Request for ${url} failed${error === undefined ? '' : `: ${error}`}` };
}
