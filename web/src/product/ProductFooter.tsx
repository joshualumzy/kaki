import { Link } from 'react-router-dom';

/** The small legal footer on the signed-in product pages. */
export function ProductFooter() {
  return (
    <footer className="product-footer">
      <Link className="product-link" to="/privacy">
        Privacy
      </Link>
      <Link className="product-link" to="/terms">
        Terms
      </Link>
    </footer>
  );
}
