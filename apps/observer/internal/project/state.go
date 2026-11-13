// Package project folds the observer's version 3 events into the Factory's projected state:
// the Factory's mode, the project, delivery waves and slices with their scheduler state and
// recorded waits, cells with their station history, executions with their measured cost and
// tokens, workflow agents and main-loop tool calls, open human gates, run records, and the
// analytics aggregates.
//
// The fold is deterministic: the same events in the same position order give byte-identical
// state (maps are encoded with sorted keys; lists grow in position order). That is what makes
// checkpoints, snapshots at a cursor and the "snapshot at N plus events (N, M] equals snapshot at
// M" guarantee possible. The projection decides nothing about the Factory; it reports what was
// recorded, and says where something is unknown.
package project

import (
	"mach/observer/internal/metrics"
)

// FormatVersion changes whenever State's shape or a fold rule changes: a persisted projection
// built under another version is discarded and rebuilt.
const FormatVersion = 2 // 2: gap classes

// Bounds on lists one hostile source could grow without limit; what is dropped is counted.
const (
	maxGatesPerCell   = 1000
	maxListPerCell    = 1000
	maxToolsPerExec   = 2000
	maxAgentsPerExec  = 1000
	maxRefusedPerExec = 500
	maxGapsKept       = 200
)

// State is the projection at one position.
type State struct {
	Format  int              `json:"format"`
	Epoch   string           `json:"epoch"`
	Pos     uint64           `json:"pos"`
	Applied int64            `json:"applied"`
	NotV3   int64            `json:"not_v3"`
	Kinds   map[string]int64 `json:"kinds"`
	// Partial says why history before some position is missing from this projection.
	Partial    string                `json:"partial,omitempty"`
	Factory    Factory               `json:"factory"`
	Project    Project               `json:"project"`
	Waves      map[string]*Wave      `json:"waves"`
	Slices     map[string]*Slice     `json:"slices"`
	Cells      map[string]*Cell      `json:"cells"`
	Executions map[string]*Execution `json:"executions"`
	Gates      map[string]*HumanGate `json:"gates"`
	Runs       []*RunRecord          `json:"runs"`
	Gaps       []Gap                 `json:"gaps"`
	GapCounts  map[string]int64      `json:"gap_counts"`
	GapClasses map[string]int64      `json:"gap_classes"`
	Stream     StreamInfo            `json:"stream"`
	Metrics    *metrics.Table        `json:"metrics"`
	Pending    Pending               `json:"pending"`

	// dirty names the entities (cells, slices, executions, waves) an event has touched since the
	// last checkpoint, so a checkpoint re-encodes only those and shares the rest (checkpoint.go).
	dirty map[string]struct{}
}

// Entity keys for checkpoints: one letter for the map, NUL, the id.
const (
	entCell      = "c\x00"
	entSlice     = "s\x00"
	entExecution = "x\x00"
	entWave      = "w\x00"
)

// touch notes that an entity may have changed.
func (s *State) touch(prefix, id string) {
	if s.dirty == nil {
		s.dirty = map[string]struct{}{}
	}
	s.dirty[prefix+id] = struct{}{}
}

// NewState is the empty projection.
func NewState(epoch string) *State {
	s := &State{Format: FormatVersion, Epoch: epoch, Metrics: metrics.NewTable()}
	s.fill()
	return s
}

// fill makes every map non-nil (after decoding a checkpoint as well).
func (s *State) fill() {
	if s.Kinds == nil {
		s.Kinds = map[string]int64{}
	}
	if s.Waves == nil {
		s.Waves = map[string]*Wave{}
	}
	if s.Slices == nil {
		s.Slices = map[string]*Slice{}
	}
	if s.Cells == nil {
		s.Cells = map[string]*Cell{}
	}
	if s.Executions == nil {
		s.Executions = map[string]*Execution{}
	}
	if s.Gates == nil {
		s.Gates = map[string]*HumanGate{}
	}
	if s.GapCounts == nil {
		s.GapCounts = map[string]int64{}
	}
	if s.GapClasses == nil {
		s.GapClasses = map[string]int64{}
	}
	if s.Metrics == nil {
		s.Metrics = metrics.NewTable()
	}
	if s.Metrics.Cells == nil {
		s.Metrics.Cells = map[string]map[string]*metrics.Agg{}
	}
	if s.Pending.Capacity == nil {
		s.Pending.Capacity = map[string]*Stamp{}
	}
	if s.Pending.CostTickets == nil {
		s.Pending.CostTickets = map[string]bool{}
	}
	if s.Pending.LifecycleTickets == nil {
		s.Pending.LifecycleTickets = map[string]bool{}
	}
	for _, x := range s.Executions {
		if x.Agents == nil {
			x.Agents = map[string]*Agent{}
		}
		if x.Queued == nil {
			x.Queued = map[string]*Agent{}
		}
		if x.Tools == nil {
			x.Tools = map[string]*Tool{}
		}
		if x.Workflows == nil {
			x.Workflows = map[string]*Workflow{}
		}
	}
}

