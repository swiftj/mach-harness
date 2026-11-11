package interview_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"mach/studio/internal/interview"
	"mach/studio/internal/testkit"
)

// ---- the question parser, against the cases in M5_INTERVIEW_POC.md section 8.3 ----

func TestQuestionParser(t *testing.T) {
	normal := testkit.QuestionText(1, "Who invites and what happens")
	q := interview.ParseQuestion(normal)
	if q == nil || q.Number != 1 || q.Title != "Who invites and what happens" || q.Preface == nil ||
		*q.Preface != "Facts from your notes: seats are limited by plan." ||
		q.Recommendation != "Yes. The slice is done when the invitation is sent." ||
		!strings.HasPrefix(q.Body, "Is this slice for a workspace admin") {
		t.Fatalf("normal question: %+v", q)
	}
	bare := "❓ **Q9** – **Invitation lifetime**: How long does an invitation last?\n➡️ Common default: 7 days."
	if q := interview.ParseQuestion(bare); q == nil || q.Number != 9 || q.Preface != nil || q.Recommendation != "Common default: 7 days." {
		t.Fatalf("no preface, en dash: %+v", q)
	}
	cases := map[string]string{
		"truncated after an interrupt": "❓ **Q12** - **What the email says**: … with the subject \"<",
		"two questions":                normal + "\n\n" + testkit.QuestionText(2, "Second"),
		"drift: lost the ❓ line":       "Let me ask again about seats.\n\n➡️ Yes.",
		"no recommendation":            "❓ **Q3** - **Seats**: Does an invitation hold a seat?",
		"no bold number":               "❓ Q3 - **Seats**: Does an invitation hold a seat?\n➡️ Yes.",
	}
	for name, text := range cases {
		if q := interview.ParseQuestion(text); q != nil {
			t.Errorf("%s: parsed as %+v", name, q)
		}
	}
	if k := interview.ClassifyMessage("- Admin invites\n- Seat held\n- Email sent\n\nDoes this capture the intent? Reply yes to write it up."); k != "confirmation" {
		t.Fatalf("confirmation: %s", k)
	}
	if k := interview.ClassifyMessage(cases["drift: lost the ❓ line"]); k != "other" {
		t.Fatalf("drift: %s", k)
	}
	if k := interview.ClassifyMessage(normal); k != "question" {
		t.Fatalf("question: %s", k)
	}
}

// ---- helpers ----

type rig struct {
	t       *testing.T
	project string
	claude  string
	bridge  *interview.Claude
}

func newRig(t *testing.T, turns ...testkit.Turn) *rig {
	t.Helper()
	project := testkit.NewProject(t)
	for _, dir := range []string{testkit.Draft(project, "specs", "slices"), testkit.Draft(project, "product", "intents"), testkit.Draft(project, "product", "slices")} {
		os.MkdirAll(dir, 0o755)
	}
	claude := testkit.FakeClaude(t, turns...)
	r := &rig{t: t, project: project, claude: claude}
	r.bridge = r.newBridge(nil)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		r.bridge.Shutdown(ctx)
	})
	return r
}

func (r *rig) newBridge(adjust func(*interview.Config)) *interview.Claude {
	r.t.Helper()
	cfg := interview.Config{
		Project: r.project, Python: testkit.Python(r.t), Script: testkit.Script(r.t), Claude: r.claude,
		BudgetUSD: 2, TurnTimeout: 30 * time.Second, KillGrace: time.Second,
		HostEnv: append(os.Environ(), "ANTHROPIC_API_KEY=sk-should-never-pass", "CLAUDE_CODE_ENTRYPOINT=parent", "GIT_DIR=/elsewhere"),
	}
	if where := testkit.NewEngine(r.t, r.project).Do(context.Background(), "where", nil); where.OK {
		cfg.ReadDirs = interview.ReadDirsFromWhere(where.Data, r.project)
	}
	if adjust != nil {
		adjust(&cfg)
	}
	b, err := interview.New(cfg)
	if err != nil {
		r.t.Fatal(err)
	}
	return b
}

