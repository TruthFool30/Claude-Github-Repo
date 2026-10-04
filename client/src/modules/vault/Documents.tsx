import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, CalendarClock, ChevronRight, CloudUpload, Download, ExternalLink, FolderClosed, FolderInput, FolderOpen, FolderPlus, Inbox,
  LayoutGrid, List, Pencil, Trash2, TriangleAlert, Upload, X,
} from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useMember } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName, fmtBytes, fmtDate, fmtRelative, plural } from '../../lib/format';
import { useIsDesktop } from '../../lib/hooks';
import {
  Avatar, Badge, Button, Card, ColorPicker, EmptyState, Fab, Field, IconButton, Input, Menu, Modal, SegmentedControl, Select, Skeleton,
  Spinner, Textarea, toast, useConfirm, PALETTE,
} from '../../ui';
import {
  keys, MAX_UPLOAD, fileUrl, uploadDocument, useDocuments, useFolders, type Folder, type FolderIcon, type VaultDoc, type Visibility,
} from './api';
import { ACCENT, DOC_KINDS, FOLDER_ICONS, Tile, daysUntil, expiryLabel, expiryShort, tint } from './meta';
import { SearchField, SectionTitle, VisibilityBadge, VisibilityPicker, VISIBILITY } from './parts';
import { useAuth } from '../../lib/auth';

type View = 'grid' | 'list';
const VIEW_KEY = 'hearth-vault-docs-view';
const readView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
};

/** Parsed sub-route: /vault/docs, /vault/docs/f/:id|none, /vault/docs/d/:id */
function useDocsRoute() {
  const rest = useParams()['*'] ?? '';
  const [kind, raw] = rest.split('/');
  if (kind === 'f') return { folder: raw === 'none' ? ('none' as const) : Number(raw) || null, docId: null };
  if (kind === 'd') return { folder: null, docId: Number(raw) || null };
  return { folder: null, docId: null };
}