// Pending holds fold bookkeeping that is part of the state (so checkpoints carry it).
type Pending struct {
	Capacity         map[string]*Stamp `json:"capacity"`          // ticket -> capacity wait opened
	CostTickets      map[string]bool   `json:"cost_tickets"`      // tickets already counted in K4's denominator
	LifecycleTickets map[string]bool   `json:"lifecycle_tickets"` // tickets already counted in C2's denominator
}

// StreamInfo is what the execution stream said about itself.
type StreamInfo struct {
	ClaudeCodeVersion string `json:"claude_code_version,omitempty"`
	Sessions          int64  `json:"sessions"`
}

// Factory is the Factory's recorded mode and the scheduler's last decision.
type Factory struct {
	State          string             `json:"state"` // unknown | observe | supervised | paused | disabled
	Autonomy       string             `json:"autonomy,omitempty"`
	AllowMerge     *bool              `json:"allow_merge"`
	Persistent     *bool              `json:"persistent"`
	Limits         map[string]float64 `json:"limits,omitempty"`
	PausedReason   string             `json:"paused_reason,omitempty"`
	Since          *Stamp             `json:"since"`
	SchedulerState string             `json:"scheduler_state,omitempty"`
	LastDecision   *Stamp             `json:"last_decision"`
	Held           []Held             `json:"held"`
	Dispatched     []string           `json:"dispatched"`
	Started        []string           `json:"started"`
}

// Held is one item the scheduler held, with its recorded reason (MACH-written prose, scrubbed).
type Held struct {
	SliceID  string `json:"slice_id,omitempty"`
	TicketID string `json:"ticket_id,omitempty"`
	Why      string `json:"why"`
}

// Project is the project's own facts.
type Project struct {
	ProjectID     string `json:"project_id,omitempty"`
	CommitSeen    string `json:"commit_seen,omitempty"`
	CommitAt      *Stamp `json:"commit_at"`
	LastValidated *Stamp `json:"last_validated"`
	IntakeRefused int64  `json:"intake_refused"`
}

// Wave is a delivery wave.
type Wave struct {
	WaveID     string   `json:"wave_id"`
	Revision   *int64   `json:"revision"`
	Slices     []string `json:"slices"`
	Approved   bool     `json:"approved"`
	ApprovedAt string   `json:"approved_at,omitempty"`
	FirstSeen  *Stamp   `json:"first_seen"`
}

// Slice is a product slice and its current revision's scheduler facts.
type Slice struct {
	SliceID      string          `json:"slice_id"`
	WaveID       string          `json:"wave_id,omitempty"`
	Revision     *int64          `json:"revision"`
	TicketID     string          `json:"ticket_id,omitempty"`
	State        string          `json:"state"` // completed | active | ready | blocked | superseded | unknown
	Dependencies []string        `json:"dependencies"`
	DependsOn    []string        `json:"depends_on"`
	Reasons      []string        `json:"last_reasons"`
	Commit       string          `json:"commit,omitempty"`
	Materialized *Stamp          `json:"materialized"`
	Blocked      *Stamp          `json:"blocked"`
	Resolved     *Stamp          `json:"resolved"`
	Scheduled    *Stamp          `json:"scheduled"`
	Integrated   *Stamp          `json:"integrated"`
	Superseded   *Stamp          `json:"superseded"`
	Revisions    []SliceRevision `json:"revisions"`
	History      []StateChange   `json:"history"`
}

// SliceRevision is an earlier revision of a slice, as it stood when the next one arrived.
type SliceRevision struct {
	Revision *int64 `json:"revision"`
	TicketID string `json:"ticket_id,omitempty"`
	State    string `json:"state"`
	At       *Stamp `json:"materialized"`
}

