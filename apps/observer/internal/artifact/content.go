package artifact

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"mach/observer/internal/redact"
)

// ErrCredentialName refuses the content of a file whose name says it holds credentials
// (redact.CredentialPath: credentials.txt, id_rsa, secrets.json, ...) or is itself
// credential-shaped. Such a file is catalogued as metadata only (M6.5 S2).
var ErrCredentialName = errors.New("the file's name says it holds credentials; its content is never served")

const CredentialReason = "its name says it holds credentials; its content is never served"

// ErrDuplicate refuses an archive member whose name the archive holds more than once (M6.6 F7).
var ErrDuplicate = errors.New("the archive holds more than one file of this name")

// HashKeys are the keys under which MACH's served JSON records (results.json, summary.json,
// decision.json) hold a hash: evidence sha256 sums and the commits a verification or review was
// made against. Their hex values are exempt from the scrubber's long-hex rule; nothing else is.
var HashKeys = []string{"sha256", "head", "since_commit", "commit"}

// Content is what may be served of one artifact.
type Content struct {
	Data      []byte
	MediaType string // the observer's own sniffing
	Class     string // text | image | video
	Redacted  int    // replacements the text scrubber made
	Truncated bool   // text cut to ServedText
	Name      string // the file's base name
}

// CapFor is the read cap for a class.
func CapFor(class string) int64 {
	switch class {
	case ClassImage:
		return MaxImage
	case ClassVideo:
		return MaxVideo
	}
	return MaxText
}

// Read reads an entry's bytes again through every guard, and refuses unless they hash to exactly
// what the catalog recorded and sniff to the type the catalog promised. What is returned is what
// was hashed: there is no second read between the check and the reply.
func (c *Catalog) Read(e Entry) (*Content, error) {
	if redact.CredentialPath(e.Path) || redact.SecretName(e.Path) {
		return nil, ErrCredentialName // whatever the entry says: its name says it holds credentials
	}
	if e.duplicate {
		return nil, ErrDuplicate
	}
	class, ok := Allowed(e.Path, e.MediaType)
	if !ok || e.SHA256 == "" {
		return nil, ErrTypeMatch
	}
	limit := CapFor(class)
	if e.Bytes > limit {
		return nil, ErrTooLarge
	}
	root, err := os.OpenRoot(c.root)
	if err != nil {
		return nil, ErrNotHeld
	}
	defer root.Close()
	var data []byte
	switch e.Origin {
	case "cell":
		data, _, err = readFile(root, ".factory/worktrees/"+e.TicketID+"/"+e.Path, limit)
	case "archive":
		data, err = readMember(root, e, limit)
	default:
		return nil, ErrNotHeld
	}
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != e.SHA256 {
		return nil, ErrChanged
	}
	media := Sniff(data)
	if media != e.MediaType {
		return nil, ErrTypeMatch
	}
	out := &Content{MediaType: media, Class: class, Name: baseName(e.Path)}
	if class == ClassText {
		text, n := c.scrubText(e, data)
		if len(text) > ServedText {
			cut := ServedText
			for cut > 0 && !utf8.RuneStart(text[cut]) {
				cut-- // never inside a UTF-8 sequence
			}
			text, out.Truncated = text[:cut], true
		}
		out.Data, out.Redacted = []byte(text), n
		return out, nil
	}
	out.Data = data
	return out, nil
}

// scrubText scrubs a text artifact for serving. A MACH record of a known kind (decision.json,
// results.json, summary.json, ...) goes through the structured rules of its kind: people by
// role, unknown keys only when clean. Anything else goes through the text scrubber. Both keep the
// relative names of the artifacts the catalog holds for this ticket, and both replace every
// person the project's records name (redact.People).
func (c *Catalog) scrubText(e Entry, data []byte) (string, int) {
	safe := c.SafeNames(e.TicketID)
	if kind := redact.KindOf(e.Path); kind != redact.KindUnknown {
		if text, n, err := redact.ScrubRecord(data, kind, c.root, redact.RecordOptions{HashKeys: HashKeys, SafeNames: safe}); err == nil {
			return text, n
		}
	}
	opt := redact.DocOptions{SafeNames: safe}
	if strings.HasSuffix(e.Path, ".json") {
		opt.HashKeys = HashKeys // a JSON evidence file: its hashes are not mistaken for secrets
	}
	return redact.ScrubDocument(string(data), c.root, opt)
}

func baseName(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[i+1:]
		}
	}
	return p
}

func readMember(root *os.Root, e Entry, limit int64) ([]byte, error) {
	var data []byte
	found := false
	err := walkArchive(root, ".factory/archive/"+e.TicketID+".tar.gz", e.TicketID, func(name string, hdr *tar.Header, r io.Reader) error {
		if name != e.Path || hdr.Typeflag != tar.TypeReg {
			return nil
		}
		if hdr.Size > limit {
			return ErrTooLarge
		}
		b, err := io.ReadAll(io.LimitReader(r, limit+1))
		if err != nil {
			return err
		}
		if int64(len(b)) > limit {
			return ErrTooLarge
		}
		data, found = b, true
		return errStop
	})
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrNotHeld
	}
	return data, nil
}
