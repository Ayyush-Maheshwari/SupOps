#!/usr/bin/env bash
# End-to-end check of the alert -> diagnose -> propose -> approve -> act loop,
# driven entirely through the public HTTP API.
set -euo pipefail
API=${API:-http://localhost:3099/api}

j() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

TOKEN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@supops.local","password":"supops"}' | j "d['token']")
AUTH="Authorization: Bearer $TOKEN"

PROJ=$(curl -s "$API/projects" -H "$AUTH" | j "d[0]['id']")
AGENT=$(curl -s "$API/agents?projectId=$PROJ" -H "$AUTH" | j "d[0]['id']")

# A target that refuses connections instantly, so the test does not wait on a timeout.
curl -s -X POST "$API/targets" -H "$AUTH" -H 'Content-Type: application/json' -d "{
  \"projectId\":\"$PROJ\",\"slug\":\"web-1\",\"name\":\"web-1\",\"env\":\"staging\",
  \"description\":\"nginx front end\",
  \"config\":{\"kind\":\"ssh\",\"host\":\"127.0.0.1\",\"port\":1,\"user\":\"ops\",\"sudo\":false},
  \"secret\":\"test-secret-value\"}" > /dev/null

RUN=$(curl -s -X POST "$API/runs" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJ\",\"agentId\":\"$AGENT\",\"task\":\"checkout is returning 500s\"}" | j "d['id']")
echo "run $RUN"

wait_for() {
  for _ in $(seq 1 40); do
    s=$(curl -s "$API/runs/$RUN" -H "$AUTH" | j "d['run']['status']")
    [ "$s" = "$1" ] && return 0
    sleep 0.5
  done
  echo "TIMEOUT waiting for status=$1 (still $s)" >&2
  return 1
}

echo
echo "== 1. agent investigates, then proposes a restart =="
wait_for awaiting_approval
curl -s "$API/runs/$RUN" -H "$AUTH" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for c in d['toolCalls']:
    print(f\"  {c['toolKey']:16} tier={c['tier'] or '-':10} state={c['state']}\")
    if c['renderedCommand']: print(f'    \$ {c[\"renderedCommand\"]}')
"

echo
echo "== 2. the read-only finding already ran; the restart is held =="
CALL=$(curl -s "$API/runs/approvals/pending" -H "$AUTH" | j "d[0]['toolCall']['id']")
curl -s "$API/runs/approvals/pending" -H "$AUTH" | python3 -c "
import sys,json
for a in json.load(sys.stdin):
    c=a['toolCall']
    print('  awaiting:', c['renderedCommand'], '| tier:', c['tier'])
    print('  why     :', '; '.join(x['reason'] for x in c['riskJson']['contributions'] if x['tier']!='read_only'))
    print('  intent  :', c['argsJson'].get('intent'))
"

echo
echo "== 3. a human approves =="
curl -s -X POST "$API/runs/tool-calls/$CALL/decision" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"decision":"approve","comment":"go ahead, traffic is already degraded"}'
echo

echo
echo "== 4. the run resumes and finishes =="
wait_for succeeded
curl -s "$API/runs/$RUN" -H "$AUTH" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d['run']
print('  status :', r['status'], '| steps:', r['iteration'], '| tokens:', r['promptTokens']+r['completionTokens'])
print()
print('  conversation the model finally saw:')
for s in d['steps']:
    m=s['messageJson']; role=m['role']
    if role=='system': body='<system prompt>'
    elif m.get('tool_calls'): body='calls: '+', '.join(t['function']['name'] for t in m['tool_calls'])
    else: body=(m.get('content') or '').replace(chr(10),' ')[:88]
    print(f'    {s[\"seq\"]:>2} {role:<9} {body}')
"
