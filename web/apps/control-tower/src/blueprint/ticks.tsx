/**
 * An agent's tool calls as a trace on its execution's axis, batched: one path per ink and cap kind
 * instead of one element per call, so a lane of 74 calls costs a handful of elements. The caps are
 * the grammar's `ToolCap` shapes (read ring, write square, run triangle, search lozenge, test check,
 * git node), redrawn as path data. Only the call in flight is drawn with the `ToolTick` primitive and
 * its animation (the spec's motion budget: at most one tick animates per cell). Hit-testing is done
 * by the view against the positions registered here; keyboard focus uses windowed tree items.
 */
import { memo, useContext, useEffect } from "react";
import { fc, ToolTick } from "@mach/ui";
import type { AgentState, EntityRef, ToolCallState } from "../sim";
import { ref } from "../sim";
import { useSceneStore } from "../scene";
import { xOn, type ExecAxis } from "./axis";
import { HitContext } from "./context";
import { useEventProgress } from "./motion";
import { toolFamily } from "./vocab";

type Ink = "ok" | "live" | "fail";

function cap(family: ReturnType<typeof toolFamily>, x: number, y: number): { d: string; filled: boolean } {
  switch (family) {
    case "read":
      return { d: `M${x - 2.3} ${y}a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0 -4.6 0`, filled: false };
    case "write":
      return { d: `M${x - 2.2} ${y - 2.2}h4.4v4.4h-4.4z`, filled: true };
    case "run":
      return { d: `M${x - 2} ${y - 2.6}L${x + 2.8} ${y}L${x - 2} ${y + 2.6}z`, filled: true };
    case "search":
      return { d: `M${x} ${y - 2.8}l2.8 2.8l-2.8 2.8l-2.8 -2.8z`, filled: false };
    case "test":
      return { d: `M${x - 2.4} ${y - 0.2}l1.8 2l3.2 -3.8`, filled: false };
    case "git":
      return { d: `M${x - 1.7} ${y}a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0 -3.4 0M${x} ${y - 3.2}v1.5M${x} ${y + 1.7}v1.5`, filled: false };
  }
}

const INK: Record<Ink, string> = { ok: fc("ink"), live: fc("live"), fail: fc("fail") };

export interface TraceProps {
  agent: AgentState;
  tids: readonly string[];
  axis: ExecAxis;
  /** Baseline y (lane coordinates) and whether the lane is open (full caps) or closed (stems only). */
  base: number;
  open: boolean;
  /** Sheet y of the lane, for nothing but the registry key. */
  laneKey: string;
}

export const ToolTrace = memo(function ToolTrace({ agent, tids, axis, base, open, laneKey }: TraceProps) {
  const hits = useContext(HitContext);
  const calls = agent.toolCalls;
  const xs = calls.map((c) => Math.round(xOn(axis, c.startedAt) * 2) / 2);
  useEffect(() => {
    hits.set(laneKey, { xs, refs: calls.map((c) => ref.tool(c.id)), tids });
    return () => hits.set(laneKey, null);
  });
  const stem = open ? 9 : 6;
  const paths: Record<string, string> = {};
  let bars = "";
  let live: ToolCallState | null = null;
  calls.forEach((c, i) => {
    const x = xs[i] as number;
    const ink: Ink = c.status === "running" ? "live" : c.status === "error" ? "fail" : "ok";
    if (c.status === "running") live = c;
    paths[`s-${ink}`] = (paths[`s-${ink}`] ?? "") + `M${x} ${base}v${-stem}${ink === "fail" ? `M${x - 2.2} ${base - stem * 0.45}h4.4` : ""}`;
    if (open) {
      const k = cap(toolFamily(c), x, base - stem - 3);
      const key = `${k.filled ? "f" : "o"}-${ink}`;
      paths[key] = (paths[key] ?? "") + k.d;
      if (c.finishedAt !== null) bars += `M${x} ${base + 5}H${Math.max(x + 1, xOn(axis, c.finishedAt))}`;
    }
  });
  return (
    <g aria-hidden="true">
      {open && bars ? <path d={bars} style={{ stroke: fc("ink-soft"), strokeWidth: 2.2 }} /> : null}
      {Object.entries(paths).map(([key, d]) => {
        const [kind, ink] = key.split("-") as ["s" | "f" | "o", Ink];
        const color = INK[ink];
        return <path key={key} d={d} style={{ fill: kind === "f" ? color : "none", stroke: color, strokeWidth: kind === "s" ? 1 : 1.1, strokeLinejoin: "round", strokeLinecap: "round" }} />;
      })}
      {live ? <LiveTick call={live} x={xOn(axis, (live as ToolCallState).startedAt)} base={base} open={open} /> : null}
      <SelectedTick calls={calls} xs={xs} base={base} stem={stem} />
    </g>
  );
});

/** The call in flight: the grammar's ToolTick with its rise, the one tick in the lane that animates. */
function LiveTick({ call, x, base, open }: { call: ToolCallState; x: number; base: number; open: boolean }) {
  const p = useEventProgress(call.startedAt, "toolTick");
  return <ToolTick variant="blueprint" family={toolFamily(call)} state="active" progress={open ? p : 1} detail={`${call.tool} ${call.target}`} at={{ x, y: base }} />;
}

/** A ring on the selected call, if it is one of these. */
function SelectedTick({ calls, xs, base, stem }: { calls: readonly ToolCallState[]; xs: readonly number[]; base: number; stem: number }) {
  const selection = useSceneStore((s) => (s.selection?.startsWith("tool:") ? s.selection : null)) as EntityRef | null;
  const hovered = useSceneStore((s) => (s.hovered?.startsWith("tool:") ? s.hovered : null)) as EntityRef | null;
  const marks = [selection, hovered].filter((r): r is EntityRef => r !== null);
  return (
    <>
      {marks.map((m, i) => {
        const idx = calls.findIndex((c) => ref.tool(c.id) === m);
        if (idx < 0) return null;
        const x = xs[idx] as number;
        return <rect key={`${m}${i}`} x={x - 5} y={base - stem - 7} width={10} height={stem + 9} rx={2} style={{ fill: "none", stroke: i === 0 && m === selection ? fc("select") : fc("ink-soft"), strokeWidth: i === 0 && m === selection ? 1.6 : 1 }} />;
      })}
    </>
  );
}
