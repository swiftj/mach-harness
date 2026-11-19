import React from "react";
import { AbsoluteFill, Easing, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { c, mono, sans } from "./theme";
import { footage, has } from "./script";

const ease = Easing.bezier(0.2, 0, 0, 1);
export const fade = (frame: number, at: number, len = 12) => interpolate(frame, [at, at + len], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
export const rise = (frame: number, at: number, len = 16, by = 24) => ({
  opacity: fade(frame, at, len),
  transform: `translateY(${interpolate(frame, [at, at + len], [by, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease })}px)`,
});

/** Fades a whole scene in and out so cuts land softly on the music. */
export const Scene: React.FC<{ bg: string; base?: string; children: React.ReactNode }> = ({ bg, base = c.night, children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const opacity = Math.min(fade(frame, 0, 10), 1 - fade(frame, durationInFrames - 10, 10));
  return (
    <AbsoluteFill style={{ background: base }}>
      <AbsoluteFill style={{ background: bg, opacity, fontFamily: sans }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

/** The MACH mark: four cells, one lit. */
export const Mark: React.FC<{ size: number; ink: string; lit?: number }> = ({ size, ink, lit = 1 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20">
    <rect x="1" y="1" width="8" height="8" rx="1.5" fill={ink} />
    <rect x="11" y="1" width="8" height="8" rx="1.5" fill="none" stroke={ink} strokeWidth="1.5" />
    <rect x="1" y="11" width="8" height="8" rx="1.5" fill="none" stroke={ink} strokeWidth="1.5" />
    <rect x="11" y="11" width="8" height="8" rx="1.5" fill={c.accent} opacity={lit} />
    <rect x="11" y="11" width="8" height="8" rx="1.5" fill="none" stroke={lit < 1 ? ink : c.accent} strokeWidth="1.5" />
  </svg>
);

/** Who this part of the film is for. */
export const Role: React.FC<{ at: number; label: string; dark?: boolean }> = ({ at, label, dark }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: "absolute", top: 44, left: 64, display: "flex", alignItems: "center", gap: 14, ...rise(frame, at, 14, -16) }}>
      <Mark size={30} ink={dark ? c.onDark : c.ink} />
      <span style={{ fontSize: 26, fontWeight: 650, color: dark ? c.onDark : c.ink }}>MACH</span>
      <span style={{ width: 1, height: 24, background: dark ? c.line : c.paperLine }} />
      <span style={{ fontSize: 24, fontWeight: 600, color: c.accent, letterSpacing: 1.5, textTransform: "uppercase" }}>{label}</span>
    </div>
  );
};

/** A short claim that appears beside the footage while the voice makes it. */
export const Callout: React.FC<{ from: number; to: number; text: string; note?: string; dark?: boolean; index?: number }> = ({ from, to, text, note, dark }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from - 2 || frame > to + 12) return null;
  const inn = spring({ frame: frame - from, fps, config: { damping: 200 }, durationInFrames: 18 });
  const out = 1 - fade(frame, to, 10);
  return (
    <div style={{ position: "absolute", left: 64, bottom: 40, opacity: inn * out, transform: `translateY(${(1 - inn) * 26}px)`, display: "flex", alignItems: "stretch", gap: 18, padding: "18px 30px 20px 18px", borderRadius: 14,
      background: dark ? "rgba(15,15,14,.94)" : "rgba(255,255,255,.97)", border: `1px solid ${dark ? c.line : c.paperLine}`, boxShadow: dark ? "0 18px 50px rgba(0,0,0,.55)" : "0 18px 50px rgba(20,20,19,.16)" }}>
      <div style={{ width: 6, borderRadius: 3, background: c.accent }} />
      <div>
        <div style={{ fontSize: 46, fontWeight: 700, lineHeight: 1.1, color: dark ? c.onDark : c.ink }}>{text}</div>
        {note ? <div style={{ fontSize: 26, marginTop: 6, color: dark ? c.onDarkMuted : c.inkMuted }}>{note}</div> : null}
      </div>
    </div>
  );
};

/** Screen footage in a plain window, with a slow push in. `start` and `rate` trim the clip to the voice. */
export const Screen: React.FC<{ clip: string; from: number; to: number; start?: number; rate?: number; dark?: boolean; zoom?: [number, number]; origin?: string }> = ({ clip, from, to, start = 0, rate = 1, dark, zoom = [1, 1.035], origin = "50% 40%" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from || frame >= to) return null;
  const local = frame - from;
  const opacity = Math.min(fade(local, 0, 9), 1 - fade(frame, to - 9, 9));
  const scale = interpolate(local, [0, to - from], zoom, { easing: Easing.inOut(Easing.ease) });
  const w = 1560, h = (w * 9) / 16;
  return (
    <div style={{ position: "absolute", left: (1920 - w) / 2, top: 100, width: w, height: h, borderRadius: 16, overflow: "hidden", opacity,
      boxShadow: dark ? "0 30px 90px rgba(0,0,0,.6), 0 0 0 1px #2E2D2A" : "0 30px 80px rgba(20,20,19,.18), 0 0 0 1px #D1CDBF", background: dark ? c.surface : "#fff" }}>
      <div style={{ width: "100%", height: "100%", transform: `scale(${scale})`, transformOrigin: origin }}>
        {has(clip) ? (
          <Sequence from={from} layout="none">
            <OffthreadVideo src={staticFile(`footage/${clip}.mp4`)} muted startFrom={Math.round(start * fps)} playbackRate={rate} style={{ width: "100%", height: "100%", objectFit: "cover" }}
              endAt={Math.round(footage[clip] * fps) - 1} />
          </Sequence>
        ) : (
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: mono, fontSize: 30, color: dark ? c.onDarkMuted : c.inkMuted }}>footage/{clip}.mp4</AbsoluteFill>
        )}
      </div>
    </div>
  );
};

/** Types text out, a few characters a frame. */
export const typed = (text: string, frame: number, at: number, perFrame = 0.9) => text.slice(0, Math.max(0, Math.floor((frame - at) * perFrame)));
