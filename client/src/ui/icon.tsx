import { createElement, isValidElement, type ComponentType, type ReactNode } from 'react';

/** Either a component (e.g. a lucide icon: `Plus`) or an element (`<Plus />`). */
export type IconLike = ComponentType<{ className?: string; size?: number | string; strokeWidth?: number }> | ReactNode;

export function renderIcon(icon: IconLike | undefined, className?: string, size?: number) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  if (typeof icon === 'function' || (typeof icon === 'object' && icon !== null && '$$typeof' in icon)) {
    return createElement(icon as ComponentType<{ className?: string; size?: number; 'aria-hidden'?: boolean }>, {
      className,
      size,
      'aria-hidden': true,
    });
  }
  return icon as ReactNode;
}