func dataOf(ev interview.Event) map[string]any {
	if m, ok := ev.Data.(map[string]any); ok {
		return m
	}
	return nil
}

// until reads events (replay first) until a state event with one of the wanted states.
func until(t *testing.T, b interview.Bridge, id string, after int64, states ...string) []interview.Event {
	t.Helper()
	replay, events, cancel, err := b.Subscribe(id, after)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	var got []interview.Event
	done := func(ev interview.Event) bool {
		got = append(got, ev)
		if ev.Name != "state" {
			return false
		}
		for _, s := range states {
			if dataOf(ev)["state"] == s {
				return true
			}
		}
		return false
	}
	for _, ev := range replay {
		if done(ev) {
			return got
		}
	}
	timeout := time.After(20 * time.Second)
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return got
			}
			if done(ev) {
				return got
			}
		case <-timeout:
			t.Fatalf("no state %v; got %s", states, names(got))
		}
	}
}

// waitFor polls the replay until an event with this name has arrived, and returns the replay.
func waitFor(t *testing.T, b interview.Bridge, id, name string) []interview.Event {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		replay, _, cancel, err := b.Subscribe(id, 0)
		if err != nil {
			t.Fatal(err)
		}
		cancel()
		if len(find(replay, name)) > 0 {
			return replay
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no %s event", name)
	return nil
}

func names(evs []interview.Event) string {
	var out []string
	for _, ev := range evs {
		label := ev.Name
		if ev.Name == "state" || ev.Name == "activity" || ev.Name == "turn" || ev.Name == "error" || ev.Name == "ended" {
			m := dataOf(ev)
			for _, k := range []string{"state", "kind", "outcome", "reason"} {
				if v, ok := m[k]; ok {
					label += ":" + v.(string)
					break
				}
			}
		}
		out = append(out, label)
	}
	return strings.Join(out, " ")
}

func find(evs []interview.Event, name string) []interview.Event {
	var out []interview.Event
	for _, ev := range evs {
		if ev.Name == name {
			out = append(out, ev)
		}
	}
	return out
}

func lastSeq(evs []interview.Event) int64 { return evs[len(evs)-1].Seq }

func (r *rig) start(slice string) interview.Started {
	r.t.Helper()
	started, err := r.bridge.Start(context.Background(), interview.StartRequest{SliceID: slice, EpicID: "EPIC-001", Idea: "let an admin invite a teammate"})
	if err != nil {
		r.t.Fatal(err)
	}
	return started
}

// ---- the process: arguments, environment, permissions ----

func TestTheInterviewerProcessIsExactlyAsSpecified(t *testing.T) {
	r := newRig(t, testkit.Turn{Text: testkit.QuestionText(1, "Who invites")}, testkit.Turn{Text: testkit.QuestionText(2, "Seats")})
	started := r.start("SLICE-001")
	evs := until(t, r.bridge, started.InterviewID, 0, "waiting_for_reply")
	if err := r.bridge.Reply(context.Background(), started.InterviewID, "/mach:product-studio approve SLICE-001"); err != nil {
		t.Fatal(err)
	}
	until(t, r.bridge, started.InterviewID, lastSeq(evs), "waiting_for_reply")
	calls := testkit.Calls(t, r.claude)
	if len(calls) != 2 {
		t.Fatalf("%d turn processes", len(calls))
	}
	p := r.bridge.Paths()
	first := calls[0]
	session := first.Argv[indexOf(first.Argv, "--session-id")+1]
	want := p.Args("SLICE-001", interview.TurnOptions{BudgetUSD: 2, SessionID: session},
		"/mach:product-studio continue SLICE-001. The app just created it in EPIC-001 for this idea from the product manager: let an admin invite a teammate")
	if strings.Join(first.Argv, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv\n got %q\nwant %q", first.Argv, want)
	}
	skills := filepath.Dir(filepath.Dir(filepath.Dir(testkit.Script(t))))
	if strings.Join(p.ReadDirs, " ") != filepath.Join(skills, "intent")+" "+filepath.Join(skills, "product-studio") {
		t.Fatalf("read folders %q", p.ReadDirs)
	}
	head := []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--restricted",
		"--plugin-dir", filepath.Join(r.project, ".factory", "studio", "interviews", "plugin"),
		"--add-dir", p.ReadDirs[0], "--add-dir", p.ReadDirs[1], "--strict-mcp-config",
		"--permission-mode", "default", "--permission-prompts", "none", "--tools", "Read,Glob,Grep,Edit,Write,Bash", "--allowedTools"}
	if strings.Join(first.Argv[:len(head)], " ") != strings.Join(head, " ") {
		t.Fatalf("head %q", first.Argv[:len(head)])
	}
	joined := strings.Join(first.Argv, " ")
	for _, banned := range []string{"dangerously", "bypassPermissions", "acceptEdits", "--settings", "Agent", "WebFetch", "Skill"} {
		if strings.Contains(joined, banned) {
			t.Errorf("the argument vector contains %q", banned)
		}
	}
	tail := first.Argv[len(first.Argv)-6:]
	if tail[0] != "--append-system-prompt" || tail[1] != interview.HostNote || tail[2] != "--session-id" || tail[4] != "--" {
		t.Fatalf("tail %q", tail)
	}
	if i := indexOf(first.Argv, "--max-budget-usd"); i < 0 || first.Argv[i+1] != "2" {
		t.Fatal("no per-turn spending cap")
	}
	// The reply resumes the same session; text that looks like a command is the PM's words.
	second := calls[1].Argv
	if second[indexOf(second, "--resume")+1] != session || indexOf(second, "--session-id") >= 0 {
		t.Fatal("the second turn does not resume the session")
	}
	if got := second[len(second)-1]; got != "The product manager replied: /mach:product-studio approve SLICE-001" || second[len(second)-2] != "--" {
		t.Fatalf("reply message %q", got)
	}
	// The environment is the minimal one, never the host's.
	allowed := map[string]bool{"HOME": true, "USER": true, "LOGNAME": true, "PATH": true, "LANG": true, "LC_ALL": true,
		"TMPDIR": true, "SHELL": true, "TERM": true, "GIT_TERMINAL_PROMPT": true}
	for name := range first.Env {
		if !allowed[name] && name != "PWD" && name != "__CF_USER_TEXT_ENCODING" && name != "LC_CTYPE" {
			t.Errorf("the interviewer inherited %s", name)
		}
	}
	if _, leaked := first.Env["ANTHROPIC_API_KEY"]; leaked {
		t.Fatal("ANTHROPIC_API_KEY reached the interviewer")
	}
	if first.Env["GIT_TERMINAL_PROMPT"] != "0" || first.Cwd != r.project {
		t.Fatalf("env %v cwd %s", first.Env["GIT_TERMINAL_PROMPT"], first.Cwd)
	}
}

