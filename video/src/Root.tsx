import "@fontsource-variable/source-sans-3/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import React from "react";
import { AbsoluteFill, Audio, Composition, Sequence, interpolate, staticFile } from "remotion";
import { LEAD, TOTAL, cuts, hasMusic, hasNarration, type SceneId } from "./script";
import { Close, Problem, Title } from "./scenes/bookends";
import { Interview, Ready } from "./scenes/product";
import { Analytics, Engineer, Line, Visibility } from "./scenes/factory";
import { FPS, H, W, c } from "./theme";
import * as F from "./factory/scenes";
import * as FS from "./factory/script";
import * as S from "./shape/scenes";
import * as SS from "./shape/script";

const FSCENE: Record<FS.SceneId, React.FC<{ voiceAt: number }>> = { title: F.Title, premise: F.Premise, studio: F.Studio, engineer: F.Engineer, floor: F.Floor, proof: F.Proof, line: F.Line, people: F.People, close: F.Close };
const fVoiceStart = Math.round(FS.LEAD * FPS);
const fVoiceEnd = FS.cuts[FS.cuts.length - 1].from + FS.cuts[FS.cuts.length - 1].voiceAt + 9 * FPS;
const fMusic = (f: number) =>
  interpolate(f, [0, 12, fVoiceStart - 8, fVoiceStart + 14, fVoiceEnd, fVoiceEnd + 20, FS.TOTAL - 50, FS.TOTAL - 2], [0, 0.6, 0.6, 0.16, 0.16, 0.58, 0.58, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

/** The companion film: the factory itself, in light theme. */
const FactoryFilm: React.FC = () => (
  <AbsoluteFill style={{ background: c.cream }}>
    {FS.cuts.map((cut) => {
      const Part = FSCENE[cut.id];
      return (
        <Sequence key={cut.id} from={cut.from} durationInFrames={cut.frames} name={cut.id}>
          <Part voiceAt={cut.voiceAt} />
        </Sequence>
      );
    })}
    {FS.hasMusic ? <Audio src={staticFile("audio/music-factory.mp3")} volume={fMusic} /> : null}
    {FS.hasNarration ? (
      <Sequence from={fVoiceStart}>
        <Audio src={staticFile("audio/narration-factory.mp3")} />
      </Sequence>
    ) : null}
  </AbsoluteFill>
);

const SSCENE: Record<SS.SceneId, React.FC<S.Props>> = { title: S.Title, ideas: S.Ideas, explore: S.Explore, brief: S.Brief, verdict: S.VerdictScene, route: S.Route, slice: S.Slice, factory: S.Factory, lookback: S.Lookback, close: S.Close };
const sVoiceStart = Math.round(SS.LEAD * FPS);
const sVoiceEnd = SS.cuts[SS.cuts.length - 1].from + SS.cuts[SS.cuts.length - 1].voiceAt + SS.cuts[SS.cuts.length - 1].voiceLen;
const sMusic = (f: number) =>
  interpolate(f, [0, 12, sVoiceStart - 8, sVoiceStart + 14, sVoiceEnd, sVoiceEnd + 20, SS.TOTAL - 50, SS.TOTAL - 2], [0, 0.6, 0.6, 0.16, 0.16, 0.58, 0.58, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

/** The third film: an idea's way through MACH, from the first thought to proof, in light theme. */
const ShapeFilm: React.FC = () => (
  <AbsoluteFill style={{ background: c.cream }}>
    {SS.cuts.map((cut) => {
      const Part = SSCENE[cut.id];
      return (
        <Sequence key={cut.id} from={cut.from} durationInFrames={cut.frames} name={cut.id}>
          <Part voiceAt={cut.voiceAt} cue={SS.cueFor(cut.id, cut.voiceAt, cut.voiceLen)} />
        </Sequence>
      );
    })}
    {SS.hasMusic ? <Audio src={staticFile("audio/music-shape.mp3")} volume={sMusic} /> : null}
    {SS.hasNarration ? (
      <Sequence from={sVoiceStart}>
        <Audio src={staticFile("audio/narration-shape.mp3")} />
      </Sequence>
    ) : null}
  </AbsoluteFill>
);

const SCENE: Record<SceneId, React.FC<{ voiceAt: number }>> = {
  title: Title, problem: Problem, interview: Interview, ready: Ready, engineer: Engineer, line: Line, visibility: Visibility, analytics: Analytics, close: Close,
};

// The music sits well under the voice, and comes up only before the first word and after the last.
const voiceStart = Math.round(LEAD * FPS);
const voiceEnd = cuts[cuts.length - 1].from + cuts[cuts.length - 1].voiceAt + 4 * FPS;
const musicVolume = (f: number) =>
  interpolate(f, [0, 12, voiceStart - 8, voiceStart + 14, voiceEnd, voiceEnd + 20, TOTAL - 50, TOTAL - 2], [0, 0.62, 0.62, 0.17, 0.17, 0.6, 0.6, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

const Film: React.FC = () => (
  <AbsoluteFill style={{ background: c.night }}>
    {cuts.map((cut) => {
      const Part = SCENE[cut.id];
      return (
        <Sequence key={cut.id} from={cut.from} durationInFrames={cut.frames} name={cut.id}>
          <Part voiceAt={cut.voiceAt} />
        </Sequence>
      );
    })}
    {hasMusic ? <Audio src={staticFile("audio/music.mp3")} volume={musicVolume} /> : null}
    {hasNarration ? (
      <Sequence from={voiceStart}>
        <Audio src={staticFile("audio/narration.mp3")} />
      </Sequence>
    ) : null}
  </AbsoluteFill>
);

export const Root: React.FC = () => (
  <>
    <Composition id="MachDemo" component={Film} durationInFrames={TOTAL} fps={FPS} width={W} height={H} />
    <Composition id="MachFactory" component={FactoryFilm} durationInFrames={FS.TOTAL} fps={FPS} width={W} height={H} />
    <Composition id="MachShape" component={ShapeFilm} durationInFrames={SS.TOTAL} fps={FPS} width={W} height={H} />
  </>
);
