export const meta = {
  name: 'belt',
  description: 'Run MACH tickets through the factory unattended: build, verify and review each in its own cell, several at once as the schedule allows',
  whenToUse: 'Several groomed MACH tickets should move through build, verification and review without a person driving each one. Pass the ticket IDs as args, e.g. ["LOCAL-001", "LOCAL-002"], or {"tickets": ["LOCAL-001", "LOCAL-002"], "until": "merge", "limit": 2, "sequential": false, "by_person": false}. run.py schedule decides which may run together. Stops each ticket wherever a person is needed.',
  phases: [
    { title: 'Preflight', detail: 'read the status, refresh the readiness audit once' },
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

const options = !Array.isArray(args) && args && typeof args === 'object' ? args : {}
const tickets = [...new Set((Array.isArray(args) ? args : options.tickets || []).map(value => String(value).trim()).filter(Boolean))]
// Optional: stop each ticket before this station (for example "merge"), leaving it for a person.
const until = typeof options.until === 'string' ? options.until : ''
// Optional: how many at once. The schedule clamps a limit above the settings unless a person raised it for this run.
const limit = Number.isInteger(options.limit) && options.limit >= 1 ? options.limit : 0
const sequential = options.sequential === true
const byPerson = options.by_person === true && limit > 0
if (!tickets.length) {
  return { error: 'Pass the ticket IDs to run, for example ["LOCAL-001", "LOCAL-002"].' }
}
const USABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/
const MAX_AT_ONCE = 8 // the belt's own fixed maximum, whatever a relay reports

const MAX_STEPS = 16 // three judging rounds need at most 11 steps; this is a backstop
const PHASE = { audit: 'Preflight', groom: 'Groom', plan: 'Groom', build: 'Build', revise: 'Build', verify: 'Verify', review: 'Review', merge: 'Wrap up', cleanup: 'Wrap up' }
const text = { type: 'string' }
// The fixed set of steps run.py names and of workers the factory ships, under both install forms (plugin, project).
const ACTIONS = ['audit', 'groom', 'plan', 'build', 'revise', 'verify', 'review', 'merge', 'cleanup', 'stop', 'ERROR']
const AGENT_TYPES = ['builder', 'contract-engineer', 'verifier', 'reviewer'].flatMap(name => [`mach:${name}`, `mach-${name}`])
const STEP = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS }, stop: { type: 'boolean' }, reason: text, stage: text, needs: text,
    agent_type: { type: 'string', enum: ['', ...AGENT_TYPES], description: 'the "agent_type" field exactly, or an empty string when it is null or absent' },
    model: text, prompt: text,
  },
  required: ['action', 'stop', 'reason', 'agent_type'],
}

