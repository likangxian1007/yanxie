import { Marquee } from '../components/fx';
import { useLang } from '../i18n';

function Chip({ label, i }: { label: string; i: number }) {
  const dot = ['bg-accent', 'bg-faint', 'bg-agent', 'bg-faint'][i % 4];
  return (
    <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface/70 px-4 py-2 text-sm whitespace-nowrap text-muted shadow-[inset_0_1px_0_0_rgb(var(--c-ink)/0.04)]">
      <span className={`size-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export function CapabilityMarquee() {
  const { t } = useLang();
  return (
    <section
      aria-label={t.marquee.aria}
      className="relative border-y border-line/60 bg-surface/20 py-6 sm:py-8"
    >
      <div className="flex flex-col gap-3">
        <Marquee duration={50}>
          {t.marquee.rowA.map((l, i) => (
            <Chip key={i} label={l} i={i} />
          ))}
        </Marquee>
        <Marquee duration={55} reverse>
          {t.marquee.rowB.map((l, i) => (
            <Chip key={i} label={l} i={i + 2} />
          ))}
        </Marquee>
      </div>
    </section>
  );
}