// StateChange is one scheduler state a slice entered.
type StateChange struct {
	State   string `json:"state"`
	EventID string `json:"event_id"`
	Pos     uint64 `json:"pos"`
	At      *int64 `json:"at_ms"`
}

// Cell is one ticket's cell and its station history.
type Cell struct {
	TicketID     string `json:"ticket_id"`
	CellInstance string `json:"cell_instance,omitempty"`
	SliceID      string `json:"slice_id,omitempty"`
	WaveID       string `json:"wave_id,omitempty"`
	Revision     *int64 `json:"revision"`
	Stage        string `json:"stage,omitempty"`
	StageSource  string `json:"stage_source,omitempty"` // the event kind that set it
	Risk         string `json:"risk,omitempty"`
	AppType      string `json:"app_type,omitempty"`
	// AppTypeSource is the event that recorded the app type (the plan's exit), "" when a run
	// record gave it. Contracts and TasksPlanned are the plan exit's counts.
	AppTypeSource string         `json:"app_type_source,omitempty"`
	Contracts     *int64         `json:"contracts,omitempty"`
	TasksPlanned  *int64         `json:"tasks_planned,omitempty"`
	FirstSeen     *Stamp         `json:"first_seen"`
	Updated       *Stamp         `json:"updated"`
	Lifecycle     bool           `json:"lifecycle"`
	CurrentVisit  string         `json:"current_visit,omitempty"`
	Round         *int64         `json:"round"`
	Visits        []*Visit       `json:"visits"`
	Gates         []*Gate        `json:"gates"`
	GatesDropped  int64          `json:"gates_dropped"`
	Tasks         []*Task        `json:"tasks"`
	Checks        []*Check       `json:"checks"`
	Targets       []Target       `json:"targets"`
	Reviews       []*ReviewRound `json:"reviews"`
	Findings      []Finding      `json:"findings"`
	Approvals     []*Approval    `json:"approvals"`
	Merge         *Merge         `json:"merge"`
	Cleanup       *Cleanup       `json:"cleanup"`
	Executions    []string       `json:"executions"`
	Archived      bool           `json:"archived"`
	Began         *Began         `json:"history_began"`
	Artifacts     ArtifactCounts `json:"artifacts"`
	Dropped       int64          `json:"dropped"`
}

// ArtifactCounts counts artifact.recorded events by nature and integrity.
type ArtifactCounts struct {
	Recorded int64 `json:"recorded"`
	Evidence int64 `json:"evidence"`
	Verified int64 `json:"verified"` // evidence with integrity match
	Mismatch int64 `json:"mismatch"`
	Missing  int64 `json:"missing"`
}

// Visit is one station visit.
type Visit struct {
	VisitID     string `json:"visit_id"`
	Station     string `json:"station"`
	Round       *int64 `json:"round"`
	Entered     *Stamp `json:"entered"`
	Exited      *Stamp `json:"exited"`
	Outcome     string `json:"outcome,omitempty"`
	StageIn     string `json:"stage_in,omitempty"`
	StageOut    string `json:"stage_out,omitempty"`
	Action      string `json:"action,omitempty"`
	Resumed     bool   `json:"resumed"`
	Head        string `json:"head,omitempty"`
	ClosedBy    string `json:"closed_by,omitempty"`
	DurationMS  *int64 `json:"recorded_duration_ms"`
	ExecutionID string `json:"execution_id,omitempty"`
	Restarts    int64  `json:"restarts"`
}

// Gate is one gate evaluation.
type Gate struct {
	Gate       string `json:"gate"`
	Verdict    string `json:"verdict"`
	ReasonCode string `json:"reason_code,omitempty"`
	Subject    string `json:"subject,omitempty"`
	Status     string `json:"status,omitempty"`
	AuditTier  string `json:"audit_tier,omitempty"`
	VisitID    string `json:"visit_id,omitempty"`
	Round      *int64 `json:"round"`
	At         *Stamp `json:"at"`
}

// Task is one recorded build task step.
type Task struct {
	TaskID   string `json:"task_id"`
	Kind     string `json:"kind,omitempty"`
	Step     string `json:"step,omitempty"`
	FirstRun string `json:"first_run,omitempty"`
	Suite    string `json:"suite,omitempty"`
	Commit   string `json:"commit,omitempty"`
	VisitID  string `json:"visit_id,omitempty"`
	Round    *int64 `json:"round"`
	At       *Stamp `json:"at"`
}