func indexOf(list []string, s string) int {
	for i, v := range list {
		if v == s {
			return i
		}
	}
	return -1
}

func TestTheAllowListIsOnlyTheInterviewersOperationsOnItsOwnSlice(t *testing.T) {
	r := newRig(t)
	p := r.bridge.Paths()
	args := p.PermissionArgs("SLICE-007")
	split := indexOf(args, "--disallowedTools")
	allow, deny := args[1:split], args[split+1:]
	var scripts, pythons []string
	for _, s := range p.Scripts {
		scripts = append(scripts, regexp.QuoteMeta(s))
	}
	for _, py := range p.Pythons {
		pythons = append(pythons, regexp.QuoteMeta(py))
	}
	if len(p.Scripts) != 2 || !strings.HasSuffix(p.Scripts[0]+p.Scripts[1], "studio.py") || len(p.Pythons) < 1 || p.Pythons[0] != "python3" {
		t.Fatalf("paths %+v", p)
	}
	bash := regexp.MustCompile(`^Bash\((` + strings.Join(pythons, "|") + `) "?(` + strings.Join(scripts, "|") + `)"? ` +
		`(where|status|validate|refresh|slice resume SLICE-007|slice check SLICE-007|slice (check|pause|set) SLICE-007 \*)\)$`)
	draft := testkit.Draft(r.project)
	edits := map[string]bool{
		"Edit(/" + draft + "/specs/slices/SLICE-007-*.md)":  true,
		"Edit(/" + draft + "/product/intents/SLICE-007.md)": true,
	}
	counts := map[string]int{}
	for _, rule := range allow {
		switch {
		case rule == "Read" || rule == "Glob" || rule == "Grep":
		case edits[rule]:
			counts["edit"]++
		case bash.MatchString(rule):
			counts["bash"]++
		default:
			t.Errorf("unexpected allow rule %q", rule)
		}
		if strings.Contains(rule, "SLICE-") && !strings.Contains(rule, "SLICE-007") {
			t.Errorf("a rule for another slice: %s", rule)
		}
	}
	// 7 operations x 2 scripts x 2 spellings x each interpreter.
	if counts["edit"] != 2 || counts["bash"] != 9*2*2*len(p.Pythons) {
		t.Fatalf("counts %v with %d interpreters", counts, len(p.Pythons))
	}
	for _, rule := range allow {
		if strings.HasPrefix(rule, "Write(") || strings.Contains(rule, "Edit(.") {
			t.Errorf("a Write or relative Edit rule: %s", rule)
		}
	}
	for _, op := range []string{"slice approve", "epic approve", "wave", "send", "reconcile", "project", "slice new"} {
		found := false
		for _, rule := range deny {
			if strings.HasSuffix(rule, " "+op+" *)") {
				found = true
			}
		}
		if !found {
			t.Errorf("no deny rule for %s", op)
		}
	}
}

