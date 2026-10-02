# Security policy

SupOps runs commands on real servers, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker
could do with it. You will get an acknowledgement, and a fix or a plan, as soon as possible.

## What counts

Anything that lets someone do more than the risk engine and approvals should allow, for example:

- an action that runs without approval when it should need one, or a forbidden action that runs
- reaching a host, cluster or API that is not a registered target
- reading credentials, the master key or the database through the app
- bypassing sign-in, roles or the second-approver rule
- secrets appearing in logs, reports or the live stream unredacted

## Supported versions

Fixes go into the latest release on `main`. Please check you are on it before reporting.

## Running SupOps safely

- Put it on a private network or behind a VPN; do not expose it to the internet as is.
- Give each target the least privilege that works (a read-only user where you only investigate).
- Keep production targets marked as `prod`, so their changes always need approval.
- Back up the `supops-data` volume: it holds the encrypted credentials and the master key.
