import { useEffect, useState, type ReactNode } from 'react';
import {
  demoPackNpcProfileForRole,
  demoPackNpcProfileForSeat,
  demoPackNpcProfileIds,
  parseMeetingSetup,
  type MeetingPace,
  type MeetingSetup,
  type MeetingSetupAgendaItem,
  type Scenario,
  type SetupFieldError,
  type SetupSource,
} from '@kaki/shared';
import { Button } from '../ui';
import { SetupApiError, saveSetup, type SetupResponse } from './api';
import { SourceLabel, formatSeconds } from './SetupDraft';

function nextId(base: string, taken: Set<string>): string {
  let index = 1;
  while (taken.has(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

function uniqueLabel(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function errorsForField(errors: SetupFieldError[], field: string): SetupFieldError[] {
  return errors.filter((error) => error.field === field);
}

function errorsForIndex(errors: SetupFieldError[], prefix: string): SetupFieldError[] {
  return errors.filter((error) => error.field.startsWith(prefix));
}

function FieldError({ errors }: { errors: SetupFieldError[] }) {
  if (errors.length === 0) return null;
  return <p className="setup-field-error">{errors.map((error) => error.message).join(' ')}</p>;
}

function EditorSection({
  title,
  source,
  children,
}: {
  title: string;
  source: SetupSource;
  children: ReactNode;
}) {
  return (
    <section className="card setup-section" aria-label={title}>
      <header className="setup-section-head">
        <h2 className="card-title">{title}</h2>
        <SourceLabel source={source} />
      </header>
      {children}
    </section>
  );
}

function paceText(seconds: number): string {
  return Number.isFinite(seconds) ? formatSeconds(seconds) : '0 seconds';
}

/** Edit the saved pre-Start draft; Save validates with the same parser the server uses. */
export function SetupEditor({
  setup,
  scenario,
  onSaved,
  onDirtyChange,
}: {
  setup: MeetingSetup;
  scenario: Scenario;
  onSaved: (result: SetupResponse) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<MeetingSetup>(setup);
  const [errors, setErrors] = useState<SetupFieldError[]>([]);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [roleProblem, setRoleProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [shownSetup, setShownSetup] = useState(setup);

  // A new saved setup (save, demo import) replaces the form during render, not in an effect: an
  // effect runs after the form is on screen, so an edit typed in between would be overwritten.
  if (shownSetup !== setup) {
    setShownSetup(setup);
    setDraft(setup);
    setErrors([]);
    setSaveProblem(null);
    setRoleProblem(null);
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(setup);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function changeTitle(title: string): void {
    setDraft((current) => ({
      ...current,
      title,
      source: { ...current.source, title: 'typed' },
    }));
  }

  function changeAgenda(index: number, patch: Partial<MeetingSetupAgendaItem>): void {
    setDraft((current) => ({
      ...current,
      agenda: current.agenda.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
      source: { ...current.source, agenda: 'typed' },
    }));
  }

  function addAgendaItem(): void {
    setDraft((current) => {
      const id = nextId('agenda-', new Set(current.agenda.map((item) => item.id)));
      return {
        ...current,
        agenda: [
          ...current.agenda,
          { id, title: '', minutes: 5, ownerRoleId: current.roles[0]?.id ?? '' },
        ],
        source: { ...current.source, agenda: 'typed' },
      };
    });
  }

  function removeAgendaItem(index: number): void {
    setDraft((current) => ({
      ...current,
      agenda: current.agenda.filter((_item, itemIndex) => itemIndex !== index),
      source: { ...current.source, agenda: 'typed' },
    }));
  }

  function moveAgendaItem(index: number, offset: number): void {
    setDraft((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.agenda.length) return current;
      const agenda = [...current.agenda];
      const [moved] = agenda.splice(index, 1);
      if (moved === undefined) return current;
      agenda.splice(target, 0, moved);
      return { ...current, agenda, source: { ...current.source, agenda: 'typed' } };
    });
  }

  function changeRoleLabel(index: number, label: string): void {
    setRoleProblem(null);
    setDraft((current) => ({
      ...current,
      roles: current.roles.map((role, roleIndex) =>
        roleIndex === index ? { ...role, label } : role,
      ),
      source: { ...current.source, roles: 'typed' },
    }));
  }

  function addRole(): void {
    setRoleProblem(null);
    setDraft((current) => {
      const id = nextId('role_', new Set(current.roles.map((role) => role.id)));
      const label = uniqueLabel('New role', new Set(current.roles.map((role) => role.label)));
      return {
        ...current,
        roles: [...current.roles, { id, label, facilitator: false }],
        source: { ...current.source, roles: 'typed' },
      };
    });
  }

  function removeRole(index: number): void {
    const role = draft.roles[index];
    if (role === undefined) return;

    const usedByAgenda = draft.agenda.some((item) => item.ownerRoleId === role.id);
    const usedBySeat = draft.seats.some((seat) => seat.roleId === role.id);
    if (usedByAgenda || usedBySeat) {
      const places = [usedByAgenda ? 'an agenda item' : '', usedBySeat ? 'a seat' : ''].filter(
        (place) => place.length > 0,
      );
      setRoleProblem(
        `"${role.label}" is still used by ${places.join(' and ')}. Change or remove ${places.length > 1 ? 'those' : 'it'} first.`,
      );
      return;
    }

    setRoleProblem(null);
    setDraft((current) => ({
      ...current,
      roles: current.roles.filter((_role, roleIndex) => roleIndex !== index),
      source: { ...current.source, roles: 'typed' },
    }));
  }

  function changeSeatName(index: number, displayName: string): void {
    setDraft((current) => ({
      ...current,
      seats: current.seats.map((seat, seatIndex) =>
        seatIndex === index ? { ...seat, displayName } : seat,
      ),
      source: { ...current.source, seats: 'typed' },
    }));
  }

  function changeSeatRole(index: number, roleId: string): void {
    setDraft((current) => {
      const seats = current.seats.map((seat, seatIndex) => {
        if (seatIndex !== index) return seat;
        if (seat.kind === 'person') return { ...seat, roleId };
        const profile = demoPackNpcProfileForRole(scenario, roleId);
        return profile === undefined
          ? { displayName: seat.displayName, roleId, kind: 'person' as const }
          : { ...seat, roleId, npcProfileId: profile };
      });
      return { ...current, seats, source: { ...current.source, seats: 'typed' } };
    });
  }

  function addSeat(): void {
    setDraft((current) => {
      const taken = new Set(current.seats.map((seat) => seat.displayName));
      const base = current.roles[0]?.label ?? 'New seat';
      const displayName = uniqueLabel(base, taken);
      return {
        ...current,
        seats: [
          ...current.seats,
          { displayName, roleId: current.roles[0]?.id ?? '', kind: 'person' as const },
        ],
        source: { ...current.source, seats: 'typed' },
      };
    });
  }

  function setSeatAi(index: number, useAi: boolean): void {
    setDraft((current) => {
      const seat = current.seats[index];
      if (seat === undefined) return current;
      const profile = useAi ? demoPackNpcProfileForSeat(scenario, seat) : undefined;
      if (useAi && profile === undefined) return current;
      const seats = current.seats.map((currentSeat, seatIndex) => {
        if (seatIndex !== index) return currentSeat;
        return useAi
          ? {
              displayName: currentSeat.displayName,
              roleId: currentSeat.roleId,
              kind: 'ai' as const,
              npcProfileId: profile,
            }
          : {
              displayName: currentSeat.displayName,
              roleId: currentSeat.roleId,
              kind: 'person' as const,
            };
      });
      return { ...current, seats, source: { ...current.source, seats: 'typed' } };
    });
  }

  function changePace(field: keyof MeetingPace, raw: string): void {
    const seconds = raw.trim() === '' ? Number.NaN : Number(raw);
    setDraft((current) => ({
      ...current,
      pace: { ...current.pace, [field]: seconds },
      source: { ...current.source, pace: 'typed' },
    }));
  }

  function cancel(): void {
    setDraft(setup);
    setErrors([]);
    setSaveProblem(null);
    setRoleProblem(null);
  }

  async function save(): Promise<void> {
    if (saving) return;
    setErrors([]);
    setSaveProblem(null);
    setRoleProblem(null);

    const parsed = parseMeetingSetup(draft, {
      npcProfileIds: demoPackNpcProfileIds(scenario),
    });
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }

    setSaving(true);
    try {
      const result = await saveSetup(parsed.value);
      setDraft(result.setup);
      onSaved(result);
    } catch (error) {
      if (error instanceof SetupApiError) {
        setErrors(error.fieldErrors);
        setSaveProblem(error.message);
      } else {
        setSaveProblem(error instanceof Error ? error.message : 'Could not save the setup.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {errors.length > 0 || saveProblem !== null ? (
        <div className="connection-banner setup-alert" role="alert">
          <p>{saveProblem ?? 'The setup has problems. Fix the highlighted fields and save again.'}</p>
          {errors.length > 0 ? (
            <ul className="setup-field-errors">
              {errors.map((error) => (
                <li key={`${error.field}-${error.message}`}>
                  <code>{error.field}</code> {error.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <section className="card setup-title-card" aria-label="Meeting title">
        <div className="setup-title-row">
          <h2 className="card-title">Meeting title</h2>
          <SourceLabel source={draft.source.title} />
        </div>
        <input
          className="setup-input"
          aria-label="Meeting title field"
          value={draft.title}
          onChange={(event) => changeTitle(event.currentTarget.value)}
        />
        <FieldError errors={errorsForField(errors, 'title')} />
      </section>

      <EditorSection title="Agenda" source={draft.source.agenda}>
        <FieldError errors={errorsForField(errors, 'agenda')} />
        <ol className="setup-list setup-agenda setup-edit-list">
          {draft.agenda.map((item, index) => (
            <li key={item.id}>
              <div className="setup-edit-row">
                <div className="setup-field setup-field-grow">
                  <label htmlFor={`agenda-title-${index}`}>Title</label>
                  <input
                    id={`agenda-title-${index}`}
                    className="setup-input"
                    aria-label={`Agenda item ${index + 1} title`}
                    value={item.title}
                    onChange={(event) => changeAgenda(index, { title: event.currentTarget.value })}
                  />
                </div>
                <div className="setup-field setup-field-narrow">
                  <label htmlFor={`agenda-minutes-${index}`}>Minutes</label>
                  <input
                    id={`agenda-minutes-${index}`}
                    className="setup-input"
                    type="number"
                    min={1}
                    aria-label={`Agenda item ${index + 1} minutes`}
                    value={Number.isFinite(item.minutes) ? item.minutes : ''}
                    onChange={(event) =>
                      changeAgenda(index, { minutes: Number(event.currentTarget.value) })
                    }
                  />
                </div>
                <div className="setup-field setup-field-grow">
                  <label htmlFor={`agenda-owner-${index}`}>Owner</label>
                  <select
                    id={`agenda-owner-${index}`}
                    className="setup-select"
                    aria-label={`Agenda item ${index + 1} owner`}
                    value={item.ownerRoleId}
                    onChange={(event) =>
                      changeAgenda(index, { ownerRoleId: event.currentTarget.value })
                    }
                  >
                    <option value="">Choose an owner</option>
                    {draft.roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="setup-item-actions">
                  <Button
                    variant="ghost"
                    aria-label={`Move agenda item ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => moveAgendaItem(index, -1)}
                  >
                    Up
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Move agenda item ${index + 1} down`}
                    disabled={index === draft.agenda.length - 1}
                    onClick={() => moveAgendaItem(index, 1)}
                  >
                    Down
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Remove agenda item ${index + 1}`}
                    onClick={() => removeAgendaItem(index)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
              <FieldError errors={errorsForIndex(errors, `agenda[${index}].`)} />
            </li>
          ))}
        </ol>
        <div className="setup-tool-actions">
          <Button variant="ghost" onClick={addAgendaItem}>
            Add agenda item
          </Button>
        </div>
      </EditorSection>

      <EditorSection title="Roles" source={draft.source.roles}>
        <FieldError errors={errorsForField(errors, 'roles')} />
        {roleProblem === null ? null : (
          <p className="setup-field-error" role="status">
            {roleProblem}
          </p>
        )}
        <ul className="setup-list setup-edit-list">
          {draft.roles.map((role, index) => (
            <li key={role.id}>
              <div className="setup-edit-row">
                <div className="setup-field setup-field-grow">
                  <label htmlFor={`role-label-${index}`}>Role name</label>
                  <input
                    id={`role-label-${index}`}
                    className="setup-input"
                    aria-label={`Role ${index + 1} name`}
                    value={role.label}
                    onChange={(event) => changeRoleLabel(index, event.currentTarget.value)}
                  />
                </div>
                <p className="setup-meta">{role.facilitator ? 'Runs the meeting' : 'Takes part'}</p>
                <div className="setup-item-actions">
                  <Button
                    variant="ghost"
                    aria-label={`Remove role ${index + 1}`}
                    onClick={() => removeRole(index)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
              <FieldError errors={errorsForIndex(errors, `roles[${index}].`)} />
            </li>
          ))}
        </ul>
        <div className="setup-tool-actions">
          <Button variant="ghost" onClick={addRole}>
            Add role
          </Button>
        </div>
      </EditorSection>

      <EditorSection title="Seats" source={draft.source.seats}>
        <FieldError errors={errorsForField(errors, 'seats')} />
        <ul className="setup-list setup-edit-list">
          {draft.seats.map((seat, index) => {
            const profile = demoPackNpcProfileForSeat(scenario, seat);
            return (
              <li key={`${seat.roleId}-${seat.displayName}-${index}`}>
                <div className="setup-edit-row">
                  <div className="setup-field setup-field-grow">
                    <label htmlFor={`seat-name-${index}`}>Display name</label>
                    <input
                      id={`seat-name-${index}`}
                      className="setup-input"
                      aria-label={`Seat ${index + 1} name`}
                      value={seat.displayName}
                      onChange={(event) => changeSeatName(index, event.currentTarget.value)}
                    />
                  </div>
                  <div className="setup-field setup-field-grow">
                    <label htmlFor={`seat-role-${index}`}>Role</label>
                    <select
                      id={`seat-role-${index}`}
                      className="setup-select"
                      aria-label={`Seat ${index + 1} role`}
                      value={seat.roleId}
                      onChange={(event) => changeSeatRole(index, event.currentTarget.value)}
                    >
                      <option value="">Choose a role</option>
                      {draft.roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {profile === undefined ? (
                    <p className="setup-meta setup-seat-kind">Person only</p>
                  ) : (
                    <label className="setup-check">
                      <input
                        type="checkbox"
                        aria-label={`Seat ${index + 1} AI stand-in`}
                        checked={seat.kind === 'ai'}
                        onChange={(event) => setSeatAi(index, event.currentTarget.checked)}
                      />
                      AI stand-in ({profile})
                    </label>
                  )}
                </div>
                <FieldError errors={errorsForIndex(errors, `seats[${index}].`)} />
              </li>
            );
          })}
        </ul>
        <div className="setup-tool-actions">
          <Button variant="ghost" onClick={addSeat}>
            Add seat
          </Button>
        </div>
      </EditorSection>

      <EditorSection title="Nudge timings" source={draft.source.pace}>
        <FieldError errors={errorsForField(errors, 'pace')} />
        <ul className="setup-pace setup-pace-edit">
          <li>
            Kaki checks {paceText(draft.pace.quietCheckAfter)} into each item. If its owner has
            spoken for less than {paceText(draft.pace.ownerQuietBelow)}, Kaki gives them a quiet
            nudge.
            <div className="setup-edit-row">
              <div className="setup-field setup-field-narrow">
                <label htmlFor="pace-quiet-after">Quiet check (seconds)</label>
                <input
                  id="pace-quiet-after"
                  className="setup-input"
                  type="number"
                  aria-label="Quiet check after (seconds)"
                  value={
                    Number.isFinite(draft.pace.quietCheckAfter) ? draft.pace.quietCheckAfter : ''
                  }
                  onChange={(event) =>
                    changePace('quietCheckAfter', event.currentTarget.value)
                  }
                />
                <FieldError errors={errorsForField(errors, 'pace.quietCheckAfter')} />
              </div>
              <div className="setup-field setup-field-narrow">
                <label htmlFor="pace-quiet-below">Quiet owner talk (seconds)</label>
                <input
                  id="pace-quiet-below"
                  className="setup-input"
                  type="number"
                  aria-label="Quiet owner talk (seconds)"
                  value={
                    Number.isFinite(draft.pace.ownerQuietBelow)
                      ? draft.pace.ownerQuietBelow
                      : ''
                  }
                  onChange={(event) =>
                    changePace('ownerQuietBelow', event.currentTarget.value)
                  }
                />
                <FieldError errors={errorsForField(errors, 'pace.ownerQuietBelow')} />
              </div>
            </div>
          </li>
          <li>
            Kaki tells the next item&rsquo;s owner {paceText(draft.pace.comingUpBefore)} before the
            current item ends.
            <div className="setup-edit-row">
              <div className="setup-field setup-field-narrow">
                <label htmlFor="pace-coming-up">Coming-up warning (seconds)</label>
                <input
                  id="pace-coming-up"
                  className="setup-input"
                  type="number"
                  aria-label="Coming-up warning (seconds)"
                  value={
                    Number.isFinite(draft.pace.comingUpBefore) ? draft.pace.comingUpBefore : ''
                  }
                  onChange={(event) => changePace('comingUpBefore', event.currentTarget.value)}
                />
                <FieldError errors={errorsForField(errors, 'pace.comingUpBefore')} />
              </div>
            </div>
          </li>
        </ul>
      </EditorSection>

      <div className="setup-form-actions">
        <div className="setup-form-status">
          {dirty ? (
            <p className="setup-note" role="status">
              You have unsaved changes.
            </p>
          ) : null}
        </div>
        <Button variant="ghost" onClick={cancel} disabled={saving || !dirty}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save setup'}
        </Button>
      </div>
    </>
  );
}
