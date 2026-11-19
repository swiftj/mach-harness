import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Callout, Role, Scene, Screen, fade, rise, typed } from "../parts";
import { c, mono } from "../theme";

const s = (n: number) => Math.round(n * 30);

// The words `/mach pull` prints for a schedule (skills/run/scripts/pull.py, in_words).
const PULL = [
  "At most 3 ticket(s) at once, 1 of them High-risk.",
  "Took in: SLICE-004 (ticket 11), SLICE-005 (ticket 12), SLICE-006 (ticket 13).",
  "Starts now: 11 (SLICE-004) is dispatched and planned.",
  "Starts now: 12 (SLICE-005) is dispatched and planned.",
  "Waits: 13 (SLICE-006): it depends on SLICE-004; it starts when that is merged.",
  "To run: 11, 12.",
];
const TOPICS = ["language", "framework", "storage", "testing", "deployment", "coding-standards"];

export const Engineer: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: end } = useVideoConfig();
  const command = "/mach pull";
  const adr = v + s(4.6);
  const shift = fade(frame, adr, 16);
  return (
    <Scene bg={c.night}>
      <Role at={0} label="Engineer" dark />
      <div style={{ position: "absolute", left: 150 - shift * 86, top: 170, width: 1620 - shift * 640, height: 660, background: c.surface, border: `1px solid ${c.line}`, borderRadius: 16, boxShadow: "0 30px 90px rgba(0,0,0,.6)", overflow: "hidden" }}>
        <div style={{ height: 46, background: c.raised, borderBottom: `1px solid ${c.line}`, display: "flex", alignItems: "center", paddingLeft: 20, fontFamily: mono, fontSize: 20, color: c.onDarkMuted }}>claude · team-space</div>
        <div style={{ padding: "30px 34px", fontFamily: mono, fontSize: 26, lineHeight: 1.6, color: c.onDark }}>
          <div>
            <span style={{ color: c.accent }}>&gt; </span>
            {typed(command, frame, v + 6, 0.5)}
            {frame < v + 34 ? <span style={{ color: c.accent, opacity: frame % 20 < 10 ? 1 : 0 }}>▍</span> : null}
          </div>
          {PULL.map((line, i) => (
            <div key={line} style={{ opacity: fade(frame, v + 44 + i * 13, 8), color: line.startsWith("Starts") ? c.onDark : line.startsWith("To run") ? c.accentInk : c.onDarkMuted, paddingLeft: 34, textIndent: -34 }}>{line}</div>
          ))}
        </div>
      </div>
      <div style={{ position: "absolute", right: 64, top: 170, width: 660, opacity: shift, transform: `translateX(${(1 - shift) * 60}px)` }}>
        <div style={{ fontSize: 24, color: c.onDarkMuted, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600, marginBottom: 16 }}>Architecture decisions · docs/adr</div>
        {TOPICS.map((topic, i) => {
          const on = fade(frame, adr + 20 + i * 12, 10);
          return (
            <div key={topic} style={{ display: "flex", alignItems: "center", gap: 18, background: c.surface, border: `1px solid ${c.line}`, borderRadius: 12, padding: "19px 24px", marginBottom: 12, opacity: 0.35 + on * 0.65 }}>
              <span style={{ fontFamily: mono, fontSize: 22, color: c.onDarkMuted }}>ADR-000{i + 1}</span>
              <span style={{ fontSize: 30, fontWeight: 600, color: c.onDark, flex: 1 }}>{topic}</span>
              <span style={{ fontSize: 22, fontWeight: 650, color: c.green, opacity: on, border: `1.5px solid ${c.green}`, borderRadius: 999, padding: "3px 14px" }}>accepted</span>
            </div>
          );
        })}
      </div>
      <Callout dark from={v + s(0.3)} to={adr - 6} text="One command pulls what is ready" />
      <Callout dark from={adr + 10} to={end - 16} text="Agents build on your stack" note="No plan until the decisions are accepted" />
    </Scene>
  );
};

const TIERS: [string, string][] = [["Fable", "plans and grooms"], ["Opus", "contracts, high-risk review"], ["Sonnet", "builds and verifies"], ["Haiku", "tickets and cleanup"]];

export const Line: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: end } = useVideoConfig();
  const tiers = v + s(15.2);
  return (
    <Scene bg={c.night}>
      <Role at={0} label="The factory line" dark />
      <Screen dark clip="floor-line" from={0} to={v + s(8.6)} start={0.4} rate={1.25} zoom={[1.08, 1.16]} origin="0% 8%" />
      <Screen dark clip="floor-record" from={v + s(8.6)} to={v + s(12.6)} start={6.3} rate={1.3} />
      <Screen dark clip="floor-station" from={v + s(12.6)} to={end} start={1.2} rate={1.1} zoom={[1.04, 1.1]} origin="100% 6%" />
      <Callout dark from={v + s(1.4)} to={v + s(4)} text="One isolated cell per ticket" />
      <Callout dark from={v + s(4.3)} to={v + s(8.3)} text="Tests first" note="Each must be seen failing before code counts" />
      <Callout dark from={v + s(8.9)} to={v + s(12.3)} text="A fresh verifier" note="Captured evidence for every scenario" />
      <Callout dark from={v + s(12.9)} to={tiers - 6} text="An independent review panel" />
      <div style={{ position: "absolute", left: 64, right: 64, bottom: 40, display: "flex", gap: 16, opacity: fade(frame, tiers, 12) * (1 - fade(frame, end - 16, 10)) }}>
        {TIERS.map(([name, job], i) => (
          <div key={name} style={{ flex: 1, background: "rgba(28,28,26,.94)", border: `1px solid ${c.line}`, borderRadius: 12, padding: "16px 22px", ...rise(frame, tiers + i * 5, 12) }}>
            <div style={{ fontSize: 32, fontWeight: 700, color: i === 0 ? c.accentInk : c.onDark }}>{name}</div>
            <div style={{ fontSize: 23, color: c.onDarkMuted }}>{job}</div>
          </div>
        ))}
      </div>
    </Scene>
  );
};

export const Visibility: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const { durationInFrames: end } = useVideoConfig();
  return (
    <Scene bg={c.night}>
      <Role at={0} label="Factory Floor" dark />
      <Screen dark clip="floor-line" from={0} to={v + s(6.6)} start={12} zoom={[1.04, 1.1]} origin="100% 6%" />
      <Screen dark clip="floor-needs-you" from={v + s(6.6)} to={end} start={1.2} zoom={[1.04, 1.1]} origin="100% 6%" />
      <Callout dark from={v + s(0.3)} to={v + s(6.2)} text="Every ticket, live" note="Where it is · why it waits · where the time went" />
      <Callout dark from={v + s(6.9)} to={end - 16} text="People decide where it matters" note="The factory says exactly what it needs" />
    </Scene>
  );
};

export const Analytics: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const { durationInFrames: end } = useVideoConfig();
  return (
    <Scene bg={c.night}>
      <Role at={0} label="Factory Floor" dark />
      <Screen dark clip="floor-analytics" from={0} to={end} />
      <Callout dark from={v + s(0.3)} to={v + s(5.6)} text="Every step is recorded" note="See where time and rework really go" />
      <Callout dark from={v + s(5.9)} to={end - 16} text="A factory that improves its own rules" note="Proposed from evidence, reviewed like any change" />
    </Scene>
  );
};
