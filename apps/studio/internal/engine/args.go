package engine

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"
)

// The engine's own ID patterns (product.py), plus a length cap the engine does not need.
var (
	ProjectIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{1,63}$`)
	EpicIDPattern    = regexp.MustCompile(`^EPIC-[0-9]{3,}$`)
	SliceIDPattern   = regexp.MustCompile(`^SLICE-[0-9]{3,}$`)
	WaveIDPattern    = regexp.MustCompile(`^WAVE-[0-9]{3,}$`)
	// SpecNamePattern is product.SPEC_NAME_RE: the only file names a slice spec may have.
	SpecNamePattern = regexp.MustCompile(`^(SLICE-[0-9]{3,})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$`)

	artifactPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)
	fieldPattern    = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
)

// Limits on request shapes. Generous for a person typing; small enough to bound every call.
const (
	maxIDLength    = 32
	maxShortText   = 300   // names, titles, an approver's name
	maxLongText    = 4000  // a vision, an outcome, a criterion, a pause note
	maxListItems   = 50    // outcomes, criteria, dependencies, slices in a wave
	maxArtifactLen = 200   // a path or ID listed under needs_reconciling
	MaxBodyBytes   = 65536 // an operation's JSON body
)

// InvalidError is a request the host rejects before the engine sees it.
type InvalidError struct{ Message string }

func (e *InvalidError) Error() string { return e.Message }

func invalid(format string, args ...any) error {
	return &InvalidError{Message: fmt.Sprintf(format, args...)}
}

// Decode reads one JSON object into v, refusing unknown fields, trailing data and anything that
// is not an object. An empty body means no arguments.
func Decode(body []byte, v any) error {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		trimmed = []byte("{}")
	}
	if trimmed[0] != '{' {
		return invalid("The request body must be a JSON object.")
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var typeErr *json.UnmarshalTypeError
		var syntaxErr *json.SyntaxError
		switch {
		case errors.As(err, &typeErr):
			return invalid("The field %q has the wrong type.", typeErr.Field)
		case errors.As(err, &syntaxErr), errors.Is(err, io.ErrUnexpectedEOF):
			return invalid("The request body is not valid JSON.")
		case strings.HasPrefix(err.Error(), "json: unknown field "):
			return invalid("Unknown field %s.", strings.TrimPrefix(err.Error(), "json: unknown field "))
		default:
			return invalid("The request body could not be read as this operation's arguments.")
		}
	}
	if dec.More() {
		return invalid("The request body must hold exactly one JSON object.")
	}
	var rest json.RawMessage
	if err := dec.Decode(&rest); err != io.EOF {
		return invalid("The request body must hold exactly one JSON object.")
	}
	return nil
}

func checkID(field, value string, pattern *regexp.Regexp, example string) error {
	if value == "" {
		return invalid("%s is required.", field)
	}
	if len(value) > maxIDLength || !pattern.MatchString(value) {
		return invalid("%s must be an ID such as %s.", field, example)
	}
	return nil
}

func checkOptionalID(field string, value *string, pattern *regexp.Regexp, example string) error {
	if value == nil {
		return nil
	}
	return checkID(field, *value, pattern, example)
}

// checkText accepts readable text: valid UTF-8, no NUL or other control characters except tab
// and newline, not blank when required, and no longer than max characters.
func checkText(field, value string, max int, required bool) error {
	if !utf8.ValidString(value) {
		return invalid("%s is not valid UTF-8 text.", field)
	}
	for _, r := range value {
		if r == 0 || (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f {
			return invalid("%s contains a control character.", field)
		}
	}
	if utf8.RuneCountInString(value) > max {
		return invalid("%s is longer than %d characters.", field, max)
	}
	if required && strings.TrimSpace(value) == "" {
		return invalid("%s is required.", field)
	}
	return nil
}

func checkOptionalText(field string, value *string, max int) error {
	if value == nil {
		return nil
	}
	return checkText(field, *value, max, true)
}

func checkList(field string, values []string, max int) error {
	if len(values) > maxListItems {
		return invalid("%s has more than %d items.", field, maxListItems)
	}
	for i, v := range values {
		if err := checkText(fmt.Sprintf("%s[%d]", field, i), v, max, true); err != nil {
			return err
		}
	}
	return nil
}

func checkIDList(field string, values []string, pattern *regexp.Regexp, example string, min int) error {
	if len(values) < min {
		return invalid("%s needs at least %d item.", field, min)
	}
	if len(values) > maxListItems {
		return invalid("%s has more than %d items.", field, maxListItems)
	}
	for i, v := range values {
		if err := checkID(fmt.Sprintf("%s[%d]", field, i), v, pattern, example); err != nil {
			return err
		}
	}
	return nil
}

// flag renders one option in --name=value form, so a value that starts with a dash can never be
// read as another option.
func flag(name, value string) string { return "--" + name + "=" + value }

func repeated(name string, values []string) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		out = append(out, flag(name, v))
	}
	return out
}

func optional(name string, value *string) []string {
	if value == nil {
		return nil
	}
	return []string{flag(name, *value)}
}
