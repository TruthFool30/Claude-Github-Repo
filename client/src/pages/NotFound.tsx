import { Link } from 'react-router';
import { Compass, Home } from 'lucide-react';
import { useDocumentTitle } from '../lib/hooks';
import { EmptyState, buttonClass } from '../ui';

export default function NotFound() {
  useDocumentTitle('Page not found');
  return (
    <EmptyState
      icon={Compass}
      as="h1"
      title="We couldn't find that page"
      description="The link may be broken, or the page may have moved. Let's get you back home."
      action={
        <Link to="/home" className={buttonClass('primary', 'md')}>
          <Home size={17} /> Go home
        </Link>
      }
    />
  );
}
