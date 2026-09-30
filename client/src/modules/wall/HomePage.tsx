import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ImagePlus, Smile } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { firstName } from '../../lib/format';
import { useDocumentTitle, useIsDesktop } from '../../lib/hooks';
import { Avatar, Card } from '../../ui';
import { useDashboard } from './api';
import { Composer } from './Composer';
import { Feed } from './Feed';
import { BirthdaysCard, MealsCard, TasksCard, TodayCard } from './Glance';
import { Hero } from './Hero';
import { QuickAddItem } from './QuickAddItem';
import type { WallPost } from './types';
import mod from './index';

export default function HomePage() {
  useDocumentTitle('Home');
  const { user, members } = useAuth();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const dash = useDashboard();
  const [composer, setComposer] = useState<{ open: boolean; post: WallPost | null; files: File[] | null }>({ open: false, post: null, files: null });
  const [quickItem, setQuickItem] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [slide, setSlide] = useState(0);
  const onStripScroll = () => {
    const el = strip.current;
    const first = el?.firstElementChild as HTMLElement | null;
    if (!el || !first) return;
    setSlide(Math.min(3, Math.round(el.scrollLeft / (first.offsetWidth + 12))));
  };
  const goTo = (i: number) => {
    const el = strip.current;
    const child = el?.children[i] as HTMLElement | undefined;
    if (el && child) el.scrollTo({ left: child.offsetLeft - 16, behavior: 'smooth' });
  };

  const openComposer = (files: File[] | null = null) => setComposer({ open: true, post: null, files });
  const editPost = (post: WallPost) => setComposer({ open: true, post, files: null });

  const d = dash.data;
  const loading = dash.isPending;
  const compact = !isDesktop;
  const widgets = [
    <TodayCard key="today" data={d?.calendar} loading={loading} compact={compact} />,
    <TasksCard key="tasks" data={d?.lists} loading={loading} members={members} compact={compact} />,
    <MealsCard key="meals" data={d?.meals} loading={loading} compact={compact} />,
    <BirthdaysCard key="bdays" members={members} compact={compact} />,
  ];
  const labels = ['Today', 'Tasks due', 'On the menu', 'Birthdays'];

  return (
    <div className="flex flex-col gap-5 lg:gap-6">
      <input
        ref={photoInput}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        className="hidden"
        data-focus-skip
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) openComposer(files);
        }}
      />
      <Hero
        dashboard={d}
        loading={loading}
        actions={{
          post: () => openComposer(),
          event: () => navigate('/calendar?new=1'),
          item: () => setQuickItem(true),
          photo: () => photoInput.current?.click(),
        }}
      />

      {!isDesktop && (
        <section aria-label="At a glance" className="-mx-4 sm:-mx-6">
          <div
            ref={strip}
            onScroll={onStripScroll}
            className="flex snap-x snap-mandatory items-start gap-3 overflow-x-auto px-4 pb-1 scrollbar-none sm:px-6 [scroll-padding-inline:1rem]"
          >
            {widgets.map((w) => (
              <div key={w.key} className="w-[80%] max-w-[330px] shrink-0 snap-start">
                {w}
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-center gap-1.5" role="tablist" aria-label="At a glance cards">
            {widgets.map((w, i) => (
              <button
                key={w.key}
                type="button"
                role="tab"
                aria-selected={i === slide}
                aria-label={labels[i]}
                onClick={() => goTo(i)}
                className="flex h-5 items-center px-0.5"
              >
                <span className={cn('block h-1.5 rounded-full transition-all duration-300', i === slide ? 'w-5 bg-primary-solid' : 'w-1.5 bg-border-strong')} />
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card padding="sm" className="hidden items-center gap-3 sm:flex">
            <Avatar user={user} size="md" />
            <button
              type="button"
              onClick={() => openComposer()}
              className="h-11 min-w-0 flex-1 truncate rounded-full border border-border bg-surface-2 px-4 text-left text-[15px] text-subtle transition hover:border-border-strong hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
            >
              What's new, {firstName(user?.name) || 'friend'}?
            </button>
            <button
              type="button"
              onClick={() => photoInput.current?.click()}
              aria-label="Share photos"
              className="hidden size-11 shrink-0 items-center justify-center rounded-full text-[#30A46C] transition hover:bg-surface-2 sm:flex"
            >
              <ImagePlus size={21} />
            </button>
            <button
              type="button"
              onClick={() => openComposer()}
              aria-label="Share how you're feeling"
              className="hidden size-11 shrink-0 items-center justify-center rounded-full text-[#F76B15] transition hover:bg-surface-2 sm:flex"
            >
              <Smile size={21} />
            </button>
          </Card>
          <Feed onCompose={() => openComposer()} onEdit={editPost} accent={mod.accent} />
        </div>

        {isDesktop && (
          <aside aria-label="At a glance" className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
            {widgets}
          </aside>
        )}
      </div>

      <Composer
        open={composer.open}
        post={composer.post}
        initialFiles={composer.files}
        onClose={() => setComposer((c) => ({ ...c, open: false, files: null }))}
      />
      <QuickAddItem open={quickItem} onClose={() => setQuickItem(false)} />
    </div>
  );
}
