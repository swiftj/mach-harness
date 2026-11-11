package interview

import (
	"regexp"
	"strconv"
	"strings"
)

// questionPattern is M5_INTERVIEW_POC.md section 8.3, unchanged.
var questionPattern = regexp.MustCompile(
	`(?s)^(?P<preface>.*?)❓\s*\*\*Q(?P<number>\d+)\*\*\s*[-–—]\s*\*\*(?P<title>[^*\n]+?)\*\*\s*:?\s*(?P<body>.*?)` +
		`\n\s*➡️\s*(?P<recommendation>.+?)\s*$`)

// Question is a final message that parsed as exactly one interview question.
type Question struct {
	MessageID      string  `json:"message_id"`
	Number         int     `json:"number"`
	Title          string  `json:"title"`
	Body           string  `json:"body"`
	Recommendation string  `json:"recommendation"`
	Preface        *string `json:"preface"`
}

// ParseQuestion: a complete message is a question when it holds exactly one ❓ block followed by
// one ➡️ line. Only ever called on a final message, never on streamed text.
func ParseQuestion(text string) *Question {
	if strings.Count(text, "❓") != 1 || strings.Count(text, "➡️") != 1 {
		return nil
	}
	m := questionPattern.FindStringSubmatch(strings.TrimSpace(text))
	if m == nil {
		return nil
	}
	group := func(name string) string { return m[questionPattern.SubexpIndex(name)] }
	number, err := strconv.Atoi(group("number"))
	if err != nil {
		return nil
	}
	q := &Question{
		Number:         number,
		Title:          strings.TrimSpace(group("title")),
		Body:           strings.TrimSpace(group("body")),
		Recommendation: strings.TrimSpace(group("recommendation")),
	}
	if preface := strings.TrimSpace(group("preface")); preface != "" {
		q.Preface = &preface
	}
	return q
}

// ClassifyMessage gives a final message's kind: question, confirmation or other.
func ClassifyMessage(text string) string {
	if ParseQuestion(text) != nil {
		return "question"
	}
	if strings.Contains(text, "Does this capture the intent") {
		return "confirmation"
	}
	return "other"
}
