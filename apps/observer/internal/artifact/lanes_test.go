package artifact

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// M22: what is served of the build station's later records is checked here, value by value: a
// kept ref only for this ticket, the task IDs the station adds (J-T01, C-T01), the codes of why a
// lane was set aside, and a changed command's kind and time only, never its text or reason.

func TestAKeptRefIsServedOnlyForItsOwnTicket(t *testing.T) {
	for _, c := range []struct {
		ref  any
		want bool
	}{
		{"refs/mach/lanes-set-aside/T-3/L2/1", true},
		{"refs/mach/lane-files/T-3/L12/40", true},
		{"refs/mach/lanes-set-aside/T-9/L2/1", false},   // another ticket's
		{"refs/mach/lanes-set-aside/T-3/L2/0", false},   // not a number the station makes
		{"refs/heads/mach-lane/T-3/L2", false},          // a branch, not a kept ref
		{"refs/mach/lanes-set-aside/T-3/L2/1 x", false}, // anything after it
		{"refs/mach/lanes-set-aside/T-3/../L2/1", false},
		{3, false},
	} {
		if got := optRef(c.ref, "T-3"); (got != nil) != c.want {
			t.Errorf("%v: served %v", c.ref, got)
		}
	}
}

func TestTheStationsTaskIDs(t *testing.T) {
	for _, id := range []string{"T01", "T7", "R1-T01", "R12-T3", "J-T01", "C-T01", "C-T12"} {
		if _, ok := task(id); !ok {
			t.Errorf("%s refused", id)
		}
	}
	for _, id := range []string{"X-T01", "CJ-T01", "C-01", "c-T01", "C-T", "T01 "} {
		if _, ok := task(id); ok {
			t.Errorf("%s accepted", id)
		}
	}
}

func TestAChangedCommandIsServedAsWhichAndWhenOnly(t *testing.T) {
	var b rawBuild
	raw := `{"test_cmd": "pytest -k secret", "command_changes": [
	  {"at": "2026-11-24T10:40:00+02:00", "changed": [{"command": "test", "old": "make test", "new": "pytest -k secret"}], "reason": "Ada said so", "loop": 1},
	  {"at": "2026-11-24T10:50:00Z", "changed": [{"command": "deploy", "old": null, "new": "rm -rf"}], "reason": "x"}],
	 "deviations": [
	  {"task": null, "type": "test-command-set", "detail": "pytest -k secret", "command": "test", "old": "make test", "new": "pytest -k secret", "reason": "Ada", "at": "2026-11-24T10:40:00Z", "ref": "refs/mach/lanes-set-aside/T-3/L2/1", "commit": "abcdef1234"},
	  {"task": "T02", "type": "test-amended", "detail": "Ada"},
	  {"task": "C-T01", "type": "step-recovered", "commit": "abcdef1234", "lane": "L2"}]}`
	if err := json.Unmarshal([]byte(raw), &b); err != nil {
		t.Fatal(err)
	}
	one := 1
	at := "2026-11-24T08:40:00Z"
	if got := commandChangesOf(&b); !reflect.DeepEqual(got, []CommandChange{{At: &at, Commands: []string{"test"}, Loop: &one}}) {
		t.Errorf("command changes: %+v", got)
	}
	devs := deviationsOf(b.Deviations, "", "T-3")
	out, _ := json.Marshal(devs)
	for _, s := range []string{"pytest", "make test", "Ada", "refs/"} {
		if strings.Contains(string(out), s) {
			t.Errorf("%q served: %s", s, out)
		}
	}
	if len(devs) != 2 || devs[0].Type != "test-command-set" || *devs[0].Command != "test" || devs[1].Type != "step-recovered" || *devs[1].Task != "C-T01" || *devs[1].Lane != "L2" {
		t.Errorf("deviations: %s", out)
	}
}
