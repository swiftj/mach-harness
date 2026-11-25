package engine

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"mach/studio/internal/security"
)

// M21 F: moving the whole project to another repository from the app. Four commands of the engine
// (project export, project import, project import --abandon, project imports), each one operation
// with a fixed argument vector, as every other. The engine decides everything; the host only
// checks the shape of a request, keeps the chosen project file between "look first" and "bring
// it in", and offers the exported file for download (server/downloads.go).
//
// Every place the host reads these commands' answers is in this file (ExportedFile, importDone,
// setAsideKey, withKept), so a change to their fields is reconciled here.

// projectArchive bounds a project file brought in through the browser. The archive format allows
// up to 256 MiB (project_archive.py); the browser path takes a quarter of that, because the file
// travels as base64 inside one JSON body held in the host's memory. A larger file is brought in
// with /mach-studio in Claude Code, which reads it from disk.
var projectArchive = uploadRule{maxBytes: 64 << 20, extensions: []string{".zip"}, what: "a project file made by MACH"}

// MaxProjectFileBytes is the largest project file the app takes in or downloads.
const MaxProjectFileBytes = 64 << 20

// tooLargeForApp is said when a project file is larger than the app takes. It names the one place
// a larger file can be brought in, since the app cannot.
const tooLargeForApp = "The file is larger than 64 MB, the most Product Studio takes in the browser. " +
	"Bring it in with /mach-studio in Claude Code instead, which reads it from this computer."

// moveTimeout is the time limit of exporting and bringing in a project: the export may read many
// issues from GitHub, and the import reads GitHub's numbers and writes every file of the project.
const moveTimeout = 15 * time.Minute

// MoveIDPattern is an ID of a project brought in: the kinds project_ids.PREFIXES numbers.
var MoveIDPattern = regexp.MustCompile(`^(SLICE|EPIC|IDEA|PP|TN|PRD|DES)-[0-9]{2,}$`)

// ProjectExportArgs: the whole project into one file. The host never passes --out: the engine
// writes into its own folder inside the Studio workspace, and the host serves that file.
type ProjectExportArgs struct {
	// OnlyMine leaves out this project's slices that are on GitHub but not in this workspace.
	OnlyMine bool `json:"only_mine"`
}

func (a *ProjectExportArgs) Argv() ([]string, error) {
	argv := []string{"project", "export"}
	if a.OnlyMine {
		argv = append(argv, "--only-mine")
	}
	return argv, nil
}

// ProjectImportArgs: bring a project file in, always looked at first (`plan`). The file comes either
// with this request (`file`) or is the one this host already keeps from an earlier request
// (`kept`, its SHA-256 as the earlier answer gave it). `ready` asks the engine also to mark ready
// the slices that were ready in the old repository; it is never combined with `plan`.
type ProjectImportArgs struct {
	File  *Upload `json:"file"`
	Kept  string  `json:"kept"`
	Plan  bool    `json:"plan"`
	Ready bool    `json:"ready"`
	path  string
}

// check validates the request and, for a file sent with it, returns its plain name and bytes.
func (a *ProjectImportArgs) check() (string, []byte, error) {
	switch {
	case a.File != nil && a.Kept != "":
		return "", nil, invalid("Give exactly one of file or kept.")
	case a.File == nil && a.Kept == "":
		return "", nil, invalid("Choose the project file to bring in.")
	case a.Plan && a.Ready:
		return "", nil, invalid("ready marks slices ready when the project is brought in; looking first (plan) changes nothing.")
	case a.Kept != "":
		if !security.ValidIncomingKey(a.Kept) {
			return "", nil, invalid("kept must be the SHA-256 of a file this host keeps.")
		}
		return "", nil, nil
	}
	if base64.StdEncoding.DecodedLen(len(a.File.ContentBase64)) > projectArchive.maxBytes+3 {
		return "", nil, invalid(tooLargeForApp)
	}
	name, data, err := decodeUpload("file", a.File, projectArchive)
	var bad *InvalidError
	if errors.As(err, &bad) && len(data) > projectArchive.maxBytes {
		return "", nil, invalid(tooLargeForApp)
	}
	return name, data, err
}

func (a *ProjectImportArgs) Argv() ([]string, error) {
	if a.path == "" {
		return nil, invalid("The file has not been staged.")
	}
	argv := []string{"project", "import", a.path}
	if a.Plan {
		argv = append(argv, "--plan")
	}
	if a.Ready {
		argv = append(argv, "--ready")
	}
	return argv, nil
}

// ProjectAbandonArgs: set aside the import that stopped part way. `archive` names which one (the
// record or the file's name) only when the engine said more than one is waiting.
type ProjectAbandonArgs struct {
	Archive *string `json:"archive"`
}

func (a *ProjectAbandonArgs) Argv() ([]string, error) {
	argv := []string{"project", "import", "--abandon"}
	if a.Archive == nil {
		return argv, nil
	}
	if err := checkOneLine("archive", *a.Archive, 255, true); err != nil {
		return nil, err
	}
	if (*a.Archive)[0] == '-' {
		return nil, invalid("archive must be the name of the file or its record.")
	}
	return append(argv, *a.Archive), nil
}

// ProjectImportsArgs: the projects brought in here, or what one of their IDs is called here.
type ProjectImportsArgs struct {
	Identifier *string `json:"identifier"`
}

func (a *ProjectImportsArgs) Argv() ([]string, error) {
	if a.Identifier == nil {
		return []string{"project", "imports"}, nil
	}
	if len(*a.Identifier) > maxIDLength || !MoveIDPattern.MatchString(*a.Identifier) {
		return nil, invalid("identifier must be an ID such as SLICE-007, EPIC-002, PP-03, TN-01, IDEA-004, PRD-01 or DES-01.")
	}
	return []string{"project", "imports", *a.Identifier}, nil
}

