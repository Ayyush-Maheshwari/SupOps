<div align="center">

# ⚡ SupOps

### Open-source AIOps that goes from **alert to root cause to fix**, with you approving every change.

AI root cause analysis, human-in-the-loop auto-remediation and predictive alerting, on top of the
Prometheus, Grafana and Alertmanager you already run. Self-hosted, and works with any model.

![Self-hosted](https://img.shields.io/badge/self--hosted-100%25-0A84FF?style=flat-square)
![Runs on Docker](https://img.shields.io/badge/docker-one%20command-2496ED?style=flat-square&logo=docker&logoColor=white)
![Node](https://img.shields.io/badge/node-%E2%89%A522-3C873A?style=flat-square&logo=node.js&logoColor=white)
![Model agnostic](https://img.shields.io/badge/LLM-Gemini%20%C2%B7%20Ollama%20%C2%B7%20OpenAI--compatible-8A63D2?style=flat-square)
![AIOps](https://img.shields.io/badge/AIOps-alert%20%E2%86%92%20fix-E5484D?style=flat-square)
![Human in the loop](https://img.shields.io/badge/risky%20actions-need%20approval-F5A623?style=flat-square)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)

</div>

---

## 👀 What it looks like

**Dashboard: everything at a glance, what's running, what's healthy, what's waiting on you.**

![SupOps dashboard](docs/images/dashboard.png)

<table>
<tr>
<td width="50%"><b>Approvals: the agent proposes, you decide.</b><br><img src="docs/images/approvals.png" alt="An approval waiting for a decision"></td>
<td width="50%"><b>Signals: every series watched, with a forecast of when it hits its limit.</b><br><img src="docs/images/signals.png" alt="A disk forecast on the Signals page"></td>
</tr>
<tr>
<td colspan="2"><b>Service map: built from your documents and architecture diagrams, confirmed against what is running.</b><br><img src="docs/images/service-map.png" alt="The service map in Knowledge"></td>
</tr>
</table>

---

## 🤔 What is SupOps?

SupOps is an AIOps platform that closes the loop your monitoring leaves open. Your observability
stack tells you something is wrong; SupOps works out why and fixes it:

- 🔎 **AI root cause analysis.** Related alerts become one incident, a fixed set of read-only checks
  gathers evidence from your metrics and logs, and the diagnosis cites that evidence for every claim.
- 🛠️ **Human-in-the-loop auto-remediation.** Fixes run over SSH or `kubectl`, and every change waits for
  your approval. Destructive commands are blocked outright.
- 📈 **Predictive alerting.** Every series of your key signals is watched, with anomaly detection and
  forecasts like *"disk full in 11 hours"*, before anyone gets paged.
- 🧠 **Runbook-aware.** Your runbooks and docs guide every run, and your service map is built from your
  documents and architecture diagrams.
- 🔒 **Self-hosted and LLM-agnostic.** Gemini, Ollama or any OpenAI-compatible model. Credentials and
  telemetry stay inside your infrastructure.
- ⚡ **Zero agents.** It plugs into Prometheus, Grafana, Alertmanager, Loki, Elasticsearch, Kubernetes
  and Slack. Nothing to install on your servers.

Most "AI for ops" tools stop at a paragraph of advice. SupOps goes one step further: it **runs
the commands**. You describe a symptom (*"checkout is returning 500s since 14:20"*), and an agent
SSHes into the right box, checks services, logs, disk, memory and recent changes, forms a
hypothesis from what it actually saw, and — where it's safe — fixes it.

The catch every ops person worries about ("an AI with root on prod?") is the part SupOps is built
around: **nothing dangerous happens without a human saying yes.**

- 🟢 **Read-only checks** (`df`, `systemctl status`, `kubectl get pods`) run instantly.
- 🟡 **State-changing actions** are classified by risk and, if they cross your policy, **pause and
  wait** — showing you the exact command, the agent's stated intent, and *why* it was flagged.
- 🔴 **Forbidden actions** (like `rm -rf /`) can never run, no matter who approves.

It's **project-agnostic**: install once, create a project, register *your* servers. Nothing about
any particular stack is hardcoded.

---

## 🚀 Get started in one command (Docker)

The whole app — API, live command stream, web UI, and its database — runs in a single container.
No config needed: it generates and persists its own secrets and creates the admin login on first
run. Nothing about your machine is baked into the image.

```bash
git clone https://github.com/Ayyush-Maheshwari/SupOps.git
cd SupOps
docker compose up --build      # first build takes a few minutes (it compiles a native SQLite module)
```

Then open **http://localhost:3001** and:

| Step | Where | What to do |
|---|---|---|
| 1️⃣ | Sign in | `admin@supops.local` / `supops` |
| 2️⃣ | **Settings** | Paste a model API key ([free Gemini key here](https://aistudio.google.com/apikey)) and hit **Test connection** |
| 3️⃣ | **Targets** | Register a server (host, user, SSH key/password — encrypted at rest) |
| 4️⃣ | **Investigate** | Describe a problem and press **Start** |

> 💾 Your data lives in the `supops-data` Docker volume, so `docker compose down && docker compose up`
> keeps everything. To wipe it and start fresh: `docker compose down -v`.

### 🏢 Only allow your company's email addresses

By default anyone can be given an account with any email address. For an internal deployment, set
`AUTH_ALLOWED_EMAIL_DOMAIN` and new accounts must use your domain:

**Docker Compose** — create `docker-compose.override.yml` next to `docker-compose.yml` (Compose
picks it up automatically, and it is git-ignored, so `git pull` never conflicts with it):

```yaml
services:
  supops:
    environment:
      AUTH_ALLOWED_EMAIL_DOMAIN: "yourcompany.com"
```

then `docker compose up -d` to restart with it (nothing is rebuilt; your data stays).

**Kubernetes** — add it to the `supops-env` secret and restart the pod
(see [k8s/README.md](k8s/README.md)):

```bash
kubectl -n supops patch secret supops-env --type merge \
  -p '{"stringData":{"AUTH_ALLOWED_EMAIL_DOMAIN":"yourcompany.com"}}'
kubectl -n supops rollout restart deploy/supops
```

- Several domains: separate them with commas (`yourcompany.com,partner.com`).
- It applies when an account is **created**. Existing accounts, including the first admin, keep
  signing in, so you can never lock yourself out.
- **Users** in the app shows whether the restriction is on and which domains are allowed.

### 🌐 Plain HTTP is fine

SupOps works over plain `http://<vm-ip>:3001`. Browsers treat any `http://` page as
insecure and flag its downloads, so there the report **PDF** and **.md** buttons open the
report in a new tab instead. Save it from the PDF viewer, or with Ctrl+S. Over HTTPS or on
`localhost` they download directly.

### 📲 Install it as an app

SupOps is a Progressive Web App. Browsers only allow installing from HTTPS or `localhost`.
On plain HTTP, allow it once per browser, with no certificate to install: open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` (or `edge://flags/...`), add
`http://<vm-ip>:3001`, and relaunch. This also removes the download warnings on that device.
An **Install app** button then appears at the bottom of the sidebar (the install icon in
the address bar works too). On an iPhone or iPad, use Safari's
**Share → Add to Home Screen**. The installed app opens in its own window with a short logo
intro, and has shortcuts to Investigate, Approvals, Health and Runs. Live data is never
cached: approvals, runs and health always come straight from the server.

---

## 🧭 How you actually use it

SupOps is organised around a few simple screens:

| Screen | What it's for |
|---|---|
| 🔎 **Investigate** | Describe a symptom → the agent finds the root cause and proposes/does the fix. One-shot. |
| 💬 **Console** | A back-and-forth assistant for everyday work ("how many pods are down on prod?"). You watch every command run live in the terminal panel. |
| 📈 **Observability** | Alerts grouped into incidents, each with an evidence pack and an automatic read-only diagnosis; signals watched for what is unusual and what is about to run out. |
| 📚 **Knowledge** | Runbooks, notes and facts every run is given, and the service map: what depends on what, from your documents and diagrams. |
| ❤️ **Health** | Antivirus-style scans of your fleet — **Quick** (fast essentials) or **Deep** (thorough AI investigation), run on demand or on a timer (15m–24h). Surfaces issues you can investigate in one click. |
| 🔔 **Alerts** | Alerts from Slack and from Alertmanager, Prometheus or Grafana connections, each already diagnosed read-only; Investigate starts the fix, with approval for every change. |
| ▶️ **Runs** | The full history of everything the agents did — each run's commands, outputs, risk, and outcome. Export a run as a shareable PDF/Markdown report. |
| 🛡️ **Approvals** | The queue of risky actions waiting on a human, plus a record of **who approved what**. |
| ⚙️ **Targets / Agents / Users / Settings** | Register servers, tune agents, manage teammate logins (admin only), and pick your model provider. |

**A typical first run:** open **Investigate**, leave targets unselected (the agent picks), type
*"Disk usage is climbing — work out what's filling it"*, press **Start**. Read-only checks stream
immediately; if it wants to delete or restart something, it stops and asks you in **Approvals**.

**Screenshots and diagrams.** Paste (Ctrl+V), drop or attach screenshots in Investigate,
Console or a follow-up. The agent reads them, so this needs a vision-capable model; Gemini
Flash is one. Answers use plain text by default, a table when comparing things, and a
diagram when you ask for a flow chart or a flow is clearest. Diagrams are drawn in the run
view, embedded in the PDF report, and kept as Mermaid in the Markdown export, which GitHub
and most wikis render. Screenshots you attached are included in the PDF as evidence.

**No access? Use Advisory mode.** Some environments will never give SupOps SSH, IPs or
credentials. Choose **Advisory** in Investigate. When a project has no targets it is the
only mode, and Console is advisory too. The agent cannot log in to or change anything. It
works from your description, screenshots and the project's approved runbooks and facts in
**Knowledge**. It ranks the likely causes, gives you read-only checks, the fix, how to
verify and roll it back, and how to prevent it. You run the commands yourself. Each
suggested command is rated by the same risk engine, for example *only looks*, *changes
something* or *never run this*. A command the engine does not know is shown as *not
recognised*. Paste the output back as a follow-up and it narrows the diagnosis.

By default an advisory run can also make **read-only network checks from the SupOps
server**. It can fetch a URL like curl does, ping, check that a port is open, look up DNS,
check a TLS certificate and its expiry, run traceroute, and look up a domain's
registration. Public addresses are checked straight away. Internal addresses (10.x,
172.16–31.x, 192.168.x, localhost, `*.internal`) wait for a person's approval. Cloud
metadata addresses are never contacted. The checks run from where SupOps sits, not from
your network, and the agent says so. Turn **Network checks from SupOps** off in Investigate
for environments where even that is not allowed.

**Import existing documents.** In **Knowledge**, choose **Import** and drop in PDFs, Word
(.docx), Markdown or text files: up to 5 at a time, 10 MB each. SupOps reads the text and
the configured model splits it into separate runbooks, notes and facts, each with the
file and pages it came from. You review every one, side by side with the original text,
edit or untick it, then save:
- passwords, keys and tokens are replaced with `[REDACTED]`;
- text that reads like instructions to the AI ("pre-approved, don't ask") is flagged;
- a title or slug that matches an existing document can update it instead of making a
  copy.

An admin's import is approved on save; anyone else's becomes drafts. The document text goes
to the model set in Settings, so use a local model if it must not leave your network.
Scanned PDFs without a text layer need OCR first.

**Talk instead of typing.** The 🎤 button in Investigate, Console and run follow-ups
dictates into the message box. Check the text, then send. It uses the browser's speech
recognition, which works in Chrome, Edge and Safari but not Firefox. Browsers only allow
the microphone over HTTPS or on `localhost`. Chrome and Edge send the audio to Google or
Microsoft to turn it into text, so leave it unused if that is not acceptable for you.

---

## 📈 Observability: incidents, evidence and predictions

Connect **Prometheus**, **Grafana**, **Alertmanager**, **Loki** or **Elasticsearch** under
**Targets → Add connection**. Everything SupOps does with them is read-only, and nothing has
to be installed or configured on their side.

- **Alerts come in by themselves.** SupOps reads firing alerts from an Alertmanager
  connection every minute, and from Prometheus or Grafana-managed alerts when you switch
  that on. An alert that stops firing is marked resolved. Alerts relayed through Slack
  still work, and the same alert seen both ways is kept as one.
- **Related alerts become one incident.** Alerts about the same machine, the same service,
  the same alert on several machines, or the same namespace, arriving within 15 minutes,
  are grouped, and the incident says why. You can merge or split incidents.
- **Evidence first.** When an incident opens, a fixed set of read-only checks runs against
  your metrics and logs, scoped to the incident's machine or namespace. It checks other
  firing alerts, CPU, load, memory, disk and disks about to fill, OOM kills, restarts and
  crash loops, CPU throttling, recent deploys, the 5xx rate against last week, how
  unusual things are compared with yesterday, and error log lines grouped into patterns.
  Checks whose metrics you do not collect are listed as not measured.
- **Diagnosed as it arrives.** Every alert gets a read-only diagnosis automatically, the way
  a health scan runs: nothing that needs approval can run in it. It begins from the evidence
  and must cite it (`[E2]`), and "inconclusive" is an allowed answer. A citation to evidence
  that does not exist is flagged. The alert and its incident show the root cause and
  confidence while the alert stays **New** for you to decide.
- **Investigate starts the fix.** Clicking **Investigate** on the alert or incident starts a
  run that builds on that diagnosis instead of repeating it, proposes the fix, and waits for
  your approval on every change. While the diagnosis is still running, Investigate opens it.
  Limit automatic diagnosis by severity or runs per hour, or switch it off, in
  **Settings → Observability**.
- **Every series watched, worst first.** SupOps finds the key signals on your metrics
  connection: CPU, memory, disk and inodes, load, network errors, pod restarts, volumes, 5xx
  rate and latency, certificate expiry, and the monitoring stack itself. You can add your own
  PromQL. Every 5 minutes it checks **every** series of each one, up to 2,000. The metrics
  backend works out each one's last day, its value this time yesterday and its trend, so no
  series is left out for want of storage. Each series gets a score for how close it is to
  trouble, with the reason in words, for example "runs out in 12h", "+6σ vs last day" or
  "1.9, at or above 1.5".
- **The Signals page** lists every watched query under its headline (Resources, Kubernetes,
  Traffic, Monitoring stack, Custom), with what needs a look on top. Pick one and its graph
  shows all its series together, up to 50; pick a series for its own graph with its usual
  range, where it is heading and when it reaches its limit, as a date. **Investigate** on a
  series diagnoses it and proposes the fix, with your approval for every change.
- **Predictions.** Something unusual is reported once it has held for two checks and is unlike
  this time yesterday, so a nightly job is not news every night. A resource heading for its
  limit within 24 hours opens an incident before any alert fires.
- **Check the stack itself.** **Observability → Check the stack**, or **Investigate the
  stack itself** in Investigate, checks that monitoring works: scrape targets, rule
  evaluation, notification delivery, config reloads, storage and log ingestion.
- **Runs keep their metrics.** A run limited to one machine still reads the metrics,
  logs and alerts about it, and Advisory runs can read them too.

Closed alerts and incidents, observations and metric samples are kept for 15 days (change it
in **Settings → Observability**). Open ones are never removed.

---

## 🗺️ Service map

**Knowledge → Service map** shows what depends on what: load balancers, services, databases,
queues and the machines they run on. Click a component to see what breaks if it fails and what
it relies on. Runs and incident diagnoses are given the connected systems as context, and alerts
on related systems join one incident.

- **Built from what you describe.** The model reads your approved documents, and every change it
  finds comes back as a suggestion with the quote behind it, for you to accept or reject.
- **From an architecture diagram.** **From a diagram** takes a draw.io file (read exactly, no model
  needed), a picture of a diagram (PNG, JPG or SVG, read by a vision model), or Mermaid, PlantUML
  or Graphviz text. What it shows becomes suggestions too.
- **Confirmed live.** **Check live** compares the map with registered targets, connections on your
  machines, Kubernetes and metrics. It never adds anything on its own: it marks connections as
  confirmed, and flags a documented one that is not there (*documented, not seen*).
- **Editable.** Add, edit, merge or remove components and connections. Entries a person edits are
  never overwritten automatically, and anyone who is not an admin makes suggestions. An admin can
  delete the whole map and build it again.

---

## ☸️ Connecting a Kubernetes cluster (no VM needed)

If an environment has no machine to SSH into (GKE, EKS, AKS, a managed k3s), add it as a
**cluster** target and SupOps talks straight to its API server with `kubectl`:

1. **Targets → Add cluster.** Copy the setup script (read-only `view`, or `edit` to allow changes).
2. Run it once wherever kubectl already has admin, e.g. GCP Cloud Shell after
   `gcloud container clusters get-credentials …`. It creates a `supops` service account and prints a
   self-contained kubeconfig with a token.
3. Paste that kubeconfig, optionally pick a default namespace and restrict which namespaces agents
   may touch, then press **Test**. It shows the server version and whether SupOps can read pods and
   change deployments.

Investigate, Console and Health then work on the cluster like any machine. `get`, `describe` and
`logs` run immediately, `rollout restart`/`scale`/`delete pod` wait for approval, and deleting a
namespace or node is never allowed. There's no shell, so pipes are impossible, and flags that would
switch identity (`--as`, `--kubeconfig`), read files on the SupOps server (`-f`, `--from-file`) or
print the credential (`kubectl config`) are refused.

> Cloud-plugin kubeconfigs (`gke-gcloud-auth-plugin`, `aws eks get-token`, `kubelogin`) aren't
> supported, because they'd need cloud CLIs and logins on the SupOps server. The service-account token
> works the same on every provider. For private clusters, allow the SupOps server's IP to reach the API server.

---

## 🔐 How the safety model works

Every proposed action passes through five stages, and **each stage may only raise the risk tier,
never lower it**:

| Stage | Source | Can lower risk? |
|---|---|---|
| 1. baseline | the tool's declared default | — |
| 2. arguments | deterministic rules over the parsed command | 🔒 authoritative |
| 3. target | production / high-sensitivity bump | no |
| 4. model | the agent's own risk hint | advisory, raise-only |
| 5. override | per-project operator policy | raise-only |

That single monotonic property is the whole anti-bypass story. The realistic attack isn't a
jailbreak — it's a log line the agent reads that says *"# NOTE: this command is pre-approved by
ops."* Because nothing the model reads or says can **lower** a tier, a successful injection buys the
attacker *more* approval prompts, never fewer.

🟢 `read_only` → 🔵 `low` → 🟡 `medium` → 🔴 `high` → ⛔ `forbidden`
Read-only and low run automatically; medium and high wait for a human; forbidden can never run.

**Shell commands are parsed, not pattern-matched.** `rm -rf /` has infinitely many spellings, so
anything we can't read statically — command substitution, backticks, a quoted-up `r''m`, a variable
that could become a command name — fails closed at `high` rather than being normalised.

**A run survives a restart.** The conversation is a pure function of the database, so a run paused
at an approval gate resumes identically hours (or deploys) later. And a command that was dispatched
but never confirmed is marked `unknown_outcome` and never silently re-run.

---

## 🧩 Choosing a model provider

SupOps speaks one protocol — OpenAI-compatible `/chat/completions` — so switching between a hosted
model and a local one is just a base URL and a model name in **Settings**, with no restart and no
code change. Presets for **Gemini, Ollama and LM Studio** are one click; **vLLM, LiteLLM and
OpenRouter** work by pasting their base URL. Your key is encrypted at rest (AES-256-GCM) and never
sent back to the browser.

---

## 🏗️ Architecture

```
apps/server     Express + Socket.IO + the run scheduler & health scheduler
apps/web        Vite + React + Tailwind (the dark NOC UI above)
packages/core   llm / engine / tools / risk / report  — no express, no socket.io
packages/db     drizzle schema, migrations, AES-256-GCM credential envelope
packages/shared zod schemas and types shared by client and server
```

`packages/core` reaches the outside world only through an injected event sink, so the engine stays
independent of the transport around it.

**Risk rules.** Every command the agent proposes goes through the rules in `packages/core/src/risk`.
The approval card shows the reason for each verdict and the kind of harm involved (for example
*Lockout risk* or *Data destruction*), plus a flag when the effect can't be undone. If a rule
misfires on a live install, set `SUPOPS_RISK_RULES=legacy` in `.env` and restart to go back to the
previous rule set. `parity.test.ts` checks that the current rules are never looser than the legacy
ones, except for the reads listed on purpose in `corpus.ts`. Coverage spans host commands
(files, services, accounts, firewall, disks, packages, kernel), containers/Kubernetes, databases
(`psql`/`mysql`/`sqlite3`, `redis-cli`, `mongosh`, dump/restore) and cloud control planes
(`aws`, `gcloud`/`gsutil`, `az`, `terraform`/`tofu`/`pulumi`); on a production target, an
irreversible delete of a database, bucket, cluster or stack is forbidden rather than approvable.
Commands that would cut SupOps off from the host (stopping `sshd`, a default-drop firewall, a
glob that removes the login account's home) or switch off its audit logging, and containers handed
the host (`--privileged`, the docker socket, a host mount or a dangerous capability), are refused
outright; anything that prints live credentials — a key file, a cloud token, `keyvault secret show`
— pauses for a human rather than running as a free read. Flags never hide the verb: `mysqladmin -u
root drop`, `kubectl --context prod delete namespace` and `git -C repo push --force` are read for
what they do, not what the first word after the flags happens to be.

---

## 🛠️ Local development

```bash
npm install
cp .env.example .env
sed -i "s|^SUPOPS_MASTER_KEY=.*|SUPOPS_MASTER_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env

npm run seed     # creates admin@supops.local / supops, a project, and the built-in agents
npm run dev      # web on :3000, api on :3001
```

| Command | Does |
|---|---|
| `npm run dev` | both apps, hot reload |
| `npm test` | the full test suite (no build step) |
| `npm run typecheck` | type-check every package |
| `npm run db:generate` | regenerate a migration after changing `packages/db/src/schema` |

The risk ruleset's test table in `packages/core/src/risk/shell.test.ts` is the real specification for
what may run unattended — extend it alongside the rules.

---

## 📦 What's built

✅ Durable agent loop with crash recovery · five-stage risk engine · approval suspend/resume with
roles and a second-approver option · configurable autonomy per project and agent · SSH execution
(with jump-host support) · Kubernetes cluster targets · Prometheus, Grafana, Loki, Elasticsearch
and Alertmanager connections · alert import, incident grouping, evidence packs and automatic read-only diagnosis · anomaly detection and resource forecasts · service map from documents and architecture diagrams, confirmed live · encrypted credentials · live run streaming · health scans (quick &
deep, scheduled or manual) · knowledge base of runbooks, notes and facts · feedback and corrections
on agent replies · automatic run-history clean-up · multiple user accounts · one-command Docker
image · shareable PDF/Markdown run reports · installable web app.

🔜 Cloud accounts (AWS, GCP, Azure) through a sandboxed toolbox · GitHub/GitLab and CI/CD ·
multi-step scripts with per-line risk checks · rules learned from past denials.

---

## 🤝 Contributing

Contributions are welcome, from a typo fix to a new risk rule. Fork the repository, make your change
on a branch, and open a pull request against `main`; the checks run on it automatically. Good first
contributions are new risk rules with test cases, evidence checks for more exporters, and docs.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the details.

If SupOps is useful to you, a ⭐ helps other teams find it. Please report security problems
privately, as described in [SECURITY.md](SECURITY.md), and follow the
[code of conduct](CODE_OF_CONDUCT.md).

## 📄 License and credits

SupOps is created by **[Ayush Maheshwari](https://github.com/Ayyush-Maheshwari)** and released
under the [Apache License 2.0](LICENSE): you may use, change and share it, including commercially.
If you redistribute it or a version of it, keep the [NOTICE](NOTICE) file, which credits the
original project. The SupOps name and logo are not covered by the licence, so a modified version
needs its own name; "based on SupOps" is welcome.
