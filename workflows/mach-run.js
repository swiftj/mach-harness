export const meta = {
  name: 'mach-run',
  description: 'Run MACH tickets through the factory unattended: build, verify and review each in its own cell, in parallel',
  whenToUse: 'Several groomed MACH tickets should move through build, verification and review without a person driving each one. Pass the ticket IDs as args, e.g. ["LOCAL-001", "LOCAL-002"]. Stops each ticket wherever a person is needed.',
  phases: [
    { title: 'Preflight', detail: 'read the board, refresh the readiness audit once' },
    { title: 'Groom', detail: 'headless grooming for tickets that need it' },
    { title: 'Build', detail: 'one builder per ticket, in its own cell' },
    { title: 'Verify', detail: 'a fresh verifier per build' },
    { title: 'Review', detail: 'a fresh panel per verified ticket' },
    { title: 'Wrap up', detail: 'cleanup of merged tickets' },
  ],
}

// The order of work is decided by run.py, never here: this script only asks "what next?",
// starts the worker it names, and asks again. A relay agent ("clerk") runs run.py because
// workflow scripts cannot run commands themselves.

const tickets = (Array.isArray(args) ? args : (args && args.tickets) || []).map(String)
if (!tickets.length) {
  return { error: 'Pass the ticket IDs to run, for example ["LOCAL-001", "LOCAL-002"].' }
}

const MAX_STEPS = 16 // three judging rounds need at most 11 steps; this is a backstop
const PHASE = { audit: 'Preflight', groom: 'Groom', plan: 'Groom', build: 'Build', revise: 'Build', verify: 'Verify', review: 'Review', cleanup: 'Wrap up' }
const text = { type: 'string' }
const STEP = {
  type: 'object',
  properties: { action: text, stop: { type: 'boolean' }, reason: text, stage: text, needs: text, agent_type: text, model: text, prompt: text },
  required: ['action', 'stop', 'reason'],
}
const BOARD = {
  type: 'object',
  properties: { audit_state: { type: 'string', description: 'the "state" field of the "audit" object' } },
  required: ['audit_state'],
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
  required: ['seats'],
}
const TALLY = {
  type: 'object',
  properties: { outcome: { type: 'string', description: 'the "outcome" field, or "ERROR" if the command refused' }, detail: text },
  required: ['outcome'],
}

function clerk(command, schema, label, phase) {
  return agent(
    `Use the MACH run skill in clerk mode: /mach:run clerk ${command}\n` +
      'Report the fields of the JSON that the command prints, copied exactly. Use an empty string where a field is null or absent. Do nothing else.',
    { label, phase, schema, model: 'haiku', effort: 'low' },
  )
}

async function review(ticket) {
  const panel = await clerk(`review-start ${ticket}`, PANEL, `${ticket}: seat the panel`, 'Review')
  if (!panel || !panel.seats.length) return panel && panel.refused ? panel.refused : 'the review panel could not be seated'
  // Every seat is a fresh agent that sees only its own prompt: a role, and where to look.
  await parallel(panel.seats.map(seat => () =>
    agent(seat.prompt, { agentType: seat.agent_type, model: seat.model, label: `${ticket}: ${seat.role} reviewer`, phase: 'Review' })))
  const tally = await clerk(`review-tally ${ticket}`, TALLY, `${ticket}: tally`, 'Review')
  log(`${ticket}: review ${tally ? tally.outcome : 'could not be tallied'}`)
  return null
}

async function runTicket(ticket) {
  const done = []
  let last = ''
  let repeats = 0
  for (let i = 0; i < MAX_STEPS; i++) {
    const step = await clerk(`next ${ticket} --headless`, STEP, `${ticket}: what next?`, 'Preflight')
    if (!step) return { ticket, outcome: 'error', reason: 'the next step could not be read', stations: done }
    if (step.stop || step.action === 'stop') {
      return { ticket, outcome: 'stopped', stage: step.stage || '', waiting_for: step.needs || '', reason: step.reason, stations: done }
    }
    // The same step twice with no change of stage means the worker is not getting through.
    const key = `${step.action}@${step.stage || ''}`
    repeats = key === last ? repeats + 1 : 0
    last = key
    if (repeats >= 2) {
      return { ticket, outcome: 'stuck', stage: step.stage || '', reason: `the ${step.action} station ran twice without moving the ticket on`, stations: done }
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
    await agent(step.prompt, opts)
  }
  return { ticket, outcome: 'stuck', reason: `still not finished after ${MAX_STEPS} steps`, stations: done }
}

phase('Preflight')
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
return {
  tickets: report,
  waiting_on_a_person: report.filter(r => r.outcome === 'stopped').map(r => `${r.ticket}: ${r.waiting_for || r.reason}`),
  problems: report.filter(r => r.outcome !== 'stopped').map(r => `${r.ticket}: ${r.reason}`),
}
