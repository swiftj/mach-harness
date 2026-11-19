import React from "react";
import { AbsoluteFill, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Mark, Scene, fade, rise, typed } from "../parts";
import { has } from "../script";
import { c, mono } from "../theme";

const Atlas: React.FC<{ start?: number; dim?: number }> = ({ start = 6, dim = 0.5 }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const scale = interpolate(frame, [0, durationInFrames], [1.06, 1.14]);
  return (
    <AbsoluteFill>
      {has("floor-atlas") ? (
        <OffthreadVideo src={staticFile("footage/floor-atlas.mp4")} muted startFrom={Math.round(start * fps)} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }} />
      ) : null}
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 45%, rgba(15,15,14,${dim - 0.12}) 0%, rgba(15,15,14,${dim + 0.3}) 75%)` }} />
    </AbsoluteFill>
  );
};

export const Title: React.FC<{ voiceAt: number }> = ({ voiceAt }) => {
  const frame = useCurrentFrame();
  const lit = fade(frame, 22, 14);
  const second = voiceAt + 54; // "Shipping the right thing..."
  return (
    <Scene bg={c.night}>
      <Atlas />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 34 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 30, ...rise(frame, 6, 20) }}>
          <Mark size={104} ink={c.onDark} lit={lit} />
          <span style={{ fontSize: 132, fontWeight: 750, letterSpacing: 6, color: c.onDark }}>MACH</span>
        </div>
        <div style={{ height: 150, textAlign: "center" }}>
          <div style={{ fontSize: 56, fontWeight: 600, color: c.onDark, ...rise(frame, voiceAt, 14) }}>AI can write code.</div>
          <div style={{ fontSize: 56, fontWeight: 600, color: c.accentInk, marginTop: 10, ...rise(frame, second, 14) }}>Shipping the right thing is still the hard part.</div>
        </div>
      </AbsoluteFill>
    </Scene>
  );
};

const QUESTIONS = ["What was asked for?", "What was really built?", "Can anyone prove it works?"];
const CHAIN = ["Intent", "Spec", "Contracts", "Plan", "Tests first", "Evidence", "Review", "Merged"];

export const Problem: React.FC<{ voiceAt: number }> = ({ voiceAt }) => {
  const frame = useCurrentFrame();
  const turn = voiceAt + 228; // "MACH is a software factory..."
  const before = 1 - fade(frame, turn - 10, 10);
  const prompt = "make renewals work like we discussed, you know what I mean";
  return (
    <Scene bg={c.night}>
      <AbsoluteFill style={{ opacity: before, padding: "0 190px", justifyContent: "center", gap: 46 }}>
        <div style={{ ...rise(frame, voiceAt - 8, 14), background: c.surface, border: `1px solid ${c.line}`, borderRadius: 16, padding: "30px 36px", fontFamily: mono, fontSize: 36, color: c.onDark, width: 1540, whiteSpace: "nowrap" }}>
          <span style={{ color: c.accent }}>&gt; </span>
          {typed(prompt, frame, voiceAt, 1.1)}
          <span style={{ opacity: frame % 20 < 10 ? 1 : 0, color: c.accent }}>▍</span>
        </div>
        <div style={{ display: "flex", gap: 28 }}>
          {QUESTIONS.map((q, i) => (
            <div key={q} style={{ ...rise(frame, voiceAt + 84 + i * 34, 14), flex: 1, border: `1.5px dashed ${c.ochre}`, borderRadius: 16, padding: "30px 30px", fontSize: 40, fontWeight: 650, color: c.onDark }}>
              <div style={{ fontSize: 64, color: c.ochre, lineHeight: 1, marginBottom: 12 }}>?</div>
              {q}
            </div>
          ))}
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ opacity: fade(frame, turn, 12), alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 56 }}>
        <div style={{ fontSize: 76, fontWeight: 720, color: c.onDark }}>
          A software factory for <span style={{ color: c.accentInk }}>both ends</span>.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {CHAIN.map((step, i) => {
            const on = fade(frame, turn + 14 + i * 7, 8);
            return (
              <React.Fragment key={step}>
                {i ? <div style={{ width: 30, height: 2, background: c.accent, opacity: on }} /> : null}
                <div style={{ opacity: 0.25 + on * 0.75, padding: "14px 22px", borderRadius: 10, fontSize: 30, fontWeight: 600, color: c.onDark, background: c.surface,
                  border: `1.5px solid ${i === CHAIN.length - 1 ? c.green : i === 0 ? c.accent : c.line}` }}>{step}</div>
              </React.Fragment>
            );
          })}
        </div>
      </AbsoluteFill>
    </Scene>
  );
};

export const Close: React.FC<{ voiceAt: number }> = ({ voiceAt }) => {
  const frame = useCurrentFrame();
  return (
    <Scene bg={c.night}>
      <Atlas start={10} dim={0.58} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 30 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 30, ...rise(frame, voiceAt - 6, 16) }}>
          <Mark size={104} ink={c.onDark} />
          <span style={{ fontSize: 132, fontWeight: 750, letterSpacing: 6, color: c.onDark }}>MACH</span>
        </div>
        <div style={{ fontSize: 60, fontWeight: 600, color: c.onDark, ...rise(frame, voiceAt + 24, 16) }}>
          From intent to merged, <span style={{ color: c.accentInk }}>with proof.</span>
        </div>
        <div style={{ fontSize: 28, color: c.onDarkMuted, letterSpacing: 2, marginTop: 26, ...rise(frame, voiceAt + 80, 18) }}>
          PRODUCT STUDIO &nbsp;·&nbsp; THE FACTORY &nbsp;·&nbsp; FACTORY FLOOR
        </div>
      </AbsoluteFill>
    </Scene>
  );
};
