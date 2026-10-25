import type { ActionDraft, ActionKind, Task } from '@kaki/shared';
import type { KakiModule } from '../modules';

const DRAFT_DELAY_MS = 500;
const RUN_DELAY_MS = 1_000;

type FakeActionKind = Exclude<ActionKind, 'gitea_issue' | 'mattermost_post'>;

function draftFor(task: Task, actionKind: FakeActionKind): ActionDraft {
  switch (actionKind) {
    case 'email':
      return {
        target: 'team@example.com',
        subject: task.title,
        body: `Hello,\n\n${task.context}\n\nThanks,\nKaki`,
      };
  }
}

/** Development module that pretends to run actions so the phone flow can be built now. */
export const fakeActionsModule: KakiModule = {
  name: 'fake-actions',
  start({ tasks }) {
    const timers = new Set<ReturnType<typeof setTimeout>>();

    function schedule(delay: number, run: () => void): void {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, delay);
      timers.add(timer);
    }

    const unsubscribe = tasks.onChange((task) => {
      // Gitea issues and Mattermost posts have real modules; faking one here would race with them.
      if (task.actionKind === 'gitea_issue' || task.actionKind === 'mattermost_post') return;

      if (task.status === 'CLAIMED' && task.mode === 'ACTION_AGENT' && task.actionKind !== undefined) {
        const actionKind = task.actionKind;
        schedule(DRAFT_DELAY_MS, () => {
          const current = tasks.get(task.id);
          if (current === undefined || current.status !== task.status || current.updatedAt !== task.updatedAt) {
            return;
          }
          try {
            tasks.transition(task.id, 'DRAFT_READY', { draft: draftFor(task, actionKind) });
          } catch (error) {
            console.error('kaki fake actions: could not prepare a draft', error);
          }
        });
        return;
      }

      if (task.status === 'RUNNING') {
        schedule(RUN_DELAY_MS, () => {
          const current = tasks.get(task.id);
          if (current === undefined || current.status !== task.status || current.updatedAt !== task.updatedAt) {
            return;
          }
          try {
            if ((task.draft?.body ?? '').includes('FAIL')) {
              tasks.transition(task.id, 'FAILED', { error: 'fake failure' });
              return;
            }
            tasks.transition(task.id, 'COMPLETED', {
              artifactUrl: `http://localhost/fake/${task.actionKind ?? 'manual'}/${task.id}`,
            });
          } catch (error) {
            console.error('kaki fake actions: could not finish an action', error);
          }
        });
      }
    });

    return () => {
      unsubscribe();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  },
};
