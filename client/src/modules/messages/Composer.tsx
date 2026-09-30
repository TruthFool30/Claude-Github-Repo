import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CornerUpLeft, ImagePlus, Pencil, SendHorizontal, Smile, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useMediaQuery } from '../../lib/hooks';
import { Avatar, resizeImage, toast } from '../../ui';
import { EmojiPicker } from './EmojiPicker';
import { getDraft, setDraft } from './drafts';
import { useAuth } from '../../lib/auth';
import { shortName } from './parts';
import type { Message, Participant } from './types';

export interface OutgoingFile {
  file: File;
  preview: string;
  width: number | null;
  height: number | null;
}

const MAX_FILES = 6;
const MAX_LEN = 4000;

async function dimsOf(file: File): Promise<[number | null, number | null]> {
  try {
    const bmp = await createImageBitmap(file);
    const out: [number, number] = [bmp.width, bmp.height];
    bmp.close();
    return out;
  } catch {
    return [null, null];
  }
}

export function Composer({
  conversationKey, replyTo, replyAuthor, editing, participants, meId, disabled, disabledReason,
  onCancelReply, onCancelEdit, onSend, onSaveEdit, onTyping,
}: {
  conversationKey: number;
  replyTo: Message | null;
  replyAuthor: string;
  editing: Message | null;
  participants: Participant[];
  meId: number;
  disabled?: boolean;
  disabledReason?: string;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onSend: (body: string, files: OutgoingFile[]) => void;
  onSaveEdit: (m: Message, body: string) => void;
  onTyping: () => void;
}) {
  const { user, familyId } = useAuth();
  const uid = user?.id ?? 0;
  const fid = familyId ?? 0;
  const [text, setText] = useState(() => getDraft(uid, fid, conversationKey));
  /** Change the field; unless editing, the value is also the conversation's saved draft. */
  const updateText = (v: string | ((t: string) => string), isEdit = !!editing) => {
    setText((cur) => {
      const next = typeof v === 'function' ? v(cur) : v;
      if (!isEdit) setDraft(uid, fid, conversationKey, next);
      return next;
    });
  };
  const restoreDraft = () => setText(getDraft(uid, fid, conversationKey));
  const [files, setFiles] = useState<OutgoingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const coarse = useMediaQuery('(pointer: coarse)');

  // Load the saved draft when switching conversations.
  const prevKey = useRef(conversationKey);
  useEffect(() => {
    if (prevKey.current !== conversationKey) {
      setText(getDraft(uid, fid, conversationKey));
      setFiles([]);
      prevKey.current = conversationKey;
    }
    if (!coarse) areaRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey]);

  // Entering edit mode loads the message text; reply focuses the field.
  useEffect(() => {
    if (editing) {
      setText(editing.body);
      requestAnimationFrame(() => {
        const el = areaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    }
  }, [editing]);
  useEffect(() => {
    if (replyTo) areaRef.current?.focus();
  }, [replyTo]);

  // Auto-grow.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const addFiles = async (list: FileList | File[]) => {
    const picked = [...list].filter((f) => f.type.startsWith('image/'));
    if (!picked.length) {
      toast.error('Only photos can be attached');
      return;
    }
    const room = MAX_FILES - files.length;
    if (picked.length > room) toast.warning(`You can attach up to ${MAX_FILES} photos per message`);
    setBusy(true);
    try {
      const out: OutgoingFile[] = [];
      for (const f of picked.slice(0, Math.max(0, room))) {
        const resized = await resizeImage(f);
        const [width, height] = await dimsOf(resized);
        out.push({ file: resized, preview: URL.createObjectURL(resized), width, height });
      }
      setFiles((cur) => [...cur, ...out]);
    } finally {
      setBusy(false);
    }
    areaRef.current?.focus();
  };

  // Mention suggestions for a trailing "@abc".
  const mentionMatch = /(^|\s)@([\p{L}]*)$/u.exec(text);
  const suggestions = mentionMatch
    ? participants
        .filter((p) => p.id !== meId && !p.managed)
        .filter((p) => shortName(p).toLowerCase().startsWith(mentionMatch[2].toLowerCase()))
        .slice(0, 5)
        .concat(
          participants.length > 2 && 'everyone'.startsWith(mentionMatch[2].toLowerCase())
            ? [{ ...participants[0], id: -1, name: 'everyone', nickname: 'everyone', color: '#8E4EC6', avatar_url: null }]
            : [],
        )
    : [];
  const insertMention = (p: Participant) => {
    updateText((t) => t.replace(/@([\p{L}]*)$/u, `@${shortName(p)} `));
    areaRef.current?.focus();
  };

  const trimmed = text.trim();
  const canSend = !disabled && !busy && (editing ? trimmed.length > 0 || editing.attachments.length > 0 : trimmed.length > 0 || files.length > 0) && text.length <= MAX_LEN;

  const submit = () => {
    if (!canSend) return;
    if (editing) {
      onSaveEdit(editing, trimmed);
      restoreDraft();
      return;
    }
    onSend(trimmed, files);
    updateText('', false);
    setFiles([]);
    areaRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (suggestions.length) {
        e.preventDefault();
        insertMention(suggestions[0]);
        return;
      }
      if (!coarse) {
        e.preventDefault();
        submit();
      }
    } else if (e.key === 'Escape') {
      if (editing) {
        e.preventDefault();
        restoreDraft();
        onCancelEdit();
      } else if (replyTo) {
        e.preventDefault();
        onCancelReply();
      }
    } else if (e.key === 'ArrowUp' && !text && !editing) {
      // Handled by parent through a custom event: edit my last message.
      areaRef.current?.dispatchEvent(new CustomEvent('hearth:edit-last', { bubbles: true }));
    }
  };

  if (disabled) {
    return (
      <div className="border-t border-border bg-surface px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-sm text-muted">
        {disabledReason ?? "You can't send messages here."}
      </div>
    );
  }

  return (
    <div
      className="relative border-t border-border bg-surface/95 px-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur sm:px-4 sm:pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:pb-3"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }
      }}
    >
      {suggestions.length > 0 && (
        <div role="listbox" aria-label="Mention someone" className="absolute bottom-full left-3 mb-2 flex gap-1.5 rounded-2xl border border-border bg-surface p-1.5 shadow-pop animate-pop-in">
          {suggestions.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === 0}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertMention(p)}
              className={cn('flex items-center gap-1.5 rounded-xl py-1 pl-1 pr-2.5 text-sm font-medium hover:bg-surface-2', i === 0 && 'bg-surface-2')}
            >
              {p.id === -1 ? (
                <>
                  <span className="flex size-5 items-center justify-center rounded-full bg-primary-soft text-[11px] text-primary-soft-fg" aria-hidden>@</span>
                  everyone <span className="text-xs font-normal text-subtle">· notifies all</span>
                </>
              ) : (
                <>
                  <Avatar user={p} size="xs" title="" /> {shortName(p)}
                </>
              )}
            </button>
          ))}
        </div>
      )}

      {(replyTo || editing) && (
        <div className="mb-2 flex items-center gap-2.5 rounded-2xl bg-surface-2 py-2 pl-3 pr-1.5 animate-fade-in">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-soft-fg">
            {editing ? <Pencil size={14} /> : <CornerUpLeft size={14} />}
          </span>
          <div className="min-w-0 flex-1 text-[13px]">
            <div className="font-semibold text-fg">{editing ? 'Editing message' : `Replying to ${replyAuthor}`}</div>
            <div className="truncate text-muted">{(editing ?? replyTo)!.body || '📷 Photo'}</div>
          </div>
          <button
            type="button"
            aria-label={editing ? 'Cancel editing' : 'Cancel reply'}
            onClick={() => {
              if (editing) {
                restoreDraft();
                onCancelEdit();
              } else onCancelReply();
            }}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-3 hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {files.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1 scrollbar-none">
          {files.map((f, i) => (
            <div key={f.preview} className="relative size-20 shrink-0 overflow-hidden rounded-2xl border border-border animate-scale-in">
              <img src={f.preview} alt={`Attachment ${i + 1}`} className="size-full object-cover" />
              <button
                type="button"
                aria-label={`Remove attachment ${i + 1}`}
                onClick={() => {
                  URL.revokeObjectURL(f.preview);
                  setFiles((cur) => cur.filter((x) => x !== f));
                }}
                className="absolute right-1 top-1 inline-flex size-6 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur hover:bg-black/80"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-1.5">
        {!editing && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              aria-label="Attach photos"
              title="Attach photos"
              disabled={busy || files.length >= MAX_FILES}
              onClick={() => fileRef.current?.click()}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:opacity-40"
            >
              <ImagePlus size={21} />
            </button>
          </>
        )}
        <div className="flex min-w-0 flex-1 items-end rounded-[22px] border border-border bg-surface-2 pl-4 pr-1 transition focus-within:border-primary/60 focus-within:bg-surface focus-within:ring-4 focus-within:ring-ring/40">
          <textarea
            ref={areaRef}
            value={text}
            rows={1}
            maxLength={MAX_LEN + 200}
            aria-label={editing ? 'Edit message' : 'Message'}
            placeholder={editing ? 'Edit your message' : 'Message…'}
            onChange={(e) => {
              updateText(e.target.value);
              if (e.target.value && !editing) onTyping();
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
              if (imgs.length && !editing) {
                e.preventDefault();
                void addFiles(imgs);
              }
            }}
            className="max-h-40 min-h-[42px] flex-1 resize-none bg-transparent py-[10px] text-[15px] leading-[22px] text-fg outline-none placeholder:text-subtle"
          />
          <EmojiPicker
            label="Insert emoji"
            keepOpen
            onPick={(e) => {
              const el = areaRef.current;
              if (!el) return updateText((t) => t + e);
              const s = el.selectionStart ?? text.length;
              const end = el.selectionEnd ?? text.length;
              const next = text.slice(0, s) + e + text.slice(end);
              updateText(next);
              requestAnimationFrame(() => {
                el.focus();
                el.setSelectionRange(s + e.length, s + e.length);
              });
            }}
            trigger={(t) => (
              <button type="button" {...t} aria-label="Insert emoji" className="mb-[3px] hidden size-9 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-3 hover:text-fg sm:inline-flex">
                <Smile size={20} />
              </button>
            )}
          />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label={editing ? 'Save edit' : 'Send message'}
          title={editing ? 'Save (Enter)' : 'Send (Enter)'}
          className={cn(
            'inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring',
            canSend ? 'bg-primary-solid text-white shadow-lift hover:bg-primary-solid-hover active:scale-90' : 'bg-surface-2 text-subtle',
          )}
        >
          <SendHorizontal size={19} className={cn('transition-transform', canSend && 'translate-x-px')} />
        </button>
      </div>
      {text.length > MAX_LEN - 200 && (
        <p className={cn('mt-1 text-right text-xs', text.length > MAX_LEN ? 'text-danger' : 'text-subtle')}>
          {text.length}/{MAX_LEN}
        </p>
      )}
    </div>
  );
}
