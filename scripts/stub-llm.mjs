/**
 * A stub OpenAI-compatible endpoint.
 *
 * Lets the end-to-end test drive an exact sequence of agent decisions -- including
 * one that must be held for approval -- without spending quota or depending on a
 * real model choosing to do the thing we want to test.
 */
import { createServer } from 'node:http';

const SCRIPT = [
  {
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'record_finding',
          arguments: JSON.stringify({
            target: 'web-1',
            finding: 'nginx worker pool is saturated; requests queue then time out.',
            severity: 'warning',
          }),
        },
      },
    ],
  },
  {
    content: null,
    tool_calls: [
      {
        id: 'call_2',
        type: 'function',
        function: {
          name: 'ssh_exec',
          arguments: JSON.stringify({
            target: 'web-1',
            command: 'systemctl restart nginx',
            intent: 'Clear the saturated worker pool so requests stop timing out.',
            expected_effect: 'nginx returns to active (running) and 500s stop.',
          }),
        },
      },
    ],
  },
  { content: 'nginx was restarted. I verified it is active and the 500s have stopped.', tool_calls: [] },
];

let turn = 0;

createServer((req, res) => {
  if (!req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end('{}');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const message = SCRIPT[Math.min(turn++, SCRIPT.length - 1)];
    const payload = {
      id: `chatcmpl-${turn}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'stub-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', ...message },
          finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
  });
}).listen(4545, () => console.log('stub llm on :4545'));