export default function DocsSection() {
  const route = useDocsRoute();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const foldersQ = useFolders();
  const docsQ = useDocuments();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>(readView);
  const [uploadFiles, setUploadFiles] = useState<File[] | null>(null);
  const [folderModal, setFolderModal] = useState<Folder | 'new' | null>(null);
  const [editDoc, setEditDoc] = useState<VaultDoc | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const docs = useMemo(() => docsQ.data ?? [], [docsQ.data]);
  const folders = foldersQ.data?.folders ?? [];
  const openDoc = route.docId ? docs.find((d) => d.id === route.docId) ?? null : null;
  // A document link shows its folder behind the preview.
  const folderKey: number | 'none' | null = route.docId ? (openDoc ? openDoc.folder_id ?? 'none' : null) : route.folder;
  const folder = typeof folderKey === 'number' ? folders.find((f) => f.id === folderKey) ?? null : null;
  const folderPath = (key: number | 'none' | null) => (key === null ? '/vault/docs' : `/vault/docs/f/${key}`);

  const setViewPersist = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  };

  const pickFiles = () => inputRef.current?.click();
  const onFilesChosen = (list: FileList | null) => {
    if (!list?.length) return;
    setUploadFiles(Array.from(list));
    if (inputRef.current) inputRef.current.value = '';
  };

  const dragProps = {
    onDragEnter: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (e.dataTransfer.files.length) setUploadFiles(Array.from(e.dataTransfer.files));
    },
  };

  const deleteFolder = async (f: Folder) => {
    const ok = await confirm({
      title: `Delete the folder “${f.name}”?`,
      message: f.doc_count ? `Its ${plural(f.doc_count, 'document')} won't be deleted — they'll move to Unfiled.` : 'The folder is empty.',
      confirmLabel: 'Delete folder',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.del<{ moved: number }>(`/vault/folders/${f.id}`);
      toast.success(`Folder deleted${res.moved ? ` · ${plural(res.moved, 'document')} moved to Unfiled` : ''}`);
      if (folderKey === f.id) navigate('/vault/docs');
      qc.invalidateQueries({ queryKey: keys.all });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (foldersQ.isLoading || docsQ.isLoading) return <DocsSkeleton />;
  if (foldersQ.isError || docsQ.isError) {
    return (
      <Card>
        <EmptyState icon={FolderClosed} accent={ACCENT} title="Couldn't load documents" description="Check your connection and try again."
          action={<Button onClick={() => { foldersQ.refetch(); docsQ.refetch(); }}>Try again</Button>} />
      </Card>
    );
  }

  const q = query.trim().toLowerCase();
  const inFolder = folderKey !== null;
  const shown = q
    ? docs.filter((d) => [d.name, d.original_name, d.notes, d.folder_name].filter(Boolean).join(' ').toLowerCase().includes(q))
    : inFolder
      ? docs.filter((d) => (folderKey === 'none' ? d.folder_id === null : d.folder_id === folderKey))
      : docs.slice(0, isDesktop ? 10 : 6);
  const expiring = docs.filter((d) => d.expires_on && daysUntil(d.expires_on) <= 30 && daysUntil(d.expires_on) >= -30).sort((a, b) => a.expires_on!.localeCompare(b.expires_on!));
  const folderMissing = typeof folderKey === 'number' && !folder;
  const uploadTarget = typeof folderKey === 'number' ? folderKey : null;

  return (
    <div {...dragProps} className="relative">
      <input ref={inputRef} type="file" multiple hidden onChange={(e) => onFilesChosen(e.target.files)} data-testid="vault-file-input" />

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchField value={query} onChange={setQuery} placeholder="Search all documents" label="Search documents" className="min-w-0 flex-1" />
        <div className="flex items-center gap-2">
          <SegmentedControl<View>
            aria-label="Layout"
            value={view}
            onChange={setViewPersist}
            options={[{ value: 'grid', label: <span className="sr-only">Grid</span>, icon: LayoutGrid }, { value: 'list', label: <span className="sr-only">List</span>, icon: List }]}
          />
          <Button variant="secondary" icon={FolderPlus} onClick={() => setFolderModal('new')} className="ml-auto sm:ml-0">New folder</Button>
          <Button icon={Upload} onClick={pickFiles} className="max-sm:hidden!">Upload</Button>
        </div>
      </div>

      {q ? (
        <section aria-label="Search results">
          <SectionTitle>{plural(shown.length, 'result')} for “{query.trim()}”</SectionTitle>
          {shown.length ? <DocCollection docs={shown} view={view} onEdit={setEditDoc} showFolder /> : (
            <Card><EmptyState compact icon={FolderOpen} accent={ACCENT} title="Nothing found" description="Try a different name, or check the spelling." /></Card>
          )}
        </section>
      ) : inFolder ? (
        folderMissing ? (
          <Card>
            <EmptyState compact icon={FolderClosed} accent={ACCENT} title="Folder not found" description="It may have been deleted." action={<Link to="/vault/docs" className="font-semibold text-primary">Back to Documents</Link>} />
          </Card>
        ) : (
          <section aria-labelledby="vault-folder-title">
            <div className="mb-4 flex items-center gap-3">
              <IconButton icon={ArrowLeft} label="Back to all documents" onClick={() => navigate('/vault/docs')} className="-ml-2" />
              {folder ? (
                <Tile color={folder.color} icon={FOLDER_ICONS[folder.icon]?.icon ?? FolderClosed} size={44} rounded="rounded-xl" />
              ) : (
                <Tile color="#8d90a0" icon={Inbox} size={44} rounded="rounded-xl" />
              )}
              <div className="min-w-0 flex-1">
                <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs font-medium text-subtle">
                  <Link to="/vault/docs" className="hover:text-fg">Documents</Link>
                  <ChevronRight size={12} aria-hidden />
                </nav>
                <h2 id="vault-folder-title" className="truncate text-xl font-bold tracking-tight text-fg">{folder ? folder.name : 'Unfiled'}</h2>
                <p className="text-xs text-muted">{plural(shown.length, 'document')} · {fmtBytes(shown.reduce((s, d) => s + d.size, 0))}</p>
              </div>
              {folder?.can_edit && (
                <Menu label={`Folder actions for ${folder.name}`} items={[
                  { label: 'Edit folder', icon: Pencil, onSelect: () => setFolderModal(folder) },
                  { label: 'Delete folder', icon: Trash2, danger: true, onSelect: () => deleteFolder(folder) },
                ]} />
              )}
            </div>
            {shown.length ? <DocCollection docs={shown} view={view} onEdit={setEditDoc} /> : (
              <DropHint onPick={pickFiles} title={folder ? `${folder.name} is empty` : 'Nothing unfiled'} />
            )}
          </section>
        )
      ) : (
        <>
          {expiring.length > 0 && <ExpiringBanner docs={expiring} />}
          <section aria-labelledby="vault-folders-title" className="mb-8">
            <SectionTitle><span id="vault-folders-title">Folders</span></SectionTitle>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {folders.map((f) => (
                <FolderCard key={f.id} folder={f} onEdit={() => setFolderModal(f)} onDelete={() => deleteFolder(f)} />
              ))}
              {(foldersQ.data?.unfiled.doc_count ?? 0) > 0 && (
                <FolderCard folder={{ id: 0, name: 'Unfiled', color: '#8d90a0', icon: 'folder', doc_count: foldersQ.data!.unfiled.doc_count, total_size: foldersQ.data!.unfiled.total_size }} unfiled />
              )}
              <li>
                <button
                  type="button"
                  onClick={() => setFolderModal('new')}
                  className="flex h-full min-h-[8.5rem] w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border-strong text-sm font-semibold text-muted transition hover:border-primary hover:bg-primary-soft/40 hover:text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
                >
                  <FolderPlus size={22} aria-hidden /> New folder
                </button>
              </li>
            </ul>
          </section>
          <section aria-labelledby="vault-recent-title">
            <SectionTitle><span id="vault-recent-title">Recently added</span></SectionTitle>
            {shown.length ? <DocCollection docs={shown} view={view} onEdit={setEditDoc} showFolder /> : (
              <DropHint onPick={pickFiles} title="No documents yet" description="Upload insurance policies, school forms, passports, warranties — anything you might need in a hurry." />
            )}
          </section>
        </>
      )}

      {dragging && (
        <div className="pointer-events-none absolute -inset-2 z-20 flex items-center justify-center rounded-3xl border-2 border-dashed border-primary bg-primary-soft/80 backdrop-blur-sm animate-fade-in">
          <div className="flex flex-col items-center gap-2 text-primary-soft-fg">
            <CloudUpload size={40} aria-hidden />
            <p className="text-lg font-bold">Drop to upload{folder ? ` to ${folder.name}` : ''}</p>
          </div>
        </div>
      )}

      <Fab label="Upload document" icon={Upload} accent={ACCENT} onClick={pickFiles} />

      <UploadModal files={uploadFiles} onClose={() => setUploadFiles(null)} folders={folders} defaultFolder={uploadTarget} onAddMore={pickFiles} />
      <FolderModal open={!!folderModal} folder={folderModal === 'new' ? null : folderModal} onClose={() => setFolderModal(null)} onCreated={(f) => navigate(`/vault/docs/f/${f.id}`)} />
      <EditDocModal doc={editDoc} folders={folders} onClose={() => setEditDoc(null)} />
      <DocPreview
        doc={openDoc}
        loading={!!route.docId && !openDoc && docsQ.isFetching}
        missing={!!route.docId && !openDoc && !docsQ.isFetching}
        onClose={() => navigate(folderPath(route.docId ? folderKey : route.folder), { replace: false })}
        onEdit={(d) => setEditDoc(d)}
      />
    </div>
  );
}

function DocsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading documents">
      <Skeleton className="mb-5 h-11 w-full rounded-xl" />
      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[8.5rem] rounded-2xl" />)}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-52 rounded-2xl" />)}
      </div>
    </div>
  );
}

