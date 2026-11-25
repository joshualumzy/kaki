import { Link } from 'react-router-dom';
import { Card, useDocumentTitle } from '../ui';
import './product.css';

/** The plain way back when a link has no page behind it. */
export function NotFoundPage() {
  useDocumentTitle('Page not found · Kaki');
  return (
    <main className="page product-page product-page-narrow">
      <Card title="Page not found">
        <p className="product-hint">
          This page does not exist. Check the address, or go back to the home page.
        </p>
        <Link className="product-open" to="/">
          Go to Kaki
        </Link>
      </Card>
    </main>
  );
}