// ---- running them ----

// notKept is the refusal when the file an earlier answer named is no longer here. Its hint tells
// the app to ask for the same file again.
func notKept() Envelope {
	env := Fail(KindInvalid, "Product Studio no longer has that file. Choose the same file again.")
	env.Error.Hint = json.RawMessage(`{"kind":"choose_file_again","target":null}`)
	return env
}

// doImport keeps the chosen file, runs the one command under the project lock, and then keeps or
// removes the file as the answer says: kept after a plan (and every other file forgotten), and
// after an import that did not finish; removed once the project is brought in.
func (e *Engine) doImport(ctx context.Context, name string, args *ProjectImportArgs) Envelope {
	fileName, data, err := args.check()
	if err != nil {
		var bad *InvalidError
		if errors.As(err, &bad) {
			return Fail(KindInvalid, bad.Message)
		}
		return Fail(KindInternal, "The file could not be prepared.")
	}
	return e.Transaction(ctx, func(tx *Tx) Envelope {
		root := e.cfg.Project
		var kept struct {
			key, name string
			size      int64
			fresh     bool
		}
		if data != nil {
			path, key, err := security.KeepIncoming(root, fileName, data)
			if err != nil {
				if errors.Is(err, security.ErrUnsafePath) {
					return Fail(KindInvalid, "Product Studio's folder has a symbolic link or an unexpected entry where the file goes, so nothing was done.")
				}
				return Fail(KindInternal, "The file could not be kept for the product engine.")
			}
			args.path, kept.key, kept.name, kept.size, kept.fresh = path, key, fileName, int64(len(data)), true
		} else {
			path, keptName, size, err := security.FindIncoming(root, args.Kept, MaxProjectFileBytes)
			if errors.Is(err, security.ErrNotKept) {
				return notKept()
			}
			if err != nil {
				return Fail(KindInvalid, "Product Studio's folder has a symbolic link or an unexpected entry where the file goes, so nothing was done.")
			}
			args.path, kept.key, kept.name, kept.size = path, args.Kept, keptName, size
		}
		env := tx.Call(ctx, name, args)
		switch {
		case env.OK && args.Plan:
			security.ForgetIncomingExcept(root, kept.key) // one file waits to be brought in at a time
			env.Data = withKept(env.Data, kept.key, kept.name, kept.size)
		case env.OK && importDone(env.Data):
			security.ForgetIncoming(root, kept.key)
		case env.OK:
			env.Data = withKept(env.Data, kept.key, kept.name, kept.size)
		case args.Plan && kept.fresh:
			// The engine would not look at it: nothing waits on this file.
			security.ForgetIncoming(root, kept.key)
		}
		return env
	})
}

// doAbandon sets the unfinished import aside, then forgets the file it was bringing in.
func (e *Engine) doAbandon(ctx context.Context, name string, args *ProjectAbandonArgs) Envelope {
	env := e.Transaction(ctx, func(tx *Tx) Envelope { return tx.Call(ctx, name, args) })
	if env.OK {
		if key := setAsideKey(env.Data); key != "" {
			security.ForgetIncoming(e.cfg.Project, key)
		}
	}
	return env
}

// ---- reading the answers (the only place the host does) ----

// ExportedFile is where `project export` wrote the file: its `file`.
func ExportedFile(data json.RawMessage) (string, error) {
	var view struct {
		File string `json:"file"`
	}
	if err := json.Unmarshal(data, &view); err != nil || view.File == "" {
		return "", errors.New("the export's answer could not be read")
	}
	return view.File, nil
}

// importDone: the answer of `project import` without --plan says the project is in: `imported`,
// or `already` (brought in before).
func importDone(data json.RawMessage) bool {
	var view struct {
		Imported bool `json:"imported"`
		Already  bool `json:"already"`
	}
	return json.Unmarshal(data, &view) == nil && (view.Imported || view.Already)
}

// setAsideKey is the SHA-256 of the file an import set aside was bringing in: `archive.sha256`.
func setAsideKey(data json.RawMessage) string {
	var view struct {
		Archive struct {
			SHA256 string `json:"sha256"`
		} `json:"archive"`
	}
	if json.Unmarshal(data, &view) != nil || !security.ValidIncomingKey(view.Archive.SHA256) {
		return ""
	}
	return view.Archive.SHA256
}

// withKept adds the host's `kept: {sha256, name, bytes}` to the engine's answer: how the app names
// the same file in the next request.
func withKept(data json.RawMessage, key, name string, size int64) json.RawMessage {
	var answer map[string]json.RawMessage
	if json.Unmarshal(data, &answer) != nil {
		return data
	}
	encoded, err := json.Marshal(map[string]any{"sha256": key, "name": name, "bytes": size})
	if err != nil {
		return data
	}
	answer["kept"] = encoded
	out, err := json.Marshal(answer)
	if err != nil {
		return data
	}
	return out
}

func init() {
	register(Operation{Name: "project.export", New: func() Args { return &ProjectExportArgs{} }, Network: true, Download: true, Timeout: moveTimeout})
	register(Operation{Name: "project.import", New: func() Args { return &ProjectImportArgs{} }, Network: true, Timeout: moveTimeout,
		MaxBody: bodyFor(projectArchive.maxBytes), TooLarge: tooLargeForApp})
	register(Operation{Name: "project.import.abandon", New: func() Args { return &ProjectAbandonArgs{} }})
	register(Operation{Name: "project.imports", New: func() Args { return &ProjectImportsArgs{} }, ReadOnly: true})
}