// BEGIN cleanStep: a pure function, evaluated on its own by tests/test_run.py.
// A relay copies run.py's step, and a model's copy is not trusted: a blank, whitespace-only or quote-only value is
// absent, an agent type outside AGENT_TYPES falls back to the default worker with a note, and a step that names no
// known action, or work with no prompt, is refused so that no agent is started with empty fields.
function cleanStep(step, agentTypes) {
  const clean = value => (typeof value === 'string' ? value.trim().replace(/^["'`\s]+|["'`\s]+$/g, '') : '')
  if (!step || typeof step !== 'object') return { error: 'run.py next returned nothing usable' }
  const action = clean(step.action)
  if (!action || action === 'ERROR') return { error: clean(step.reason) || 'run.py next failed' }
  if (!['audit', 'groom', 'plan', 'build', 'revise', 'verify', 'review', 'merge', 'cleanup', 'stop'].includes(action)) {
    return { error: `run.py next named an unknown step '${action.slice(0, 40)}'` }
  }
  const out = { action, stop: step.stop === true || action === 'stop', reason: clean(step.reason), stage: clean(step.stage), needs: clean(step.needs),
    agent_type: clean(step.agent_type), model: clean(step.model), prompt: typeof step.prompt === 'string' ? step.prompt.trim() : '' }
  let note = ''
  if (out.agent_type && !agentTypes.includes(out.agent_type)) {
    note = `unknown agent type '${out.agent_type.slice(0, 40)}' ignored; the default worker runs this step`
    out.agent_type = ''
  }
  if (!out.stop && out.action !== 'review' && !out.prompt) return { error: `run.py next gave the ${action} step no prompt` }
  return { step: out, note }
}
// END cleanStep
// BEGIN cleanSchedule: a pure function, evaluated on its own by tests/test_run.py.
// A relay copies run.py schedule's answer, and a model's copy is not trusted. Only tickets still pending are started,
// each once; running never exceeds the ceiling the relay read, nor `most`; an unreadable ceiling counts as 1. A ticket
// to be prepared stops before build; an "until" that is neither empty nor "build" stops it there too (fewer, never more).
function cleanSchedule(plan, pending, running, most) {
  const clean = value => (typeof value === 'string' ? value.trim().replace(/^["'`\s]+|["'`\s]+$/g, '') : '')
  if (!plan || typeof plan !== 'object') return { error: 'run.py schedule returned nothing usable', start: [], held: [] }
  const refused = clean(plan.refused)
  if (refused) return { error: refused, start: [], held: [] }
  const read = typeof plan.in_force === 'string' ? Number(clean(plan.in_force)) : plan.in_force
  const ceiling = Math.min(Number.isInteger(read) && read >= 1 ? read : 1, most)
  const busy = running.map(String)
  const room = Math.max(0, ceiling - busy.length)
  const key = item => (item && typeof item === 'object' ? clean(item.given) || clean(item.ticket_id) : '')
  const start = []
  const taken = new Set()
  for (const item of Array.isArray(plan.start) ? plan.start : []) {
    const ticket = key(item)
    if (!ticket || !pending.includes(ticket) || busy.includes(ticket) || taken.has(ticket)) continue
    if (start.length >= room) break
    taken.add(ticket)
    const asked = clean(item.until).toLowerCase()
    start.push({ ticket, until: ['', 'null', 'none'].includes(asked) ? '' : 'build' })
  }
  const held = []
  for (const item of Array.isArray(plan.held) ? plan.held : []) {
    const ticket = key(item)
    if (!ticket || !pending.includes(ticket) || taken.has(ticket)) continue
    taken.add(ticket)
    const after = (Array.isArray(item.after) ? item.after : []).map(clean).filter(Boolean).slice(0, 10)
    held.push({ ticket, why: clean(item.why).slice(0, 400) || 'the schedule held it', after })
  }
  return { start, held, ceiling }
}
// END cleanSchedule
const STATUS = {
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

const SCHEDULE = {
  type: 'object',
  properties: {
    refused: { type: 'string', description: 'the refusal text if the command refused, otherwise empty' },
    in_force: { type: 'number', description: 'the "in_force" field of the "ceiling" object' },
    start: {
      type: 'array',
      items: { type: 'object', properties: { ticket_id: text, given: text, until: text }, required: ['ticket_id', 'until'] },
    },
    held: {
      type: 'array',
      items: { type: 'object', properties: { ticket_id: text, given: text, why: text, after: { type: 'array', items: text } }, required: ['ticket_id', 'why'] },
    },
  },
  required: ['refused', 'in_force', 'start', 'held'],
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

// `prepare` is "build" when the schedule starts a ticket that has no plan yet: it goes as far as the build station
// and returns to the queue, to be scheduled again with its plan known.
async function runTicket(ticket, prepare) {
  const done = []
  let said = '' // what the last worker reported, passed on if the ticket gets stuck
  let last = ''
  let repeats = 0
  for (let i = 0; i < MAX_STEPS; i++) {
    const read = cleanStep(await clerk(`next ${ticket} --headless`, STEP, `${ticket}: what next?`, 'Preflight'), AGENT_TYPES)
    if (read.error) {
      return { ticket, outcome: 'error', reason: `the next step could not be read: ${read.error}`, stations: done }
    }
    if (read.note) log(`${ticket}: ${read.note}`)
    const step = read.step
    if (step.stop || step.action === 'stop') {
      return { ticket, outcome: 'stopped', stage: step.stage || '', waiting_for: step.needs || '', reason: step.reason, stations: done }
    }
    if (until && step.action === until) {
      return { ticket, outcome: 'stopped', stage: step.stage || '', waiting_for: `a person: stopped before ${until}, as asked`, reason: step.reason, stations: done }
    }
    if (prepare && step.action === prepare) {
      return { ticket, outcome: 'prepared', stage: step.stage || '', reason: `planned; it returns to the schedule before ${prepare}`, stations: done }
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
const status = await clerk('status --headless', STATUS, 'read the status', 'Preflight')
if (status && (status.audit_state === 'missing' || status.audit_state === 'stale')) {
  log(`The readiness audit is ${status.audit_state}; running it once before any ticket starts.`)
  await agent('Use the MACH audit skill on the main checkout: /mach:audit', { label: 'readiness audit', phase: 'Preflight', model: 'sonnet' })
}

// Each ticket lives in its own cell on its own branch, but tickets that touch the same files, or several High-risk
// ones, do not run together. run.py schedule decides what may start; this pool only asks it again whenever a ticket
// finishes, and starts what it names.
function scheduleCommand(pending, running) {
  const flags = sequential ? ' --sequential' : limit ? ` --limit ${limit}${byPerson ? ' --by-person' : ''}` : ''
  return `schedule ${pending.join(' ')}${running.length ? ' --running ' + running.join(' ') : ''}${flags}`
}

async function pool(list) {
  const results = []
  const order = list.filter(ticket => USABLE_ID.test(ticket))
  for (const ticket of list.filter(ticket => !USABLE_ID.test(ticket))) {
    results.push({ ticket: ticket.slice(0, 60), outcome: 'error', reason: 'not a usable ticket ID, so it was not started' })
  }
  let pending = order.slice()
  const running = new Map()
  const prepared = {}
  let held = []
  let problem = ''
  while (pending.length || running.size) {
    let consumed = false
    if (pending.length) {
      const asked = await clerk(scheduleCommand(pending, [...running.keys()]), SCHEDULE, 'what may start?', 'Preflight')
      const plan = cleanSchedule(asked, pending, [...running.keys()], MAX_AT_ONCE)
      problem = plan.error || ''
      held = plan.held || []
      for (const item of plan.start || []) {
        pending = pending.filter(ticket => ticket !== item.ticket)
        consumed = true
        if (item.until && prepared[item.ticket]) {
          results.push({ ticket: item.ticket, outcome: 'stuck', reason: 'it was prepared twice without reaching the line: its plan is still not recorded' })
          continue
        }
        log(`${item.ticket}: starting${item.until ? ' (as far as ' + item.until + ', then scheduled again)' : ''}`)
        running.set(item.ticket, runTicket(item.ticket, item.until).then(result => ({ ticket: item.ticket, result }), () => ({ ticket: item.ticket, result: null })))
      }
    }
    if (!running.size) {
      if (pending.length && consumed) continue // every start was a stuck ticket: ask again about the rest
      break
    }
    const finished = await Promise.race([...running.values()])
    running.delete(finished.ticket)
    const result = finished.result || { ticket: finished.ticket, outcome: 'error', reason: 'the run for this ticket failed' }
    if (result.outcome === 'prepared') {
      prepared[finished.ticket] = true
      pending = order.filter(ticket => ticket === finished.ticket || pending.includes(ticket)) // back in the queue, in the order given
      continue
    }
    results.push(result)
  }
  // Nothing is running and nothing may start: the rest wait, each with the schedule's reason.
  for (const ticket of pending) {
    const why = held.find(item => item.ticket === ticket)
    results.push(problem
      ? { ticket, outcome: 'error', reason: `the schedule could not be read: ${problem}` }
      : { ticket, outcome: 'held', reason: why ? why.why : 'the schedule did not start it', waiting_for_tickets: why ? why.after : [] })
  }
  return results
}

const report = await pool(tickets)
for (const result of report) {
  log(`${result.ticket}: ${result.outcome}${result.waiting_for ? ', waiting for ' + result.waiting_for : ''}`)
}

// Learn: when enough tickets have finished, the observe station measures them and files one tuning ticket,
// and that ticket runs through the same line. Rule changes are never written directly.
// Inside a supervised Factory execution, run.py's status reports no pass due and no tuning ticket, and refuses every
// ticket but the execution's own: the pass is separate work that the supervisor leaves for a person.
phase('Learn')
let learned = 'no observe pass was due'
const after = await clerk('status --headless', STATUS, 'is an observe pass due?', 'Learn')
if (after && after.observe_due === true) {
  await agent('Use the MACH observe skill unattended: /mach:observe --auto', { label: 'observe pass', phase: 'Learn' })
  learned = 'an observe pass ran'
}
const settled = after && after.observe_due === true ? await clerk('status --headless', STATUS, 'any tuning ticket to run?', 'Learn') : after
const tuning = ((settled && settled.factory_tuning_ready) || []).filter(id => !tickets.includes(id))
if (tuning.length) {
  log(`Running the tuning ticket${tuning.length > 1 ? 's' : ''} ${tuning.join(', ')} through the line.`)
  for (const result of await pool(tuning)) report.push(result)
  learned += `; tuning ticket${tuning.length > 1 ? 's' : ''} ${tuning.join(', ')} ran`
}
return {
  learning: learned,
  tickets: report,
  waiting_on_a_person: report.filter(r => r.outcome === 'stopped' && r.waiting_for !== 'nothing').map(r => `${r.ticket}: ${r.waiting_for || r.reason}`),
  finished: report.filter(r => r.outcome === 'stopped' && r.waiting_for === 'nothing').map(r => r.ticket),
  held: report.filter(r => r.outcome === 'held').map(r => `${r.ticket}: ${r.reason}`),
  problems: report.filter(r => r.outcome !== 'stopped' && r.outcome !== 'held').map(r => `${r.ticket}: ${r.reason}`),
}
