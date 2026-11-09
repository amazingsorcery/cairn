---
title: "Privacy Notice"
slug: privacy
effectiveDate: "{{POLICY_EFFECTIVE_DATE}}"
lastReviewedAt: "2026-08-31"
---

# Privacy Notice

This notice explains what personal data {{BRAND_NAME}} holds about **you, the account holder**,
why we hold it, how long we keep it, and what you can require us to do with it.

It also explains something unusual about this service, which is the single most important thing
on this page: **we do not hold data about the subjects of your investigations.** Section 4 sets
out what that means and what it makes you responsible for.

The controller is {{BRAND_LEGAL_ENTITY}}. Contact {{BRAND_CONTACT_PRIVACY}} for anything in this
notice.

**A qualified lawyer has not yet reviewed this document, and the controller's jurisdiction of
establishment is not yet settled.**

## 1. Our position in one paragraph

We hold the minimum needed to run an account: an email address, session records, and the content
you choose to create. We use no third-party analytics, no advertising networks and no session
recording. We do not sell or share your data. We do not profile you. Your investigative
interests — which tools you look at, which playbooks you use, what you write in your notes — are
exactly the kind of information our users cannot afford to leak, and the service is built on that
assumption.

## 2. What we collect

### 2.1 Account data

| Data | Why we hold it | Lawful basis (GDPR) |
| --- | --- | --- |
| Email address | To identify your account, send magic-link sign-in emails, and contact you about the service | Contract (Art. 6(1)(b)) |
| GitHub account identifier and email, if you sign in with GitHub | To authenticate you | Contract (Art. 6(1)(b)) |
| Account creation date, last sign-in | Account management and security | Legitimate interests (Art. 6(1)(f)) |
| Display name, if you set one | To label your account in the interface | Contract (Art. 6(1)(b)) |

We do not ask for your real name, your employer, your postal address, or a phone number. If you
choose to put any of those in a display name or a note, that is your decision.

### 2.2 Session and security data

| Data | Why we hold it | Lawful basis |
| --- | --- | --- |
| Session records (session identifier, expiry, and the fact of an active session) | To keep you signed in | Contract (Art. 6(1)(b)) |
| Authentication events (sign-in, sign-out, failed attempts, with timestamp) | To detect and investigate account compromise | Legitimate interests (Art. 6(1)(f)) |
| IP address and user-agent, in short-lived server logs | Security, abuse prevention and debugging | Legitimate interests (Art. 6(1)(f)) |

Sessions are stored in our own PostgreSQL database, not in a third-party session service.

### 2.3 Content you create

| Data | Why we hold it | Lawful basis |
| --- | --- | --- |
| Workspaces, their names and settings | To provide the service | Contract (Art. 6(1)(b)) |
| Timestamped notes you write | To provide the service | Contract (Art. 6(1)(b)) |
| Saved tool collections and playbook checklist progress | To provide the service | Contract (Art. 6(1)(b)) |

**This content is yours.** We store it so we can give it back to you. We do not analyse it, mine
it, use it to improve the catalogue, or use it to train any model.

### 2.4 What we do not collect

- No third-party analytics of any kind. No Google Analytics, no Plausible, no Matomo, no
  self-hosted equivalent that profiles individuals.
- No advertising or marketing trackers, and no advertising network is present on the service.
- No session recording, heatmaps, or behavioural tracking.
- No cross-site tracking, no tracking pixels, no fingerprinting.
- No cookies except those strictly necessary for authentication and security.

This is a product commitment, not a current-state description that might quietly change. Adding
behavioural analytics would require a change to this notice with 14 days' notice under section 9,
and it is contrary to a standing constraint in the product's own design documents.

### 2.5 The Live surfaces — what we do and do not record

The Live section (`/live/flights` and `/live/cameras`) is the only part of the service that makes
outbound requests. It changes nothing about what we collect **about you**, and it is worth being
precise about why.

**We keep no viewing records.** We do not log which aircraft, which map area or which camera any
user looked at. Our outbound request log records that a connector was called and whether it
succeeded; it does not record you, your query, a bounding box, a camera identifier, or any
response body. We retain no imagery.

**Flights** are fetched server-side and cached. Your browser talks to us, we talk to the
aggregator, and the aggregator therefore does not see your address or your interest.

**Cameras are the opposite, deliberately.** We do not proxy or re-host camera imagery, because
doing so would make us a redistributor of a third party's images and, where people are in frame,
a controller of their image data. Instead, camera feeds are **click-to-load**:

- Nothing loads from any operator until you click. Camera pages render from our own database and
  open no connection.
- **When you click, your browser connects directly to the operator**, which will see your IP
  address and, because the URL identifies one camera, which location you chose. We disclose this
  on the page, naming the operator, before you click.
- We set `no-referrer` on these requests, so the operator does not learn which of our pages you
  came from.
- **That request never touches our servers, so we do not and cannot know which cameras you
  viewed.** There is no viewing history for us to lose, disclose or be compelled to produce.

This is a genuine trade and we would rather you understood it than trusted it. Section 4.2 of the
[Acceptable Use Policy](/legal/acceptable-use) covers the same ground from the other direction.

## 3. Cookies

We set only cookies that are strictly necessary to operate the service: a session cookie to keep
you signed in, and a CSRF token cookie to protect form submissions. These do not require consent
under the ePrivacy Directive and its national implementations, which is why you are not shown a
cookie banner. There is nothing to consent to because there is nothing optional being set.