func TestTheOneSkillPluginIsStable(t *testing.T) {
	r := newRig(t, testkit.Turn{Text: "Hello."})
	started := r.start("SLICE-001")
	until(t, r.bridge, started.InterviewID, 0, "waiting_for_reply")
	plugin := filepath.Join(r.project, ".factory", "studio", "interviews", "plugin")
	manifest, _ := os.ReadFile(filepath.Join(plugin, ".claude-plugin", "plugin.json"))
	if string(manifest) != `{"name": "mach", "version": "0.0.0-interviewer", "description": "Product Studio interviewer"}` {
		t.Fatalf("manifest %s", manifest)
	}
	target, err := os.Readlink(filepath.Join(plugin, "skills", "product-studio"))
	if err != nil || target != filepath.Dir(filepath.Dir(testkit.Script(t))) {
		t.Fatalf("link %s %v", target, err)
	}
	if r.bridge.Paths().PluginDir != plugin {
		t.Fatal("the plugin path is not the stable one")
	}
}

// ---- events ----

func TestATurnBecomesTheContractsEvents(t *testing.T) {
	script := testkit.Script(t)
	spec := filepath.Join(".factory", "studio", "draft", "specs", "slices", "SLICE-001-invite.md")
	r := newRig(t,
		testkit.Turn{Text: testkit.QuestionText(1, "Who invites"), Cost: 0.0123, SessionCost: 0.11, Tools: []testkit.FakeTool{
			{ID: "toolu_1", Name: "Bash", Input: map[string]any{"command": `python3 "` + script + `" status`}},
			{ID: "toolu_2", Name: "Read", Input: map[string]any{"file_path": "/project/docs/product.md"}},
			{ID: "toolu_3", Name: "Write", Input: map[string]any{"file_path": "/x/specs/slices/SLICE-001-invite.md"}, Write: spec},
			{ID: "toolu_5", Name: "Read", Input: map[string]any{"file_path": "/elsewhere/notes.md"},
				Error: "/elsewhere/notes.md is outside /project; --restricted confines the file tools to the working directory."},
		}},
		testkit.Turn{Text: "I can't approve; use the Approve button.", Tools: []testkit.FakeTool{
			{ID: "toolu_4", Name: "Bash", Input: map[string]any{"command": `python3 "` + script + `" slice approve SLICE-001`}, Denied: true},
		}},
	)
	started := r.start("SLICE-001")
	if started.Resumed {
		t.Fatal("a new interview reported resumed")
	}
	evs := until(t, r.bridge, started.InterviewID, 0, "waiting_for_reply")
	got := names(evs)
	for _, want := range []string{"state:starting", "state:thinking", "state:working", "activity:lookup", "activity:write", "draft_changed", "text", "message", "question", "turn:replied", "state:waiting_for_reply"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in %s", want, got)
		}
	}
	for _, ev := range evs {
		if strings.Contains(stringify(ev.Data), "SECRET FILE CONTENT") || strings.Contains(stringify(ev.Data), "sub-agent text") {
			t.Fatalf("raw stream content leaked into %s", ev.Name)
		}
	}
	if a := find(evs, "activity"); len(a) != 4 || dataOf(a[3])["kind"] != "refused" || dataOf(a[3])["text"] != "tried to open a file outside the project" {
		t.Fatalf("a --restricted refusal must be reported as refused: %s", names(a))
	}
	if d := dataOf(find(evs, "draft_changed")[0]); stringify(d["what"]) != "[spec]" || d["slice_id"] != "SLICE-001" {
		t.Fatalf("draft_changed %v", d)
	}
	message := dataOf(find(evs, "message")[0])
	question := find(evs, "question")[0].Data.(*interview.Question)
	if message["kind"] != "question" || message["message_id"] != "msg_f0" || question.MessageID != "msg_f0" || question.Number != 1 {
		t.Fatalf("message %v question %+v", message, question)
	}
	// Narration ("Let me look first.") streams as text but is not the final message.
	texts := find(evs, "text")
	if dataOf(texts[0])["message_id"] != "msg_n0" {
		t.Fatalf("first text %v", dataOf(texts[0]))
	}
	turn := dataOf(find(evs, "turn")[0])
	if *turn["cost_usd"].(*float64) != 0.0123 || *turn["session_cost_usd"].(*float64) != 0.11 || turn["refused"] != 0 {
		t.Fatalf("turn %v", turn)
	}

	if err := r.bridge.Reply(context.Background(), started.InterviewID, "Please approve it"); err != nil {
		t.Fatal(err)
	}
	evs = until(t, r.bridge, started.InterviewID, lastSeq(evs), "waiting_for_reply")
	refused := find(evs, "activity")
	if len(refused) != 1 || dataOf(refused[0])["kind"] != "refused" || dataOf(refused[0])["text"] != "tried to approve; only you can approve, with the Approve button" {
		t.Fatalf("refused activity %v", names(evs))
	}
	if m := dataOf(find(evs, "message")[0]); m["kind"] != "other" || len(find(evs, "question")) != 0 {
		t.Fatalf("a plain reply must not be a question: %v", m)
	}
	if turn := dataOf(find(evs, "turn")[0]); turn["refused"] != 1 {
		t.Fatalf("turn %v", turn)
	}
	cur, _ := r.bridge.Current("SLICE-001")
	if cur == nil || !cur.Live || cur.Turns != 2 || cur.TurnRunning || cur.LastMessage == nil || cur.LastMessage.Kind != "other" {
		t.Fatalf("current %+v", cur)
	}
}