// Check is one recorded verification check.
type Check struct {
	TargetID   string     `json:"target_id"`
	TargetKind string     `json:"target_kind,omitempty"`
	Result     string     `json:"result"`
	Evidence   []Evidence `json:"evidence"`
	Rerecorded bool       `json:"rerecorded"`
	VisitID    string     `json:"visit_id,omitempty"`
	Round      *int64     `json:"round"`
	At         *Stamp     `json:"at"`
}

// Evidence is one file a check names.
type Evidence struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
	Bytes  *int64 `json:"bytes"`
}

// Target is one verification target listed for a visit.
type Target struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

// ReviewRound is one judging round's review.
type ReviewRound struct {
	Round                 *int64            `json:"round"`
	VisitID               string            `json:"visit_id,omitempty"`
	Risk                  string            `json:"risk,omitempty"`
	MaxRounds             *int64            `json:"max_rounds"`
	ApprovalsNeeded       *int64            `json:"approvals_needed"`
	HumanApprovalRequired bool              `json:"human_approval_required"`
	Tuning                bool              `json:"tuning"`
	Delta                 bool              `json:"delta"`
	Restarted             int64             `json:"restarted"`
	Panel                 []Seat            `json:"panel"`
	Started               *Stamp            `json:"started"`
	Verdicts              []Verdict         `json:"verdicts"`
	Outcome               string            `json:"outcome,omitempty"`
	Approvals             *int64            `json:"approvals"`
	Votes                 map[string]string `json:"votes,omitempty"`
	Blockers              *int64            `json:"blockers"`
	SecurityVeto          bool              `json:"security_veto"`
	Decided               *Stamp            `json:"decided"`
}

// Seat is a panel seat.
type Seat struct {
	Seat  string `json:"seat"`
	Model string `json:"model,omitempty"`
}

// Verdict is one seat's vote.
type Verdict struct {
	Seat     string   `json:"seat"`
	Vote     string   `json:"vote"`
	Blockers int64    `json:"blockers"`
	Notes    int64    `json:"notes"`
	Rules    []string `json:"rules"`
	Model    string   `json:"model,omitempty"`
	At       *Stamp   `json:"at"`
}

// Finding is a reconstructed review finding (model-written title, shown as text).
type Finding struct {
	Round    *int64 `json:"round"`
	Seat     string `json:"seat"`
	N        int64  `json:"n"`
	Severity string `json:"severity"`
	Rule     string `json:"rule,omitempty"`
	FileRel  string `json:"file_rel,omitempty"`
	Title    string `json:"title"`
	Nature   string `json:"nature"` // always "prose": written by an agent
}

// Approval is a recorded human approval (never a name).
type Approval struct {
	Round     *int64 `json:"round"`
	ByRole    string `json:"by_role"`
	NoteGiven bool   `json:"note_given"`
	At        *Stamp `json:"at"`
}

// Merge is the cell's merge.
type Merge struct {
	Method         string `json:"method,omitempty"`
	MergeCommit    string `json:"merge_commit,omitempty"`
	ApprovedCommit string `json:"approved_commit,omitempty"`
	LandedCommit   string `json:"landed_commit,omitempty"`
	Revalidated    bool   `json:"revalidated"`
	PullRequest    *int64 `json:"pull_request"`
	At             *Stamp `json:"at"`
}

// Cleanup is the cell's cleanup.
type Cleanup struct {
	Outcome string `json:"outcome,omitempty"`
	Archive string `json:"archive,omitempty"`
	Bundle  bool   `json:"bundle"`
	At      *Stamp `json:"at"`
}

// Began says history for the cell begins part-way.
type Began struct {
	Reason string `json:"reason"`
	Stage  string `json:"stage,omitempty"`
	At     *Stamp `json:"at"`
}

// HumanGate is a wait for a person: an approval a review asked for, or a ticket the supervisor
// parked for a person.
type HumanGate struct {
	Key      string `json:"key"`
	Kind     string `json:"kind"` // approval | required
	TicketID string `json:"ticket_id,omitempty"`
	SliceID  string `json:"slice_id,omitempty"`
	Round    *int64 `json:"round"`
	Reason   string `json:"reason,omitempty"`
	Opened   *Stamp `json:"opened"`
	Closed   *Stamp `json:"closed"`
	ClosedBy string `json:"closed_by,omitempty"`
}

