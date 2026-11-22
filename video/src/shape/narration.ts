// The third film's narration, one line per scene, in order. This is the text the voice is generated from:
// SCRIPT below is the scene-script form (one "NAME: text" line each) used for the two earlier films,
// read by the same voice (NARRATOR, c6SfcYrb2t09NHXiT80T), written to public/audio/narration-shape.mp3
// with its .cues.json and .srt. The film cuts each scene on its line's cue, so keep one line per scene.
export const NARRATION = [
  ["title", "Every feature starts as an idea. This is how MACH carries one, from the first thought, to proof that it worked."],
  ["ideas", "It starts on the ideas board. A request from a customer, a thought from a colleague, a fault from production. One place for everything that might become work. Today's idea: let members renew a loan themselves."],
  ["explore", "MACH explores it with you, one open question at a time. And it never asks what it can look up. The rules already shipped that this would touch. The similar requests. The principles and policies standing in its way."],
  ["brief", "The conversation becomes a brief. One page. The problem, who has it, and the outcomes, each with how you would know it was met. Every assumption is marked as an assumption, until someone confirms it."],
  ["verdict", "Then MACH asks the hardest questions it can find. Who wouldn't want this? What if you're wrong? And the verdict is yours alone. Go, not now, or no. MACH never recommends one."],
  ["route", "On a go, MACH sizes the work from what the brief touches, and proposes the route. Here, one epic, in thin slices, in build order. Every outcome is carried by a slice. Nothing is created until you say so."],
  ["slice", "Each slice is settled by interview, and answers to your product principles, your organisation's policies, and the design you approved. It says exactly what it does to behaviour that has already shipped."],
  ["factory", "Then the factory takes over. Built test first, on today's code. Verified against the design. Reviewed by an independent panel. And every change lands with its own record: the why, the evidence, and who approved."],
  ["lookback", "And when it ships, the idea comes back to you. Each outcome, with how you said you'd know. Met, not met, or too early to say."],
  ["close", "MACH. From the reason, to the code, and back again. All in Claude Code."],
] as const;

export const VOICE = { NARRATOR: "c6SfcYrb2t09NHXiT80T" };

export const SCRIPT = NARRATION.map(([, text]) => `NARRATOR: ${text}`).join("\n");
