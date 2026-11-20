---
id: POL-security
title: Security
owner: Security team (@your-org/security)
status: active
applies-to:
  - topic:security
  - topic:sign-in
  - topic:password
  - topic:permission
---

# Security

A starter policy pack. MACH does not install it: a team that wants it copies this folder to `policies/security/` in
its repository, sets the owner to the real team (and its GitHub team, where there is one), keeps only the statements
it means, and merges it by pull request like an ADR. Each statement is one RFC 2119 sentence, numbered
`POL-security-NN`; a number is never reused.

- **POL-security-01:** Every change to stored data MUST be made by a person who is signed in.
- **POL-security-02:** A person MUST NOT see or change data that belongs to another customer.
- **POL-security-03:** A refusal message MUST NOT say whether an account exists for an email address.
- **POL-security-04:** A password or a secret token MUST NOT be shown again after it is first set.
- **POL-security-05:** Repeated failed sign-in attempts SHOULD slow down or block further attempts for that account.