// Execution is one supervised execution.
type Execution struct {
	ExecutionID    string               `json:"execution_id"`
	TicketID       string               `json:"ticket_id,omitempty"`
	SliceID        string               `json:"slice_id,omitempty"`
	RunnerID       string               `json:"runner_id,omitempty"`
	Attempt        *int64               `json:"attempt"`
	Workflow       string               `json:"workflow,omitempty"`
	Until          string               `json:"until,omitempty"`
	Limits         map[string]float64   `json:"limits,omitempty"`
	Claimed        *Stamp               `json:"claimed"`
	Started        *Stamp               `json:"started"`
	ProcessStarted *Stamp               `json:"process_started"`
	ProcessEnded   *Stamp               `json:"process_ended"`
	Ended          string               `json:"ended,omitempty"` // exited | timed-out | interrupted | could-not-start
	ExitCode       *int64               `json:"exit_code"`
	Seconds        *int64               `json:"seconds"`
	Completed      *Stamp               `json:"completed"`
	Failed         *Stamp               `json:"failed"`
	StageAtStart   string               `json:"stage_at_start,omitempty"`
	StageAtEnd     string               `json:"stage_at_end,omitempty"`
	Next           string               `json:"next,omitempty"`
	WaitingFor     string               `json:"waiting_for,omitempty"`
	How            string               `json:"how,omitempty"`
	ClaudeError    string               `json:"claude_error,omitempty"`
	CostUSD        *float64             `json:"cost_usd"` // execution.completed (MACH-recorded)
	RefusedTools   []string             `json:"refused_tools"`
	Recovery       []string             `json:"recovery"`
	Usage          *Usage               `json:"usage"`
	Session        *Session             `json:"session"`
	Workflows      map[string]*Workflow `json:"workflows"`
	Agents         map[string]*Agent    `json:"agents"`
	Queued         map[string]*Agent    `json:"queued"`
	Tools          map[string]*Tool     `json:"tools"`
	ToolsDropped   int64                `json:"tools_dropped"`
	Refused        []Refusal            `json:"refused"`
	Visits         []string             `json:"visits"`
}

// Usage is execution.usage: Claude-reported cost and tokens, per execution and per model.
type Usage struct {
	TotalCostUSD    *float64               `json:"total_cost_usd"`
	Subtype         string                 `json:"subtype,omitempty"`
	IsError         *bool                  `json:"is_error"`
	TerminalReason  string                 `json:"terminal_reason,omitempty"`
	BudgetExhausted bool                   `json:"budget_exhausted"`
	Models          map[string]*ModelUsage `json:"models"`
	// CostComplete (schema revision 1): false when the stream says the reported spend may be
	// lower than what was spent; nil from a revision-0 event, which did not say.
	CostComplete          *bool    `json:"cost_complete"`
	CostIncompleteReasons []string `json:"cost_incomplete_reasons"`
	At                    *Stamp   `json:"at"`
}

// ModelUsage is one model's recorded use within one execution.
type ModelUsage struct {
	CostUSD             *float64 `json:"cost_usd"`
	InputTokens         *int64   `json:"input_tokens"`
	OutputTokens        *int64   `json:"output_tokens"`
	CacheReadTokens     *int64   `json:"cache_read_tokens"`
	CacheCreationTokens *int64   `json:"cache_creation_tokens"`
}

// Session is session.initialized.
type Session struct {
	ClaudeCodeVersion string `json:"claude_code_version,omitempty"`
	Model             string `json:"model,omitempty"`
	PermissionMode    string `json:"permission_mode,omitempty"`
}

// Workflow is one Dynamic Workflow run inside an execution.
type Workflow struct {
	Ref          string   `json:"ref"`
	Workflow     string   `json:"workflow,omitempty"`
	Tickets      []string `json:"tickets"`
	Phases       []Phase  `json:"phases"`
	Started      *Stamp   `json:"started"`
	Finished     *Stamp   `json:"finished"`
	Status       string   `json:"status,omitempty"` // completed | killed | unknown; never from result.subtype
	StopReason   string   `json:"stop_reason,omitempty"`
	TotalTokens  *int64   `json:"total_tokens"`
	ToolUses     *int64   `json:"tool_uses"`
	DurationMS   *int64   `json:"duration_ms"`
	WorkflowJSON bool     `json:"workflow_json"`
}

