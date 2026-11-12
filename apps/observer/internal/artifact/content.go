package artifact

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
)

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
		text, n := ScrubText(string(data), c.root)
		if len(text) > ServedText {
			text, out.Truncated = text[:ServedText], true
		}
		out.Data, out.Redacted = []byte(text), n
		return out, nil
	}
	out.Data = data
	return out, nil
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
