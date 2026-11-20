import type { ReactNode } from 'react';
import type { MeetingSetup, MeetingSetupAgendaItem, MeetingSetupSeat, SetupSource } from '@kaki/shared';

const SOURCE_LABELS: Record<SetupSource, string> = {
  'calendar invite': 'From calendar invite',
  'demo pack': 'From demo pack',
  typed: 'Typed',
};

export function SourceLabel({ source }: { source: SetupSource }) {
  return (
    <span className="setup-source" data-source={source}>
      {SOURCE_LABELS[source]}
    </span>
  );
}

function Section({
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

function formatMinutes(minutes: number): string {
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const minutePart = minutes === 0 ? '' : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const secondPart = rest === 0 ? '' : `${rest} ${rest === 1 ? 'second' : 'seconds'}`;
  return [minutePart, secondPart].filter((part) => part.length > 0).join(' ');
}

function roleName(setup: MeetingSetup, roleId: string): string {
  return setup.roles.find((role) => role.id === roleId)?.label ?? roleId;
}

function agendaLine(setup: MeetingSetup, item: MeetingSetupAgendaItem): string {
  return `${formatMinutes(item.minutes)} · Owner: ${roleName(setup, item.ownerRoleId)}`;
}

function seatKind(seat: MeetingSetupSeat): string {
  return seat.kind === 'ai' ? 'AI stand-in' : 'Person';
}

/** Read-only view of the saved meeting plan; every section names where its contents came from. */
export function SetupDraft({ setup }: { setup: MeetingSetup }) {
  return (
    <>
      <section className="card setup-title-card" aria-label="Meeting title">
        <div className="setup-title-row">
          <h2 className="setup-title">{setup.title}</h2>
          <SourceLabel source={setup.source.title} />
        </div>
        {setup.organisation === undefined ? null : (
          <p className="setup-meta">{setup.organisation}</p>
        )}
      </section>

      <Section title="Agenda" source={setup.source.agenda}>
        <ol className="setup-list setup-agenda">
          {setup.agenda.map((item) => (
            <li key={item.id}>
              <p className="setup-item-title">{item.title}</p>
              <p className="setup-meta">{agendaLine(setup, item)}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Roles" source={setup.source.roles}>
        <ul className="setup-list">
          {setup.roles.map((role) => (
            <li key={role.id}>
              <p className="setup-item-title">{role.label}</p>
              <p className="setup-meta">{role.facilitator ? 'Runs the meeting' : 'Takes part'}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Seats" source={setup.source.seats}>
        <ul className="setup-list">
          {setup.seats.map((seat) => (
            <li key={`${seat.roleId}-${seat.displayName}`}>
              <p className="setup-item-title">{seat.displayName}</p>
              <p className="setup-meta">
                {roleName(setup, seat.roleId)} · {seatKind(seat)}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Nudge timings" source={setup.source.pace}>
        <ul className="setup-pace">
          <li>
            Kaki checks {formatSeconds(setup.pace.quietCheckAfter)} into each item. If its owner has
            spoken for less than {formatSeconds(setup.pace.ownerQuietBelow)}, Kaki gives them a quiet
            nudge.
          </li>
          <li>
            Kaki tells the next item&rsquo;s owner {formatSeconds(setup.pace.comingUpBefore)} before
            the current item ends.
          </li>
        </ul>
      </Section>
    </>
  );
}
