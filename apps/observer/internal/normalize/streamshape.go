package normalize

// Structural acceptance of stream records (M6_1_STREAM_COMPATIBILITY.md, section 8). The parser
// is no longer pinned to one Claude Code version: each record is accepted or refused on its own
// shape. A shape names, for one classification, the type of every field the parser reads (and of
// the objects on the way to them). A field may be absent or null unless it is required; when it
// is there it must have its type. A record whose shape does not match is refused whole: it yields
// a history.gap (reason "unexpected-shape") and nothing of its content. Fields the parser does not
// read are not looked at, so a runtime that adds fields stays compatible.
//
// The runtime version is then a fact recorded per source, not a gate:
//
//	proven               the version is one the fixtures come from (ProvenVersions)
//	compatible-unproven  another version, every record so far matched the known shapes
//	incompatible         another (or a proven) version, and at least one record did not
//	unknown              no init record read yet

// ProvenVersions are the Claude Code versions the stream fixtures were recorded with
// (tests/fixtures/execution-streams/): 2.1.322 by the M6.1 stream proof, 2.1.323 by the M6.2
// acceptance run.
var ProvenVersions = []string{"2.1.322", "2.1.323"}

// Runtime states.
const (
	RuntimeProven       = "proven"
	RuntimeUnproven     = "compatible-unproven"
	RuntimeIncompatible = "incompatible"
	RuntimeUnknown      = "unknown"
)

// Proven reports whether v is one of ProvenVersions.
func Proven(v string) bool {
	for _, p := range ProvenVersions {
		if p == v {
			return true
		}
	}
	return false
}

type fieldType int

const (
	tString fieldType = iota
	tNumber
	tBool
	tObject
	tArray
	tStringOrNumber
)

// shapeField: a path of keys from the record (a "[]" element means "every element of this array").
type shapeField struct {
	path     []string
	typ      fieldType
	required bool
}

func fld(typ fieldType, path ...string) shapeField { return shapeField{path: path, typ: typ} }
func req(typ fieldType, path ...string) shapeField {
	return shapeField{path: path, typ: typ, required: true}
}

// shapes per classification. "result" stands for every result/<subtype>.
var shapes = map[string][]shapeField{
	"system/init": {fld(tString, "claude_code_version"), fld(tString, "model"), fld(tString, "permissionMode"), fld(tArray, "tools"),
		fld(tString, "tools", "[]"), fld(tArray, "agents"), fld(tString, "agents", "[]")},
	"assistant": {fld(tString, "timestamp"), fld(tString, "agent_id"), req(tObject, "message"), fld(tArray, "message", "content"),
		fld(tObject, "message", "content", "[]"), fld(tString, "message", "content", "[]", "type")},
	"user":                {fld(tString, "timestamp"), fld(tString, "agent_id"), req(tObject, "message")},
	"system/task_started": {req(tString, "task_id"), fld(tString, "task_type"), fld(tString, "tool_use_id"), fld(tString, "workflow_name")},
	"system/task_progress": {req(tString, "task_id"), fld(tArray, "workflow_progress"), fld(tObject, "workflow_progress", "[]"),
		fld(tString, "workflow_progress", "[]", "type"), fld(tNumber, "workflow_progress", "[]", "index"),
		fld(tString, "workflow_progress", "[]", "title"), fld(tString, "workflow_progress", "[]", "label"),
		fld(tString, "workflow_progress", "[]", "state"), fld(tString, "workflow_progress", "[]", "agentId"),
		fld(tString, "workflow_progress", "[]", "agentType"), fld(tString, "workflow_progress", "[]", "model"),
		fld(tString, "workflow_progress", "[]", "phaseTitle"), fld(tNumber, "workflow_progress", "[]", "phaseIndex"),
		fld(tNumber, "workflow_progress", "[]", "attempt"), fld(tNumber, "workflow_progress", "[]", "queuedAt"),
		fld(tNumber, "workflow_progress", "[]", "startedAt"), fld(tNumber, "workflow_progress", "[]", "lastProgressAt"),
		fld(tNumber, "workflow_progress", "[]", "durationMs"), fld(tNumber, "workflow_progress", "[]", "toolCalls"),
		fld(tNumber, "workflow_progress", "[]", "tokens"), fld(tString, "workflow_progress", "[]", "lastToolName")},
	"system/task_updated":      {req(tString, "task_id"), fld(tObject, "patch"), fld(tString, "patch", "status"), fld(tNumber, "patch", "end_time")},
	"system/task_notification": {req(tString, "task_id"), fld(tString, "status"), fld(tObject, "usage"), fld(tNumber, "usage", "total_tokens"), fld(tNumber, "usage", "tool_uses"), fld(tNumber, "usage", "duration_ms")},
	"system/permission_denied": {fld(tString, "tool_name"), fld(tString, "agent_id"), fld(tString, "tool_use_id")},
	"result": {fld(tString, "subtype"), fld(tString, "terminal_reason"), fld(tBool, "is_error"), fld(tNumber, "total_cost_usd"),
		fld(tNumber, "result_index"), fld(tString, "result"), fld(tObject, "modelUsage")},
}

