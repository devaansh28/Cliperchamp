import { CAPTION_PRESETS, CaptionStyleSchema, VIDEO_TEMPLATES, type CaptionStyle } from '@clipforge/shared';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { Field, Input, Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useEditorStore } from '../editor-store';

const FONTS: CaptionStyle['fontFamily'][] = ['Inter', 'Montserrat', 'Bebas Neue', 'Roboto Mono', 'DejaVu Sans'];

export function StylePanel() {
  const timeline = useEditorStore((s) => s.timeline)!;
  const update = useEditorStore((s) => s.update);
  const style = timeline.captionStyle;
  const [keywords, setKeywords] = useState(style.highlightKeywords.join(', '));
  const set = (patch: Partial<CaptionStyle>, key?: string) =>
    update((t) => ({ ...t, captionStyle: CaptionStyleSchema.parse({ ...t.captionStyle, ...patch }) }), key ? `style:${key}` : undefined);

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Templates</h3>
        <div className="grid gap-2">
          {VIDEO_TEMPLATES.map((t) => {
            const preset = CAPTION_PRESETS.find((p) => p.id === t.captionPreset);
            return (
              <button key={t.id} type="button" className="rounded-md border border-border p-2 text-left hover:border-primary/60" onClick={() => preset && set({ ...preset.style, preset: preset.id })}>
                <p className="text-xs font-medium">{t.label}</p>
                <p className="text-[11px] text-muted-foreground">{t.description}</p>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Caption style</h3>
        <div className="grid grid-cols-2 gap-2">
          {CAPTION_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={style.preset === p.id}
              onClick={() => set({ ...CaptionStyleSchema.parse({}), ...p.style, preset: p.id, highlightKeywords: style.highlightKeywords })}
              className={cn('relative rounded-md border border-border bg-black px-2 py-3 text-center', style.preset === p.id && 'border-primary ring-1 ring-primary')}
            >
              {style.preset === p.id ? <Check className="absolute right-1 top-1 size-3 text-primary" /> : null}
              <span
                style={{
                  fontFamily: p.style.fontFamily,
                  fontWeight: p.style.fontWeight,
                  color: p.style.textColor,
                  textTransform: p.style.uppercase ? 'uppercase' : 'none',
                  textShadow: p.style.strokeWidth ? '0 2px 0 #000, 0 0 3px #000' : undefined,
                }}
                className="text-sm"
              >
                {p.label} <span style={{ color: p.style.highlightColor }}>Aa</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Font" htmlFor="style-font">
            <Select id="style-font" value={style.fontFamily} onChange={(e) => set({ fontFamily: e.target.value as CaptionStyle['fontFamily'] })}>
              {FONTS.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </Select>
          </Field>
          <Field label="Weight" htmlFor="style-weight">
            <Select id="style-weight" value={style.fontWeight} onChange={(e) => set({ fontWeight: Number(e.target.value) as CaptionStyle['fontWeight'] })}>
              {[400, 600, 700, 800, 900].map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`Size ${style.fontSize}px`} htmlFor="style-size">
            <input id="style-size" type="range" min={24} max={160} value={style.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) }, 'size')} className="w-full" />
          </Field>
          <Field label={`Outline ${style.strokeWidth}px`} htmlFor="style-stroke">
            <input id="style-stroke" type="range" min={0} max={16} value={style.strokeWidth} onChange={(e) => set({ strokeWidth: Number(e.target.value) }, 'stroke')} className="w-full" />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ['textColor', 'Text'],
              ['highlightColor', 'Highlight'],
              ['strokeColor', 'Outline'],
            ] as const
          ).map(([k, label]) => (
            <Field key={k} label={label} htmlFor={`style-${k}`}>
              <input id={`style-${k}`} type="color" value={style[k]} onChange={(e) => set({ [k]: e.target.value }, k)} className="h-8 w-full cursor-pointer rounded border border-border bg-transparent" />
            </Field>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Position" htmlFor="style-position">
            <Select id="style-position" value={style.position} onChange={(e) => set({ position: e.target.value as CaptionStyle['position'] })}>
              <option value="top">Top</option>
              <option value="center">Middle</option>
              <option value="bottom">Bottom</option>
            </Select>
          </Field>
          <Field label="Animation" htmlFor="style-animation">
            <Select id="style-animation" value={style.animation} onChange={(e) => set({ animation: e.target.value as CaptionStyle['animation'] })}>
              <option value="karaoke">Word highlight</option>
              <option value="pop">Pop</option>
              <option value="fade">Fade</option>
              <option value="none">None</option>
            </Select>
          </Field>
          <Field label={`Nudge ${style.offsetY}%`} htmlFor="style-offset">
            <input id="style-offset" type="range" min={-30} max={30} value={style.offsetY} onChange={(e) => set({ offsetY: Number(e.target.value) }, 'offset')} className="w-full" />
          </Field>
          <Field label={`Line length ${style.maxCharsPerLine}`} htmlFor="style-line">
            <input id="style-line" type="range" min={8} max={40} value={style.maxCharsPerLine} onChange={(e) => set({ maxCharsPerLine: Number(e.target.value) }, 'line')} className="w-full" />
          </Field>
        </div>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={style.uppercase} onChange={(e) => set({ uppercase: e.target.checked })} /> Uppercase
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={style.shadow} onChange={(e) => set({ shadow: e.target.checked })} /> Shadow
          </label>
        </div>
        <Field label="Highlight keywords" htmlFor="style-keywords" hint="Comma separated. These words always use the highlight color.">
          <Input
            id="style-keywords"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            onBlur={() =>
              set({
                highlightKeywords: keywords
                  .split(',')
                  .map((k) => k.trim())
                  .filter(Boolean)
                  .slice(0, 50)
                  .map((k) => k.slice(0, 40)),
              })
            }
          />
        </Field>
      </section>
    </div>
  );
}
