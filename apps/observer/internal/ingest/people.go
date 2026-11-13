package ingest

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"mach/observer/internal/normalize"
	"mach/observer/internal/redact"
)

// People's names never reach the browser (contract D10). The structural rules replace every
// person-bearing field by its role; this file finds the names themselves, so the scrubber can
// also replace them where they reappear in free text (a finding, a note, a reason). It reads, by
// stat-change only and never through a command:
//
//   - the machine-local authorization's enabled_by (.factory/local/runner.json);
//   - the project's git identities: [user] in .git/config, and the name and e-mail of every entry
//     of .git/logs/HEAD and of each worktree's logs/HEAD (the cells' commits are made there);
//     nothing else of a reflog is kept;
//   - each cell's records that name people: review/round-N/decision.json (the approver and who
//     recorded the approval), the votes, build-report.json and cell.json.
//
// The intake log's "by" fields are learned by its normaliser as each line is read.

const maxIdentityFile = 4 << 20

type stamp struct{ size, mtime int64 }

type peopleScan struct {
	root  string
	list  *redact.People
	seen  map[string]stamp
	cells map[string]int64 // ticket -> lifecycle log size at the last scan
}

func newPeopleScan(root string) *peopleScan {
	return &peopleScan{root: root, list: redact.PeopleFor(root), seen: map[string]stamp{}, cells: map[string]int64{}}
}

// changed reports whether the file at rel is new or changed since it was last read.
func (p *peopleScan) changed(rel string) bool {
	info, err := os.Lstat(filepath.Join(p.root, filepath.FromSlash(rel)))
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxIdentityFile {
		return false
	}
	st := stamp{info.Size(), info.ModTime().UnixNano()}
	if p.seen[rel] == st {
		return false
	}
	p.seen[rel] = st
	return true
}

func (p *peopleScan) read(rel string) []byte {
	b, ok := (normalize.DirFiles{Dir: p.root}).Read(rel, maxIdentityFile)
	if !ok {
		return nil
	}
	return b
}

// project reads the project-wide sources: the authorization and git's identities.
func (p *peopleScan) project() {
	if rel := ".factory/local/runner.json"; p.changed(rel) {
		p.list.LearnJSON(p.read(rel))
	}
	if rel := ".git/config"; p.changed(rel) {
		p.list.Learn(gitConfigUser(p.read(rel))...)
	}
	logs := []string{".git/logs/HEAD"}
	if entries, err := os.ReadDir(filepath.Join(p.root, ".git", "worktrees")); err == nil {
		for i, e := range entries {
			if i >= 512 {
				break
			}
			if e.IsDir() && e.Type()&os.ModeSymlink == 0 {
				logs = append(logs, ".git/worktrees/"+e.Name()+"/logs/HEAD")
			}
		}
	}
	for _, rel := range logs {
		if p.changed(rel) {
			p.list.Learn(reflogIdentities(p.read(rel))...)
		}
	}
}

// cell reads a cell's person-bearing records when its lifecycle log has grown (a review, an
// approval or a build is recorded there first) or on first sight.
func (p *peopleScan) cell(ticket string, files normalize.Files, size int64) {
	if last, ok := p.cells[ticket]; ok && last == size {
		return
	}
	p.cells[ticket] = size
	for _, rel := range []string{"cell.json", "build-report.json"} {
		if b, ok := files.Read(rel, maxIdentityFile); ok {
			p.list.LearnJSON(b)
		}
	}
	// Rounds are numbered from 1 without holes (review.py); the first missing one ends the scan.
	for n := 1; n <= 99; n++ {
		dir := "review/round-" + itoa(int64(n))
		decision, okDecision := files.Read(dir+"/decision.json", maxIdentityFile)
		votes := files.List(dir + "/votes")
		if !okDecision && len(votes) == 0 && len(files.List(dir)) == 0 {
			break
		}
		if okDecision {
			p.list.LearnJSON(decision)
		}
		for _, v := range votes {
			if strings.HasSuffix(v, ".json") {
				if b, ok := files.Read(dir+"/votes/"+v, maxIdentityFile); ok {
					p.list.LearnJSON(b)
				}
			}
		}
	}
}

var reflogRe = regexp.MustCompile(`^[0-9a-f]{7,64} [0-9a-f]{7,64} ([^<\n]{1,80}) <([^>\n]{0,120})> [0-9]+ [+-][0-9]{4}`)

// reflogIdentities returns the "name" and "e-mail" of each reflog entry, nothing else.
func reflogIdentities(b []byte) []string {
	seen := map[string]bool{}
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		m := reflogRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		for _, v := range []string{strings.TrimSpace(m[1]), strings.TrimSpace(m[2])} {
			if v != "" && !seen[v] && len(out) < 256 {
				seen[v] = true
				out = append(out, v)
			}
		}
	}
	return out
}

// gitConfigUser returns name and email of the [user] section.
func gitConfigUser(b []byte) []string {
	var out []string
	section := ""
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			section = strings.ToLower(strings.Trim(line, "[] "))
			continue
		}
		if section != "user" {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "name", "email":
			out = append(out, strings.Trim(strings.TrimSpace(v), `"`))
		}
	}
	return out
}
