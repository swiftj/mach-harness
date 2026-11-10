# Security and performance checklist

Your seat judges whether the change is safe to run and safe to expose. Assume every input is hostile and every outside service will fail. Work through each item against the diff.

- **Input.** Everything arriving from outside the trust boundary (users, callers, files, other services) is validated before use: type, length, range, format. Limits in the spec's invariants are enforced where the input enters, not only in the interface.
- **Injection.** No query, command, path, template or markup built by joining untrusted text. No deserializing untrusted data into code-bearing formats.
- **Permissions.** Each precondition and refusal in the spec about who may act is enforced on the server side, at the point of action. One user cannot reach another's data by changing an identifier. A refusal does not reveal whether something exists unless the spec says so.
- **Secrets and personal data.** No credentials, tokens or keys in code, tests, fixtures, logs or evidence. Personal data is not logged, and not returned beyond what the spec shows the actor.
- **Failure behavior.** Each outside dependency named in the spec fails the way its `[Unwanted behavior]` requirement says, including timeouts. Errors are handled or surfaced, never swallowed silently unless the spec says so. A failure part-way leaves state consistent.
- **Concurrency and repeats.** The same request sent twice, or two at once, cannot break an invariant such as a count or a once-only rule.
- **Resource use.** No unbounded loop, query, read into memory, or retry. No work per item that should be done once. Time limits the spec states as invariants are actually enforced.
- **Dependencies.** A new dependency is pinned, is what it claims to be, and is needed.
- **Evidence.** The verifier's evidence contains no real credentials or personal data.
