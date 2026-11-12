/**
 * The Atlas light layer (spec g, L2): an optional PixiJS 8 canvas between the SVG scene and its
 * overlay. Decoration only: aria-hidden, no pointer events, no state of its own. Every frame it reads
 * the store's playhead and the Atlas camera and draws three things, each a pure function of the
 * playhead through the same selectors the SVG uses:
 *
 * - the work lamp's light pool on the floor of each working cell, with a soft falloff past its walls
 *   (fading in and out with the station's start and end, as the SVG lamp does);
 * - a short fading light trail behind each travelling packet (at most 40 px on screen);
 * - a brief wash of light when a gate opens (pass ink) or refuses (fail ink).
 *
 * It is off under reduced motion and when WebGL is unavailable; the SVG drawing is complete without
 * it. CSP: `pixi.js/unsafe-eval` (no `eval`), no workers, no images (the glow is drawn on a canvas),
 * loaded as its own chunk only when the layer is switched on.
 */
import { useEffect, useRef } from "react";
import type * as PixiModule from "pixi.js";
import { lampFalloff, lampPool, planeMatrix, project, slicePolyline, polylineLength } from "@mach/ui";
import { useSceneStore, useStore } from "../scene";
import { sceneAt, type GateState } from "../sim";
import type { CameraStore } from "../atlas/camera";
import type { PlantLayout } from "../atlas/layout";
import { PLATE_Z } from "../atlas/layout";
import { anim, lampLevel, legsInFlight } from "../atlas/derive";

type Pixi = typeof PixiModule;

export interface EffectsProps {
  camera: CameraStore;
  layout: PlantLayout;
  /** Called with true once the light is drawing, false when it stops: the SVG lamp pools switch off meanwhile (spec b.3, never both). */
  onActive?: (on: boolean) => void;
}

/** Whether a WebGL context can be made here (no context is kept). */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** The light layer. Mount it through AtlasView's `effects` prop. */
export function PixiEffects(props: EffectsProps) {
  const reduced = useSceneStore((s) => s.reducedMotion);
  if (reduced || typeof document === "undefined" || !webglAvailable()) return null;
  return <PixiLayer {...props} />;
}

function parseColor(value: string): [number, number, number] | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (rgb) {
    const [r = 0, g = 0, b = 0] = rgb[1]!.split(/[ ,/]+/).map(Number);
    return [r, g, b];
  }
  return null;
}
const toNum = ([r, g, b]: [number, number, number]) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);

interface Palette {
  dark: boolean;
  lamp: number;
  bloom: number;
  live: number;
  pass: number;
  fail: number;
  human: number;
}

/** Colours from the factory tokens on the page, re-read when the theme changes. */
function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const get = (name: string) => parseColor(css.getPropertyValue(`--mach-factory-${name}`)) ?? [128, 128, 128];
  const ground = get("ground");
  const dark = 0.299 * ground[0] + 0.587 * ground[1] + 0.114 * ground[2] < 128;
  const lamp = get("lamp");
  // The bloom around the pool: the lamp's own hue raised to a light's intensity (dark, screened) or
  // deepened once (light, multiplied onto the paper).
  const max = Math.max(...lamp, 1);
  const bloom: [number, number, number] = dark ? [(lamp[0] / max) * 235, (lamp[1] / max) * 235, (lamp[2] / max) * 235] : [(lamp[0] * lamp[0]) / 255, (lamp[1] * lamp[1]) / 255, (lamp[2] * lamp[2]) / 255];
  return { dark, lamp: toNum(lamp), bloom: toNum(bloom), live: toNum(get("live")), pass: toNum(get("pass")), fail: toNum(get("fail")), human: toNum(get("human")) };
}

