import { Fragment, type ReactNode } from 'react';
import { firstName } from '../../lib/format';
import type { Member } from '../../lib/types';

const TOKEN = /(@[\p{L}][\p{L}'’-]*|https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/gu;

/**
 * Post / comment text: keeps line breaks, highlights @mentions of family members in their color
 * and turns URLs into links.
 */
export function RichText({ text, members, className }: { text: string; members: Member[]; className?: string }) {
  const byName = new Map<string, Member>();
  for (const m of members) {
    byName.set(firstName(m.name).toLowerCase(), m);
    if (m.nickname) byName.set(m.nickname.toLowerCase(), m);
  }
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    if (token.startsWith('@')) {
      const m = byName.get(token.slice(1).toLowerCase());
      parts.push(
        m ? (
          <span
            key={start}
            className="rounded-md px-1 py-px font-semibold"
            style={{ color: `color-mix(in oklab, ${m.color} 62%, var(--fg))`, backgroundColor: `color-mix(in oklab, ${m.color} 13%, transparent)` }}
          >
            {token}
          </span>
        ) : (
          token
        ),
      );
    } else {
      parts.push(
        <a key={start} href={token} target="_blank" rel="noopener noreferrer" className="break-all font-medium text-primary underline-offset-2 hover:underline">
          {token.replace(/^https?:\/\//, '')}
        </a>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <span className={className} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </span>
  );
}
