import { useEffect } from 'react';

/** Keep the browser tab in step with the page; `undefined` leaves another owner's title alone. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (title !== undefined) document.title = title;
  }, [title]);
}
