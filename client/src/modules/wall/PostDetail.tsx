import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, MessageSquareOff } from 'lucide-react';
import { ApiError, errorMessage } from '../../lib/api';
import { firstName } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { Button, Card, EmptyState, Skeleton, SkeletonText, buttonClass } from '../../ui';
import { usePost } from './api';
import { Composer } from './Composer';
import { PostCard } from './PostCard';
import type { WallPost } from './types';

/** /home/post/:id — a single post with every comment (target of notifications and shared links). */
export default function PostDetail() {
  const { id } = useParams();
  const postId = Number(id);
  const q = usePost(postId);
  const [editing, setEditing] = useState<WallPost | null>(null);
  useDocumentTitle(q.data ? `${firstName(q.data.author?.name) || 'Family'}'s post` : 'Post');
  const notFound = !Number.isInteger(postId) || postId <= 0 || (q.error instanceof ApiError && q.error.status === 404);

  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/home" className="-ml-2 mb-4 inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold text-muted transition hover:bg-surface-2 hover:text-fg">
        <ArrowLeft size={17} /> Home
      </Link>
      {notFound ? (
        <Card>
          <EmptyState
            icon={MessageSquareOff}
            title="This post isn't here anymore"
            description="It may have been deleted, or it belongs to another family."
            action={<Link to="/home" className={buttonClass('primary')}>Back to the wall</Link>}
          />
        </Card>
      ) : q.isError ? (
        <Card>
          <EmptyState compact title="Couldn't load this post" description={errorMessage(q.error)} action={<Button variant="secondary" onClick={() => void q.refetch()}>Try again</Button>} />
        </Card>
      ) : !q.data ? (
        <Card aria-busy="true" aria-label="Loading post">
          <div className="flex items-center gap-3">
            <Skeleton circle className="size-9" />
            <div className="flex-1">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="mt-2 h-3 w-24" />
            </div>
          </div>
          <SkeletonText lines={3} className="mt-4" />
          <Skeleton className="mt-4 aspect-[2/1] w-full rounded-xl" />
        </Card>
      ) : (
        <PostCard post={q.data} onEdit={setEditing} expanded />
      )}
      <Composer open={!!editing} post={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
