import { lazy } from 'react';
import { Route, Routes } from 'react-router';
import { useWallLive } from './api';
import HomePage from './HomePage';

const PostDetail = lazy(() => import('./PostDetail'));

/** Home module: the dashboard + family wall at /home and single posts at /home/post/:id. */
export default function WallPage() {
  useWallLive();
  return (
    <Routes>
      <Route index element={<HomePage />} />
      <Route path="post/:id" element={<PostDetail />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}
