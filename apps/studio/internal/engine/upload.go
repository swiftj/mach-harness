package engine

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// Upload is a file the person chose in the browser, sent inside the operation's JSON body as
// base64, so every upload passes the same Host, session, Origin, CSRF and Content-Type checks as
// any other request and the host never parses a multipart body. The host checks only its name and
// size; it never reads, parses or interprets the content. The engine checks the content.
type Upload struct {
	Name          string `json:"name"`
	ContentBase64 string `json:"content_base64"`
}

// uploadRule bounds one kind of file.
type uploadRule struct {
	maxBytes   int
	extensions []string // lower case, with the dot
	what       string   // "a Markdown or plain-text document", in a refusal
}

var (
	// prd.py MAX_BYTES and FORMATS.
	prdDocument = uploadRule{maxBytes: 512 << 10, extensions: []string{".md", ".markdown", ".txt", ".text"}, what: "a Markdown (.md) or plain-text (.txt) document"}
	// issue_rules.MOCK_MAX_BYTES; the engine decides the format by content.
	mockPicture = uploadRule{maxBytes: 5 << 20, extensions: []string{".png", ".jpg", ".jpeg"}, what: "a PNG or JPEG picture"}
	// jira_export.KEYS_MAX_BYTES.
	jiraKeysFile = uploadRule{maxBytes: 8 << 20, extensions: []string{".csv"}, what: "a CSV file exported from Jira"}
)

// maxJSONInput is prd.py's MAX_INPUT_BYTES: the most a map or a set of drafted answers may be.
const maxJSONInput = 1 << 20

// bodyFor gives the largest JSON body an operation with this rule can need: the base64 text and
// the other fields.
func bodyFor(maxBytes int) int64 { return int64(base64.StdEncoding.EncodedLen(maxBytes)) + 64<<10 }

var unsafeNameRune = regexp.MustCompile(`[^A-Za-z0-9._ -]+`)

// stagedName turns the name the browser reported into a plain file name with the same extension:
// the base name only, characters outside letters, digits, dot, space, underscore and hyphen
// replaced by a hyphen, no leading dot or hyphen, at most 100 characters. The engine records a
// PRD's name, so a plain name is kept as it was given.
func stagedName(given string, rule uploadRule) (string, error) {
	name := given
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	ext := strings.ToLower(path.Ext(name))
	allowed := false
	for _, e := range rule.extensions {
		if ext == e {
			allowed = true
		}
	}
	if !allowed {
		return "", invalid("The file must be %s (%s).", rule.what, strings.Join(rule.extensions, ", "))
	}
	stem := strings.TrimSuffix(name, path.Ext(name))
	stem = unsafeNameRune.ReplaceAllString(stem, "-")
	stem = strings.TrimLeft(stem, ".-_ ")
	stem = strings.TrimRight(stem, ". ")
	for strings.Contains(stem, "..") {
		stem = strings.ReplaceAll(stem, "..", ".")
	}
	if len(stem) > 90 {
		stem = strings.TrimRight(stem[:90], ". ")
	}
	if stem == "" {
		stem = "upload"
	}
	return stem + ext, nil
}

// decodeUpload checks a file's name and size and returns the staged name and the bytes.
func decodeUpload(field string, u *Upload, rule uploadRule) (string, []byte, error) {
	if u == nil {
		return "", nil, invalid("%s is required: {name, content_base64}.", field)
	}
	if err := checkText(field+".name", u.Name, 255, true); err != nil {
		return "", nil, err
	}
	name, err := stagedName(u.Name, rule)
	if err != nil {
		return "", nil, err
	}
	if base64.StdEncoding.DecodedLen(len(u.ContentBase64)) > rule.maxBytes+3 {
		return "", nil, invalid("The file is larger than %s.", sizeWords(rule.maxBytes))
	}
	data, err := base64.StdEncoding.DecodeString(u.ContentBase64)
	if err != nil {
		return "", nil, invalid("%s.content_base64 is not base64.", field)
	}
	if len(data) == 0 {
		return "", nil, invalid("The file is empty.")
	}
	if len(data) > rule.maxBytes {
		return "", nil, invalid("The file is larger than %s.", sizeWords(rule.maxBytes))
	}
	return name, data, nil
}

// decodeJSONInput checks a JSON value that the engine reads from a file (`--from`): an object or
// a list, no larger than the engine reads. It is written out as it came, compacted.
func decodeJSONInput(field string, raw json.RawMessage) ([]byte, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, invalid("%s is required.", field)
	}
	if trimmed[0] != '{' && trimmed[0] != '[' {
		return nil, invalid("%s must be a JSON object or list.", field)
	}
	var out bytes.Buffer
	if err := json.Compact(&out, trimmed); err != nil {
		return nil, invalid("%s is not valid JSON.", field)
	}
	if out.Len() > maxJSONInput {
		return nil, invalid("%s is larger than 1 MiB.", field)
	}
	return out.Bytes(), nil
}

func sizeWords(n int) string {
	switch {
	case n >= 1<<20 && n%(1<<20) == 0:
		return strconv.Itoa(n>>20) + " MiB"
	case n >= 1<<10 && n%(1<<10) == 0:
		return strconv.Itoa(n>>10) + " KiB"
	}
	return strconv.Itoa(n) + " bytes"
}

// FileArgs is an operation whose engine command reads one file: a document, a picture, a CSV or
// JSON the engine reads with `--from`. The host stages the file inside the Studio workspace for
// the length of the call (security.StageUpload) and removes it afterwards; Argv then names the
// staged copy. No path ever comes from the request.
type FileArgs interface {
	Args
	// Staged returns the file to stage, after the arguments were checked: a plain name and the bytes.
	Staged() (name string, data []byte, err error)
	// SetPath gives the staged copy's absolute path, which Argv uses.
	SetPath(path string)
}

// stagedPath is embedded by every FileArgs to hold the staged path; Argv refuses without one.
type stagedPath struct{ path string }

func (s *stagedPath) SetPath(path string) { s.path = path }

func (s *stagedPath) staged() (string, error) {
	if s.path == "" {
		return "", invalid("The file has not been staged.")
	}
	return s.path, nil
}