// Phase is a declared workflow phase (a list, never a moment).
type Phase struct {
	Index int64  `json:"index"`
	Title string `json:"title"`
}

// Agent is a workflow agent (or an Agent-tool sub-agent) as its snapshots showed it. It carries
// a token total and a tool-call count, never a cost and never individual tool calls.
type Agent struct {
	AgentID    string            `json:"agent_id,omitempty"`
	Workflow   string            `json:"workflow,omitempty"`
	Index      *int64            `json:"index"`
	Label      string            `json:"label,omitempty"`
	Phase      string            `json:"phase,omitempty"`
	PhaseIndex *int64            `json:"phase_index"`
	AgentType  string            `json:"agent_type,omitempty"`
	Model      string            `json:"model,omitempty"`
	AgentTry   *int64            `json:"agent_try"`
	TicketID   string            `json:"ticket_id,omitempty"`
	Station    string            `json:"station,omitempty"`
	Seat       string            `json:"seat,omitempty"`
	Inferred   map[string]string `json:"inferred,omitempty"`
	Queued     *Stamp            `json:"queued"`
	Started    *Stamp            `json:"started"`
	Progressed *Stamp            `json:"progressed"`
	Finished   *Stamp            `json:"finished"`
	Status     string            `json:"status"` // queued | running | done | error | unknown
	DurationMS *int64            `json:"duration_ms"`
	Tokens     *int64            `json:"tokens"`
	ToolCalls  *int64            `json:"tool_calls"`
	LastTool   string            `json:"last_tool,omitempty"`
	Refused    int64             `json:"refused"`
}

// Tool is one main-loop or Agent-tool sub-agent tool call (never a workflow agent's).
type Tool struct {
	ToolCallID  string `json:"tool_call_id"`
	AgentID     string `json:"agent_id,omitempty"`
	Tool        string `json:"tool"`
	TargetClass string `json:"target_class,omitempty"`
	Script      string `json:"script,omitempty"`
	PathRel     string `json:"path_rel,omitempty"`
	Called      *Stamp `json:"called"`
	Returned    *Stamp `json:"returned"`
	Status      string `json:"status"` // running | ok | error | unknown
	DurationMS  *int64 `json:"duration_ms"`
}

// Refusal is one refused tool call.
type Refusal struct {
	Tool    string `json:"tool"`
	Summary string `json:"summary,omitempty"`
	AgentID string `json:"agent_id,omitempty"`
	At      *Stamp `json:"at"`
}

// RunRecord is run.recorded: one finished ticket, as cleanup wrote it.
type RunRecord struct {
	TicketID               string `json:"ticket_id"`
	SliceID                string `json:"slice_id,omitempty"`
	RecordVersion          *int64 `json:"record_version"`
	Outcome                string `json:"outcome"`
	Rounds                 *int64 `json:"rounds"`
	FirstPass              bool   `json:"first_pass"`
	VerifyFailures         int64  `json:"verify_failures"`
	ReviewRejections       int64  `json:"review_rejections"`
	Escalated              bool   `json:"escalated"`
	HumanApproval          bool   `json:"human_approval"`
	Deviations             int64  `json:"deviations"`
	Blockers               int64  `json:"blockers"`
	TestsSeenFailingFirst  int64  `json:"tests_seen_failing_first"`
	TestsPassingOnFirstRun int64  `json:"tests_passing_on_first_run"`
	Risk                   string `json:"risk,omitempty"`
	AppType                string `json:"app_type,omitempty"`
	MergeMethod            string `json:"merge_method,omitempty"`
	MergeCommit            string `json:"merge_commit,omitempty"`
	ClosedAt               *Stamp `json:"closed_at"`
	EventID                string `json:"event_id"`
}

// Gap is a recorded history gap.
type Gap struct {
	SourceKey string `json:"source_key"`
	FromSeq   *int64 `json:"from_seq"`
	ToSeq     *int64 `json:"to_seq"`
	Reason    string `json:"reason"`
	Class     string `json:"class"`
	Lost      bool   `json:"history_lost"`
	Count     *int64 `json:"count"`
	EventID   string `json:"event_id"`
	Pos       uint64 `json:"pos"`
}
