import { useSyncExternalStore } from 'react';
import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';
import { api, getApiFamily, qs } from '../../lib/api';
import { resizeImage, toast } from '../../ui';
import type { Album, AlbumDetail, Overview, PhotoDetail, TimelinePage } from './types';

// ---- queries ------------------------------------------------------------------------------------
export const keys = {
  overview: ['photos', 'overview'] as const,
  albums: ['photos', 'albums'] as const,
  album: (id: number) => ['photos', 'album', id] as const,
  timeline: (filter: string) => ['photos', 'timeline', filter] as const,
  photo: (id: number) => ['photos', 'photo', id] as const,
};

export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: () => api.get<Overview>('/photos') });
export const useAlbums = () => useQuery({ queryKey: keys.albums, queryFn: () => api.get<Album[]>('/photos/albums') });
export const useAlbum = (id: number) =>
  useQuery({ queryKey: keys.album(id), queryFn: () => api.get<AlbumDetail>(`/photos/albums/${id}`), enabled: Number.isInteger(id) && id > 0, retry: false });
export const usePhotoDetail = (id: number | null) =>
  useQuery({ queryKey: keys.photo(id ?? 0), queryFn: () => api.get<PhotoDetail>(`/photos/items/${id}`), enabled: !!id, retry: false });

/** `until`: a deep-linked photo id — the first page is extended so that photo (and its neighbours) are loaded. */
export function useTimeline(filter: { album?: string; member?: number | null }, until?: number | null) {
  const f = JSON.stringify({ ...filter, until: until ?? null });
  return useInfiniteQuery({
    queryKey: keys.timeline(f),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.get<TimelinePage>(
        `/photos/all${qs({ cursor: pageParam, limit: 60, album: filter.album, member: filter.member, until: pageParam ? null : until })}`,
      ),
    getNextPageParam: (last) => last.next_cursor,
  });
}

// ---- EXIF capture date -----------------------------------------------------------------------------
/** DateTimeOriginal from a JPEG's EXIF block (local time, as the camera wrote it), or null. */
export async function exifDate(file: File): Promise<Date | null> {
  if (!/jpe?g$/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return null;
  try {
    const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (buf.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < buf.byteLength) {
      const marker = buf.getUint16(off);
      const len = buf.getUint16(off + 2);
      if (marker === 0xffe1 && buf.getUint32(off + 4) === 0x45786966) {
        const tiff = off + 10;
        const le = buf.getUint16(tiff) === 0x4949;
        const u16 = (o: number) => buf.getUint16(o, le);
        const u32 = (o: number) => buf.getUint32(o, le);
        const readAscii = (o: number, n: number) => {
          let s = '';
          for (let i = 0; i < n; i++) s += String.fromCharCode(buf.getUint8(o + i));
          return s;
        };
        const findTag = (ifd: number, tag: number) => {
          const n = u16(ifd);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (u16(e) === tag) return e;
          }
          return -1;
        };
        const ifd0 = tiff + u32(tiff + 4);
        const exifPtr = findTag(ifd0, 0x8769);
        const candidates: number[] = [];
        if (exifPtr >= 0) {
          const exifIfd = tiff + u32(exifPtr + 8);
          candidates.push(findTag(exifIfd, 0x9003), findTag(exifIfd, 0x9004));
        }
        candidates.push(findTag(ifd0, 0x0132));
        for (const e of candidates) {
          if (e < 0) continue;
          const s = readAscii(tiff + u32(e + 8), 19); // "YYYY:MM:DD HH:MM:SS"
          const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
          if (m) {
            const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
            if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1900) return d;
          }
        }
        return null;
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + len;
    }
  } catch {
    /* unreadable EXIF */
  }
  return null;
}

/** Cheap client-side sanity check: PNGs must end with IEND, JPEGs with an end-of-image marker. */
export async function looksIntact(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 64)).arrayBuffer());
    const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    const isJpeg = head[0] === 0xff && head[1] === 0xd8;
    if (isPng) return new TextDecoder('latin1').decode(tail).includes('IEND');
    if (isJpeg) {
      let end = tail.length;
      while (end > 2 && tail[end - 1] === 0) end--;
      return tail[end - 2] === 0xff && tail[end - 1] === 0xd9;
    }
    return true;
  } catch {
    return false;
  }
}

// ---- upload queue ----------------------------------------------------------------------------------
export type JobStatus = 'queued' | 'preparing' | 'uploading' | 'done' | 'error';
export interface UploadJob {
  id: string;
  name: string;
  preview: string;
  progress: number;
  status: JobStatus;
  error?: string;
  /** false for validation errors (4xx): retrying the same file can't help. */
  retryable?: boolean;
  albumId: number | null;
  batch: string;
  file: File;
}

interface UploadState {
  jobs: UploadJob[];
}

let state: UploadState = { jobs: [] };
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());
const setJobs = (fn: (jobs: UploadJob[]) => UploadJob[]) => {
  state = { jobs: fn(state.jobs) };
  emit();
};
const patchJob = (id: string, patch: Partial<UploadJob>) => setJobs((jobs) => jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)));

