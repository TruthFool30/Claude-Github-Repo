import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Link2, MessageCircle, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, fmtDateTime, fmtRelative } from '../../lib/format';
import { Avatar, Card, Menu, toast, useConfirm } from '../../ui';
import { useWallActions } from './api';
import { Comments } from './Comments';
import { MOODS } from './moods';
import { PhotoGrid } from './PhotoGrid';
import { ReactionButton, ReactionSummary } from './Reactions';
import { RichText } from './RichText';
import type { WallPost } from './types';

export function PostCard({ post, onEdit, expanded, className }: { post: WallPost; onEdit: (p: WallPost) => void; expanded?: boolean; className?: string }) {
  const { user, members, role, isAdmin } = useAuth();
  const { react, deletePost, pin } = useWallActions();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [focusComment, setFocusComment] = useState(0);
  const mine = post.user_id === user?.id;
  const mood = post.mood ? MOODS[post.mood] : null;
  const myReaction = post.reactions.find((r) => r.user_id === user?.id)?.emoji ?? null;
  const author = post.author ?? { name: 'Former member', color: '#8d90a0', avatar_url: null };
  const bigText = !post.photos.length && post.body.length <= 90 && !post.body.includes('\n');
  const pinnedBy = post.pinned_by ? members.find((m) => m.id === post.pinned_by) : null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/home/post/${post.id}`);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: 'Delete this post?',
      message: mine
        ? 'The post, its photos, comments and reactions will be removed for everyone.'
        : `You're deleting ${firstName(author.name)}'s post as an admin. This can't be undone.`,
      confirmLabel: 'Delete post',
      danger: true,
    });
    if (!ok) return;
    const done = await deletePost(post);
    if (done && expanded) navigate('/home');
  };

  return (
    <Card padding="none" className={cn('overflow-hidden', post.pinned && 'ring-1 ring-warning/40', className)}>
      <article aria-label={`Post by ${author.name}`}>
        {post.pinned && (
          <div className="flex items-center gap-1.5 border-b border-warning/20 bg-warning-soft px-4 py-1.5 text-xs font-semibold text-warning-soft-fg sm:px-5">
            <Pin size={13} className="rotate-45" /> Pinned{pinnedBy ? ` by ${pinnedBy.id === user?.id ? 'you' : firstName(pinnedBy.name)}` : ''}
          </div>
        )}
        <header className="flex items-start gap-3 px-4 pt-4 sm:px-5">
          <Avatar user={author} size="md" />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-[15px] text-fg">
              <span className="font-semibold">{author.name}</span>
              {mood && (
                <span className="text-muted">
                  {' '}is feeling {mood.emoji} <span className="font-medium text-fg">{mood.label}</span>
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[13px] text-subtle">
              <Link to={`/home/post/${post.id}`} className="hover:underline" title={fmtDateTime(post.created_at)}>
                <time dateTime={post.created_at}>{fmtRelative(post.created_at)}</time>
              </Link>
              {post.edited_at && <span title={`Edited ${fmtDateTime(post.edited_at)}`}> · Edited</span>}
            </p>
          </div>
          <Menu
            label="Post actions"
            className="-mr-2 -mt-1"
            items={[
              mine && { label: 'Edit post', icon: Pencil, onSelect: () => onEdit(post) },
              role !== 'child' && { label: post.pinned ? 'Unpin' : 'Pin to top', icon: post.pinned ? PinOff : Pin, onSelect: () => void pin(post, !post.pinned) },
              { label: 'Copy link', icon: Link2, onSelect: () => void copyLink() },
              (mine || isAdmin) && 'divider',
              (mine || isAdmin) && { label: 'Delete post', icon: Trash2, danger: true, onSelect: () => void remove() },
            ]}
          />
        </header>

        {post.body && (
          <div className="px-4 pt-3 sm:px-5">
            <RichText
              text={post.body}
              members={members}
              className={cn('block text-fg', bigText ? 'text-[19px] font-medium leading-snug tracking-tight' : 'text-[15px] leading-relaxed')}
            />
          </div>
        )}

        {post.photos.length > 0 && <PhotoGrid photos={post.photos} caption={post.body || undefined} className="mt-3" showAll={expanded} />}

        {(post.reactions.length > 0 || post.comment_count > 0) && (
          <div className="flex items-center gap-3 px-4 pt-3 sm:px-5">
            <div className="min-w-0 flex-1">
              <ReactionSummary reactions={post.reactions} members={members} meId={user?.id} />
            </div>
            {post.comment_count > 0 && (
              <Link to={`/home/post/${post.id}`} className="shrink-0 text-[13px] text-muted hover:text-fg hover:underline">
                {post.comment_count} comment{post.comment_count === 1 ? '' : 's'}
              </Link>
            )}
          </div>
        )}

        <div className="mx-4 mt-2 flex items-center gap-1 border-t border-border pt-1.5 pb-1.5 sm:mx-5">
          <ReactionButton mine={myReaction} onPick={(emoji) => void react(post, emoji)} />
          <button
            type="button"
            onClick={() => setFocusComment((n) => n + 1)}
            className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg sm:flex-none"
          >
            <MessageCircle size={18} /> Comment
          </button>
        </div>

        <Comments post={post} members={members} expanded={expanded} focusSignal={focusComment} />
      </article>
    </Card>
  );
}
