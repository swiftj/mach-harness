import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Callout, Mark, Scene, Screen, fade, rise } from "../parts";
import { footage, has } from "../script";
import { c, mono } from "../theme";

export type Props = { voiceAt: number; cue: (phrase: string) => number };

const Light: React.FC<{ children: React.ReactNode }> = ({ children }) => <Scene bg={c.cream} base={c.cream}>{children}</Scene>;

const Chip: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <span style={{ fontFamily: mono, fontSize: 30, padding: "8px 20px", borderRadius: 10, background: c.ink, color: c.cream, ...style }}>{children}</span>
);

/** Screen footage whose speed is set so the clip fills its span, slowed or quickened only a little. */
const Shot: React.FC<{ clip: string; from: number; to: number; start?: number; zoom?: [number, number]; origin?: string }> = ({ clip, from, to, start = 0, ...rest }) => {
  const { fps } = useVideoConfig();
  const len = has(clip) ? footage[clip] - start : 0;
  const rate = len > 0 ? Math.min(1.25, Math.max(0.6, len / ((to - from) / fps))) : 1;
  return <Screen clip={clip} from={from} to={to} start={start} rate={rate} zoom={rest.zoom ?? [1, 1.04]} origin={rest.origin} />;
};

// The through-line: an idea's way through MACH, which moves on one step as the film does.
const STEPS = ["Idea", "Brief", "Verdict", "Slices", "Code", "Proof", "Look back"];
const easeOut = Easing.bezier(0.2, 0, 0, 1);

