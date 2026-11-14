package insight

// Every word an insight shows is here, so the wording can be reviewed in one place. A template is
// fixed text with {name} placeholders that the rules fill with numbers, identifiers and labels from
// this file only; no text from the Factory's records is ever placed in one.
//
// Wording rules (enforced by TestTemplatesWording): an insight states what was recorded and how it
// compares with a stated threshold; it never claims a cause, never treats two figures seen together
// as one depending on the other, never claims a trend on two windows, and never suggests changing,
// removing or loosening verification, security review or a person's approval.

// InvestigationLabel heads every possible investigation.
const InvestigationLabel = "Possible investigation (a suggestion to look further, not a conclusion)"

// Notice is stated on every reply.
const Notice = "Improvement Opportunities are deterministic rules over recorded figures. They are advisory and read-only: " +
	"they describe what was recorded and where to look, they do not establish why it happened, and none of them is a reason " +
	"to change verification, security review or a person's approval."

// gatesStay closes every investigation that touches throughput.
const gatesStay = " Verification, security review and a person's approval stay as they are whatever this shows."

// Text is one rule's wording.
type Text struct {
	Title         string
	Condition     string
	Why           string
	Investigation string
}

// Templates are every rule's wording, by rule id.
var Templates = map[string]Text{
	RuleStationShare: {
		Title:     "{station} holds {share} of the measured station time",
		Condition: "{station} holds {share} of the measured station time in this selection ({station_time} of {total_time}), over {visits} visits, {measured} of them measured; a visit the records show was not continuous (its execution ended before its exit) is bounded, not measured, and is in neither figure. The rule's threshold is {threshold}.",
		Why: "Time at one station is spent again for every visit to it, so a station with a large share of the measured time " +
			"is where the selection's measured time sits. Visits whose length was not measured are counted apart and are not in the share.",
		Investigation: "Open the longest {station} visits and compare them with the station's median ({median}) and 90th percentile ({p90}); " +
			"check whether a few tickets or many hold the time." + gatesStay,
	},
	RuleWaitP90: {
		Title:     "{wait} waits have a 90th percentile of {p90}",
		Condition: "The 90th percentile of measured {wait} waits is {p90} (median {median}), over {measured} measured of {waits} recorded waits. The rule's threshold is {threshold}.",
		Why: "A long upper tail means some tickets or slices spent much longer waiting than the typical one. " +
			"A wait is recorded time in which no station was working on the item.",
		Investigation: "Open the longest {wait} waits and read when each began and ended, and what the item waited on." + gatesStay,
	},
	RuleWaitShare: {
		Title:     "Measured {wait} waits add up to {share} of the measured dispatch-to-merge time",
		Condition: "Measured {wait} waits total {wait_time} over {measured} waits; the measured dispatch-to-merge time (C3) of the same selection totals {c3_time} over {c3_count} merged tickets. That is {share}; the rule's threshold is {threshold}.",
		Why: "Both totals are recorded in the same selection, but they are not the same set of tickets: some waits belong to tickets " +
			"not merged in it. The ratio places the waits beside the delivery time; it does not measure how much shorter delivery would have been.",
		Investigation: "Open the {wait} waits by length and see which tickets they belong to and which station each ticket entered next." + gatesStay,
	},
	RuleRemediationShare: {
		Title:     "Visits after the first judging round hold {share} of the measured station time",
		Condition: "Station visits in round 2 or later total {later_time} of {total_time} measured station time ({share}), over {later_visits} of {visits} measured visits with a recorded round. The rule's threshold is {threshold}.",
		Why: "A round after the first is a revision after a failed verification or a rejected review, so this share is the measured time " +
			"the selection spent on revisions. Visits with no recorded round are counted apart.",
		Investigation: "Open the round-2 visits by length and read the verification failures and review decisions that came before them." + gatesStay,
	},
	RuleFirstPass: {
		Title:     "First-pass rate {value}, below the observe station's target",
		Condition: "{num} of {den} merged tickets passed on the first round (Q2 = {value}); the observe station's target is above {target}. Population: {population}.",
		Why: "The observe station tracks this target for every finished ticket; a ticket that does not pass first goes through build, " +
			"verification and review again.",
		Investigation: "Read the verification failures and review rejections of the tickets that needed more than one round, grouped by kind. " +
			"Any change to the Factory's rules goes through the observe station's factory-tuning ticket and its review.",
	},
	RuleRounds: {
		Title:     "Average judging rounds {value}, above the observe station's target",
		Condition: "Merged tickets took {num} judging rounds over {den} tickets (Q3 = {value}); the observe station's target is below {target}. Population: {population}.",
		Why:       "The observe station tracks this target; each round past the first repeats build, verification and review for the same slice.",
		Investigation: "Open the review rounds that were rejected and the verifications that failed, and look for kinds that repeat. " +
			"Any change to the Factory's rules goes through the observe station's factory-tuning ticket and its review.",
	},
	RuleEscalation: {
		Title:     "Escalation rate {value}, above the observe station's target",
		Condition: "{num} of {den} finished tickets were escalated to a person (R5 = {value}); the observe station's target is below {target}. Population: {population}.",
		Why: "An escalated ticket reached the three-round limit or a question only a person can answer. " +
			"Escalation is the line working as designed; the rate says how often it was needed.",
		Investigation: "Open the escalated tickets and read the last round's findings for each." + gatesStay,
	},
	RuleTrendRejections: {
		Title:         "Review rejection rate higher in the later window",
		Condition:     "Review rounds rejected or escalated: {later} of decided rounds in the later window ({later_num} of {later_den}), {earlier} in the earlier window ({earlier_num} of {earlier_den}). The rule's threshold is {threshold}.",
		Why:           "Two windows are two observations, not a trend. The difference is recorded; whether it continues is not known from them.",
		Investigation: "Open the rejected rounds of the later window and compare their findings with the earlier window's." + gatesStay,
	},
	RuleTrendVerification: {
		Title:         "Failed verification rate higher in the later window",
		Condition:     "Verification verdicts that did not pass: {later} in the later window ({later_num} of {later_den}), {earlier} in the earlier window ({earlier_num} of {earlier_den}). The rule's threshold is {threshold}.",
		Why:           "Two windows are two observations, not a trend. The difference is recorded; whether it continues is not known from them.",
		Investigation: "Open the failed verifications of the later window and read which checks failed, by kind." + gatesStay,
	},
	RuleRecurringFailure: {
		Title:     "Failed {kind} checks recur across {tickets} tickets",
		Condition: "Failed verification checks of kind {kind} were recorded on {tickets} tickets ({count} checks), {share} of the {analyzed} tickets that visited verification. The rule (the observe station's pattern rule) needs at least {min_tickets} tickets and {min_share}.",
		Why:       "The observe station treats a problem seen on several tickets as a pattern worth a rule proposal; this is the same test over the recorded check kinds.",
		Investigation: "Read the failed {kind} checks ticket by ticket and look for what they share. " +
			"Any change to the Factory's rules goes through the observe station's factory-tuning ticket and its review.",
	},
	RuleRecurringGate: {
		Title:         "Refusals of the {gate} gate recur across {tickets} tickets",
		Condition:     "The {gate} gate refused on {tickets} tickets ({count} refusals), {share} of the {analyzed} tickets with a lifecycle log. The rule (the observe station's pattern rule) needs at least {min_tickets} tickets and {min_share}.",
		Why:           "A gate that refuses on several tickets is a recurring condition the line met; the refusal itself is the gate doing its work.",
		Investigation: "Open the refusals of the {gate} gate and read their reason codes ticket by ticket." + gatesStay,
	},
	RuleRecurringBlocker: {
		Title:         "Review blockers citing {rule} recur across {tickets} tickets",
		Condition:     "Review blocker findings citing rule {rule} were recorded on {tickets} tickets ({count} findings), {share} of the {analyzed} tickets that visited review. The rule (the observe station's pattern rule) needs at least {min_tickets} tickets and {min_share}.",
		Why:           "The observe station treats blockers that cite one rule on several tickets as a pattern worth a rule proposal; this is the same test over the recorded rule codes.",
		Investigation: "Read the blocker findings that cite {rule}, ticket by ticket. Any change to the Factory's rules goes through the observe station's factory-tuning ticket and its review.",
	},
	RuleCapacityHeld: {
		Title:     "Work was recorded waiting for a free place on {days} days",
		Condition: "The scheduler recorded work held for a free place (the Factory's recorded limit of {limit} executions at once) in {days} day buckets of this selection: {waits} waits of {items} tickets or slices. The rule's threshold is {threshold}.",
		Why: "Each of these waits is the scheduler's own record that every place was in use while the item was ready. " +
			"It is not read from how busy the Factory looked.",
		Investigation: "Open the waits and the concurrency over the same days, and see which executions held the places." + gatesStay,
	},
	RuleExecShare: {
		Title:     "{measure}: {value} of executions",
		Condition: "{measure}: {num} over {den} {population} ({value}). The rule's threshold is {threshold}.",
		Why: "Each of these executions needed a recovery, ended without moving the ticket, or ended in a way the supervisor could not tell; " +
			"the recorded outcome of the work is in the cell's own records.",
		Investigation: "Open these executions and read how each ended and what the next execution of the same ticket did." + gatesStay,
	},
	RuleExecLater: {
		Title:         "{measure} higher in the later window",
		Condition:     "{measure}: {later} in the later window ({later_num} over {later_den}), {earlier} in the earlier window ({earlier_num} over {earlier_den}). The rule's threshold is {threshold}.",
		Why:           "Two windows are two observations, not a trend. The difference is recorded; whether it continues is not known from them.",
		Investigation: "Open the later window's executions of this kind and compare how they ended with the earlier window's." + gatesStay,
	},
	RuleCostLater: {
		Title:     "Recorded cost higher in the later window, with no more integrated slices",
		Condition: "Recorded cost: {later_cost} over {later_den} executions in the later window, {earlier_cost} over {earlier_den} in the earlier window ({ratio} of it). Integrated slices recorded: {later_t2} later, {earlier_t2} earlier. Recorded cost covers {later_cov} and {earlier_cov} of the executions expected to record one (failed executions record none and are not counted). The rule's threshold is {threshold}.",
		Why: "Recorded cost only, as Claude reported it and MACH recorded it; nothing is estimated. The two figures are seen together; " +
			"that does not show that one depends on the other, and integrated slices differ in size.",
		Investigation: "Open the later window's executions by recorded cost and see which tickets and stages they ran.",
	},
	RuleUsageMissing: {
		Title:     "{missing} of {population} have no {record}",
		Condition: "{without} of {eligible} {population} in this selection carry no {record} ({missing}). The rule's threshold is {threshold}.",
		Why: "Figures read from this record leave these executions out, so every total read from it in this selection is a lower bound. " +
			"This is a data-quality note.",
		Investigation: "List the executions without the record and read how each ended.",
	},
	RuleLifecycleCoverage: {
		Title:         "{share} of tickets have a lifecycle log",
		Condition:     "{with} of {tickets} tickets in this selection have a lifecycle log ({share}); station visits, gates and waits are read only from it. The rule's threshold is {threshold}.",
		Why:           "Tickets without a lifecycle log are missing from every station figure, so those figures describe part of the work. This is a data-quality note.",
		Investigation: "Open the tickets without a lifecycle log and check whether their cells were run before lifecycle recording, or by hand.",
	},
}

