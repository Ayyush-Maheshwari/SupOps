# Contributing to SupOps

Thanks for helping. Bug reports, fixes, new risk rules and documentation are all welcome.

## Getting set up

You need Node.js 22 or newer.

```bash
npm install
npm test                          # unit and engine tests (node --test)
npm run typecheck                 # every package
npm run build --workspace=@supops/web   # the web build
```

`README.md` explains how to run the whole app with Docker, and `scripts/stub-llm.mjs` gives you a
fake model for trying things without an API key.

## Before you open a pull request

- **Tests pass and every package typechecks.** Add a test for the bug you fix or the rule you add.
- **The risk engine only ever raises.** Each stage may make an action riskier, never safer. New
  rules come with test cases, and the existing corpus, parity and fuzz tests must stay green.
- **No real infrastructure in code.** Use made-up hosts and addresses in tests and examples
  (`10.0.0.5`, `203.0.113.10`, `web-1`, `example.com`): never your own IPs, hostnames, company or
  people's names, and never a real key or token, even an expired one.
- **Keep changes focused.** One fix or feature per pull request, matching the style of the code
  around it.
- **Describe the why.** Say what problem the change solves and how you checked it.

## Reporting bugs and ideas

Open an issue with what you expected, what happened, and how to reproduce it. For anything
security-related, follow [SECURITY.md](SECURITY.md) instead.

## Licence

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), like the rest of the project, and that the attribution in
[NOTICE](NOTICE) stays as it is.
