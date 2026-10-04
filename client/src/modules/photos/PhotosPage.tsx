import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useLive } from '../../lib/live';
import { plural } from '../../lib/format';
import { toast } from '../../ui';
import { bindUploads, keys } from './data';
import { UploadTray } from './common';
import { Library } from './Library';
import { AlbumPage } from './AlbumPage';
import type { Album } from './types';

export default function PhotosPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  useLive('photos');

  useEffect(() => {
    bindUploads(qc, ({ count, failed, albumId }) => {
      if (count) {
        const album = albumId
          ? qc.getQueryData<Album>(keys.album(albumId)) ?? qc.getQueryData<Album[]>(keys.albums)?.find((a) => a.id === albumId)
          : null;
        toast.success(`${plural(count, 'photo')} added${album ? ` to ${album.title}` : ''}`, {
          description: failed ? `${plural(failed, 'photo')} couldn't be uploaded` : undefined,
          action: albumId && !window.location.pathname.endsWith(`/albums/${albumId}`)
            ? { label: 'View', onClick: () => navigate(`/photos/albums/${albumId}`) }
            : undefined,
        });
      } else if (failed) {
        toast.error(`${plural(failed, 'photo')} couldn't be uploaded`);
      }
    });
  }, [qc, navigate]);

  return (
    <>
      <Routes>
        <Route index element={<Library view="albums" />} />
        <Route path="all" element={<Library view="all" />} />
        <Route path="albums/:id" element={<AlbumPage />} />
        <Route path="*" element={<Navigate to="/photos" replace />} />
      </Routes>
      <UploadTray />
    </>
  );
}
