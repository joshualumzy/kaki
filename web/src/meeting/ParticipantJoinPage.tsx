import { useSearchParams } from 'react-router-dom';
import Meeting from './room/Meeting';

/** The invite link's landing page: a team participant joins the meeting named in the code. */
export function ParticipantJoinPage() {
  const [search] = useSearchParams();
  return <Meeting variant="participant" initialCode={search.get('code') ?? ''} />;
}
