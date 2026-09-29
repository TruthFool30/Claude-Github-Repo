import type { ComponentType, LazyExoticComponent } from 'react';
import type { LucideIcon } from 'lucide-react';

/** Descriptor exported (default) from client/src/modules/<id>/index.tsx. */
export interface ModuleDef {
  /** Matches the server module name and the TanStack query-key prefix. */
  id: string;
  /** Navigation label. */
  label: string;
  /** Shorter label for the mobile bottom bar (defaults to label). */
  shortLabel?: string;
  icon: LucideIcon;
  /** Route base, e.g. '/lists'. The app mounts `${path}/*`, so nested <Routes> work inside. */
  path: string;
  /** Page component — usually `lazy(() => import('./ListsPage'))`. */
  element: LazyExoticComponent<ComponentType> | ComponentType;
  /** 'primary' → mobile bottom bar (first 4 by order); 'secondary' → the "More" sheet. Both show in the desktop sidebar. */
  nav: 'primary' | 'secondary';
  /** Sort order in navigation (10, 20, …). */
  order: number;
  /** Accent color (hex) for icons/headers of this module. */
  accent: string;
  /** One-liner shown in the More sheet / search palette. */
  description?: string;
}