/** Where along the chain the scene stands: [frame, step] keys, eased between. */
const usePlace = (keys: [number, number][]) => {
  const frame = useCurrentFrame();
  if (keys.length === 1) return keys[0][1];
  return interpolate(frame, keys.map((k) => k[0]), keys.map((k) => k[1]), { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
};

/** The chain across the top of every scene: steps passed are ink and filled, the current one terracotta, those to come outlined. */
const Chain: React.FC<{ keys: [number, number][]; brand?: boolean; show?: number }> = ({ keys, brand = true, show = 1 }) => {
  const frame = useCurrentFrame();
  const p = usePlace(keys);
  const here = Math.floor(p + 0.02);
  return (
    <div style={{ position: "absolute", top: 36, left: 64, right: 64, height: 46, display: "flex", alignItems: "center", gap: 40, opacity: show }}>
      {/* Without the brand the steps keep their place, so the chain does not jump at the cut. */}
      {(
        <div style={{ display: "flex", alignItems: "center", gap: 14, ...rise(frame, 2, 14, -16), ...(brand ? {} : { opacity: 0 }) }}>
          <Mark size={30} ink={c.ink} />
          <span style={{ fontSize: 26, fontWeight: 650, color: c.ink }}>MACH</span>
        </div>
      )}
      <div style={{ flex: 1, display: "flex", alignItems: "center", marginLeft: 40 }}>
        {STEPS.map((step, i) => {
          const reached = p >= i - 0.02;
          const current = here === i;
          const ink = current ? c.accent : reached ? c.ink : c.inkMuted;
          return (
            <React.Fragment key={step}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 14, height: 14, borderRadius: 7, boxSizing: "border-box", background: reached ? ink : "transparent", border: `2px solid ${reached ? ink : c.paperLine}` }} />
                <span style={{ fontSize: 25, fontWeight: current ? 700 : 550, color: ink, opacity: reached ? 1 : 0.62, whiteSpace: "nowrap" }}>{step}</span>
              </div>
              {i < STEPS.length - 1 ? (
                <div style={{ flex: 1, height: 2, margin: "0 18px", background: c.paperLine, position: "relative" }}>
                  <div style={{ position: "absolute", inset: 0, width: `${Math.min(1, Math.max(0, p - i)) * 100}%`, background: c.ink }} />
                </div>
              ) : null}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export const Title: React.FC<Props> = ({ voiceAt: v, cue }) => {
  const frame = useCurrentFrame();
  return (
    <Light>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 26 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 30, ...rise(frame, 6, 20) }}>
          <Mark size={104} ink={c.ink} lit={fade(frame, 22, 14)} />
          <span style={{ fontSize: 132, fontWeight: 750, letterSpacing: 6, color: c.ink }}>MACH</span>
        </div>
        <div style={{ fontSize: 50, fontWeight: 600, color: c.inkMuted, ...rise(frame, 18, 16) }}>From idea to proof</div>
        <div style={{ fontSize: 60, fontWeight: 650, color: c.ink, marginTop: 34, ...rise(frame, v, 14) }}>Every feature starts as an idea.</div>
      </AbsoluteFill>
      <Chain brand={false} keys={[[0, -1]]} show={fade(frame, cue("from the first thought"), 20)} />
    </Light>
  );
};

export const Ideas: React.FC<Props> = ({ voiceAt: v, cue }) => {
  const { durationInFrames: end } = useVideoConfig();
  return (
    <Light>
      <Chain keys={[[v - 6, -1], [v + 18, 0]]} />
      <Shot clip="shape-board" from={0} to={end} />
      <Callout from={v + 6} to={cue("One place") - 8} text="It starts on the ideas board" note="Requests from customers, thoughts from colleagues, faults from production" />
      <Callout from={cue("One place")} to={cue("Today's idea") - 8} text="One place for everything that might become work" />
      <Callout from={cue("Today's idea")} to={end - 16} text="Let members renew a loan themselves" note="Today's idea" />
    </Light>
  );
};

export const Explore: React.FC<Props> = ({ voiceAt: v, cue }) => {
  const { durationInFrames: end } = useVideoConfig();
  return (
    <Light>
      <Chain keys={[[v, 0], [v + 40, 0.5]]} />
      <Shot clip="shape-explore" from={0} to={end} />
      <Callout from={v + 6} to={cue("And it never") - 8} text="MACH explores it with you" note="One open question at a time" />
      <Callout from={cue("And it never")} to={end - 16} text="It never asks what it can look up" note="The rules already shipped, similar requests, the principles and policies in its way" />
    </Light>
  );
};

export const Brief: React.FC<Props> = ({ voiceAt: v, cue }) => {
  const { durationInFrames: end } = useVideoConfig();
  return (
    <Light>
      <Chain keys={[[v - 6, 0.5], [v + 18, 1]]} />
      <Shot clip="shape-brief" from={0} to={end} />
      <Callout from={v + 6} to={cue("The problem") - 8} text="The conversation becomes a brief" note="One page" />
      <Callout from={cue("The problem")} to={cue("Every assumption") - 8} text="The problem, who has it, the outcomes" note="Each outcome says how you would know it was met" />
      <Callout from={cue("Every assumption")} to={end - 16} text="Every assumption is marked" note="Until someone confirms it" />
    </Light>
  );
};

/** The three answers, shown alike: MACH offers no recommendation between them. */
const Verdict: React.FC<{ at: number; never: number; end: number }> = ({ at, never, end }) => {
  const frame = useCurrentFrame();
  const show = Math.min(fade(frame, at, 12), 1 - fade(frame, end - 14, 10));
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: show }}>
      <div style={{ background: "rgba(250,249,245,.97)", border: `1px solid ${c.paperLine}`, borderRadius: 22, padding: "48px 72px 44px", boxShadow: "0 30px 90px rgba(20,20,19,.2)", textAlign: "center", ...rise(frame, at, 16, 30) }}>
        <div style={{ fontSize: 72, fontWeight: 740, color: c.ink }}>The verdict is yours alone.</div>
        <div style={{ display: "flex", justifyContent: "center", gap: 22, marginTop: 36 }}>
          {["Go", "Not now", "No"].map((w, i) => (
            <span key={w} style={{ fontSize: 44, fontWeight: 650, color: c.ink, padding: "14px 40px", borderRadius: 14, border: `2px solid ${c.ink}`, background: "#fff", ...rise(frame, at + 22 + i * 7, 10) }}>{w}</span>
          ))}
        </div>
        <div style={{ fontSize: 36, color: c.inkMuted, marginTop: 30, opacity: fade(frame, never, 12) }}>MACH never recommends one.</div>
      </div>
    </AbsoluteFill>
  );
};

export const VerdictScene: React.FC<Props> = ({ voiceAt: v, cue }) => {
  const { durationInFrames: end } = useVideoConfig();
  const at = cue("And the verdict");
  return (
    <Light>
      <Chain keys={[[at - 4, 1], [at + 20, 2]]} />
      <Shot clip="shape-case" from={0} to={end} />
      <Callout from={v + 6} to={at - 8} text="The hardest questions MACH can find" note="Who wouldn't want this? What if you're wrong?" />
      <Verdict at={at} never={cue("MACH never")} end={end} />
    </Light>
  );
};

export const Route: React.FC<Props> = ({ voiceAt: v, cue }) => {
  const { durationInFrames: end } = useVideoConfig();
  const route = cue("proposes the route");
  return (
    <Light>
      <Chain keys={[[route - 4, 2], [route + 20, 3]]} />
      <Shot clip="shape-route" from={0} to={end} />
      <Callout from={v + 6} to={cue("Here, one epic") - 8} text="MACH sizes the work" note="From what the brief touches, then proposes the route" />
      <Callout from={cue("Here, one epic")} to={cue("Every outcome") - 8} text="One epic, in thin slices" note="In build order" />
      <Callout from={cue("Every outcome")} to={cue("Nothing is created") - 8} text="Every outcome is carried by a slice" />
      <Callout from={cue("Nothing is created")} to={end - 16} text="Nothing is created until you say so" />
    </Light>
  );
};

export const Slice: React.FC<Props> = ({ voiceAt: v, cue }) => {
  const { durationInFrames: end } = useVideoConfig();
  return (
    <Light>
      <Chain keys={[[0, 3]]} />
      <Shot clip="studio-spec-rules" from={0} to={end} />
      <Callout from={v + 6} to={cue("and answers") - 8} text="Each slice is settled by interview" />
      <Callout from={cue("and answers")} to={cue("It says exactly") - 8} text="It answers to what you have set" note="Your product principles, your organisation's policies, the design you approved" />
      <Callout from={cue("It says exactly")} to={end - 16} text="It says what it does to shipped behaviour" />
    </Light>
  );
};

export const Factory: React.FC<Props> = ({ voiceAt: v, cue }) => {
  const { durationInFrames: end } = useVideoConfig();
  const record = cue("And every change");
  return (
    <Light>
      <Chain keys={[[v - 6, 3], [v + 18, 4], [record - 4, 4], [record + 20, 5]]} />
      <Shot clip="light-line" from={0} to={record} start={8.5} zoom={[1.02, 1.08]} origin="100% 6%" />
      <Shot clip={has("light-change-record") ? "light-change-record" : "light-record"} from={record} to={end} start={has("light-change-record") ? 0 : 7.6} />
      <Callout from={v + 6} to={cue("Built test first") - 8} text="Then the factory takes over" />
      <Callout from={cue("Built test first")} to={record - 8} text="Built on today's code" note="Verified against the design, reviewed by an independent panel" />
      <Callout from={record} to={end - 16} text="Every change lands with its own record" note="The why, the evidence, and who approved" />
    </Light>
  );
};

export const Lookback: React.FC<Props> = ({ voiceAt: v, cue }) => {
  const { durationInFrames: end } = useVideoConfig();
  return (
    <Light>
      <Chain keys={[[v - 6, 5], [v + 18, 6]]} />
      <Shot clip="shape-lookback" from={0} to={end} />
      <Callout from={v + 6} to={cue("Each outcome") - 8} text="The idea comes back to you" />
      <Callout from={cue("Each outcome")} to={end - 16} text="Each outcome, against how you said you'd know" note="Met, not met, or too early to say" />
    </Light>
  );
};

/** The chain again, larger, and the line from its last step drawn back round to its first. */
const Loop: React.FC<{ at: number; back: number }> = ({ at, back }) => {
  const frame = useCurrentFrame();
  const x0 = 330, gap = 210, y = 470;
  const xs = STEPS.map((_, i) => x0 + i * gap);
  const draw = interpolate(frame, [back, back + 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.ease) });
  const closed = draw > 0.98;
  const last = xs[xs.length - 1];
  const arc = `M ${last} ${y + 16} C ${last} ${y + 260}, ${x0} ${y + 260}, ${x0} ${y + 22}`;
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, opacity: fade(frame, at, 14) }}>
      <line x1={x0} y1={y} x2={last} y2={y} stroke={c.ink} strokeWidth={3} />
      <path d={arc} fill="none" stroke={c.accent} strokeWidth={3} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
      <path d={`M ${x0 - 11} ${y + 38} L ${x0} ${y + 20} L ${x0 + 11} ${y + 38}`} fill="none" stroke={c.accent} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" opacity={closed ? 1 : 0} />
      {STEPS.map((step, i) => {
        const current = closed ? i === 0 : i === STEPS.length - 1;
        return (
          <g key={step}>
            <circle cx={xs[i]} cy={y} r={11} fill={current ? c.accent : c.ink} />
            <text x={xs[i]} y={y - 34} textAnchor="middle" fontSize={34} fontWeight={current ? 720 : 600} fill={current ? c.accent : c.ink} style={{ fontFamily: "inherit" }}>{step}</text>
          </g>
        );
      })}
    </svg>
  );
};

export const Close: React.FC<Props> = ({ voiceAt: v, cue }) => {
  const frame = useCurrentFrame();
  return (
    <Light>
      <AbsoluteFill style={{ alignItems: "center", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 26, marginTop: 170, ...rise(frame, v - 6, 16) }}>
          <Mark size={92} ink={c.ink} />
          <span style={{ fontSize: 116, fontWeight: 750, letterSpacing: 6, color: c.ink }}>MACH</span>
        </div>
      </AbsoluteFill>
      <Loop at={cue("From the reason")} back={cue("and back again")} />
      <div style={{ position: "absolute", top: 712, width: "100%", textAlign: "center", fontSize: 46, fontWeight: 650, color: c.ink, ...rise(frame, cue("From the reason"), 14) }}>
        From the reason, to the code, and back again.
      </div>
      <div style={{ position: "absolute", top: 846, width: "100%", display: "flex", justifyContent: "center", alignItems: "center", gap: 16, fontSize: 40, color: c.inkMuted, ...rise(frame, cue("All in"), 14) }}>
        All in <Chip>Claude Code</Chip>
      </div>
    </Light>
  );
};
