export const meta = {
  name: 'belt',
  description: 'Run MACH tickets through the factory unattended: build, verify and review each in its own cell, in parallel',
  whenToUse: 'Several groomed MACH tickets should move through build, verification and review without a person driving each one. Pass the ticket IDs as args, e.g. ["LOCAL-001", "LOCAL-002"]. Stops each ticket wherever a person is needed.',
  phases: [
    { title: 'Preflight', detail: 'read the board, refresh the readiness audit once' },
    { title: 'Groom', detail: 'headless grooming for tickets that need it' },
    { title: 'Build', detail: 'one builder per ticket, in its own cell' },
    { title: 'Verify', detail: 'a fresh verifier per build' },
    { title: 'Review', detail: 'a fresh panel per verified ticket' },
    { title: 'Wrap up', detail: 'merge approved tickets where the settings allow, then clean up' },
    { title: 'Learn', detail: 'an observe pass when one is due, then its tuning ticket' },
  ],
}

// The order of work is decided by run.py, never here: this script only asks "what next?",
// starts the worker it names, and asks again. Workflow scripts cannot run commands themselves,
// so a relay agent ("clerk") runs run.py. The script's location is found once, up front, and
// every later relay is given the exact command, so no relay has to find or load anything.

const tickets = (Array.isArray(args) ? args : (args && args.tickets) || []).map(String)
// Optional: stop each ticket before this station (for example "merge"), leaving it for a person.
const until = !Array.isArray(args) && args && typeof args.until === 'string' ? args.until : ''
if (!tickets.length) {
  return { error: 'Pass the ticket IDs to run, for example ["LOCAL-001", "LOCAL-002"].' }
}

const MAX_STEPS = 16 // three judging rounds need at most 11 steps; this is a backstop
const PHASE = { audit: 'Preflight', groom: 'Groom', plan: 'Groom', build: 'Build', revise: 'Build', verify: 'Verify', review: 'Review', merge: 'Wrap up', cleanup: 'Wrap up' }
const text = { type: 'string' }
const STEP = {
  type: 'object',
  properties: { action: text, stop: { type: 'boolean' }, reason: text, stage: text, needs: text, agent_type: text, model: text, prompt: text },
  required: ['action', 'stop', 'reason'],
}
const BOARD = {
  type: 'object',
  properties: {
    audit_state: { type: 'string', description: 'the "state" field of the "audit" object' },
    observe_due: { type: 'boolean' },
    factory_tuning_ready: { type: 'array', items: { type: 'string' } },
  },
  required: ['audit_state', 'observe_due', 'factory_tuning_ready'],
}
const PANEL = {
  type: 'object',
  properties: {
    refused: { type: 'string', description: 'the refusal text if the command refused, otherwise empty' },
    seats: {
      type: 'array',
      items: { type: 'object', properties: { role: text, model: text, agent_type: text, prompt: text }, required: ['role', 'model', 'agent_type', 'prompt'] },
    },
  },
  required: ['refused', 'seats'],
}
const TALLY = {
  type: 'object',
  properties: { outcome: { type: 'string', description: 'the "outcome" field, or "ERROR" if the command refused' }, detail: text },
  required: ['outcome'],
}

const WHERE = {
  type: 'object',
  properties: { project: text, run_script: text, python: text },
  required: ['project', 'run_script'],
}
const CHECK = {
  type: 'object',
  properties: { is_mach_project: { type: 'boolean' }, project: text },
  required: ['is_mach_project'],
}

phase('Preflight')
const where = await agent(
  'Do these two things in order, and do not change directory at any point.\n' +
    '1. Run `pwd` as your very first command and note its output: that folder is the project. Report it as "project".\n' +
    '2. Find the MACH conveyor-belt script: use the MACH run skill with the single word "where": /mach:run where\n' +
    '   It prints a small JSON object; report its "run_script" and "python" fields exactly. Ignore its "project" field: use the folder from step 1.\n' +
    '   If that skill cannot be loaded, look for .claude/skills/mach-run/scripts/run.py under the project folder; if it exists, report its ' +
    'absolute path as run_script and "python3" as python. If neither works, report an empty run_script.',
  { label: 'locate the belt script', phase: 'Preflight', schema: WHERE, model: 'haiku', effort: 'low' },
)
if (!where || !/run\.py$/.test(where.run_script || '') || !where.project) {
  return { error: 'The MACH run script could not be located, so nothing was started. Check that MACH is installed in this project (the plugin, or .claude/skills/mach-run).' }
}
const RUN = `${where.python || 'python3'} "${where.run_script}" --project "${where.project}"`

function clerk(command, schema, label, phase) {
  return agent(
    'Run exactly the one command in the code block below, complete and unchanged, including its last words, and nothing else:\n\n' +
      '```bash\n' + `${RUN} ${command}` + '\n```\n\n' +
      'Report the fields of the JSON it prints, copied exactly; use an empty string where a field is null or absent. ' +
      'If the command prints no JSON or fails, set "action" (or "outcome", or "refused") to "ERROR", set any true/false field to false, and put its error text in "reason" (or "detail"). ' +
      'Do not run any other command, load any skill, or try another way.',
    { label, phase, schema, model: 'haiku', effort: 'low' },
  )
}

