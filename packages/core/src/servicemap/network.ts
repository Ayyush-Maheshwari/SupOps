/**
 * What a machine is actually talking to: `ss` output parsed into listening ports and
 * established connections, and well-known ports named. Read-only commands; the
 * output is plain text, so this is parsed defensively and anything odd is skipped.
 */

export interface Listen {
  port: number;
  process: string | null;
}

export interface Conn {
  localPort: number;
  peer: string;
  peerPort: number;
  process: string | null;
}

const addrPort = (s: string): { host: string; port: number } | null => {
  const m = s.match(/^\[?([^\]]*?)\]?:(\d+|\*)$/);
  if (!m || m[2] === '*') return null;
  return { host: m[1]!.replace(/^::ffff:/, ''), port: Number(m[2]) };
};
const proc = (s: string | undefined) => s?.match(/users:\(\("([^"]+)"/)?.[1] ?? null;

/** `ss -tlnpH` (or without -p): one LISTEN line per port. */
export function parseListening(out: string): Listen[] {
  const seen = new Map<number, Listen>();
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || (cols[0] !== 'LISTEN' && !/^\d/.test(cols[0]!))) continue;
    const local = addrPort(cols[0] === 'LISTEN' ? cols[3]! : cols[2]!);
    if (!local) continue;
    // Loopback-only listeners serve the machine itself, not the network.
    if (/^(127\.|::1$|localhost)/.test(local.host)) continue;
    if (!seen.has(local.port)) seen.set(local.port, { port: local.port, process: proc(line) });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

/** `ss -tnpH state established`: who this machine talks to. */
export function parseConnections(out: string): Conn[] {
  const conns = new Map<string, Conn>();
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    // With a state filter there is no state column: Recv-Q Send-Q Local Peer [Process].
    const off = /^\d/.test(cols[0]!) ? 0 : 1;
    const local = addrPort(cols[2 + off] ?? '');
    const peer = addrPort(cols[3 + off] ?? '');
    if (!local || !peer) continue;
    if (/^(127\.|::1$)/.test(peer.host)) continue;
    const c = { localPort: local.port, peer: peer.host, peerPort: peer.port, process: proc(line) };
    conns.set(`${c.localPort}|${c.peer}|${c.peerPort}`, c);
  }
  return [...conns.values()];
}

/** Well-known ports: what is probably listening there. */
export const WELL_KNOWN: Record<number, { name: string; type: 'database' | 'cache' | 'queue' | 'service' | 'load_balancer' | 'monitoring' | 'storage' }> = {
  5432: { name: 'postgresql', type: 'database' },
  3306: { name: 'mysql', type: 'database' },
  27017: { name: 'mongodb', type: 'database' },
  1433: { name: 'mssql', type: 'database' },
  1521: { name: 'oracle', type: 'database' },
  9042: { name: 'cassandra', type: 'database' },
  6379: { name: 'redis', type: 'cache' },
  11211: { name: 'memcached', type: 'cache' },
  5672: { name: 'rabbitmq', type: 'queue' },
  9092: { name: 'kafka', type: 'queue' },
  4222: { name: 'nats', type: 'queue' },
  1883: { name: 'mqtt', type: 'queue' },
  9200: { name: 'elasticsearch', type: 'database' },
  8086: { name: 'influxdb', type: 'database' },
  9000: { name: 'minio', type: 'storage' },
  2049: { name: 'nfs', type: 'storage' },
  9090: { name: 'prometheus', type: 'monitoring' },
  9093: { name: 'alertmanager', type: 'monitoring' },
  3000: { name: 'grafana', type: 'monitoring' },
  3100: { name: 'loki', type: 'monitoring' },
  8428: { name: 'victoriametrics', type: 'monitoring' },
};

/** Ports that are plumbing rather than a service someone depends on. */
export const IGNORED_PORTS = new Set([22, 53, 111, 123, 9100, 9256, 9182, 10250, 10255, 2379, 2380]);