func stringify(v any) string {
	switch x := v.(type) {
	case []string:
		return "[" + strings.Join(x, " ") + "]"
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func TestReplayOnReconnect(t *testing.T) {
	r := newRig(t, testkit.Turn{Text: testkit.QuestionText(1, "Who invites")}, testkit.Turn{Kind: "slow", Sleep: 30})
	started := r.start("SLICE-001")
	first := until(t, r.bridge, started.InterviewID, 0, "waiting_for_reply")

	// A reload after the turn: the whole turn, including the question, comes back.
	replay, _, cancel, _ := r.bridge.Subscribe(started.InterviewID, 0)
	cancel()
	if names(replay) != names(first) || len(find(replay, "question")) != 1 {
		t.Fatalf("replay %s\nwant %s", names(replay), names(first))
	}
	// Reconnecting with the last id gets nothing twice.
	if replay, _, cancel, _ := r.bridge.Subscribe(started.InterviewID, lastSeq(first)); len(replay) != 0 {
		cancel()
		t.Fatalf("replayed after the last id: %s", names(replay))
	} else {
		cancel()
	}
	// During the next turn: the last question, then this turn so far.
	r.bridge.Reply(context.Background(), started.InterviewID, "yes")
	until(t, r.bridge, started.InterviewID, lastSeq(first), "thinking")
	deadline := time.Now().Add(10 * time.Second)
	for {
		replay, _, cancel, _ = r.bridge.Subscribe(started.InterviewID, 0)
		cancel()
		if len(find(replay, "text")) > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(find(replay, "question")) != 1 || len(find(replay, "text")) == 0 || find(replay, "question")[0].Seq > find(replay, "text")[0].Seq {
		t.Fatalf("mid-turn replay %s", names(replay))
	}
	for i := 1; i < len(replay); i++ {
		if replay[i].Seq <= replay[i-1].Seq {
			t.Fatal("replay out of order")
		}
	}
	if !r.bridge.Busy("SLICE-001") {
		t.Fatal("a running turn is not reported busy")
	}
}

// ---- the lock ----

func TestTheLockAllowsOneInterviewPerSlice(t *testing.T) {
	r := newRig(t, testkit.Turn{Text: "Hello."}, testkit.Turn{Text: "Hello again."})
	started := r.start("SLICE-001")
	until(t, r.bridge, started.InterviewID, 0, "waiting_for_reply")
	var conflict *interview.ConflictError
	if _, err := r.bridge.Start(context.Background(), interview.StartRequest{SliceID: "SLICE-001"}); !errors.As(err, &conflict) {
		t.Fatalf("second start in this host: %v", err)
	}
	other := r.newBridge(nil) // another host on the same project
	if _, err := other.Start(context.Background(), interview.StartRequest{SliceID: "SLICE-001"}); !errors.As(err, &conflict) ||
		!strings.Contains(conflict.Message, "process") {
		t.Fatalf("another host: %v", err)
	}
	if cur, _ := other.Current("SLICE-001"); cur == nil || cur.Live || !cur.LockedElsewhere {
		t.Fatalf("current from the other host: %+v", cur)
	}
	r.bridge.Stop(context.Background(), started.InterviewID)
	s2, err := other.Start(context.Background(), interview.StartRequest{SliceID: "SLICE-001"})
	if err != nil {
		t.Fatalf("after stop: %v", err)
	}
	other.Stop(context.Background(), s2.InterviewID)

	// A process that dies holding the lock (like a crashed terminal prototype) does not leave it held.
	lock := filepath.Join(r.project, ".factory", "studio", "interviews", "SLICE-002.lock")
	holder := exec.Command(testkit.Python(t), "-c",
		"import fcntl,sys,time; f=open(sys.argv[1],'a+'); fcntl.flock(f, fcntl.LOCK_EX); f.write('{\"pid\": 1, \"since\": \"x\"}'); f.flush(); print('held', flush=True); time.sleep(60)", lock)
	out, _ := holder.StdoutPipe()
	holder.Start()
	buf := make([]byte, 5)
	out.Read(buf)
	if _, err := r.bridge.Start(context.Background(), interview.StartRequest{SliceID: "SLICE-002"}); !errors.As(err, &conflict) {
		t.Fatalf("a lock held by another process: %v", err)
	}
	holder.Process.Kill()
	holder.Wait()
	s3, err := r.bridge.Start(context.Background(), interview.StartRequest{SliceID: "SLICE-002"})
	if err != nil {
		t.Fatalf("after the holder died: %v", err)
	}
	r.bridge.Stop(context.Background(), s3.InterviewID)
}

// ---- interrupt, stop, time limit, budget, crash, shutdown, restart ----

func TestInterruptAndStop(t *testing.T) {
	r := newRig(t, testkit.Turn{Kind: "slow", Sleep: 60}, testkit.Turn{Text: "Back."})
	started := r.start("SLICE-001")
	evs := waitFor(t, r.bridge, started.InterviewID, "text") // the process is up and streaming
	if err := r.bridge.Reply(context.Background(), started.InterviewID, "hello"); err == nil {
		t.Fatal("a reply during a turn was accepted")
	}
	began := time.Now()
	if err := r.bridge.Interrupt(context.Background(), started.InterviewID); err != nil {
		t.Fatal(err)
	}
	evs = until(t, r.bridge, started.InterviewID, lastSeq(evs), "waiting_for_reply")
	if time.Since(began) > 5*time.Second {
		t.Fatal("the interrupt did not stop the process promptly")
	}
	if turn := dataOf(find(evs, "turn")[0]); turn["outcome"] != "interrupted" || len(find(evs, "message")) != 0 || len(find(evs, "error")) != 0 {
		t.Fatalf("interrupted turn: %s", names(evs))
	}
	if err := r.bridge.Interrupt(context.Background(), started.InterviewID); err == nil {
		t.Fatal("interrupting nothing should be a conflict")
	}
	if err := r.bridge.Reply(context.Background(), started.InterviewID, "continue"); err != nil {
		t.Fatal(err)
	}
	evs = until(t, r.bridge, started.InterviewID, lastSeq(evs), "waiting_for_reply")
	if err := r.bridge.Stop(context.Background(), started.InterviewID); err != nil {
		t.Fatal(err)
	}
	evs = until(t, r.bridge, started.InterviewID, lastSeq(evs), "ended")
	if names(evs) != "ended:stopped state:ended" {
		t.Fatalf("stop: %s", names(evs))
	}
	if err := r.bridge.Reply(context.Background(), started.InterviewID, "more"); err == nil {
		t.Fatal("a reply after stop was accepted")
	}
	if cur, _ := r.bridge.Current("SLICE-001"); cur == nil || cur.Live || cur.LockedElsewhere || cur.Turns != 2 {
		t.Fatalf("after stop: %+v", cur)
	}
}

func TestTimeLimitBudgetAndCrash(t *testing.T) {
	r := newRig(t, testkit.Turn{Kind: "slow", Sleep: 60}, testkit.Turn{Kind: "budget", Text: "partial"}, testkit.Turn{Kind: "crash"})
	r.bridge = r.newBridge(func(c *interview.Config) { c.TurnTimeout = 700 * time.Millisecond })
	started := r.start("SLICE-001")
	evs := until(t, r.bridge, started.InterviewID, 0, "waiting_for_reply")
	if e := dataOf(find(evs, "error")[0]); e["kind"] != "timed_out" || dataOf(find(evs, "turn")[0])["outcome"] != "timed_out" {
		t.Fatalf("time limit: %s", names(evs))
	}
	r.bridge.Reply(context.Background(), started.InterviewID, "yes")
	evs = until(t, r.bridge, started.InterviewID, lastSeq(evs), "waiting_for_reply")
	if e := dataOf(find(evs, "error")[0]); e["kind"] != "error_max_budget_usd" || e["message"] != "This turn reached its spending limit." || len(find(evs, "message")) != 0 {
		t.Fatalf("budget: %s", names(evs))
	}
	r.bridge.Reply(context.Background(), started.InterviewID, "yes")
	evs = until(t, r.bridge, started.InterviewID, lastSeq(evs), "waiting_for_reply")
	if e := dataOf(find(evs, "error")[0]); e["kind"] != "no_result" || dataOf(find(evs, "turn")[0])["outcome"] != "failed" || len(find(evs, "message")) != 0 {
		t.Fatalf("crash: %s", names(evs))
	}
}

func TestShutdownEndsRunningTurns(t *testing.T) {
	r := newRig(t, testkit.Turn{Kind: "slow", Sleep: 60})
	started := r.start("SLICE-001")
	evs := waitFor(t, r.bridge, started.InterviewID, "text")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	began := time.Now()
	r.bridge.Shutdown(ctx)
	if time.Since(began) > 5*time.Second {
		t.Fatal("shutdown waited for the turn")
	}
	evs = until(t, r.bridge, started.InterviewID, lastSeq(evs), "ended")
	if !strings.Contains(names(evs), "ended:host_shutdown") || !strings.Contains(names(evs), "turn:interrupted") {
		t.Fatalf("shutdown: %s", names(evs))
	}
	if _, err := r.bridge.Start(context.Background(), interview.StartRequest{SliceID: "SLICE-002"}); !errors.Is(err, interview.ErrUnavailable) {
		t.Fatalf("start after shutdown: %v", err)
	}
}

func TestResumingAfterARestartShowsTheLastQuestionWithoutATurn(t *testing.T) {
	r := newRig(t, testkit.Turn{Text: testkit.QuestionText(4, "Seats")})
	started := r.start("SLICE-001")
	until(t, r.bridge, started.InterviewID, 0, "waiting_for_reply")
	r.bridge.Shutdown(context.Background())

	restarted := r.newBridge(nil)
	defer restarted.Shutdown(context.Background())
	if cur, _ := restarted.Current("SLICE-001"); cur == nil || cur.Live || cur.State != "saved" || cur.LastMessage == nil || cur.LastMessage.Question == nil || cur.LastMessage.Question.Number != 4 {
		t.Fatalf("saved interview: %+v", cur)
	}
	again, err := restarted.Start(context.Background(), interview.StartRequest{SliceID: "SLICE-001"})
	if err != nil || !again.Resumed {
		t.Fatalf("resume: %+v %v", again, err)
	}
	evs := until(t, restarted, again.InterviewID, 0, "waiting_for_reply")
	if names(evs) != "state:starting message question state:waiting_for_reply" {
		t.Fatalf("resume events: %s", names(evs))
	}
	if n := len(testkit.Calls(t, r.claude)); n != 1 {
		t.Fatalf("resuming ran %d turn processes in all, want 1", n)
	}
}

func TestCapability(t *testing.T) {
	claude := testkit.FakeClaude(t)
	dir := t.TempDir()
	env := os.Environ()
	check := func() interview.Capability { return interview.CheckClaude(context.Background(), claude, dir, env) }
	if c := check(); !c.OK || c.Version != "2.1.322" {
		t.Fatalf("ok: %+v", c)
	}
	testkit.SetFakeFile(t, claude, "version.txt", "2.2.0 (Claude Code)")
	if c := check(); !c.OK {
		t.Fatalf("newer: %+v", c)
	}
	testkit.SetFakeFile(t, claude, "version.txt", "2.1.321 (Claude Code)")
	if c := check(); c.OK || !strings.Contains(c.Reason, "too old") {
		t.Fatalf("older: %+v", c)
	}
	testkit.SetFakeFile(t, claude, "version.txt", "2.1.400 (Claude Code)")
	testkit.SetFakeFile(t, claude, "help.txt", "Usage: claude --permission-prompts")
	if c := check(); c.OK || !strings.Contains(c.Reason, "restricted") {
		t.Fatalf("no --restricted: %+v", c)
	}
	testkit.SetFakeFile(t, claude, "help.txt", "--restricted --permission-prompts")
	testkit.SetFakeFile(t, claude, "auth.json", `{"loggedIn": false}`)
	if c := check(); c.OK || !strings.Contains(c.Reason, "not signed in") {
		t.Fatalf("signed out: %+v", c)
	}
	if c := interview.CheckClaude(context.Background(), "", dir, env); c.OK || !strings.Contains(c.Reason, "not installed") {
		t.Fatalf("missing: %+v", c)
	}
	if testkit.Calls(t, claude) != nil {
		t.Fatal("a capability check started a turn")
	}
	r := newRig(t)
	testkit.SetFakeFile(t, r.claude, "auth.json", `{"loggedIn": false}`)
	if ok, reason := r.bridge.Available(); ok || !strings.Contains(reason, "/mach:product-studio continue SLICE-NNN") {
		t.Fatalf("bridge reason: %q", reason)
	}
	if r.bridge.ContinueCommand() != "/mach:product-studio continue" {
		t.Fatal(r.bridge.ContinueCommand())
	}
	if interview.ContinueCommandFor("/p/.claude/skills/mach-product-studio/scripts/studio.py") != "/mach-product-studio continue" {
		t.Fatal("project install command")
	}
}