async function review(ticket) {
  const panel = await clerk(`review-start ${ticket}`, PANEL, `${ticket}: seat the panel`, 'Review')
  if (!panel || !panel.seats || !panel.seats.length) return panel && panel.refused ? panel.refused : 'the review panel could not be seated'
  // Every seat is a fresh agent that sees only its own prompt: a role, and where to look.
  await parallel(panel.seats.map(seat => () =>
    agent(seat.prompt, { agentType: seat.agent_type, model: seat.model, label: `${ticket}: ${seat.role} reviewer`, phase: 'Review' })))
  const tally = await clerk(`review-tally ${ticket}`, TALLY, `${ticket}: tally`, 'Review')
  log(`${ticket}: review ${tally ? tally.outcome : 'could not be tallied'}`)
  return null
}

async function runTicket(ticket) {
  const done = []
  let said = '' // what the last worker reported, passed on if the ticket gets stuck
  let last = ''
  let repeats = 0
  for (let i = 0; i < MAX_STEPS; i++) {
    const step = await clerk(`next ${ticket} --headless`, STEP, `${ticket}: what next?`, 'Preflight')
    if (!step || step.action === 'ERROR' || !step.action) {
      return { ticket, outcome: 'error', reason: (step && step.reason) || 'the next step could not be read', stations: done }
    }
    if (step.stop || step.action === 'stop') {
      return { ticket, outcome: 'stopped', stage: step.stage || '', waiting_for: step.needs || '', reason: step.reason, stations: done }
    }
    if (until && step.action === until) {
      return { ticket, outcome: 'stopped', stage: step.stage || '', waiting_for: `a person: stopped before ${until}, as asked`, reason: step.reason, stations: done }
    }
    // The same step twice with no change of stage means the worker is not getting through.
    const key = `${step.action}@${step.stage || ''}`
    repeats = key === last ? repeats + 1 : 0
    last = key
    if (repeats >= 2) {
      return { ticket, outcome: 'stuck', stage: step.stage || '', reason: `the ${step.action} station ran twice without moving the ticket on`, last_report: said, stations: done }
    }
    done.push(step.action)
    if (step.action === 'review') {
      const problem = await review(ticket)
      if (problem) return { ticket, outcome: 'error', reason: problem, stations: done }
      continue
    }
    const opts = { label: `${ticket}: ${step.action}`, phase: PHASE[step.action] || 'Build' }
    if (step.agent_type) opts.agentType = step.agent_type
    else if (step.model) opts.model = step.model
    const reported = await agent(step.prompt, opts)
    said = typeof reported === 'string' ? reported.slice(0, 1500) : ''
  }
  return { ticket, outcome: 'stuck', reason: `still not finished after ${MAX_STEPS} steps`, stations: done }
}

// Nothing starts unless the folder really is a MACH project: a wrong folder would make every ticket look new.
const check = await clerk('where', CHECK, 'check the project', 'Preflight')
if (!check || check.is_mach_project !== true) {
  return { error: `${where.project} is not a MACH project (no .factory folder), so nothing was started. Run the workflow from the project's folder.` }
}

// The audit measures the whole repository, so refresh it once here rather than once per ticket.
const board = await clerk('board --headless', BOARD, 'read the board', 'Preflight')
if (board && (board.audit_state === 'missing' || board.audit_state === 'stale')) {
  log(`The readiness audit is ${board.audit_state}; running it once before any ticket starts.`)
  await agent('Use the MACH audit skill on the main checkout: /mach:audit', { label: 'readiness audit', phase: 'Preflight', model: 'sonnet' })
}

// Tickets are independent: each lives in its own cell on its own branch.
const results = await parallel(tickets.map(ticket => () => runTicket(ticket)))
const report = results.map((result, index) => result || { ticket: tickets[index], outcome: 'error', reason: 'the run for this ticket failed' })
for (const result of report) {
  log(`${result.ticket}: ${result.outcome}${result.waiting_for ? ', waiting for ' + result.waiting_for : ''}`)
}

// Learn: when enough tickets have finished, the observe station measures them and files one tuning ticket,
// and that ticket runs through the same line. Rule changes are never written directly.
phase('Learn')
let learned = 'no observe pass was due'
const after = await clerk('board --headless', BOARD, 'is an observe pass due?', 'Learn')
if (after && after.observe_due === true) {
  await agent('Use the MACH observe skill unattended: /mach:observe --auto', { label: 'observe pass', phase: 'Learn' })
  learned = 'an observe pass ran'
}
const settled = after && after.observe_due === true ? await clerk('board --headless', BOARD, 'any tuning ticket to run?', 'Learn') : after
const tuning = ((settled && settled.factory_tuning_ready) || []).filter(id => !tickets.includes(id))
if (tuning.length) {
  log(`Running the tuning ticket${tuning.length > 1 ? 's' : ''} ${tuning.join(', ')} through the line.`)
  const tuned = await parallel(tuning.map(ticket => () => runTicket(ticket)))
  tuned.forEach((result, index) => report.push(result || { ticket: tuning[index], outcome: 'error', reason: 'the run for this ticket failed' }))
  learned += `; tuning ticket${tuning.length > 1 ? 's' : ''} ${tuning.join(', ')} ran`
}
return {
  learning: learned,
  tickets: report,
  waiting_on_a_person: report.filter(r => r.outcome === 'stopped' && r.waiting_for !== 'nothing').map(r => `${r.ticket}: ${r.waiting_for || r.reason}`),
  finished: report.filter(r => r.outcome === 'stopped' && r.waiting_for === 'nothing').map(r => r.ticket),
  problems: report.filter(r => r.outcome !== 'stopped').map(r => `${r.ticket}: ${r.reason}`),
}