function DropHint({ onPick, title, description }: { onPick: () => void; title: string; description?: string }) {
  return (
    <Card className="border-dashed">
      <EmptyState
        compact
        icon={CloudUpload}
        accent={ACCENT}
        title={title}
        description={description ?? 'Drag files here or choose them from your device (up to 25 MB each).'}
        action={<Button icon={Upload} onClick={onPick}>Choose files</Button>}
      />
    </Card>
  );
}

function ExpiringBanner({ docs }: { docs: VaultDoc[] }) {
  return (
    <section aria-labelledby="vault-expiring" className="mb-6 rounded-2xl border border-border bg-warning-soft/60 p-4 sm:p-5">
      <div className="mb-2.5 flex items-center gap-2">
        <CalendarClock size={18} className="text-warning-soft-fg" aria-hidden />
        <h2 id="vault-expiring" className="text-[15px] font-bold text-fg">Renew soon</h2>
      </div>
      <ul className="flex flex-col gap-1.5">
        {docs.map((d) => {
          const e = expiryLabel(d.expires_on!);
          return (
            <li key={d.id}>
              <Link to={`/vault/docs/d/${d.id}`} className="flex items-center gap-3 rounded-xl bg-surface/80 px-3 py-2 transition hover:bg-surface focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
                {(() => { const K = DOC_KINDS[d.kind]; return <K.icon size={18} style={{ color: K.color }} aria-hidden />; })()}
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{d.name}</span>
                <VisibilityBadge value={d.visibility} />
                <Badge tone={e.tone}>{e.text}</Badge>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function FolderCard({ folder, unfiled, onEdit, onDelete }: {
  folder: Pick<Folder, 'id' | 'name' | 'color' | 'icon' | 'doc_count' | 'total_size'> & { can_edit?: boolean }; unfiled?: boolean; onEdit?: () => void; onDelete?: () => void;
}) {
  const Icon = unfiled ? Inbox : FOLDER_ICONS[folder.icon]?.icon ?? FolderClosed;
  return (
    <li className="relative">
      <Link
        to={unfiled ? '/vault/docs/f/none' : `/vault/docs/f/${folder.id}`}
        className="group flex h-full min-h-[8.5rem] flex-col justify-between overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
        style={{ backgroundImage: `radial-gradient(circle at 100% 0%, color-mix(in oklab, ${folder.color} 16%, transparent) 0%, transparent 55%)` }}
      >
        <Tile color={folder.color} icon={Icon} size={44} rounded="rounded-[14px]" className="transition-transform duration-200 group-hover:scale-105" />
        <span className="mt-3 block min-w-0">
          <span className="block truncate pr-6 text-[15px] font-semibold text-fg">{folder.name}</span>
          <span className="block text-xs text-muted">{plural(folder.doc_count, 'file')} · {fmtBytes(folder.total_size)}</span>
        </span>
      </Link>
      {!unfiled && 'can_edit' in folder && folder.can_edit && (
        <div className="absolute right-2 top-2">
          <Menu label={`Actions for ${folder.name}`} items={[
            { label: 'Edit folder', icon: Pencil, onSelect: () => onEdit?.() },
            { label: 'Delete folder', icon: Trash2, danger: true, onSelect: () => onDelete?.() },
          ]} />
        </div>
      )}
    </li>
  );
}

// ---- documents --------------------------------------------------------------------------------

function DocCollection({ docs, view, onEdit, showFolder }: { docs: VaultDoc[]; view: View; onEdit: (d: VaultDoc) => void; showFolder?: boolean }) {
  if (view === 'list') {
    return (
      <Card padding="none" className="overflow-hidden">
        <ul className="divide-y divide-border">{docs.map((d) => <DocRow key={d.id} doc={d} onEdit={onEdit} showFolder={showFolder} />)}</ul>
      </Card>
    );
  }
  return <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{docs.map((d) => <DocCard key={d.id} doc={d} onEdit={onEdit} showFolder={showFolder} />)}</ul>;
}

function useDocActions(doc: VaultDoc, onEdit: (d: VaultDoc) => void) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const remove = async () => {
    const ok = await confirm({ title: `Delete “${doc.name}”?`, message: doc.visibility !== 'family' ? 'This file will be permanently deleted.' : 'The file will be permanently deleted for everyone in the family.', confirmLabel: 'Delete', danger: true });
    if (!ok) return false;
    const prev = qc.getQueryData<VaultDoc[]>(keys.documents);
    qc.setQueryData<VaultDoc[]>(keys.documents, (old) => old?.filter((d) => d.id !== doc.id));
    try {
      await api.del(`/vault/documents/${doc.id}`);
      toast.success('Document deleted');
      qc.invalidateQueries({ queryKey: keys.all });
      return true;
    } catch (e) {
      qc.setQueryData(keys.documents, prev);
      toast.error(errorMessage(e));
      return false;
    }
  };
  const items = [
    { label: 'Open', icon: FolderOpen, onSelect: () => navigate(`/vault/docs/d/${doc.id}`) },
    { label: 'Download', icon: Download, onSelect: () => { window.location.href = fileUrl(doc, { download: true }); } },
    doc.can_edit && { label: 'Rename or move', icon: FolderInput, onSelect: () => onEdit(doc) },
    doc.can_edit && ('divider' as const),
    doc.can_edit && { label: 'Delete', icon: Trash2, danger: true, onSelect: remove },
  ];
  return { items, remove };
}

function Thumb({ doc, className, compact }: { doc: VaultDoc; className?: string; compact?: boolean }) {
  const k = DOC_KINDS[doc.kind];
  const [failed, setFailed] = useState(false);
  const accent = doc.folder_color ?? k.color;
  if (doc.kind === 'image' && !failed) {
    // Documents (cards, scans) must not be cropped: fit them on a neutral mat.
    return (
      <div className={cn('flex size-full items-center justify-center bg-surface-2', compact ? 'p-0.5' : 'p-3', className)}>
        <img src={fileUrl(doc)} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} className={cn('max-h-full max-w-full object-contain', !compact && 'rounded-md shadow-card')} />
      </div>
    );
  }
  const badge = (
    <span className="rounded px-1.5 text-[10px] font-extrabold uppercase tracking-wide text-white" style={{ backgroundColor: k.color === '#8d90a0' ? '#6b6e7e' : k.color }}>
      {(doc.ext || k.label).slice(0, 4)}
    </span>
  );
  if (compact) {
    return (
      <div className={cn('flex size-full flex-col items-center justify-center gap-0.5', className)} style={tint(k.color, 14)}>
        <k.icon size={16} aria-hidden />
      </div>
    );
  }
  // A page-like tile unique to the document: folder-coloured header, its title, faux text lines.
  const seed = [...doc.name].reduce((a, c) => a + c.charCodeAt(0), 0);
  const widths = [92, 78, 86, 64, 88, 70].map((w, i) => w - ((seed >> i) % 18));
  return (
    <div
      className={cn('flex size-full items-end justify-center px-[14%] pt-[9%]', className)}
      style={{ background: `linear-gradient(160deg, color-mix(in oklab, ${accent} 12%, var(--surface-2)), color-mix(in oklab, ${accent} 26%, var(--surface-2)))` }}
    >
      <div className="relative flex h-full w-full flex-col overflow-hidden rounded-t-lg bg-surface shadow-card ring-1 ring-black/5">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5" style={{ backgroundColor: accent }}>
          <k.icon size={11} className="shrink-0 text-white" aria-hidden />
          <span className="truncate text-[9px] font-bold uppercase tracking-wider text-white/90">{doc.folder_name ?? 'Unfiled'}</span>
        </div>
        <p className="line-clamp-2 px-2.5 pt-2 text-[11px] font-bold leading-tight text-fg">{doc.name}</p>
        <div className="flex flex-col gap-1 px-2.5 pt-2" aria-hidden>
          {widths.map((w, i) => <span key={i} className="h-1 rounded-full bg-surface-3" style={{ width: `${w}%` }} />)}
        </div>
        <span className="absolute bottom-1.5 right-1.5">{badge}</span>
      </div>
    </div>
  );
}

const shortDate = (v: string) => fmtDate(v, new Date(v).getFullYear() === new Date().getFullYear() ? 'MMM d' : 'MMM d, yyyy');

function DocMeta({ doc, showFolder }: { doc: VaultDoc; showFolder?: boolean }) {
  return (
    <>
      {doc.ext ? doc.ext.toUpperCase() : DOC_KINDS[doc.kind].label} · {fmtBytes(doc.size)}
      {showFolder ? ` · ${doc.folder_name ?? 'Unfiled'}` : ` · ${shortDate(doc.created_at)}`}
    </>
  );
}

function DocCard({ doc, onEdit, showFolder }: { doc: VaultDoc; onEdit: (d: VaultDoc) => void; showFolder?: boolean }) {
  const { items } = useDocActions(doc, onEdit);
  const owner = useMember(doc.owner_id);
  const exp = doc.expires_on ? expiryLabel(doc.expires_on) : null;
  return (
    <li className="group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift">
      <div className="relative aspect-[4/3] overflow-hidden border-b border-border bg-surface-2">
        <Thumb doc={doc} className="transition-transform duration-300 group-hover:scale-[1.03]" />
        <div className="absolute left-2 top-2 flex gap-1">
        </div>
      </div>
      <Link
        to={`/vault/docs/d/${doc.id}`}
        className="flex min-w-0 flex-1 flex-col gap-1 p-3 after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:ring-4 focus-visible:after:ring-ring"
        aria-label={`${doc.name}${doc.visibility === 'private' ? ' (private)' : doc.visibility === 'adults' ? ' (adults only)' : ''}`}
      >
        <span className="line-clamp-2 text-sm font-semibold leading-snug text-fg">{doc.name}</span>
        <span className="truncate text-xs text-muted"><DocMeta doc={doc} showFolder={showFolder} /></span>
        <span className="mt-auto flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden pt-1">
          {owner && <Avatar user={owner} size="xs" />}
          <VisibilityBadge value={doc.visibility} iconOnly />
          {exp && exp.tone !== 'neutral' && <Badge tone={exp.tone} className="min-w-0"><span title={exp.text}>{expiryShort(doc.expires_on!)}</span></Badge>}
        </span>
      </Link>
      <div className="absolute right-1.5 top-1.5 z-[1] rounded-lg bg-surface/85 opacity-100 shadow-xs backdrop-blur transition lg:opacity-0 lg:group-hover:opacity-100 lg:focus-within:opacity-100">
        <Menu label={`Actions for ${doc.name}`} items={items} />
      </div>
    </li>
  );
}

function DocRow({ doc, onEdit, showFolder }: { doc: VaultDoc; onEdit: (d: VaultDoc) => void; showFolder?: boolean }) {
  const { items } = useDocActions(doc, onEdit);
  const owner = useMember(doc.owner_id);
  const exp = doc.expires_on ? expiryLabel(doc.expires_on) : null;
  return (
    <li className="relative flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-2/70 sm:px-4">
      <div className="size-11 shrink-0 overflow-hidden rounded-xl border border-border"><Thumb doc={doc} compact /></div>
      <Link to={`/vault/docs/d/${doc.id}`} className="min-w-0 flex-1 after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-4 focus-visible:after:ring-inset focus-visible:after:ring-ring">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[15px] font-semibold text-fg">{doc.name}</span>
          <VisibilityBadge value={doc.visibility} className="shrink-0" />
        </span>
        <span className="block truncate text-xs text-muted"><DocMeta doc={doc} showFolder={showFolder} /></span>
      </Link>
      {exp && exp.tone !== 'neutral' && <Badge tone={exp.tone} className="max-sm:hidden!">{exp.text}</Badge>}
      {owner && <Avatar user={owner} size="xs" className="max-sm:hidden!" />}
      <span className="hidden w-20 text-right text-xs text-subtle md:block">{fmtRelative(doc.created_at)}</span>
      <div className="relative z-[1]"><Menu label={`Actions for ${doc.name}`} items={items} /></div>
    </li>
  );
}

// ---- preview ----------------------------------------------------------------------------------

function TextPreview({ doc }: { doc: VaultDoc }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['vault', 'text', doc.id, doc.updated_at],
    queryFn: async () => {
      const res = await fetch(fileUrl(doc), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Could not load');
      const text = await res.text();
      return text.length > 200_000 ? `${text.slice(0, 200_000)}\n…` : text;
    },
  });
  if (isLoading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>;
  if (isError) return <p className="p-6 text-sm text-muted">Preview unavailable — download the file instead.</p>;
  if (doc.ext === 'csv') {
    const rows = (data ?? '').trim().split(/\r?\n/).slice(0, 200).map((l) => l.split(','));
    return (
      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="sticky top-0 bg-surface-2"><tr>{rows[0]?.map((c, i) => <th key={i} className="whitespace-nowrap px-3 py-2 font-semibold text-fg">{c}</th>)}</tr></thead>
          <tbody className="divide-y divide-border">{rows.slice(1).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="whitespace-nowrap px-3 py-2 text-muted">{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  return <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[13px] leading-relaxed text-fg sm:p-5">{data}</pre>;
}

function PreviewBody({ doc }: { doc: VaultDoc }) {
  const k = DOC_KINDS[doc.kind];
  const src = fileUrl(doc);
  if (doc.kind === 'image') {
    return (
      <div className="flex max-h-[62vh] min-h-56 items-center justify-center bg-[repeating-conic-gradient(var(--surface-2)_0_25%,var(--surface)_0_50%)] bg-[length:20px_20px] p-3">
        <img src={src} alt={doc.name} className="max-h-[58vh] max-w-full rounded-lg object-contain shadow-card" />
      </div>
    );
  }
  if (doc.kind === 'pdf') {
    return (
      <div className="relative bg-surface-2">
        <iframe src={`${src}#view=FitH`} title={`Preview of ${doc.name}`} className="block h-[62vh] w-full bg-white" />
        <a href={src} target="_blank" rel="noreferrer" className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur sm:hidden">
          <ExternalLink size={13} aria-hidden /> Open full screen
        </a>
      </div>
    );
  }
  if (doc.kind === 'text') return <TextPreview doc={doc} />;
  if (doc.kind === 'audio') return <div className="p-8"><audio controls src={src} className="w-full" /></div>;
  if (doc.kind === 'video') return <video controls src={src} className="max-h-[62vh] w-full bg-black" />;
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <Tile color={k.color} icon={k.icon} size={72} rounded="rounded-3xl" />
      <p className="text-[15px] font-semibold text-fg">No preview for {doc.ext ? `.${doc.ext}` : 'this'} files</p>
      <p className="max-w-xs text-sm text-muted">Download it to open it with an app on your device.</p>
    </div>
  );
}

function DocPreview({ doc, loading, missing, onClose, onEdit }: { doc: VaultDoc | null; loading: boolean; missing: boolean; onClose: () => void; onEdit: (d: VaultDoc) => void }) {
  const qc = useQueryClient();
  const owner = useMember(doc?.owner_id);
  const { role } = useAuth();
  const isAdult = role === 'admin' || role === 'member';
  const [shown, setShown] = useState<VaultDoc | null>(doc);
  if (doc && doc !== shown) setShown(doc);
  const d = doc ?? shown;
  const open = !!doc || loading || missing;
  const actions = useDocActionsSafe(d, onEdit);

  const setVisibility = async (next: Visibility) => {
    if (!d) return;
    const prevVis = d.visibility;
    const patch = (v: Visibility) => qc.setQueryData<VaultDoc[]>(keys.documents, (old) => old?.map((x) => (x.id === d.id ? { ...x, visibility: v, is_private: v === 'private', adults_only: v === 'adults' } : x)));
    patch(next);
    try {
      await api.patch(`/vault/documents/${d.id}`, { visibility: next });
      toast.success(next === 'private' ? 'Only you can see this now' : next === 'adults' ? 'Now hidden from children' : 'Shared with the family');
      qc.invalidateQueries({ queryKey: keys.all });
    } catch (e) {
      patch(prevVis);
      toast.error(errorMessage(e));
    }
  };

  if (!d || missing) {
    return (
      <Modal open={open} onClose={onClose} title={missing ? 'Document not found' : 'Loading…'} size="sm">
        {missing ? <p className="text-sm text-muted">It may have been deleted, or it's private to someone else.</p> : <div className="flex justify-center py-10"><Spinner /></div>}
      </Modal>
    );
  }
  const k = DOC_KINDS[d.kind];
  const exp = d.expires_on ? expiryLabel(d.expires_on) : null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={<span className="line-clamp-2 break-words">{d.name}</span>}
      description={<><k.icon size={13} className="-mt-0.5 mr-1 inline" aria-hidden />{d.ext ? d.ext.toUpperCase() : k.label} · {fmtBytes(d.size)} · {d.folder_name ?? 'Unfiled'}</>}
      bodyClassName="!px-0 !pb-0 sm:!px-0 sm:!pb-0"
      footer={
        <>
          {d.can_edit && <Button variant="ghost" icon={Trash2} className="text-danger sm:mr-auto" onClick={async () => { if (await actions.remove()) onClose(); }}>Delete</Button>}
          {d.can_edit && <Button variant="secondary" icon={Pencil} onClick={() => onEdit(d)}>Edit</Button>}
          <a href={fileUrl(d, { download: true })} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary-solid px-4 text-sm font-semibold text-on-primary shadow-xs transition hover:bg-primary-solid-hover focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
            <Download size={17} aria-hidden /> Download
          </a>
        </>
      }
    >
      <div className="grid lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 border-y border-border lg:border-b-0 lg:border-r">
          <PreviewBody doc={d} />
        </div>
        <aside className="flex flex-col gap-4 p-5 text-sm" aria-label="Document details">
          {exp && (
            <div className={cn('flex items-center gap-2 rounded-xl px-3 py-2 font-semibold', exp.tone === 'danger' ? 'bg-danger-soft text-danger-soft-fg' : exp.tone === 'warning' ? 'bg-warning-soft text-warning-soft-fg' : 'bg-surface-2 text-muted')}>
              {exp.tone === 'neutral' ? <CalendarClock size={16} aria-hidden /> : <TriangleAlert size={16} aria-hidden />} {exp.tone === 'neutral' ? `Expires ${fmtDate(d.expires_on)}` : exp.text}
            </div>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5">
            <dt className="text-subtle">Uploaded by</dt>
            <dd className="flex min-w-0 items-center gap-1.5 font-medium text-fg">{owner && <Avatar user={owner} size="xs" />}<span className="truncate">{owner ? firstName(owner.name) : 'Former member'}</span></dd>
            <dt className="text-subtle">Added</dt>
            <dd className="font-medium text-fg">{fmtDate(d.created_at, 'MMM d, yyyy')}</dd>
            <dt className="text-subtle">Folder</dt>
            <dd className="truncate font-medium text-fg">{d.folder_name ?? 'Unfiled'}</dd>
            <dt className="text-subtle">File</dt>
            <dd className="truncate font-medium text-fg" title={d.original_name}>{d.original_name}</dd>
          </dl>
          {d.notes && <p className="whitespace-pre-line rounded-xl bg-surface-2/70 p-3 leading-relaxed text-fg">{d.notes}</p>}
          <div className="rounded-2xl border border-border p-3">
            {d.is_owner ? (
              <VisibilityPicker stacked value={d.visibility} onChange={setVisibility} allowAdults={isAdult} what="this file" />
            ) : (
              <p className="flex items-center gap-2 text-muted">
                {(() => { const V = VISIBILITY[d.visibility]; return <V.icon size={16} aria-hidden />; })()}
                {d.visibility === 'adults' ? 'Adults only — hidden from children' : 'Shared with the family'}
              </p>
            )}
          </div>
        </aside>
      </div>
    </Modal>
  );
}

/** useDocActions needs a document; the preview may render before one is loaded. */
function useDocActionsSafe(doc: VaultDoc | null, onEdit: (d: VaultDoc) => void) {
  const placeholder = { id: 0, name: '', is_private: false, visibility: 'family', can_edit: false } as VaultDoc;
  return useDocActions(doc ?? placeholder, onEdit);
}

// ---- upload -----------------------------------------------------------------------------------

interface QueueItem { file: File; progress: number; status: 'ready' | 'uploading' | 'done' | 'error'; error?: string }

function UploadModal({ files, onClose, folders, defaultFolder, onAddMore }: {
  files: File[] | null; onClose: () => void; folders: Folder[]; defaultFolder: number | null; onAddMore: () => void;
}) {
  const qc = useQueryClient();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [folderId, setFolderId] = useState<string>('');
  const [visibility, setVisibility] = useState<Visibility>('family');
  const { role } = useAuth();
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const open = !!files;

  useEffect(() => {
    if (!files) return;
    setQueue((prev) => {
      const base = running ? prev : prev.filter((q) => q.status !== 'done');
      const seen = new Set(base.map((q) => `${q.file.name}:${q.file.size}`));
      const added = files.filter((f) => !seen.has(`${f.name}:${f.size}`)).map((file): QueueItem => (
        file.size > MAX_UPLOAD ? { file, progress: 0, status: 'error', error: 'Larger than 25 MB' } : file.size === 0 ? { file, progress: 0, status: 'error', error: 'Empty file' } : { file, progress: 0, status: 'ready' }
      ));
      return [...base, ...added];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);
  useEffect(() => {
    if (open && !running) {
      setFolderId(defaultFolder ? String(defaultFolder) : '');
    }
    if (!open) {
      setQueue([]);
      setVisibility('family');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ready = queue.filter((q) => q.status === 'ready');
  const start = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready.length) return;
    setRunning(true);
    abort.current = new AbortController();
    const hadErrors = queue.some((q) => q.status === 'error');
    let ok = 0;
    let failed = 0;
    for (const item of ready) {
      const update = (patch: Partial<QueueItem>) => setQueue((qs) => qs.map((q) => (q.file === item.file ? { ...q, ...patch } : q)));
      update({ status: 'uploading', progress: 0 });
      try {
        await uploadDocument(item.file, { folder_id: folderId, visibility }, (p) => update({ progress: p }), abort.current.signal);
        update({ status: 'done', progress: 1 });
        ok++;
      } catch (err) {
        update({ status: 'error', error: errorMessage(err) });
        failed++;
        if (abort.current.signal.aborted) break;
      }
    }
    setRunning(false);
    qc.invalidateQueries({ queryKey: keys.all });
    if (ok) {
      const target = folders.find((f) => String(f.id) === folderId)?.name;
      toast.success(`${plural(ok, 'document')} uploaded${target ? ` to ${target}` : ''}`, { description: visibility === 'private' ? 'Private — only you can see them' : visibility === 'adults' ? 'Hidden from children' : undefined });
    }
    if (!failed && !hadErrors) setTimeout(onClose, 250);
  };

  const close = () => {
    if (running) abort.current?.abort();
    else onClose();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      dismissible={!running}
      title="Upload documents"
      description="Up to 25 MB per file. Images and PDFs can be previewed right here."
      icon={<Tile color={ACCENT} icon={CloudUpload} size={40} rounded="rounded-xl" />}
      footer={
        <>
          <Button variant="secondary" onClick={close}>{running ? 'Stop' : 'Cancel'}</Button>
          <Button type="submit" form="vault-upload-form" icon={Upload} loading={running} disabled={!ready.length}>
            {ready.length > 1 ? `Upload ${ready.length} files` : 'Upload'}
          </Button>
        </>
      }
    >
      <form id="vault-upload-form" onSubmit={start} className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2" aria-label="Files to upload">
          {queue.map((item, i) => {
            const ext = item.file.name.split('.').pop()?.toLowerCase() ?? '';
            return (
              <li key={`${item.file.name}-${i}`} className="flex items-center gap-3 rounded-xl border border-border p-2.5">
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-[10px] font-extrabold uppercase text-muted">{ext.slice(0, 4) || 'FILE'}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-fg">{item.file.name}</p>
                  {item.status === 'error' ? (
                    <p className="text-xs font-medium text-danger">{item.error}</p>
                  ) : item.status === 'ready' ? (
                    <p className="text-xs text-muted">{fmtBytes(item.file.size)}</p>
                  ) : (
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={`Uploading ${item.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}>
                      <div className={cn('h-full rounded-full transition-[width] duration-200', item.status === 'done' ? 'bg-success' : 'bg-primary-solid')} style={{ width: `${Math.max(4, item.progress * 100)}%` }} />
                    </div>
                  )}
                </div>
                {item.status === 'done' ? (
                  <Badge tone="success">Done</Badge>
                ) : !running && (
                  <IconButton size="sm" icon={X} label={`Remove ${item.file.name}`} onClick={() => setQueue((qs) => qs.filter((q) => q !== item))} />
                )}
              </li>
            );
          })}
        </ul>
        {!running && (
          <Button type="button" variant="ghost" size="sm" icon={FolderPlus} className="self-start" onClick={onAddMore}>Add more files</Button>
        )}
        <Field label="Folder">
          <Select value={folderId} onChange={(e) => setFolderId(e.target.value)} disabled={running}>
            <option value="">Unfiled</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </Field>
        <div className="rounded-2xl border border-border p-3">
          <VisibilityPicker value={visibility} onChange={setVisibility} allowAdults={role === 'admin' || role === 'member'} disabled={running} what="these files" />
        </div>
      </form>
    </Modal>
  );
}

// ---- edit / folder modals -----------------------------------------------------------------

function EditDocModal({ doc, folders, onClose }: { doc: VaultDoc | null; folders: Folder[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [folderId, setFolderId] = useState('');
  const [expires, setExpires] = useState('');
  const [notes, setNotes] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('family');
  const { role } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!doc) return;
    setName(doc.name);
    setFolderId(doc.folder_id ? String(doc.folder_id) : '');
    setExpires(doc.expires_on ?? '');
    setNotes(doc.notes ?? '');
    setVisibility(doc.visibility);
    setError('');
  }, [doc]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!doc) return;
    if (!name.trim()) return setError('Give the document a name');
    setSaving(true);
    try {
      const body: Record<string, unknown> = { name, folder_id: folderId || null, expires_on: expires || null, notes };
      if (doc.is_owner) body.visibility = visibility;
      const saved = await api.patch<VaultDoc>(`/vault/documents/${doc.id}`, body);
      qc.setQueryData<VaultDoc[]>(keys.documents, (old) => old?.map((d) => (d.id === saved.id ? saved : d)));
      qc.invalidateQueries({ queryKey: keys.all });
      toast.success('Document updated');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!doc}
      onClose={onClose}
      dismissible={!saving}
      title="Edit document"
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" form="vault-doc-form" loading={saving}>Save</Button></>}
    >
      <form id="vault-doc-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-sm font-medium text-danger-soft-fg">{error}</p>}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus trailing={doc?.ext ? <span className="mr-2 text-xs font-semibold uppercase text-subtle">.{doc.ext}</span> : undefined} />
        </Field>
        <Field label="Folder">
          <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">Unfiled</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </Field>
        <Field label="Expires on" hint="Passports, insurance, warranties… you'll get a reminder 30 days before.">
          <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} trailing={expires ? <IconButton size="sm" icon={X} label="Clear expiry date" onClick={() => setExpires('')} /> : undefined} />
        </Field>
        <Field label="Notes">
          <Textarea rows={2} autoGrow value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder="Where the original is kept, policy details…" />
        </Field>
        {doc?.is_owner && (
          <div className="rounded-2xl border border-border p-3">
            <VisibilityPicker value={visibility} onChange={setVisibility} allowAdults={role === 'admin' || role === 'member'} what="this file" />
          </div>
        )}
      </form>
    </Modal>
  );
}

function FolderModal({ open, folder, onClose, onCreated }: { open: boolean; folder: Folder | null; onClose: () => void; onCreated: (f: Folder) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[0]);
  const [icon, setIcon] = useState<FolderIcon>('folder');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setName(folder?.name ?? '');
    setColor(folder?.color ?? PALETTE[6]);
    setIcon(folder?.icon ?? 'folder');
    setError('');
  }, [open, folder]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give the folder a name');
    setSaving(true);
    try {
      const body = { name, color, icon };
      const saved = folder ? await api.patch<Folder>(`/vault/folders/${folder.id}`, body) : await api.post<Folder>('/vault/folders', body);
      qc.invalidateQueries({ queryKey: keys.all });
      toast.success(folder ? 'Folder updated' : `Folder “${saved.name}” created`);
      onClose();
      if (!folder) onCreated(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const Icon = FOLDER_ICONS[icon].icon;
  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title={folder ? 'Edit folder' : 'New folder'}
      icon={<Tile color={color} icon={Icon} size={40} rounded="rounded-xl" />}
      footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button><Button type="submit" form="vault-folder-form" loading={saving}>{folder ? 'Save' : 'Create folder'}</Button></>}
    >
      <form id="vault-folder-form" onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <Field label="Name" required error={error}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Medical, Taxes, Car" autoFocus />
        </Field>
        <Field label="Color">
          <ColorPicker value={color} onChange={setColor} aria-label="Folder color" />
        </Field>
        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold text-fg">Icon</legend>
          <div className="grid grid-cols-6 gap-2" role="radiogroup" aria-label="Folder icon">
            {(Object.keys(FOLDER_ICONS) as FolderIcon[]).map((key) => {
              const I = FOLDER_ICONS[key].icon;
              const on = key === icon;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={FOLDER_ICONS[key].label}
                  title={FOLDER_ICONS[key].label}
                  onClick={() => setIcon(key)}
                  className={cn('flex aspect-square items-center justify-center rounded-xl border transition active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring', on ? 'border-transparent' : 'border-border text-muted hover:bg-surface-2 hover:text-fg')}
                  style={on ? { ...tint(color, 18), boxShadow: `inset 0 0 0 2px ${color}` } : undefined}
                >
                  <I size={20} aria-hidden />
                </button>
              );
            })}
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
