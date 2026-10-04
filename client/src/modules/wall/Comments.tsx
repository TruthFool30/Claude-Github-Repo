import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { CornerDownRight, Pencil, SendHorizontal, Trash2, X } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, fmtDateTime, fmtRelative } from '../../lib/format';
import type { Member } from '../../lib/types';
import { Avatar, Menu, useConfirm } from '../../ui';
import { useWallActions } from './api';
import { MentionTextarea } from './MentionTextarea';
import { MAX_COMMENT_CHARS } from './moods';
import { RichText } from './RichText';
import type { WallComment, WallPost } from './types';

interface Props {
  post: WallPost;
  members: Member[];
  /** Show every comment (post detail page). */
  expanded?: boolean;
  /** Increment to focus the comment box (e.g. the "Comment" button). */
  focusSignal?: number;
}

export function Comments({ post, members, expanded, focusSignal = 0 }: Props) {
  const { user } = useAuth();
  const { addComment } = useWallActions();
  const [composing, setComposing] = useState(!!expanded);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<WallComment | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  // "Comment" button: reveal the box (feed cards keep it hidden to stay compact) and focus it.
  useEffect(() => {
    if (!focusSignal) return;
    setComposing(true);
    requestAnimationFrame(() => input.current?.focus());
  }, [focusSignal]);

  const threads = post.comments.filter((c) => !c.parent_id);
  const repliesOf = (id: number) => post.comments.filter((c) => c.parent_id === id);
  // Feed cards show only the latest two comments (flat); the post page shows full threads.
  const preview = expanded ? [] : [...post.comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id).slice(-2);
  const more = post.comments.length - preview.length;

  const startReply = (c: WallComment) => {
    const top = c.parent_id ? post.comments.find((x) => x.id === c.parent_id) ?? c : c;
    setReplyTo(top);
    const name = c.author ? firstName(c.author.name) : '';
    if (name && c.user_id !== user?.id && !text.includes(`@${name}`)) setText((t) => `@${name} ${t}`);
    setComposing(true);
    requestAnimationFrame(() => input.current?.focus());
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const parent = replyTo?.id ?? null;
    setText('');
    setReplyTo(null);
    const ok = await addComment(post, body, parent);
    if (!ok) {
      setText(body);
      if (parent) setReplyTo(post.comments.find((c) => c.id === parent) ?? null);
    }
    setSending(false);
  };

  if (!expanded && !post.comments.length && !composing) return null;

  return (
    <div className="border-t border-border px-4 pb-4 pt-3 sm:px-5">
      {expanded ? (
        threads.length > 0 && (
          <ul className="mb-3 flex flex-col gap-3">
            {threads.map((c) => (
              <li key={c.id}>
                <CommentRow comment={c} post={post} members={members} onReply={startReply} />
                {repliesOf(c.id).length > 0 && (
                  <ul className="mt-2 flex flex-col gap-2 pl-10">
                    {repliesOf(c.id).map((r) => (
                      <li key={r.id}>
                        <CommentRow comment={r} post={post} members={members} onReply={startReply} small />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )
      ) : (
        <>
          {more > 0 && (
            <Link to={`/home/post/${post.id}`} className="mb-2 inline-block text-[13px] font-semibold text-muted hover:text-fg hover:underline">
              View all {post.comments.length} comments
            </Link>
          )}
          {preview.length > 0 && (
            <ul className={cn('flex flex-col gap-2.5', composing && 'mb-3')}>
              {preview.map((c) => {
                const parent = c.parent_id ? post.comments.find((x) => x.id === c.parent_id) : null;
                const showParent = parent && !preview.includes(parent);
                return (
                  <li key={c.id}>
                    {showParent && (
                      <p className="mb-1 flex items-center gap-1 pl-8 text-xs text-subtle">
                        <CornerDownRight size={12} aria-hidden />
                        replying to <span className="font-semibold text-muted">{parent.author ? firstName(parent.author.name) : 'a comment'}</span>
                      </p>
                    )}
                    <CommentRow comment={c} post={post} members={members} onReply={startReply} small />
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {composing && (
      <form onSubmit={submit} className="flex items-end gap-2.5">
        <Avatar user={user} size="sm" className="mb-1" />
        <div className="min-w-0 flex-1">
          {replyTo && (
            <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted animate-fade-in">
              <CornerDownRight size={13} />
              Replying to <span className="font-semibold text-fg">{replyTo.author ? firstName(replyTo.author.name) : 'comment'}</span>
              <button type="button" onClick={() => setReplyTo(null)} className="ml-1 rounded p-0.5 hover:bg-surface-2 hover:text-fg" aria-label="Cancel reply">
                <X size={13} />
              </button>
            </div>
          )}
          <div className="flex items-end gap-1 rounded-2xl border border-border bg-surface-2 pl-3.5 pr-1 transition-colors focus-within:border-primary focus-within:bg-surface focus-within:ring-4 focus-within:ring-ring/40">
            <MentionTextarea
              ref={input}
              value={text}
              onValueChange={setText}
              members={members.filter((m) => m.id !== user?.id)}
              maxHeight={160}
              maxLength={MAX_COMMENT_CHARS}
              placeholder={replyTo ? 'Write a reply…' : 'Write a comment…'}
              aria-label={replyTo ? 'Write a reply' : `Comment on ${post.author ? `${firstName(post.author.name)}'s` : 'this'} post`}
              className="py-2 text-[15px] leading-6 sm:text-sm"
              placement="above"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                } else if (e.key === 'Escape' && replyTo) {
                  e.stopPropagation();
                  setReplyTo(null);
                }
              }}
            />
            <button
              type="submit"
              disabled={!text.trim() || sending}
              aria-label="Send comment"
              className="mb-1 flex size-8 shrink-0 items-center justify-center rounded-xl text-primary transition hover:bg-primary-soft disabled:text-subtle disabled:hover:bg-transparent"
            >
              <SendHorizontal size={18} />
            </button>
          </div>
        </div>
      </form>
      )}
    </div>
  );
}

function CommentRow({
  comment, post, members, onReply, small,
}: { comment: WallComment; post: WallPost; members: Member[]; onReply: (c: WallComment) => void; small?: boolean }) {
  const { user, isAdmin } = useAuth();
  const { editComment, deleteComment } = useWallActions();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const mine = comment.user_id === user?.id;
  const canDelete = mine || isAdmin || post.user_id === user?.id;
  const author = comment.author ?? { name: 'Former member', color: '#8d90a0', avatar_url: null };

  const save = async () => {
    const body = draft.trim();
    if (!body) return;
    setEditing(false);
    if (body !== comment.body) await editComment(comment, body);
  };

  return (
    <div className={cn('group flex gap-2.5', comment.pending && 'opacity-60')}>
      <Avatar user={author} size={small ? 'xs' : 'sm'} className={small ? 'mt-1.5' : 'mt-0.5'} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="rounded-2xl border border-primary bg-surface px-3 py-2 ring-4 ring-ring/40">
            <MentionTextarea
              value={draft}
              onValueChange={setDraft}
              members={members}
              maxHeight={160}
              maxLength={MAX_COMMENT_CHARS}
              autoFocus
              aria-label="Edit comment"
              className="text-sm leading-6"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void save();
                } else if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditing(false);
                  setDraft(comment.body);
                }
              }}
            />
            <div className="mt-1 flex items-center justify-end gap-3 text-xs">
              <span className="mr-auto text-subtle">Esc to cancel · Enter to save</span>
              <button type="button" className="font-semibold text-muted hover:text-fg" onClick={() => { setEditing(false); setDraft(comment.body); }}>
                Cancel
              </button>
              <button type="button" className="font-semibold text-primary" onClick={() => void save()} disabled={!draft.trim()}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-1">
            <div className="min-w-0 rounded-2xl rounded-tl-md bg-surface-2 px-3 py-2">
              <div className="text-[13px] font-semibold text-fg">{author.name}</div>
              <RichText text={comment.body} members={members} className="block text-[14px] leading-relaxed text-fg" />
            </div>
            {!comment.pending && (mine || canDelete) && (
              <Menu
                label="Comment actions"
                className="shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover:opacity-100"
                items={[
                  mine && { label: 'Edit', icon: Pencil, onSelect: () => { setDraft(comment.body); setEditing(true); } },
                  canDelete && {
                    label: 'Delete', icon: Trash2, danger: true,
                    onSelect: async () => {
                      const ok = await confirm({
                        title: 'Delete this comment?',
                        message: comment.parent_id ? 'This reply will be removed.' : 'Replies to it will be removed too.',
                        confirmLabel: 'Delete', danger: true,
                      });
                      if (ok) void deleteComment(comment);
                    },
                  },
                ]}
              />
            )}
          </div>
        )}
        {!editing && (
          <div className="mt-1 flex items-center gap-3 pl-3 text-xs text-subtle">
            <time dateTime={comment.created_at} title={fmtDateTime(comment.created_at)}>
              {comment.pending ? 'Sending…' : fmtRelative(comment.created_at)}
            </time>
            {!comment.pending && (
              <button type="button" onClick={() => onReply(comment)} className="font-semibold text-muted hover:text-fg">
                Reply
              </button>
            )}
            {comment.edited_at && <span>Edited</span>}
          </div>
        )}
      </div>
    </div>
  );
}
