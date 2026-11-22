import { Link, useLocation } from 'react-router-dom';
import { SIGN_IN_ENDED } from '../net/plainFailure';

/** A failure sentence; the signed-out one carries the way back in. */
export function ErrorText({ text }: { text: string }) {
  const location = useLocation();
  if (text !== SIGN_IN_ENDED) return <>{text}</>;
  const next = encodeURIComponent(`${location.pathname}${location.search}`);
  return (
    <>
      {text} <Link to={`/signin?next=${next}`}>Sign in</Link>
    </>
  );
}
