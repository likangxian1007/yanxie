import { Bento } from './sections/Bento';
import { CapabilityMarquee } from './sections/CapabilityMarquee';
import { ExternalAgents } from './sections/ExternalAgents';
import { FinalCta } from './sections/FinalCta';
import { Footer } from './sections/Footer';
import { Hero } from './sections/Hero';
import { Mobile } from './sections/Mobile';
import { Nav } from './sections/Nav';
import { SelfHost } from './sections/SelfHost';
import { Story } from './sections/Story';
import { type Lang, LangProvider } from './i18n';

export function App({ initialLang }: { initialLang?: Lang } = {}) {
  return (
    <LangProvider initial={initialLang}>
      <div className="relative min-h-screen overflow-x-clip bg-canvas text-fg">
        <Nav />
        <main>
          <Hero />
          <CapabilityMarquee />
          <Story />
          <div id="features" className="scroll-mt-20">
            <Bento />
          </div>
          <ExternalAgents />
          <Mobile />
          <SelfHost />
          <FinalCta />
        </main>
        <Footer />
      </div>
    </LangProvider>
  );
}
