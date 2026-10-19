import { ArrowRight, Captions, Clapperboard, Download, FileText, Mic, Sparkles, Wand2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/layout/Logo';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth-store';

const FEATURES = [
  { icon: FileText, title: 'Script from an idea', text: 'Describe a topic, audience and tone. Get a structured hook, scenes and call to action you can edit line by line.' },
  { icon: Mic, title: 'Voiceover', text: 'Generate narration with a free local voice or your own provider, preview it, or upload a recording.' },
  { icon: Captions, title: 'Animated captions', text: 'Word-by-word highlights, five original styles, keyword colors, SRT import and export.' },
  { icon: Clapperboard, title: 'Timeline editor', text: 'Arrange clips, trim, add music, undo and redo. Your work saves itself.' },
  { icon: Wand2, title: 'Preview = export', text: 'The preview runs the same composition the renderer uses, so what you see is what you get.' },
  { icon: Download, title: 'Real MP4 export', text: '1080×1920, 30 fps, H.264 and AAC, checked frame-accurately before you download.' },
];

const STEPS = ['Start a project from a template', 'Write or generate the script', 'Add footage, voice and music', 'Style captions and preview', 'Export a vertical MP4'];

export function LandingPage() {
  const signedIn = useAuthStore((s) => s.status === 'signed-in');
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Logo />
        <nav className="flex items-center gap-2">
          {signedIn ? (
            <Button asChild>
              <Link to="/app">Open dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost">
                <Link to="/login">Sign in</Link>
              </Button>
              <Button asChild>
                <Link to="/register">Start free</Link>
              </Button>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-10 md:grid-cols-[1.2fr_1fr] md:pt-20">
          <div className="pointer-events-none absolute -top-20 left-1/3 -z-10 size-[480px] rounded-full bg-primary/20 blur-[120px]" />
          <div className="space-y-6">
            <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
              <Sparkles className="size-3.5 text-accent" /> Short-form video, forged in minutes
            </span>
            <h1 className="text-4xl font-black leading-[1.05] tracking-tight md:text-6xl">
              From one idea to a <span className="bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">captioned vertical video</span>.
            </h1>
            <p className="max-w-xl text-lg text-muted-foreground">
              ClipForge AI writes the script, voices it, times the captions and renders a real MP4 for TikTok, Reels and Shorts. Edit anything before you export.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to={signedIn ? '/app/projects/new' : '/register'}>
                  Create a video <ArrowRight />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="#how">How it works</a>
              </Button>
            </div>
          </div>
          <div className="mx-auto w-full max-w-[280px]" aria-hidden>
            <div className="relative aspect-[9/16] overflow-hidden rounded-[2rem] border-4 border-muted bg-gradient-to-b from-[#1e1b4b] via-[#3b0764] to-[#7c2d12] shadow-2xl shadow-primary/20">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.15),transparent_50%)]" />
              <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 text-center text-2xl font-black uppercase leading-tight text-white [text-shadow:0_3px_0_#000]">
                Your story <span className="text-[#ffd400]">hits</span> different
              </div>
              <div className="absolute inset-x-6 bottom-8 h-1 rounded-full bg-white/20">
                <div className="h-full w-2/3 rounded-full bg-white" />
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16" aria-labelledby="features">
          <h2 id="features" className="mb-10 text-center text-3xl font-bold">
            Everything a short needs
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <div key={title} className="rounded-lg border border-border bg-card p-5">
                <Icon className="mb-3 size-5 text-primary" />
                <h3 className="mb-1 font-semibold">{title}</h3>
                <p className="text-sm text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="how" className="mx-auto max-w-3xl px-6 py-16">
          <h2 className="mb-8 text-center text-3xl font-bold">How it works</h2>
          <ol className="space-y-3">
            {STEPS.map((step, i) => (
              <li key={step} className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary">{i + 1}</span>
                {step}
              </li>
            ))}
          </ol>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="rounded-2xl border border-border bg-gradient-to-br from-primary/20 to-accent/10 p-10 text-center">
            <h2 className="mb-3 text-3xl font-bold">Make your first short today</h2>
            <p className="mb-6 text-muted-foreground">No credit card. The demo plan has monthly limits and never charges you.</p>
            <Button asChild size="lg">
              <Link to={signedIn ? '/app/projects/new' : '/register'}>Get started</Link>
            </Button>
          </div>
        </section>
      </main>
      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">© {new Date().getFullYear()} ClipForge AI</footer>
    </div>
  );
}
