package act

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// The shapes a decision may take. The ticket pattern is decide.py's TICKET_ID_RE with a length cap;
// the ADR pattern is act.py's ADR_RE.
var (
	TicketPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$`)
	OptionPattern = regexp.MustCompile(`^[a-z][a-z-]{0,31}$`)
	ADRPattern    = regexp.MustCompile(`^ADR-[0-9]{4}$`)
)

// Options are the option keys `decide do` carries out by itself (design M23 3.1's table). Any other
// key is sent only when `decide --json` offers it for that ticket now with do: true ("wait").
var Options = map[string]bool{
	"approve": true, "send-back": true, "merge": true, "accept": true, "exception": true, "replan": true,
	"set-test-command": true, "retry": true, "run": true, "revise": true, "answers": true, "abandon": true,
	"take-over": true,
}

// LongOptions may run the project's tests or a merge: they are given the longer time limit.
var LongOptions = map[string]bool{"merge": true, "set-test-command": true, "abandon": true, "approve": true}

// Limits on what a person types. act.py's own limits are the same or wider.
const (
	MaxTicket    = 64
	MaxName      = 120
	MaxReason    = 4000
	MaxTestCmd   = 1000
	MaxAnswer    = 4000
	MaxADRs      = 20
	MaxQuestions = 30
	MaxBodyBytes = 256 << 10
)

// Answer is one answer to a spec's open question: an answer in the person's words, or left open.
type Answer struct {
	N         int     `json:"n"`
	Answer    *string `json:"answer,omitempty"`
	LeaveOpen bool    `json:"leave_open,omitempty"`
}

// Body is a decision's JSON body as the page sends it.
type Body struct {
	By      *string  `json:"by"`
	Reason  *string  `json:"reason"`
	ADRs    []string `json:"adrs"`
	TestCmd *string  `json:"test_cmd"`
	Answers []Answer `json:"answers"`
}

// Decision is one person's decision on one ticket, as the page asked for it.
type Decision struct {
	Ticket string
	Option string
	Body
}

// InvalidError is a request refused before run.py sees it.
type InvalidError struct{ Message string }

func (e *InvalidError) Error() string { return e.Message }

func invalid(format string, args ...any) error {
	return &InvalidError{Message: fmt.Sprintf(format, args...)}
}

// DecodeBody reads one JSON object, refusing unknown fields, trailing data and anything that is
// not an object. An empty body means no inputs.
func DecodeBody(body []byte) (Body, error) {
	var b Body
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		trimmed = []byte("{}")
	}
	if trimmed[0] != '{' {
		return b, invalid("The request body must be a JSON object.")
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		var typeErr *json.UnmarshalTypeError
		var syntaxErr *json.SyntaxError
		switch {
		case errors.As(err, &typeErr):
			return b, invalid("The field %q has the wrong type.", typeErr.Field)
		case errors.As(err, &syntaxErr), errors.Is(err, io.ErrUnexpectedEOF):
			return b, invalid("The request body is not valid JSON.")
		case strings.HasPrefix(err.Error(), "json: unknown field "):
			return b, invalid("Unknown field %s.", strings.TrimPrefix(err.Error(), "json: unknown field "))
		default:
			return b, invalid("The request body could not be read as a decision.")
		}
	}
	var rest json.RawMessage
	if err := dec.Decode(&rest); err != io.EOF {
		return b, invalid("The request body must hold exactly one JSON object.")
	}
	return b, nil
}

// checkText accepts readable text: valid UTF-8, no NUL or other control character (newline and tab
// only where lines allows them), not blank, and no longer than max characters.
func checkText(field, value string, max int, lines bool) error {
	if !utf8.ValidString(value) {
		return invalid("%s is not valid UTF-8 text.", field)
	}
	for _, r := range value {
		if r == 0x7f || r == 0x2028 || r == 0x2029 || (r < 0x20 && !(lines && (r == '\n' || r == '\t'))) || (r >= 0x80 && r < 0xa0) {
			return invalid("%s contains a control character.", field)
		}
	}
	if utf8.RuneCountInString(value) > max {
		return invalid("%s is longer than %d characters.", field, max)
	}
	if strings.TrimSpace(value) == "" {
		return invalid("%s is empty.", field)
	}
	return nil
}

// CheckTicket and CheckOption check a route's two path values.
func CheckTicket(ticket string) error {
	if ticket == "" || len(ticket) > MaxTicket || !TicketPattern.MatchString(ticket) {
		return invalid("That is not a ticket ID.")
	}
	return nil
}

func CheckOption(option string) error {
	if !OptionPattern.MatchString(option) {
		return invalid("That is not an option MACH offers.")
	}
	return nil
}

// Check refuses a decision whose shape run.py could never accept from the Floor. Whether the
// option is on offer for the ticket now, and which inputs it needs, run.py decides (act.py).
func (d Decision) Check(allowed func(ticket, option string) bool) error {
	if err := CheckTicket(d.Ticket); err != nil {
		return err
	}
	if err := CheckOption(d.Option); err != nil {
		return err
	}
	if !Options[d.Option] && (allowed == nil || !allowed(d.Ticket, d.Option)) {
		return invalid("%q is not something the Factory Floor can decide for %s now. Read the list again.", d.Option, d.Ticket)
	}
	if d.By != nil {
		if err := checkText("Your name", *d.By, MaxName, false); err != nil {
			return err
		}
	}
	if d.Reason != nil {
		if err := checkText("The reason", *d.Reason, MaxReason, true); err != nil {
			return err
		}
	}
	if d.TestCmd != nil {
		if err := checkText("The test command", *d.TestCmd, MaxTestCmd, false); err != nil {
			return err
		}
	}
	if len(d.ADRs) > MaxADRs {
		return invalid("At most %d architecture decisions at once.", MaxADRs)
	}
	for _, id := range d.ADRs {
		if !ADRPattern.MatchString(id) {
			return invalid("%q is not an ADR ID such as ADR-0007.", truncate(id, 40))
		}
	}
	if d.Answers != nil && d.Option != "answers" {
		return invalid("Only the answers to open questions take answers.")
	}
	if d.Option == "answers" {
		if len(d.Answers) == 0 || len(d.Answers) > MaxQuestions {
			return invalid("Give one answer for each open question, at most %d.", MaxQuestions)
		}
		seen := map[int]bool{}
		for _, a := range d.Answers {
			if a.N < 1 || a.N > MaxQuestions || seen[a.N] {
				return invalid("Each answer names its question by number, once.")
			}
			seen[a.N] = true
			switch {
			case a.LeaveOpen && a.Answer != nil:
				return invalid("Question %d is both answered and left open: keep one.", a.N)
			case !a.LeaveOpen && a.Answer == nil:
				return invalid("Question %d has no answer: answer it, or leave it open.", a.N)
			case a.Answer != nil:
				if err := checkText("The answer to question "+strconv.Itoa(a.N), *a.Answer, MaxAnswer, true); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// flag renders one option in --name=value form, so a value that starts with a dash can never be
// read as another option.
func flag(name, value string) string { return "--" + name + "=" + value }

// Argv is the vector after `--project=<root>` for this decision. answersFile is the private file
// holding the answers, for the "answers" option only.
func (d Decision) Argv(answersFile string) []string {
	argv := []string{"decide", "do", d.Ticket, d.Option}
	if d.By != nil {
		argv = append(argv, flag("by", *d.By))
	}
	if d.Reason != nil {
		argv = append(argv, flag("reason", *d.Reason))
	}
	for _, id := range d.ADRs {
		argv = append(argv, flag("adr", id))
	}
	if d.TestCmd != nil {
		argv = append(argv, flag("test-cmd", *d.TestCmd))
	}
	if answersFile != "" {
		argv = append(argv, flag("answers-file", answersFile))
	}
	return append(argv, "--via=floor", "--json")
}