function PixiLayer({ camera, layout, onActive }: EffectsProps) {
  const host = useRef<HTMLDivElement>(null);
  const store = useStore();
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let raf = 0;
    let destroy: (() => void) | null = null;
    void (async () => {
      try {
        await import("pixi.js/unsafe-eval");
        const PIXI: Pixi = await import("pixi.js");
        if (disposed) return;
        const app = new PIXI.Application();
        await app.init({ preference: "webgl", backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1), resizeTo: el, autoStart: false, sharedTicker: false });
        if (disposed) {
          app.destroy(true);
          return;
        }
        app.canvas.setAttribute("aria-hidden", "true");
        app.canvas.style.pointerEvents = "none";
        el.appendChild(app.canvas);
        // A soft round glow, drawn once on a canvas (no image, no data URL).
        const glowCanvas = document.createElement("canvas");
        glowCanvas.width = glowCanvas.height = 128;
        const g2 = glowCanvas.getContext("2d");
        if (g2) {
          const grad = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
          grad.addColorStop(0, "rgba(255,255,255,1)");
          grad.addColorStop(0.45, "rgba(255,255,255,0.55)");
          grad.addColorStop(1, "rgba(255,255,255,0)");
          g2.fillStyle = grad;
          g2.fillRect(0, 0, 128, 128);
        }
        const glow = PIXI.Texture.from(glowCanvas);
        // The lamp pool: the grammar's own falloff stops, so the light sits exactly where the SVG pool does.
        const poolCanvas = document.createElement("canvas");
        poolCanvas.width = poolCanvas.height = 128;
        const p2 = poolCanvas.getContext("2d");
        if (p2) {
          const grad = p2.createRadialGradient(64, 64, 0, 64, 64, 64);
          for (const [offset, opacity] of lampFalloff) grad.addColorStop(offset, `rgba(255,255,255,${opacity})`);
          p2.fillStyle = grad;
          p2.fillRect(0, 0, 128, 128);
        }
        const poolTexture = PIXI.Texture.from(poolCanvas);
        const world = new PIXI.Container();
        const lamps = new PIXI.Container();
        const washes = new PIXI.Container();
        const trails = new PIXI.Graphics();
        world.addChild(lamps, trails, washes);
        app.stage.addChild(world);
        const lampSprites = new Map<string, { holder: InstanceType<Pixi["Container"]>; sprite: InstanceType<Pixi["Sprite"]>; bloom: InstanceType<Pixi["Sprite"]> }>();
        const washPool: InstanceType<Pixi["Sprite"]>[] = [];
        let palette = readPalette(el);
        let paletteKey = "";
        let last = "";

        const frame = () => {
          raf = requestAnimationFrame(frame);
          const s = store.getState();
          const cam = camera.get();
          // Re-read the palette when the theme attribute or class changes.
          const key = `${document.documentElement.className}|${document.documentElement.getAttribute("data-theme")}|${document.documentElement.style.colorScheme}`;
          if (key !== paletteKey) {
            paletteKey = key;
            palette = readPalette(el);
            app.canvas.style.mixBlendMode = palette.dark ? "screen" : "multiply";
          }
          const stamp = `${s.playhead}|${cam.x}|${cam.y}|${cam.zoom}|${paletteKey}|${app.renderer.width}`;
          if (stamp === last) return;
          last = stamp;
          const t = s.playhead;
          const scene = sceneAt(s.fixture, t);
          world.position.set(cam.x, cam.y);
          world.scale.set(cam.zoom);

          // 1. Lamp pools, in the plane of each cell's floor.
          const seen = new Set<string>();
          for (const cell of Object.values(scene.cells)) {
            const a = lampLevel(cell, t);
            if (a <= 0) continue;
            const bay = layout.bayByTicket.get(cell.ticketId);
            if (!bay) continue;
            seen.add(cell.ticketId);
            let entry = lampSprites.get(cell.ticketId);
            const pool = lampPool(bay.origin, PLATE_Z);
            if (!entry) {
              const holder = new PIXI.Container();
              const bloom = new PIXI.Sprite(glow);
              const sprite = new PIXI.Sprite(poolTexture);
              bloom.anchor.set(0.5);
              sprite.anchor.set(0.5);
              holder.addChild(bloom, sprite);
              lamps.addChild(holder);
              entry = { holder, sprite, bloom };
              lampSprites.set(cell.ticketId, entry);
            }
            const [ma, mb, mc, md, me, mf] = planeMatrix(pool.z);
            entry.holder.setFromMatrix(new PIXI.Matrix(ma, mb, mc, md, me, mf));
            entry.sprite.position.set(pool.cx, pool.cy);
            entry.sprite.width = pool.rx * 2;
            entry.sprite.height = pool.ry * 2;
            entry.sprite.tint = palette.lamp;
            entry.sprite.alpha = a;
            // The bloom: a wider, fainter halo past the walls, capped (spec g: 0.18 dark, 0.10 light).
            entry.bloom.position.set(pool.cx, pool.cy);
            entry.bloom.width = pool.rx * 3.4;
            entry.bloom.height = pool.ry * 3.4;
            entry.bloom.tint = palette.bloom;
            entry.bloom.alpha = a * (palette.dark ? 0.18 : 0.1);
          }
          for (const [id, entry] of lampSprites) {
            if (!seen.has(id)) {
              entry.holder.destroy({ children: true });
              lampSprites.delete(id);
            }
          }

          // 2. Light trails behind travelling packets: at most 40 px long on screen, alpha at most 0.25.
          trails.clear();
          for (const { leg, p } of legsInFlight(s.fixture, t, false)) {
            if (leg.card || p <= 0 || p >= 1) continue;
            const len = polylineLength(leg.route);
            if (len <= 0) continue;
            const span = Math.min(p, 40 / cam.zoom / len);
            const pts = slicePolyline(leg.route, p - span, p).map(project);
            const color = leg.state === "failed" ? palette.fail : leg.state === "succeeded" ? palette.pass : leg.state === "human" ? palette.human : palette.live;
            const n = pts.length;
            for (let i = 1; i < n; i++) {
              const a = pts[i - 1]!;
              const b = pts[i]!;
              trails.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 5 / cam.zoom, color, alpha: 0.25 * (i / (n - 1)), cap: "round" });
            }
          }

          // 3. A brief wash of light when a gate opens or refuses.
          let used = 0;
          for (const gate of Object.values(scene.gates)) {
            const w = washOf(gate, t);
            if (!w) continue;
            const at = gatePoint(layout, gate);
            if (!at) continue;
            let sprite = washPool[used];
            if (!sprite) {
              sprite = new PIXI.Sprite(glow);
              sprite.anchor.set(0.5);
              washes.addChild(sprite);
              washPool.push(sprite);
            }
            used += 1;
            const p = project({ ...at, z: PLATE_Z + 18 });
            sprite.visible = true;
            sprite.position.set(p.x, p.y);
            sprite.width = sprite.height = 96;
            sprite.tint = w.kind === "fail" ? palette.fail : w.kind === "human" ? palette.human : palette.pass;
            sprite.alpha = w.alpha * (palette.dark ? 1 : 0.7);
          }
          for (let i = used; i < washPool.length; i++) washPool[i]!.visible = false;
          app.render();
        };
        raf = requestAnimationFrame(frame);
        onActive?.(true);
        destroy = () => {
          onActive?.(false);
          cancelAnimationFrame(raf);
          app.destroy(true, { children: true, texture: true });
        };
      } catch {
        // No WebGL, or the renderer could not start: the SVG drawing stands on its own.
      }
    })();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      destroy?.();
    };
  }, [camera, layout, store, onActive]);
  return <div ref={host} className="atlas-effects-layer" aria-hidden="true" />;
}

/** A gate's wash: a pass or refusal within its animation window, fading out. */
function washOf(gate: GateState, t: number): { kind: "pass" | "fail" | "human"; alpha: number } | null {
  if (gate.decidedAt === null || t < gate.decidedAt) return null;
  const elapsed = t - gate.decidedAt;
  if (gate.state === "passed") {
    const p = anim(gate.gate === "human-approval" ? "humanRelease" : "gateOpen", elapsed, false);
    return p < 1 ? { kind: gate.gate === "human-approval" ? "human" : "pass", alpha: 0.32 * (1 - p) } : null;
  }
  if (gate.state === "failed") {
    const p = anim("gateRefuse", elapsed, false);
    return p < 1 ? { kind: "fail", alpha: 0.4 * (1 - p) } : null;
  }
  return null;
}

function gatePoint(L: PlantLayout, gate: GateState) {
  switch (gate.gate) {
    case "verification":
      return L.bayByTicket.get(gate.ticketId)?.gate ?? null;
    case "review":
      return L.review.gate;
    case "human-approval":
      return L.human.gate;
    case "merge-revalidation":
      return L.integration.gate;
    case "audit":
      return L.intake.auditGate;
    default:
      return null;
  }
}
