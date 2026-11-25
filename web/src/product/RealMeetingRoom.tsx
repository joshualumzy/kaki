import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { MeetingScopeProvider, ScenarioProvider } from '../kaki';
import Meeting from '../meeting/room/Meeting';
import { useDocumentTitle } from '../ui';
import { getMeetingInfo, type MeetingInfo } from './api';
import { EndedMeetingCard } from './EndedMeetingCard';
import './product.css';

/** The real meeting room: its own scenario, its own websocket and its own LiveKit room. */
export function RealMeetingRoom() {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  // "Start now" opens the room with this flag: the owner's meeting begins as soon as they are in.
  const autoStart = searchParams.get('start') === '1';
  const [info, setInfo] = useState<MeetingInfo | null | undefined>(undefined);
  useDocumentTitle(
    info === null || info === undefined || info.title.trim() === ''
      ? 'Meeting · Kaki'
      : `${info.title} · Kaki`,
  );

  useEffect(() => {
    let cancelled = false;
    setInfo(undefined);
    getMeetingInfo(id)
      .then((meeting) => {
        if (!cancelled) setInfo(meeting);
      })
      .catch(() => {
        // A failed info check must not keep anyone out of a live room.
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (info === undefined) {
    return (
      <main className="page product-page product-page-narrow">
        <p className="empty-state" role="status">
          Checking this meeting…
        </p>
      </main>
    );
  }

  if (info !== null && info.status === 'ended') {
    return (
      <main className="page product-page product-page-narrow">
        <EndedMeetingCard
          meetingId={id}
          meetingTitle={info.title}
          historyWorkspaceId={info.historyWorkspaceId ?? null}
        />
      </main>
    );
  }

  return (
    <MeetingScopeProvider meetingId={id}>
      <ScenarioProvider view="meeting" meetingId={id}>
        <Meeting variant="real" meetingId={id} autoStart={autoStart} />
      </ScenarioProvider>
    </MeetingScopeProvider>
  );
}
