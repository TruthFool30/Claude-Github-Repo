import type { ReactNode } from 'react';
import { CalendarDays, Check, Heart, ListChecks, MessageCircle, UtensilsCrossed } from 'lucide-react';
import { Logo } from '../layout/Logo';

function FloatingCard({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`absolute rounded-2xl border border-white/15 bg-white/12 p-3.5 text-white shadow-2xl backdrop-blur-md ${className ?? ''}`}>{children}</div>;
}

const dot = (c: string, label: string) => (
  <span className="flex size-7 items-center justify-center rounded-full text-[10px] font-bold text-white ring-2 ring-[#4B3FC4]" style={{ background: c }}>
    {label}
  </span>
);

/** Split layout for sign-in / sign-up / onboarding: form on the left, brand panel on the right (desktop). */
export function AuthLayout({ children, title, subtitle }: { children: ReactNode; title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-bg">
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[36rem] -translate-x-1/2 rounded-full opacity-60 blur-3xl lg:hidden"
          style={{ background: 'radial-gradient(closest-side, color-mix(in oklab, var(--primary) 35%, transparent), transparent)' }}
        />
        <div className="relative px-6 pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-10 sm:pt-8">
          <Logo />
        </div>
        <div className="relative flex flex-1 items-center justify-center px-6 py-10 sm:px-10">
          <div className="w-full max-w-[400px] animate-scale-in">
            <h1 className="text-[28px] font-bold leading-tight tracking-tight text-fg sm:text-[32px]">{title}</h1>
            {subtitle && <p className="mt-2 text-[15px] text-muted">{subtitle}</p>}
            <div className="mt-8">{children}</div>
          </div>
        </div>
        <p className="relative px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center text-xs text-subtle">Private & self-hosted. Your family's data stays yours.</p>
      </div>

      <div className="relative hidden w-[46%] max-w-[720px] overflow-hidden lg:block">
        <div className="absolute inset-3 overflow-hidden rounded-[32px]" style={{ background: 'linear-gradient(150deg, #6E6AF0 0%, #4B3FC4 55%, #3A2E9E 100%)' }}>
          <div aria-hidden className="absolute -right-24 -top-24 size-96 rounded-full opacity-50 blur-3xl" style={{ background: '#FF9A5A' }} />
          <div aria-hidden className="absolute -bottom-32 -left-20 size-96 rounded-full opacity-40 blur-3xl" style={{ background: '#D6409F' }} />
          <div aria-hidden className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'radial-gradient(white 1px, transparent 1px)', backgroundSize: '22px 22px' }} />

          <div className="relative flex h-full flex-col justify-between p-12 text-white">
            <div className="max-w-md">
              <span className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur">
                <Heart size={13} className="fill-current" /> Made for families
              </span>
              <h2 className="mt-5 text-[40px] font-bold leading-[1.1] tracking-tight">Everything your family shares, in one warm place.</h2>
              <p className="mt-4 text-[17px] leading-relaxed text-white/75">
                Calendars, grocery lists, chats, photos, meal plans and budgets — synced for everyone, instantly.
              </p>
            </div>

            <div className="relative h-[300px]">
              <FloatingCard className="left-0 top-4 w-64 rotate-[-4deg]">
                <div className="flex items-center gap-2 text-xs font-semibold text-white/70">
                  <CalendarDays size={14} /> Today
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <span className="h-10 w-1 rounded-full bg-[#FFB224]" />
                  <div>
                    <div className="text-sm font-semibold">Soccer practice</div>
                    <div className="text-xs text-white/70">4:30 PM · Mia</div>
                  </div>
                </div>
              </FloatingCard>
              <FloatingCard className="right-2 top-0 w-60 rotate-[3deg]">
                <div className="flex items-center gap-2 text-xs font-semibold text-white/70">
                  <ListChecks size={14} /> Groceries
                </div>
                {['Avocados', 'Oat milk', 'Pasta'].map((t, i) => (
                  <div key={t} className="mt-2 flex items-center gap-2 text-sm">
                    <span className={`flex size-4 items-center justify-center rounded-full border-2 ${i < 2 ? 'border-[#3DD68C] bg-[#3DD68C]' : 'border-white/50'}`}>
                      {i < 2 && <Check size={10} strokeWidth={4} />}
                    </span>
                    <span className={i < 2 ? 'text-white/60 line-through' : ''}>{t}</span>
                  </div>
                ))}
              </FloatingCard>
              <FloatingCard className="bottom-6 left-10 w-72 rotate-[2deg]">
                <div className="flex items-center gap-2 text-xs font-semibold text-white/70">
                  <MessageCircle size={14} /> Family chat
                </div>
                <div className="mt-2 rounded-xl rounded-bl-sm bg-white/15 px-3 py-2 text-sm">Pizza night on Friday? 🍕</div>
                <div className="mt-2 flex -space-x-2">
                  {dot('#5B5BD6', 'AR')}
                  {dot('#D6409F', 'SR')}
                  {dot('#30A46C', 'MR')}
                  {dot('#F76B15', 'LR')}
                </div>
              </FloatingCard>
              <FloatingCard className="bottom-0 right-6 w-48 rotate-[-3deg]">
                <div className="flex items-center gap-2 text-xs font-semibold text-white/70">
                  <UtensilsCrossed size={14} /> Tonight
                </div>
                <div className="mt-1.5 text-sm font-semibold">Lemon herb chicken</div>
              </FloatingCard>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
