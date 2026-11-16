Recorded response shapes for M8's GitHub calls, used by tests/test_mach_requests.py's stand-in for gh.

- `issue_events.json`: `GET /repos/{owner}/{repo}/issues/{n}/events`, as GitHub's REST documentation
  shows it (verified 2026-11-15). The stand-in applies the same filter as collab.EVENTS_JQ.
- `permission_write.json`, `permission_triage.json`: `GET .../collaborators/{login}/permission`
  after `--jq '{permission, role_name}'`. Triage reads as `read`.
- `issue_view.json`: `gh issue view N --json number,title,body,author,labels,state,updatedAt`.

These are shapes, not live answers; section 6 of docs/mach-next/M8_DESIGN.md lists what only a real
repository can confirm.
