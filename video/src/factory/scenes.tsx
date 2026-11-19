import React from "react";
import { AbsoluteFill, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Callout, Mark, Role, Scene, Screen, fade, rise, typed } from "../parts";
import { has } from "../script";
import { c, mono } from "../theme";

const s = (n: number) => Math.round(n * 30);
const Light: React.FC<{ children: React.ReactNode }> = ({ children }) => <Scene bg={c.cream} base={c.cream}>{children}</Scene>;

/** The isometric floor behind a veil of paper, for the cards that open and close the film. */
const Plant: React.FC<{ clip: string; start?: number; veil?: number }> = ({ clip, start = 0, veil = 0.6 }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const scale = interpolate(frame, [0, durationInFrames], [1.04, 1.12]);
  return (
    <AbsoluteFill>
      {has(clip) ? <OffthreadVideo src={staticFile(`footage/${clip}.mp4`)} muted startFrom={Math.round(start * fps)} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }} /> : null}
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 46%, rgba(250,249,245,${veil + 0.22}) 0%, rgba(250,249,245,${veil}) 55%, rgba(250,249,245,${veil - 0.2}) 100%)` }} />
    </AbsoluteFill>
  );
};

const Chip: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <span style={{ fontFamily: mono, fontSize: 30, padding: "8px 20px", borderRadius: 10, background: c.ink, color: c.cream, ...style }}>{children}</span>
);

export const Title: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const frame = useCurrentFrame();
  return (
    <Light>
      <Plant clip="light-atlas-wide" />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 30 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 30, ...rise(frame, 6, 20) }}>
          <Mark size={104} ink={c.ink} lit={fade(frame, 22, 14)} />
          <span style={{ fontSize: 132, fontWeight: 750, letterSpacing: 6, color: c.ink }}>MACH</span>
        </div>
        <div style={{ fontSize: 60, fontWeight: 650, color: c.ink, ...rise(frame, v, 14) }}>This is a software factory.</div>
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 46, fontWeight: 600, color: c.inkMuted, ...rise(frame, v + s(2.3), 14) }}>
          It runs entirely inside <Chip>Claude Code</Chip>
        </div>
      </AbsoluteFill>
    </Light>
  );
};

const STATIONS: [string, string, string][] = [
  ["Groom", "Fable", "interviews, writes the spec"], ["Plan", "Opus", "contracts and a test-first plan"], ["Build", "Sonnet", "tests first, then code"],
  ["Verify", "Sonnet", "captures the evidence"], ["Review", "Opus · Sonnet", "an independent panel"], ["Merge", "script", "lands the approved commit"],
];
const NATIVE = ["skills", "sub-agents", "workflows", "git worktrees"];

export const Premise: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const frame = useCurrentFrame();
  const run = v + s(4.2); // "Planned, built, verified, reviewed and merged"
  const native = v + s(11.6); // "No new platform to adopt"
  const at = interpolate(frame, [run, run + s(5.6)], [0, STATIONS.length - 0.01], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Light>
      <Role at={4} label="The factory" />
      <AbsoluteFill style={{ padding: "0 90px", justifyContent: "center", gap: 46 }}>
        <div style={{ fontSize: 66, fontWeight: 720, color: c.ink, ...rise(frame, v, 16) }}>
          Product intent goes in. <span style={{ color: c.accent }}>Merged, proven software</span> comes out.
        </div>
        <div style={{ display: "flex", gap: 14, ...rise(frame, v + s(2.4), 16) }}>
          {STATIONS.map(([name, tier, job], i) => {
            const on = frame >= run && Math.floor(at) === i;
            const done = frame >= run && at > i + 1 - 0.01;
            return (
              <div key={name} style={{ flex: 1, background: "#fff", borderRadius: 14, padding: "22px 20px 20px", border: `2px solid ${on ? c.accent : done ? c.green : c.paperLine}`, boxShadow: on ? "0 14px 40px rgba(217,119,87,.25)" : "0 6px 20px rgba(20,20,19,.06)", transform: `translateY(${on ? -8 : 0}px)` }}>
                <div style={{ fontSize: 34, fontWeight: 720, color: c.ink }}>{name}</div>
                <div style={{ fontFamily: mono, fontSize: 20, color: c.accent, marginTop: 4 }}>{tier}</div>
                <div style={{ fontSize: 22, color: c.inkMuted, marginTop: 10, lineHeight: 1.25 }}>{job}</div>
                <div style={{ height: 6, borderRadius: 3, marginTop: 16, background: done ? c.green : on ? c.accent : c.paperLine }} />
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18, opacity: fade(frame, native, 14) }}>
          <Chip>Claude Code</Chip>
          <span style={{ fontSize: 34, color: c.inkMuted }}>in your own repository, built from its own</span>
          {NATIVE.map((n, i) => (
            <span key={n} style={{ fontFamily: mono, fontSize: 26, padding: "7px 16px", borderRadius: 999, border: `1.5px solid ${c.ink}`, color: c.ink, background: "#fff", ...rise(frame, native + 16 + i * 7, 10) }}>{n}</span>
          ))}
        </div>
      </AbsoluteFill>
    </Light>
  );
};

/** The hand-off drawn in MACH's own style: the approved slice becomes the cell's work order. */
const WorkOrder: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  const go = fade(frame, at + 34, 22);
  const card: React.CSSProperties = { width: 640, background: "#fff", borderRadius: 18, border: `1px solid ${c.paperLine}`, boxShadow: "0 24px 70px rgba(20,20,19,.14)", padding: "34px 40px" };
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 40, opacity: fade(frame, at, 12) }}>
      <div style={{ ...card, ...rise(frame, at, 16, 30) }}>
        <div style={{ fontSize: 22, color: c.inkMuted, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600 }}>Product Studio · approved slice</div>
        <div style={{ fontSize: 46, fontWeight: 720, color: c.ink, marginTop: 6 }}>Invite a teammate <span style={{ color: c.inkMuted, fontWeight: 400 }}>#11</span></div>
        <div style={{ fontSize: 26, color: c.ink, marginTop: 16, lineHeight: 1.5 }}>4 rules · 9 requirements<br />5 decisions · 3 scenarios</div>
        <div style={{ fontFamily: mono, fontSize: 22, color: c.green, marginTop: 16 }}>✓ approved · spec and why hashed</div>
      </div>
      <div style={{ width: 150, height: 6, borderRadius: 3, background: c.paperLine, overflow: "hidden" }}>
        <div style={{ width: `${go * 100}%`, height: "100%", background: c.accent }} />
      </div>
      <div style={{ ...card, borderColor: go > 0.95 ? c.accent : c.paperLine, opacity: 0.35 + go * 0.65 }}>
        <div style={{ fontSize: 22, color: c.inkMuted, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600 }}>The factory · cell 11</div>
        <div style={{ fontSize: 46, fontWeight: 720, color: c.ink, marginTop: 6 }}>Work order</div>
        <div style={{ fontFamily: mono, fontSize: 24, color: c.ink, marginTop: 16, lineHeight: 1.6 }}>specs/slices/SLICE-004…<br />branch feature/11</div>
        <div style={{ fontFamily: mono, fontSize: 22, color: c.green, marginTop: 16, opacity: go }}>✓ same text, checked by hash</div>
      </div>
    </AbsoluteFill>
  );
};

export const Studio: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const { durationInFrames: end } = useVideoConfig();
  const order = v + s(9.6);
  return (
    <Light>
      <Role at={0} label="Product manager → factory" />
      <Screen clip="studio-interview" from={0} to={v + s(5.6)} start={5.4} rate={1.3} origin="50% 55%" zoom={[1, 1.05]} />
      <Screen clip="studio-ready" from={v + s(5.6)} to={order + 8} start={4.2} rate={1.2} />
      <Callout from={v + s(0.4)} to={v + s(5.2)} text="It begins in Product Studio" note="A slice of intent, settled by interview" />
      <Callout from={v + s(5.9)} to={order - 8} text="Marked ready" note="Saved as an approved issue" />
      <WorkOrder at={order} />
      <Callout from={v + s(12.6)} to={end - 16} text="Nothing is lost in translation" note="The factory builds the text the product manager approved" />
    </Light>
  );
};

const PULL = [
  "At most 3 ticket(s) at once, 1 of them High-risk.",
  "Took in: SLICE-004 (ticket 11), SLICE-005 (ticket 12), SLICE-006 (ticket 13).",
  "Starts now: 11 (SLICE-004) is dispatched and planned.",
  "Starts now: 12 (SLICE-005) is dispatched and planned.",
  "Waits: 13 (SLICE-006): it depends on SLICE-004; it starts when that is merged.",
  "To run: 11, 12.",
];

export const Engineer: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: end } = useVideoConfig();
  const cells = v + s(6.4);
  return (
    <Light>
      <Role at={0} label="Engineer" />
      <div style={{ position: "absolute", left: 64, top: 150, width: 1120, height: 640, background: "#fff", border: `1px solid ${c.paperLine}`, borderRadius: 16, boxShadow: "0 30px 80px rgba(20,20,19,.14)", overflow: "hidden" }}>
        <div style={{ height: 46, background: c.paper, borderBottom: `1px solid ${c.paperLine}`, display: "flex", alignItems: "center", paddingLeft: 20, fontFamily: mono, fontSize: 20, color: c.inkMuted }}>Claude Code · team-space</div>
        <div style={{ padding: "28px 32px", fontFamily: mono, fontSize: 26, lineHeight: 1.6, color: c.ink }}>
          <div><span style={{ color: c.accent }}>&gt; </span>{typed("/mach pull", frame, v + 4, 0.5)}{frame < v + 30 ? <span style={{ color: c.accent, opacity: frame % 20 < 10 ? 1 : 0 }}>▍</span> : null}</div>
          {PULL.map((line, i) => (
            <div key={line} style={{ opacity: fade(frame, v + 40 + i * 14, 8), color: line.startsWith("Starts") ? c.ink : line.startsWith("To run") ? c.accent : c.inkMuted, fontWeight: line.startsWith("To run") ? 700 : 400, paddingLeft: 34, textIndent: -34 }}>{line}</div>
          ))}
        </div>
      </div>
      <div style={{ position: "absolute", right: 64, top: 150, width: 600 }}>
        <div style={{ fontSize: 24, color: c.inkMuted, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600, marginBottom: 16, opacity: fade(frame, cells, 12) }}>Isolated cells · git worktrees</div>
        {[["11", "Invite a teammate", "planning"], ["12", "Remove a teammate", "planning"], ["13", "Change a teammate's role", "waits for 11"]].map(([n, title, state], i) => (
          <div key={n} style={{ background: "#fff", border: `1.5px solid ${i < 2 ? c.accent : c.paperLine}`, borderRadius: 14, padding: "20px 24px", marginBottom: 14, ...rise(frame, cells + 8 + i * 12, 14) }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
              <span style={{ fontFamily: mono, fontSize: 24, color: c.inkMuted }}>cell {n}</span>
              <span style={{ fontSize: 32, fontWeight: 650, color: c.ink }}>{title}</span>
            </div>
            <div style={{ fontFamily: mono, fontSize: 21, color: c.inkMuted, marginTop: 6 }}>feature/{n} · <span style={{ color: i < 2 ? c.accent : c.ochre }}>{state}</span></div>
          </div>
        ))}
      </div>
      <Callout from={v + s(0.3)} to={v + s(5.8)} text="One command" note="The factory pulls whatever is ready" />
      <Callout from={cells + 6} to={end - 16} text="One isolated cell per ticket" note="Scheduled so parallel work never collides" />
    </Light>
  );
};

export const Floor: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: end } = useVideoConfig();
  const names = ["Grooming", "Planning", "Building", "Verification", "Review"];
  const list = v + s(11.2);
  return (
    <Light>
      <Role at={0} label="Factory Floor" />
      <Screen clip="light-atlas-arrive" from={0} to={v + s(6.2)} start={1.8} rate={1.3} zoom={[1, 1.04]} origin="50% 50%" />
      <Screen clip="light-atlas-wide" from={v + s(6.2)} to={end} zoom={[1.02, 1.1]} origin="50% 50%" />
      <Callout from={v + s(0.3)} to={v + s(5.6)} text="The factory floor" note="Every cell is a ticket being built" />
      <Callout from={v + s(6.5)} to={list - 8} text="Watch the work move" note="Slices arrive · agents take their stations" />
      <div style={{ position: "absolute", left: 64, bottom: 44, display: "flex", gap: 12, opacity: fade(frame, list, 10) * (1 - fade(frame, end - 16, 10)) }}>
        {names.map((n, i) => (
          <div key={n} style={{ fontSize: 34, fontWeight: 700, color: c.ink, background: "rgba(255,255,255,.97)", border: `1.5px solid ${c.paperLine}`, borderBottom: `5px solid ${c.accent}`, borderRadius: 12, padding: "12px 24px", boxShadow: "0 14px 40px rgba(20,20,19,.14)", ...rise(frame, list + i * 22, 10) }}>{n}</div>
        ))}
      </div>
    </Light>
  );
};

export const Proof: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: end } = useVideoConfig();
  const claim = v + s(3.4), tests = v + s(8.4), verify = v + s(13), panel = v + s(18.2);
  const big = Math.min(fade(frame, claim, 12), 1 - fade(frame, tests - 14, 10));
  return (
    <Light>
      <Role at={0} label="Why it is a factory" />
      <Screen clip="light-atlas-cell" from={0} to={verify} start={0.4} zoom={[1, 1.04]} />
      <Screen clip="light-record" from={verify} to={panel} start={7.6} zoom={[1, 1.04]} />
      <Screen clip="light-atlas-review" from={panel} to={end} start={4.2} zoom={[1, 1.04]} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: big }}>
        <div style={{ background: "rgba(250,249,245,.96)", border: `1px solid ${c.paperLine}`, borderRadius: 22, padding: "44px 64px", boxShadow: "0 30px 90px rgba(20,20,19,.2)", textAlign: "center" }}>
          <div style={{ fontSize: 76, fontWeight: 740, color: c.ink }}>The agents write the code.</div>
          <div style={{ fontSize: 76, fontWeight: 740, color: c.accent, marginTop: 6, ...rise(frame, claim + s(1.9), 12) }}>Scripts decide whether it counts.</div>
        </div>
      </AbsoluteFill>
      <Callout from={v + s(0.3)} to={claim - 6} text="A factory, not a chat" />
      <Callout from={tests + 6} to={verify - 8} text="Red before green" note="A test must be seen failing before the code that passes it" />
      <Callout from={verify + 6} to={panel - 8} text="Evidence, not self-report" note="A fresh verifier captures proof of every scenario" />
      <Callout from={panel + 6} to={end - 16} text="An independent panel votes" note="Three rounds at most, then a person decides" />
    </Light>
  );
};

export const Line: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const { durationInFrames: end } = useVideoConfig();
  return (
    <Light>
      <Role at={0} label="The line" />
      <Screen clip="light-switch" from={0} to={v + s(3.2)} start={1.6} rate={1.2} zoom={[1, 1.02]} />
      <Screen clip="light-line" from={v + s(3.2)} to={end} start={8.5} zoom={[1.04, 1.1]} origin="100% 6%" />
      <Callout from={v + s(0.3)} to={v + s(3)} text="Switch to the line" />
      <Callout from={v + s(3.5)} to={end - 16} text="Every ticket, at its station" note="Why it waits · where the time went · the command to move it on" />
    </Light>
  );
};

export const People: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const { durationInFrames: end } = useVideoConfig();
  return (
    <Light>
      <Role at={0} label="People stay in charge" />
      <Screen clip="light-needs-you" from={0} to={end} start={0.2} rate={0.85} zoom={[1.04, 1.1]} origin="100% 6%" />
      <Callout from={v + s(0.3)} to={v + s(3.6)} text="It never guesses on your behalf" />
      <Callout from={v + s(3.9)} to={end - 16} text="It stops, says so, and waits" note="Approvals, merges and risky calls stay with a person" />
    </Light>
  );
};

export const Close: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const frame = useCurrentFrame();
  const rows: [string, string, number][] = [["Product managers", "define it.", 1.1], ["Engineers", "run it.", 3.0], ["The factory", "proves it.", 4.6]];
  return (
    <Light>
      <Plant clip="light-atlas-wide" start={3} veil={0.66} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 22 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 26, marginBottom: 18, ...rise(frame, v - 6, 16) }}>
          <Mark size={92} ink={c.ink} />
          <span style={{ fontSize: 116, fontWeight: 750, letterSpacing: 6, color: c.ink }}>MACH</span>
        </div>
        {rows.map(([who, what, t]) => (
          <div key={who} style={{ fontSize: 56, fontWeight: 650, color: c.ink, ...rise(frame, v + s(t), 12) }}>
            {who} <span style={{ color: c.accent }}>{what}</span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 40, color: c.inkMuted, marginTop: 22, ...rise(frame, v + s(6.6), 14) }}>
          All in <Chip>Claude Code</Chip>
        </div>
      </AbsoluteFill>
    </Light>
  );
};