// Labels for subjects (fixed words, never record text).
var waitLabels = map[string]string{
	"dependency": "dependency", "queue": "queue (eligible, not dispatched)", "capacity": "execution-capacity",
	"capacity-slice": "slice capacity", "human-approval": "human approval", "person": "parked-for-a-person",
}

var execMeasures = map[string]string{
	"S1":          "Recoveries per claimed execution (S1)",
	"S2":          "Executions with an unknown outcome (S2)",
	"X1":          "Failed executions (X1)",
	"interrupted": "Interrupted, timed-out or could-not-start executions",
}

// NotEvaluated reasons (fixed text with numbers).
const (
	reasonNoFlow         = "the station, wait and coverage figures were not read: {why}"
	reasonFewVisits      = "needs at least {min} measured station visits; {n} recorded"
	reasonFewStations    = "needs measured time at two stations or more; {n} recorded"
	reasonStationFilter  = "a station filter leaves one station, so a share among stations has no meaning"
	reasonFewSubject     = "needs at least {min} measured {what}; {n} recorded"
	reasonNoWaits        = "no wait was recorded in this selection"
	reasonFewDen         = "needs a denominator of at least {min} {what}; {n} recorded"
	reasonNoValue        = "the figure has no value: {why}"
	reasonNoCompare      = "needs a comparison window: {why}"
	reasonPrevFew        = "needs at least {min} {what} in each window; {later} later, {earlier} earlier"
	reasonCoverage       = "coverage is below {min} in a window ({later} later, {earlier} earlier), too low to compare"
	reasonSuspect        = "a recorded history gap makes one of the windows suspect"
	reasonFewAnalyzed    = "needs at least {min} tickets analyzed (the observe station's minimum); {n}"
	reasonLastRuns       = "last_runs selects the observe station's run records; this rule does not read them"
	reasonNoLimit        = "no Factory limit on executions at once is recorded, so no wait for a free place can be read"
	reasonNoCapWaits     = "no wait for a free place was recorded in this selection"
	reasonFilter         = "this rule cannot honour the {filter} filter"
	reasonHistoryUnknown = "the start of the recorded history is not known, so the earlier window cannot be shown to lie inside it"
	reasonBeforeHistory  = "the earlier window starts {from}, before the recorded history ({history}): it would compare a window the observer holds only in part"
)