// blockShapes are checked on each content block of an assistant or user message by its type.
var blockShapes = map[string][]shapeField{
	"tool_use":    {req(tString, "id"), req(tString, "name"), fld(tObject, "input")},
	"tool_result": {req(tString, "tool_use_id"), fld(tBool, "is_error")},
}

// usageShape is each model's entry of a result's modelUsage.
var usageShape = []shapeField{fld(tNumber, "costUSD"), fld(tNumber, "inputTokens"), fld(tNumber, "outputTokens"), fld(tNumber, "cacheReadInputTokens"),
	fld(tNumber, "cacheCreationInputTokens")}

// ShapeOK reports whether rec matches the known shape of its classification, and if not, the
// first field that does not (a name, never a value).
func ShapeOK(class string, rec map[string]any) (bool, string) {
	key := class
	if class == "result" || len(class) > 7 && class[:7] == "result/" {
		key = "result"
	}
	list, ok := shapes[key]
	if !ok {
		return true, "" // read and turned into nothing (rate_limit_event, background tasks)
	}
	for _, fd := range list {
		if ok, at := shapeCheck(rec, fd.path, fd.typ, fd.required); !ok {
			return false, at
		}
	}
	switch key {
	case "assistant", "user":
		msg, _ := rec["message"].(map[string]any)
		content, isList := msg["content"].([]any)
		if !isList {
			if _, isText := msg["content"].(string); msg["content"] != nil && !isText {
				return false, "message.content"
			}
			return true, ""
		}
		for _, item := range content {
			b, isObj := item.(map[string]any)
			if !isObj {
				return false, "message.content[]"
			}
			typ, _ := b["type"].(string)
			for _, fd := range blockShapes[typ] {
				if ok, at := shapeCheck(b, fd.path, fd.typ, fd.required); !ok {
					return false, "message.content[" + typ + "]." + at
				}
			}
		}
	case "result":
		if mu, isObj := rec["modelUsage"].(map[string]any); isObj {
			for _, u := range mu {
				m, isObj := u.(map[string]any)
				if !isObj {
					return false, "modelUsage.<model>"
				}
				for _, fd := range usageShape {
					if ok, at := shapeCheck(m, fd.path, fd.typ, false); !ok {
						return false, "modelUsage.<model>." + at
					}
				}
			}
		}
	}
	return true, ""
}

// check walks path in v; "[]" applies the rest of the path to every element.
func shapeCheck(v any, path []string, typ fieldType, required bool) (bool, string) {
	if len(path) == 0 {
		if v == nil {
			return !required, ""
		}
		return typeIs(v, typ), ""
	}
	if path[0] == "[]" {
		list, isList := v.([]any)
		if !isList {
			return v == nil, "[]"
		}
		for _, item := range list {
			if ok, at := shapeCheck(item, path[1:], typ, required); !ok {
				return false, "[]." + at
			}
		}
		return true, ""
	}
	m, isObj := v.(map[string]any)
	if !isObj {
		return v == nil && !required, path[0]
	}
	child, present := m[path[0]]
	if !present || child == nil {
		if required && len(path) == 1 {
			return false, path[0]
		}
		return true, ""
	}
	ok, at := shapeCheck(child, path[1:], typ, required)
	if !ok {
		if at == "" {
			return false, path[0]
		}
		return false, path[0] + "." + at
	}
	return true, ""
}

func typeIs(v any, typ fieldType) bool {
	switch typ {
	case tString:
		_, ok := v.(string)
		return ok
	case tNumber:
		_, ok := v.(float64)
		return ok
	case tBool:
		_, ok := v.(bool)
		return ok
	case tObject:
		_, ok := v.(map[string]any)
		return ok
	case tArray:
		_, ok := v.([]any)
		return ok
	case tStringOrNumber:
		switch v.(type) {
		case string, float64:
			return true
		}
	}
	return false
}
