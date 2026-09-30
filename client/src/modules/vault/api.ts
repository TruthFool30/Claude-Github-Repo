import { useQuery } from '@tanstack/react-query';
import { ApiError, api, getApiFamily, UNAUTHORIZED_EVENT } from '../../lib/api';

export type ContactCategory = 'medical' | 'school' | 'childcare' | 'home' | 'family' | 'work' | 'pets' | 'emergency' | 'other';
export type FolderIcon = 'folder' | 'medical' | 'school' | 'insurance' | 'home' | 'travel' | 'car' | 'finance' | 'kids' | 'pets' | 'legal' | 'work';
export type NoteKind = 'wifi' | 'insurance' | 'medical' | 'id' | 'bank' | 'code' | 'vehicle' | 'other';
export type Visibility = 'family' | 'adults' | 'private';
export type DocKind = 'pdf' | 'image' | 'text' | 'doc' | 'sheet' | 'slides' | 'archive' | 'audio' | 'video' | 'other';

export interface Phone {
  label: string;
  number: string;
}

export interface Contact {
  id: number;
  name: string;
  category: ContactCategory;
  role: string | null;
  organization: string | null;
  phones: Phone[];
  email: string | null;
  address: string | null;
  website: string | null;
  notes: string | null;
  favorite: boolean;
  emergency: boolean;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
}

export interface Folder {
  id: number;
  name: string;
  color: string;
  icon: FolderIcon;
  created_by: number | null;
  created_at: string;
  doc_count: number;
  total_size: number;
  last_upload_at: string | null;
  can_edit: boolean;
}

export interface FoldersResponse {
  folders: Folder[];
  unfiled: { doc_count: number; total_size: number };
}

export interface VaultDoc {
  id: number;
  folder_id: number | null;
  folder_name: string | null;
  folder_color: string | null;
  name: string;
  original_name: string;
  ext: string;
  mime: string;
  size: number;
  owner_id: number | null;
  is_private: boolean;
  adults_only: boolean;
  visibility: Visibility;
  notes: string | null;
  expires_on: string | null;
  created_at: string;
  updated_at: string;
  kind: DocKind;
  url: string;
  download_name: string;
  can_edit: boolean;
  is_owner: boolean;
}

export interface NoteField {
  label: string;
  /** null while a secret value is hidden (until /reveal). */
  value: string | null;
  secret: boolean;
}

export interface VaultNote {
  id: number;
  title: string;
  kind: NoteKind;
  fields: NoteField[];
  body: string | null;
  is_private: boolean;
  adults_only: boolean;
  visibility: Visibility;
  owner_id: number | null;
  created_at: string;
  updated_at: string;
  secret_count: number;
  revealed: boolean;
  can_edit: boolean;
  is_owner: boolean;
}

export interface Overview {
  contacts: number;
  emergency: number;
  folders: number;
  documents: number;
  notes: number;
  expiring: VaultDoc[];
}

export const keys = {
  all: ['vault'] as const,
  overview: ['vault', 'overview'] as const,
  contacts: ['vault', 'contacts'] as const,
  folders: ['vault', 'folders'] as const,
  documents: ['vault', 'documents'] as const,
  document: (id: number) => ['vault', 'document', id] as const,
  notes: ['vault', 'notes'] as const,
};

export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: () => api.get<Overview>('/vault') });
export const useContacts = () => useQuery({ queryKey: keys.contacts, queryFn: () => api.get<Contact[]>('/vault/contacts') });
export const useFolders = () => useQuery({ queryKey: keys.folders, queryFn: () => api.get<FoldersResponse>('/vault/folders') });
export const useDocuments = () => useQuery({ queryKey: keys.documents, queryFn: () => api.get<VaultDoc[]>('/vault/documents') });
export const useNotes = () => useQuery({ queryKey: keys.notes, queryFn: () => api.get<VaultNote[]>('/vault/notes') });

/** File URLs are loaded by <img>/<iframe> (no custom headers), so the tab's family goes in the query. */
export function fileUrl(doc: Pick<VaultDoc, 'url'>, { download = false } = {}) {
  const params = new URLSearchParams();
  const fid = getApiFamily();
  if (fid) params.set('family_id', String(fid));
  if (download) params.set('download', '1');
  const s = params.toString();
  return s ? `${doc.url}?${s}` : doc.url;
}

export const MAX_UPLOAD = 25 * 1024 * 1024;

/** Multipart upload with progress (fetch can't report upload progress). */
export function uploadDocument(
  file: File,
  fields: Record<string, string>,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<VaultDoc> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/vault/documents');
    xhr.withCredentials = true;
    const fid = getApiFamily();
    if (fid) xhr.setRequestHeader('X-Family-Id', String(fid));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve(data as VaultDoc);
        return;
      }
      if (xhr.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `Upload failed (${xhr.status})`;
      reject(new ApiError(xhr.status, msg, data));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error — check your connection and try again'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled'));
    signal?.addEventListener('abort', () => xhr.abort());
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', file, file.name);
    xhr.send(form);
  });
}
