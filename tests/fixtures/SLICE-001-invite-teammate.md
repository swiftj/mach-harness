# SLICE-001: Invite a teammate by email

## Summary

- **Actor:** Workspace admin
- **Trigger:** The admin submits one email address on the Members page
- **Outcome:** The invitee receives an invitation email and one seat is held for them

## Scope

### In scope

- Inviting one teammate by email from the Members page
- Holding a seat for the invitee as soon as the invitation is sent
- Refusing invitations that break a seat, duplicate, or email rule

### Out of scope

- Inviting many teammates at once from a file (Deferred to SLICE-002)
- Accepting an invitation and joining the workspace (Deferred to SLICE-003)
- Reminder emails for invitations nobody has accepted (Deferred to SLICE-004)

## Preconditions

- The admin is signed in to a workspace with at least one purchased seat
- The workspace's purchased seat count is known

## Invariants

- **INV-01:** A workspace MUST NOT have more members and pending invitations than purchased seats.
- **INV-02:** An email address MUST NOT hold more than one membership or pending invitation in the same workspace.
- **INV-03:** An invitation link MUST stop working 7 days after it is sent.
- **INV-04:** An invitation MUST be sent only to an email address that has text before and after a single at sign.

## Functional requirements

- **FR-01:** [Event-driven] When the admin submits an invitation that passes every check, the system SHALL reserve one seat for the invitee.
- **FR-02:** [Event-driven] When a seat is reserved for an invitee, the system SHALL send the invitation email to the invitee within 60 seconds.
- **FR-03:** [Unwanted behavior] If the email address is not valid, then the system SHALL reject the invitation and display "Enter a valid email address."
- **FR-04:** [Unwanted behavior] If every purchased seat is in use, then the system SHALL reject the invitation and display "All seats are in use. Add seats to invite more people."
- **FR-05:** [Unwanted behavior] If the email address already belongs to a member or a pending invitation, then the system SHALL reject the invitation and display "This person is already a member or has a pending invitation."
- **FR-06:** [Unwanted behavior] If the email service does not accept the invitation email within 60 seconds, then the system SHALL display "We couldn't send the invitation. Try again in a few minutes."
- **FR-07:** [Unwanted behavior] If the admin's account is suspended, then the system SHALL reject the invitation and display "Your account is suspended. Contact your workspace owner."
- **FR-08:** [Unwanted behavior] If the invitation email cannot be sent, then the system SHALL release the reserved seat.
- **FR-09:** [Ubiquitous] The system SHALL show the number of seats in use on the Members page.

## Acceptance criteria

### Decision matrix

| Rule | Admin active | Email valid | Already member or invited | Seat available | Expected outcome | Side effects | Covers |
|------|--------------|-------------|---------------------------|----------------|------------------|--------------|--------|
| R1   | No           | -           | -                         | -              | Rejected with "Your account is suspended. Contact your workspace owner." | None | FR-07 |
| R2   | Yes          | No          | -                         | -              | Rejected with "Enter a valid email address." | None | FR-03, INV-04 |
| R3   | Yes          | Yes         | Yes                       | -              | Rejected with "This person is already a member or has a pending invitation." | None | FR-05, INV-02 |
| R4   | Yes          | Yes         | No                        | No             | Rejected with "All seats are in use. Add seats to invite more people." | None | FR-04, INV-01 |
| R5   | Yes          | Yes         | No                        | Yes            | Invitation sent | One seat reserved; invitation email sent to the invitee | FR-01, FR-02 |

### Scenarios

#### AC-01: Admin invites a teammate

- **Covers:** FR-01, FR-02, FR-09
- **Given** the workspace "Acme Design" has 5 purchased seats and 3 members
- **When** the admin invites "sam@example.com"
- **Then** an invitation email arrives for "sam@example.com" within 60 seconds
- **And** the Members page shows 4 of 5 seats in use

#### AC-02: Invitation link expires

- **Covers:** INV-03
- **Given** an invitation was sent to "sam@example.com" 7 days ago
- **When** the invitee opens the invitation link
- **Then** the system displays "This invitation has expired. Ask your admin for a new one."

#### AC-03: Email service failure releases the reserved seat

- **Covers:** FR-06, FR-08
- **Given** the workspace "Acme Design" has 5 purchased seats and 4 members
- **And** the email service is not responding
- **When** the admin invites "sam@example.com"
- **Then** after 60 seconds the system displays "We couldn't send the invitation. Try again in a few minutes."
- **And** the Members page shows 4 of 5 seats in use

## Dependencies and permissions

- **External dependencies:** Email delivery service, which sends the invitation email (failure: FR-06)
- **Required permissions:** Workspace admin role in the invited workspace

## Assumptions

- The Members page already shows the seat count; found in docs/members-page.md.

## Accepted defaults

- Invitation links expire 7 days after they are sent (INV-03).

## Open questions

- None.
