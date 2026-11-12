package artifact

import (
	"bytes"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

// cleanRel accepts a plain slash-separated relative path: no empty, "." or ".." component, no NUL,
// no backslash, no leading slash.
func cleanRel(rel string) bool {
	if rel == "" || len(rel) > 512 || strings.HasPrefix(rel, "/") || strings.ContainsAny(rel, "\x00\\") || path.Clean(rel) != rel {
		return false
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// plainRel is cleanRel for a name taken from a record or an archive (never a fixed path): every
// component must also be a plain name.
func plainRel(rel string) bool {
	if !cleanRel(rel) {
		return false
	}
	for _, part := range strings.Split(rel, "/") {
		if !partRe.MatchString(part) {
			return false
		}
	}
	return true
}

// partRe is one path component: plain names only (no %, no control characters, no leading dot).
var partRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._ +-]{0,199}$`)

// Classes of content the observer will serve.
const (
	ClassText  = "text"
	ClassImage = "image"
	ClassVideo = "video"
	ClassNone  = "none"
)

var extClass = map[string]string{
	".png": ClassImage, ".jpg": ClassImage, ".jpeg": ClassImage, ".gif": ClassImage, ".webp": ClassImage,
	".webm": ClassVideo, ".mp4": ClassVideo,
	".txt": ClassText, ".md": ClassText, ".json": ClassText, ".log": ClassText, ".out": ClassText, ".cast": ClassText,
	".csv": ClassText, ".yaml": ClassText, ".yml": ClassText, ".diff": ClassText, ".patch": ClassText, "": ClassText,
}

// Sniff decides a file's media type from its first bytes, never from its name. Only the types the
// observer serves are recognised; anything else (including SVG and HTML, which can script, and
// any binary) is application/octet-stream and refused.
func Sniff(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(b, []byte{0xff, 0xd8, 0xff}):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("GIF87a")) || bytes.HasPrefix(b, []byte("GIF89a")):
		return "image/gif"
	case len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return "image/webp"
	case bytes.HasPrefix(b, []byte{0x1a, 0x45, 0xdf, 0xa3}):
		return "video/webm"
	case len(b) >= 12 && bytes.Equal(b[4:8], []byte("ftyp")):
		return "video/mp4"
	}
	head := b[:min(len(b), 8192)]
	if bytes.IndexByte(head, 0) >= 0 {
		return "application/octet-stream"
	}
	if !utf8.Valid(trimPartialRune(head)) {
		return "application/octet-stream"
	}
	if markup(head) {
		return "text/html" // refused: markup is never served as anything a browser renders
	}
	return "text/plain"
}

// markup recognises HTML and SVG documents by their opening, the way a browser's sniffer would.
func markup(head []byte) bool {
	s := strings.ToLower(strings.TrimLeft(string(head[:min(len(head), 512)]), " \t\r\n\ufeff"))
	for _, p := range []string{"<!doctype html", "<html", "<svg", "<script", "<?xml", "<iframe", "<body", "<head"} {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

func trimPartialRune(b []byte) []byte {
	for i := 0; i < 3 && len(b) > 0; i++ {
		if utf8.Valid(b) {
			return b
		}
		b = b[:len(b)-1]
	}
	return b
}

// ClassOf is the class of a sniffed media type.
func ClassOf(media string) string {
	switch {
	case media == "text/plain":
		return ClassText
	case strings.HasPrefix(media, "image/"):
		return ClassImage
	case strings.HasPrefix(media, "video/"):
		return ClassVideo
	}
	return ClassNone
}

// Allowed reports whether a file named name with the sniffed media type may be served at all:
// the class its extension promises must be the class its contents show.
func Allowed(name, media string) (string, bool) {
	ext := strings.ToLower(path.Ext(name))
	want, ok := extClass[ext]
	got := ClassOf(media)
	if !ok || got == ClassNone || want != got {
		return got, false
	}
	return got, true
}