export function useUploads() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
    () => state,
  );
}

let queryClient: QueryClient | null = null;
let onBatchDone: ((info: { count: number; failed: number; albumId: number | null }) => void) | null = null;
export function bindUploads(qc: QueryClient, done: typeof onBatchDone) {
  queryClient = qc;
  onBatchDone = done;
}

const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
let running = false;

export function clearFinished() {
  setJobs((jobs) => {
    jobs.filter((j) => j.status === 'done' || j.status === 'error').forEach((j) => URL.revokeObjectURL(j.preview));
    return jobs.filter((j) => j.status !== 'done' && j.status !== 'error');
  });
}

export function dismissJob(id: string) {
  setJobs((jobs) => {
    const j = jobs.find((x) => x.id === id);
    if (j) URL.revokeObjectURL(j.preview);
    return jobs.filter((x) => x.id !== id);
  });
}

export function retryJob(id: string) {
  patchJob(id, { status: 'queued', progress: 0, error: undefined });
  void pump();
}

/** Queue files for upload into an album (or unsorted). Returns the number accepted. */
export function enqueueUploads(files: File[], albumId: number | null): number {
  const isImage = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(f.name);
  const images = files.filter(isImage);
  const skipped = files.filter((f) => !isImage(f));
  if (skipped.length) {
    toast.warning(`Skipped ${skipped.length === 1 ? '1 file' : `${skipped.length} files`} that ${skipped.length === 1 ? "isn't a photo" : "aren't photos"}`, {
      description: skipped.slice(0, 3).map((f) => f.name).join(', ') + (skipped.length > 3 ? '…' : ''),
    });
  }
  if (!images.length) return 0;
  const batch = `b${rid()}`;
  setJobs((jobs) => [
    ...jobs,
    ...images.map((file) => ({
      id: rid(), name: file.name, preview: URL.createObjectURL(file), progress: 0, status: 'queued' as JobStatus, albumId, batch, file,
    })),
  ]);
  void pump();
  return images.length;
}

async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = state.jobs.find((j) => j.status === 'queued');
      if (!job) break;
      await runJob(job);
      maybeFinishBatch(job.batch);
    }
  } finally {
    running = false;
  }
}

async function runJob(job: UploadJob) {
  patchJob(job.id, { status: 'preparing', progress: 0.02 });
  try {
    const taken = (await exifDate(job.file)) ?? (job.file.lastModified ? new Date(job.file.lastModified) : null);
    // A truncated/corrupt file can still be half-decoded by the browser and re-encoded into a
    // half-grey JPEG — never "repair" it: send the original bytes and let the server reject it.
    const intact = await looksIntact(job.file);
    const full = intact ? await resizeImage(job.file, { maxSize: 2048, quality: 0.86 }) : job.file;
    const thumb = intact ? await resizeImage(job.file, { maxSize: 720, quality: 0.8 }) : job.file;
    const fd = new FormData();
    if (job.albumId) fd.append('album_id', String(job.albumId));
    if (taken && taken.getTime() < Date.now() + 864e5) fd.append('taken_at', taken.toISOString());
    fd.append('batch', job.batch);
    fd.append('file', full);
    if (thumb !== job.file && thumb.size < full.size) fd.append('thumb', thumb, `thumb-${thumb.name}`);
    patchJob(job.id, { status: 'uploading', progress: 0.05 });
    await xhrUpload('/api/photos/upload', fd, (p) => patchJob(job.id, { progress: 0.05 + p * 0.95 }));
    patchJob(job.id, { status: 'done', progress: 1 });
    queryClient?.invalidateQueries({ queryKey: ['photos'] });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 0;
    patchJob(job.id, {
      status: 'error',
      error: err instanceof Error ? err.message : 'Upload failed',
      retryable: !(status >= 400 && status < 500 && status !== 408 && status !== 429),
    });
  }
}

function maybeFinishBatch(batch: string) {
  const jobs = state.jobs.filter((j) => j.batch === batch);
  if (jobs.some((j) => j.status === 'queued' || j.status === 'preparing' || j.status === 'uploading')) return;
  const done = jobs.filter((j) => j.status === 'done').length;
  const failed = jobs.filter((j) => j.status === 'error').length;
  if (done) {
    api.post(`/photos/batches/${batch}/done`).catch(() => {});
  }
  onBatchDone?.({ count: done, failed, albumId: jobs[0]?.albumId ?? null });
  if (!failed) {
    // Leave successful uploads visible for a moment, then tidy up.
    setTimeout(() => {
      setJobs((all) => {
        all.filter((j) => j.batch === batch && j.status === 'done').forEach((j) => URL.revokeObjectURL(j.preview));
        return all.filter((j) => !(j.batch === batch && j.status === 'done'));
      });
    }, 2500);
  }
}

function xhrUpload(url: string, body: FormData, onProgress: (p: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    const fam = getApiFamily();
    if (fam) xhr.setRequestHeader('X-Family-Id', String(fam));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error((data as { error?: string } | null)?.error || `Upload failed (${xhr.status})`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Network error — check your connection'));
    xhr.send(body);
  });
}
