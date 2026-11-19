import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Callout, Role, Scene, Screen, fade, rise } from "../parts";
import { c, mono } from "../theme";

const s = (n: number) => Math.round(n * 30);

export const Interview: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const { durationInFrames: end } = useVideoConfig();
  return (
    <Scene bg={c.cream}>
      <Role at={4} label="Product manager" />
      <Screen clip="studio-home" from={0} to={v + s(5.2)} start={0.5} rate={1.4} />
      <Screen clip="studio-interview" from={v + s(5.2)} to={v + s(15)} start={1.3} rate={1.25} origin="50% 55%" zoom={[1, 1.06]} />
      <Screen clip="studio-interview" from={v + s(15)} to={v + s(17.2)} start={21.2} origin="50% 60%" zoom={[1.04, 1.07]} />
      <Screen clip="studio-spec" from={v + s(17.2)} to={end} start={0.6} rate={1.3} />
      <Callout from={v + s(0.4)} to={v + s(4.6)} text="Product Studio" note="Vision, epics and slices of intent" />
      <Callout from={v + s(5.6)} to={v + s(9.6)} text="One question at a time" note="Yes or no, in plain words" />
      <Callout from={v + s(10)} to={v + s(14.4)} text="Every question comes with a recommendation" />
      <Callout from={v + s(15.3)} to={end - 16} text="The spec writes itself" note="Requirements · decision table · scenarios" />
    </Scene>
  );
};

const Label: React.FC<{ text: string; color: string }> = ({ text, color }) => (
  <span style={{ fontFamily: mono, fontSize: 24, padding: "6px 14px", borderRadius: 999, border: `1.5px solid ${color}`, color: c.ink, background: "#fff" }}>{text}</span>
);

/** A drawing of the hand-off, in MACH's own style: it is not a picture of GitHub's page. */
const IssueCard: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: fade(frame, at, 12) }}>
      <div style={{ width: 1180, background: "#fff", borderRadius: 20, border: `1px solid ${c.paperLine}`, boxShadow: "0 30px 80px rgba(20,20,19,.16)", padding: "46px 54px", ...rise(frame, at, 18, 40) }}>
        <div style={{ fontSize: 24, color: c.inkMuted, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600 }}>Saved as an issue</div>
        <div style={{ fontSize: 58, fontWeight: 720, color: c.ink, marginTop: 8 }}>
          Invite a teammate <span style={{ color: c.inkMuted, fontWeight: 400 }}>#11</span>
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 20, ...rise(frame, at + 16, 12) }}>
          <Label text="mach:slice" color={c.blue} />
          <Label text="mach:ready" color={c.green} />
          <span style={{ fontSize: 24, color: c.inkMuted, alignSelf: "center", marginLeft: 8 }}>in epic Team membership #6</span>
        </div>
        <div style={{ marginTop: 34, borderTop: `1px solid ${c.paperLine}`, paddingTop: 28, display: "grid", gridTemplateColumns: "200px 1fr", rowGap: 14, fontSize: 28, ...rise(frame, at + 40, 14) }}>
          <span style={{ color: c.inkMuted }}>Approved</span>
          <span style={{ color: c.ink }}><span style={{ color: c.green, fontWeight: 700 }}>✓</span> revision 1, by the product manager</span>
          <span style={{ color: c.inkMuted }}>Spec</span>
          <span style={{ fontFamily: mono, fontSize: 24, color: c.ink }}>sha256 9f2c41…e07a</span>
          <span style={{ color: c.inkMuted }}>Why</span>
          <span style={{ fontFamily: mono, fontSize: 24, color: c.ink }}>sha256 3b8d6a…51c2</span>
        </div>
        <div style={{ marginTop: 28, fontSize: 28, color: c.ink, ...rise(frame, at + 100, 14) }}>
          An edit after approval takes it <span style={{ color: c.accent, fontWeight: 650 }}>out of the queue</span> until it is approved again.
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const Ready: React.FC<{ voiceAt: number }> = ({ voiceAt: v }) => {
  const { durationInFrames: end } = useVideoConfig();
  const card = v + s(4.6);
  return (
    <Scene bg={c.cream}>
      <Role at={0} label="Product manager" />
      <Screen clip="studio-ready" from={0} to={card + 8} start={0.8} rate={1.6} zoom={[1.0, 1.05]} />
      <Callout from={v + s(0.2)} to={card - 8} text="Mark ready to build" note="One click is the whole hand-off" />
      <IssueCard at={card} />
      <Callout from={v + s(7.4)} to={end - 16} text="What gets built is what you signed off" />
    </Scene>
  );
};