## 4. Investigation subjects — the part that matters

{{BRAND_NAME}} deliberately holds **no records about the people or organisations you
investigate**. There is no entity database, no dossier store, no person index. Nothing you type
into a workspace is sent to any tool in the catalogue.

The consequence, stated plainly:

**Where your notes contain personal data about identifiable people, you are the data controller
of that personal data. We are your processor for the storage of it, and nothing more.**

That means:

- You need your own lawful basis for holding that information — for most of our users this will
  be legitimate interests, a journalistic or academic exemption, or a legal obligation.
- You are responsible for responding to any subject access, rectification or erasure request from
  a person in your notes. We cannot answer such a request for you, because we cannot search your
  notes for a person and would not do so if asked.
- You should apply data minimisation to your own notes and delete them when the work ends.
- If your notes are exposed in a breach, the notification obligation to affected individuals is
  yours. We will notify you promptly so that you can meet it — see section 8.

If you need a formal data processing agreement to satisfy your organisation's compliance
requirements, contact {{BRAND_CONTACT_PRIVACY}}.

**Do not use a workspace as an ongoing database of individuals.** Section 4.5 of the
[Acceptable Use Policy](/legal/acceptable-use) prohibits it, for reasons that protect both of us.

## 5. Who we share data with

We share your personal data with no one for their own purposes. We do not sell it, rent it, or
exchange it.

We rely on a small number of processors to operate the service:

| Processor | Purpose | Data involved |
| --- | --- | --- |
| Our hosting provider | Running the application and database on a single virtual private server | All service data, encrypted at rest and in transit |
| Our transactional email provider | Sending magic-link sign-in emails | Your email address and the sign-in link |
| GitHub, if you use GitHub sign-in | Authentication | Whatever GitHub discloses to us on your authorisation |

The identity of the hosting and email providers is stated on the service's infrastructure page and
kept current. Each is bound by a processing agreement. We do not add processors without updating
this notice.

We will disclose data where we are legally compelled to. Where we are lawfully permitted to tell
you about such a demand, we will, before responding where possible.

## 6. Where your data is held

Service data is held on infrastructure located in {{BRAND_DATA_REGION}}. Where a processor
involves a transfer outside the UK or EEA, that transfer relies on an adequacy decision or on
Standard Contractual Clauses with a transfer risk assessment.

## 7. How long we keep things

| Data | Retention |
| --- | --- |
| Account record | Until you delete your account |
| Workspaces, notes, collections | Until you delete them, or until you delete your account |
| Active sessions | Until expiry or sign-out; expired sessions purged within 30 days |
| Authentication event log | 90 days |
| Server logs containing IP addresses | 30 days |
| Backups | 30 days, then destroyed |

**When you delete your account**, we delete your account record, workspaces, notes and
collections from live systems within 30 days. Backups containing your data are destroyed on the
backup rotation above, within 30 days, and we do not restore deleted accounts from backup.

You can delete individual notes, collections or workspaces at any time from the interface; those
deletions take effect immediately in live systems.

## 8. Security and breach notification

- All traffic is served over TLS.
- Data is encrypted at rest at the storage layer.
- Authentication is by email magic link or GitHub OAuth. **We never hold a password for your
  account**, so there is no password of yours for anyone to steal from us.
- Access to production systems is limited to named operators using multi-factor authentication.
- We do not read your workspace contents in the course of ordinary operation. Access to
  production data for debugging is limited to what is necessary, logged, and not undertaken
  routinely.

If a breach affects your personal data, we will notify the competent supervisory authority within
72 hours where required, and we will notify you without undue delay where the breach is likely to
result in a high risk to your rights and freedoms.

Because your notes may contain personal data for which **you** are the controller, we will notify
you of any breach affecting workspace content regardless of whether it meets the threshold for
notifying us — you need that information to meet your own obligations, and you will get it
promptly.

Report a suspected vulnerability to {{BRAND_CONTACT_SECURITY}}.

## 9. Your rights

Where the UK GDPR or the EU GDPR applies to our processing of your account data, you have the
right to:

- **Access** a copy of the personal data we hold about you.
- **Rectify** inaccurate data.
- **Erase** your data, subject to any legal obligation we have to retain it.
- **Restrict** or **object to** processing based on legitimate interests.
- **Portability** — receive your data in a structured, machine-readable format.
- **Withdraw consent**, where we rely on consent. We currently rely on consent for nothing.
- **Complain** to a supervisory authority. In the UK that is the Information Commissioner's
  Office; in the EU it is the authority in your member state.

In practice, two of these are built into the product and need no request: **export** produces your
entire account content as Markdown or PDF at any time, and **account deletion** is available
directly in your settings. For anything else, contact {{BRAND_CONTACT_PRIVACY}}. We respond
within one month.

We will not charge for these requests, and we will not ask why you are making one.

## 10. Changes to this notice

Material changes are notified to registered users by email at least 14 days before they take
effect. The effective date above is updated on every change. We will not introduce third-party
tracking, advertising or behavioural analytics; if that position ever changed it would be a
material change requiring notice, and you would be free to export and delete before it took
effect.

## 11. Contact

- Privacy, data protection and rights requests: {{BRAND_CONTACT_PRIVACY}}
- Security and vulnerability reports: {{BRAND_CONTACT_SECURITY}}
- Everything else: {{BRAND_DOMAIN}}
