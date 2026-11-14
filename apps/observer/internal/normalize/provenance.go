package normalize

import (
	"regexp"

	"mach/observer/internal/redact"
)

// Execution provenance (M6.5, event revision 3): the snapshot the supervisor takes once, when it
// starts an execution (skills/run/scripts/provenance.py), carried on execution.started as
// data.provenance. It is rebuilt here field by field, deny-by-default like every payload: digests,
// versions, identifiers, numbers and booleans only. A value that does not fit its filter is dropped
// to null, never repaired; a key that is not named is not kept.
//
// An execution.started without the key (every execution before this existed) reads as
// provenance: null with provenance_reason "not-recorded"; the supervisor's own failure to capture
// one is "capture-failed". Nothing is ever attributed to an execution after the fact.

// ProvenanceSchema is the snapshot schema this observer reads.
const ProvenanceSchema = 1

// Provenance reasons, when provenance is null.
const (
	ProvenanceNotRecorded   = "not-recorded"   // the execution's start carries none (before M6.5)
	ProvenanceCaptureFailed = "capture-failed" // the supervisor tried at start and could not; the execution ran as usual
	ProvenanceNotUnderstood = "not-understood" // a snapshot of another schema, or without its identity
)

var (
	// A part of the line: "skill:build", "agent:builder", "workflow:belt", "plugin:manifest".
	provPartRe    = regexp.MustCompile(`^(skill|agent|workflow|plugin):[a-z0-9][a-z0-9_-]{0,39}$`)
	provTierRe    = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	provVersionRe = regexp.MustCompile(`^[0-9A-Za-z.+-]{1,40}$`)
	provDigestRe  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	provInstallRe = regexp.MustCompile(`^(plugin|project)$`) // how MACH is installed (never a Go package name in this source)
)

const (
	provMaxParts = 256
	provMaxTiers = 16
)

// provenance normalises execution.started's provenance and provenance_reason. It returns the
// snapshot (nil when there is none) and the reason (nil when there is a snapshot).
func provenance(raw any, present bool, reason any) (any, any) {
	if !present {
		return nil, ProvenanceNotRecorded
	}
	if raw == nil {
		if reason == ProvenanceCaptureFailed {
			return nil, ProvenanceCaptureFailed
		}
		return nil, ProvenanceNotUnderstood // something was written, with a reason this observer does not know
	}
	snap := obj(raw)
	if n, ok := redact.Int(snap["schema"]); snap == nil || !ok || n != ProvenanceSchema {
		// Another snapshot schema: not understood by this observer, so not shown as if it were.
		return nil, ProvenanceNotUnderstood
	}
	out := map[string]any{"schema": int64(ProvenanceSchema)}

	m := obj(snap["mach"])
	out["mach"] = map[string]any{"version": provMatch(m["version"], provVersionRe), "install": provMatch(m["install"], provInstallRe),
		"commit": fullCommitOrNil(m["commit"])}

	l := obj(snap["line"])
	files := map[string]any{}
	for k, v := range obj(l["files"]) {
		if len(files) >= provMaxParts || !provPartRe.MatchString(k) {
			continue
		}
		if d := provMatch(v, provDigestRe); d != nil {
			files[k] = d
		}
	}
	out["line"] = map[string]any{"digest": provMatch(l["digest"], provDigestRe), "count": intOrNil(l["count"]), "files": files}

	c := obj(snap["config"])
	config := map[string]any{"recorded": boolOrNil(c["recorded"]), "digest": provMatch(c["digest"], provDigestRe), "models": nil, "review": nil,
		"max_parallel": intOrNil(c["max_parallel"])}
	if models := obj(c["models"]); models != nil {
		kept := map[string]any{}
		for tier, name := range models {
			if len(kept) >= provMaxTiers || !provTierRe.MatchString(tier) {
				continue
			}
			if n, ok := redact.Name(name); ok {
				kept[tier] = n
			}
		}
		config["models"] = kept
	}
	if review := obj(c["review"]); review != nil {
		tiers := map[string]any{}
		for tier, rules := range obj(review["tiers"]) {
			r := obj(rules)
			if len(tiers) >= provMaxTiers || r == nil || !provTierRe.MatchString(tier) {
				continue
			}
			tiers[tier] = map[string]any{"approvals": intOrNil(r["approvals"]), "reviewers": intOrNil(r["reviewers"]), "human_approval": boolOrNil(r["human_approval"])}
		}
		config["review"] = map[string]any{"max_loops": intOrNil(review["max_loops"]), "security_veto": boolOrNil(review["security_veto"]), "tiers": tiers}
	}
	out["config"] = config

	p := obj(snap["policy"])
	out["policy"] = map[string]any{"autonomy": enum(p["autonomy"], "observe", "supervised"), "max_risk": enum(p["max_risk"], risks...),
		"allow_merge": boolOrNil(p["allow_merge"]), "max_parallel": numOrNil(p["max_parallel"]),
		"allowed_tools_digest": provMatch(p["allowed_tools_digest"], provDigestRe), "allowed_tools_count": intOrNil(p["allowed_tools_count"])}

	t := obj(snap["ticket"])
	out["ticket"] = map[string]any{"risk": enum(t["risk"], risks...), "app_type": provMatch(t["app_type"], provTierRe)}

	s := obj(snap["source"])
	out["source"] = map[string]any{"commit": fullCommitOrNil(s["commit"]), "slice_revision": intOrNil(s["slice_revision"]),
		"slice_digest": provMatch(s["slice_digest"], provDigestRe), "spec_sha256": provMatch(s["spec_sha256"], provDigestRe)}

	id := provMatch(snap["config_id"], provDigestRe)
	if id == nil {
		// Without its identity a snapshot cannot be compared; it is not shown as if it could be.
		return nil, ProvenanceNotUnderstood
	}
	out["config_id"] = id
	return out, nil
}

// provMatch keeps a string that matches re and passes the scrubber's test, else nil.
func provMatch(v any, re *regexp.Regexp) any {
	s, ok := v.(string)
	if !ok || !re.MatchString(s) || (!provDigestRe.MatchString(s) && redact.Sensitive(s)) {
		return nil
	}
	return s
}
