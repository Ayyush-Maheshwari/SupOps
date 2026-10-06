import { execFile } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, isIP } from 'node:net';
import type { LookupFunction, Socket } from 'node:net';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import type { PeerCertificate, TLSSocket } from 'node:tls';
import { z } from 'zod';
import type { RiskContribution } from '@supops/shared';
import type { ToolOutput } from '@supops/db';
import type { ResolvedTarget, ToolDef } from './types.ts';
import { addressProblem, BlockedAddressError, guardLookup } from './executors/http.ts';

/**
 * Network checks from the SupOps server, for advisory runs that have no access to any
 * system: the curl / ping / dig / openssl s_client / traceroute / whois an engineer
 * would run first, answered from where SupOps sits.
 *
 * Everything is read-only, and the address is checked at connect time, inside the
 * lookup the socket actually uses (no rebinding a public name to an internal IP):
 *  - cloud metadata and link-local addresses are never contacted;
 *  - internal addresses (10/8, 172.16/12, 192.168/16, loopback, CGNAT, ULA) only when
 *    the call says `allow_private`, which raises it to an approval -- so the agent
 *    cannot map your network from the SupOps server without a person agreeing;
 *  - HTTP is GET or HEAD only, redirects are followed hop by hop through the same
 *    check, and the body read is capped.
 */

/** The virtual target these checks run "on": the SupOps server itself. */
export const NETWORK_TARGET: ResolvedTarget = {
  id: 'supops-server',
  slug: 'supops-server',
  kind: 'http',
  env: 'dev',
  sensitivity: 0,
  description: 'SupOps itself: network checks run from here (not from the operator\'s network), and project knowledge is read here.',
  config: { kind: 'http', baseUrl: 'http://supops-server.invalid', allowPrivateNetwork: false },
  credentialId: null,
  protectedPaths: null,
  writablePaths: null,
  unitAllowlist: null,
};

export const isNetworkTarget = (t: { id: string }) => t.id === NETWORK_TARGET.id;

const CHECKS = ['http', 'ping', 'tcp', 'dns', 'tls', 'traceroute', 'whois'] as const;
const RECORDS = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'SRV', 'CAA', 'PTR', 'ANY'] as const;
/** A hostname or IP, nothing that could be read as an option or a path. */
const HOST = /^(?=.{1,253}$)(?!-)[a-zA-Z0-9_.:-]+$|^\[[0-9a-fA-F:.]+\]$/;

const args = z
  .object({
    target: z.string(),
    check: z.enum(CHECKS),
    url: z.string().max(2000).optional(),
    host: z.string().max(253).regex(HOST, 'host must be a hostname or IP address').optional(),
    port: z.number().int().min(1).max(65535).optional(),
    method: z.enum(['GET', 'HEAD']).optional(),
    record_type: z.enum(RECORDS).optional(),
    resolver: z.string().max(64).regex(HOST).optional(),
    count: z.number().int().min(1).max(5).optional(),
    max_hops: z.number().int().min(1).max(30).optional(),
    insecure: z.boolean().optional(),
    allow_private: z.boolean().optional(),
  })
  .superRefine((a, ctx) => {
    if (a.check === 'http' && !a.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'http needs a url' });
    if (a.check !== 'http' && !a.host) ctx.addIssue({ code: 'custom', path: ['host'], message: `${a.check} needs a host` });
    if (a.check === 'tcp' && !a.port) ctx.addIssue({ code: 'custom', path: ['port'], message: 'tcp needs a port' });
  });
type Args = z.infer<typeof args>;

const MAX_OUT = 12_000;
const ok = (text: string): ToolOutput => ({ ok: true, text: text.length > MAX_OUT ? `${text.slice(0, MAX_OUT)}\n… (truncated)` : text });
const fail = (text: string): ToolOutput => ({ ok: false, text });

const bare = (h: string) => h.replace(/^\[|\]$/g, '');
const hostOf = (a: Args): string => {
  if (a.check !== 'http') return bare(a.host!);
  try {
    return bare(new URL(a.url!).hostname);
  } catch {
    return '';
  }
};

/** Names that only make sense inside a private network. */
const INTERNAL_NAME = /^(localhost|[^.]+)$|\.(local|localdomain|internal|intranet|lan|home|corp|private|svc|cluster\.local)$/i;

function privateLooking(host: string): boolean {
  if (isIP(host)) return addressProblem(host, false) !== null;
  return INTERNAL_NAME.test(host);
}

function classify(a: Args): RiskContribution[] {
  const host = hostOf(a);
  if (isIP(host) && addressProblem(host, true)) {
    return [{ stage: 'arguments', tier: 'forbidden', ruleId: 'net.metadata', reason: `${host} is a link-local or cloud-metadata address; it is never contacted` }];
  }
  if (a.allow_private || privateLooking(host)) {
    return [{ stage: 'arguments', tier: 'medium', ruleId: 'net.internal', reason: `checks an internal address (${host}) from the SupOps server, which needs a person's approval` }];
  }
  return [{ stage: 'arguments', tier: 'read_only', ruleId: 'net.public', reason: `read-only ${a.check} check of a public address` }];
}

class PrivateAddressError extends Error {}

/**
 * Whether this call may reach internal addresses. Either the agent asked for it, or the
 * host is plainly internal -- both classify as needing approval, so by the time the
 * call runs a person has agreed. A public-looking name that turns out to resolve
 * internally was not approved for that, and is refused at connect time.
 */
const mayReachPrivate = (a: Args): boolean => !!a.allow_private || privateLooking(hostOf(a));

/** The lookup every socket here uses: metadata always refused, internal only when allowed. */
export function guarded(allowPrivate: boolean): LookupFunction {
  return guardLookup((ip, hostname) => {
    if (addressProblem(ip, true)) return new BlockedAddressError(`${hostname} resolves to ${ip}, a link-local or cloud-metadata address, which is never contacted`);
    if (!allowPrivate && addressProblem(ip, false)) return new PrivateAddressError(`${hostname} resolves to ${ip}, an internal address`);
    return null;
  });
}

/** Resolve once, applying the same rules, for tools that take an IP (ping, traceroute). */
function resolveChecked(host: string, allowPrivate: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    guarded(allowPrivate)(host, { family: 0 }, (err, address) => (err ? reject(err) : resolve(String(address))));
  });
}

/**
 * A literal IP never goes through the lookup, so the same rules are applied to it here
 * before any socket opens.
 */
function literalRefusal(host: string, allowPrivate: boolean): ToolOutput | null {
  if (!isIP(host)) return null;
  if (addressProblem(host, true)) return fail(`${host} is a link-local or cloud-metadata address; it is never contacted`);
  if (!allowPrivate && addressProblem(host, false)) return needsApproval(host, new PrivateAddressError(`${host} is an internal address`));
  return null;
}

const needsApproval = (host: string, err: unknown) =>
  err instanceof PrivateAddressError
    ? fail(`${err.message}. Checks of internal addresses need a person's approval: call net_check again with allow_private: true and say in your reply why it is needed.`)
    : null;

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const hints: Record<string, string> = {
      ENOTFOUND: 'the name does not resolve (NXDOMAIN or no such host)',
      EAI_AGAIN: 'DNS lookup timed out or failed temporarily',
      ECONNREFUSED: 'connection refused: the host is up but nothing listens on that port',
      ETIMEDOUT: 'timed out: filtered by a firewall, or the host is down',
      EHOSTUNREACH: 'host unreachable from the SupOps server',
      ENETUNREACH: 'network unreachable from the SupOps server',
      ECONNRESET: 'connection reset by the peer',
      CERT_HAS_EXPIRED: 'the TLS certificate has expired',
    };
    return code && hints[code] ? `${code}: ${hints[code]}` : err.message;
  }
  return String(err);
}

// ---- http -------------------------------------------------------------------

const SHOWN_HEADERS = ['server', 'content-type', 'content-length', 'location', 'cache-control', 'strict-transport-security', 'x-powered-by', 'via', 'x-cache', 'retry-after', 'www-authenticate', 'date'];

interface Hop { url: string; status: number; ms: { dns?: number; connect?: number; tls?: number; ttfb: number; total: number }; headers: Record<string, string>; body: string; truncated: boolean; ip?: string; cert?: string }

function httpHop(url: URL, a: Args, signal: AbortSignal, maxBody = 2048): Promise<Hop> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const t0 = performance.now();
  const ms: Hop['ms'] = { ttfb: 0, total: 0 };
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: a.method ?? 'GET',
        headers: { 'user-agent': 'SupOps-net-check/1.0', accept: '*/*' },
        lookup: guarded(mayReachPrivate(a)),
        timeout: 15_000,
        signal,
        ...(url.protocol === 'https:' ? { rejectUnauthorized: !a.insecure, servername: isIP(bare(url.hostname)) ? undefined : url.hostname } : {}),
        agent: false,
      },
      (res) => {
        ms.ttfb = Math.round(performance.now() - t0);
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          if (size >= maxBody) { truncated = true; res.destroy(); return; }
          chunks.push(c);
          size += c.length;
        });
        const sock = res.socket as TLSSocket | null;
        const cert = sock && 'getPeerCertificate' in sock ? summariseCert(sock.getPeerCertificate(), url.hostname) : undefined;
        const done = () => {
          ms.total = Math.round(performance.now() - t0);
          const headers: Record<string, string> = {};
          for (const h of SHOWN_HEADERS) if (res.headers[h] !== undefined) headers[h] = String(res.headers[h]);
          const type = String(res.headers['content-type'] ?? '');
          const raw = Buffer.concat(chunks).subarray(0, maxBody);
          const text = /text|json|xml|html|javascript/.test(type) || !type ? raw.toString('utf8') : `(${raw.length} bytes of ${type})`;
          resolve({ url: url.toString(), status: res.statusCode ?? 0, ms, headers, body: text, truncated: truncated || size > maxBody, ip: sock?.remoteAddress, cert });
        };
        res.on('end', done);
        res.on('close', done);
        res.on('error', reject);
      },
    );
    req.on('socket', (s: Socket) => {
      s.on('lookup', () => (ms.dns = Math.round(performance.now() - t0)));
      s.on('connect', () => (ms.connect = Math.round(performance.now() - t0)));
      s.on('secureConnect', () => (ms.tls = Math.round(performance.now() - t0)));
    });
    req.on('timeout', () => req.destroy(new Error('no response within 15s')));
    req.on('error', reject);
    req.end();
  });
}

async function checkHttp(a: Args, signal: AbortSignal): Promise<ToolOutput> {
  let url: URL;
  try {
    url = new URL(a.url!);
  } catch {
    return fail(`not a valid URL: ${a.url}`);
  }
  const hops: Hop[] = [];
  for (let i = 0; i < 6; i++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail(`only http and https URLs can be checked (got ${url.protocol})`);
    if (url.username || url.password) return fail('URLs with credentials in them are not checked');
    const host = bare(url.hostname);
    const refused = literalRefusal(host, mayReachPrivate(a));
    if (refused) return refused;
    let hop: Hop;
    try {
      hop = await httpHop(url, a, signal);
    } catch (err) {
      const gated = needsApproval(host, err);
      if (gated) return gated;
      return fail([...hops.map(fmtHop), `${a.method ?? 'GET'} ${url} -> failed: ${describeError(err)}`].join('\n\n'));
    }
    hops.push(hop);
    const loc = hop.headers.location;
    if (hop.status >= 300 && hop.status < 400 && loc) {
      url = new URL(loc, url);
      continue;
    }
    break;
  }
  return ok(hops.map(fmtHop).join('\n\n') + (hops.length > 1 ? `\n\nRedirects: ${hops.length - 1}` : ''));
}

function fmtHop(h: Hop): string {
  const t = h.ms;
  const timing = [t.dns !== undefined && `dns ${t.dns}ms`, t.connect !== undefined && `connect ${t.connect}ms`, t.tls !== undefined && `tls ${t.tls}ms`, `first byte ${t.ttfb}ms`, `total ${t.total}ms`].filter(Boolean).join(', ');
  return [
    `${h.url} -> HTTP ${h.status}${h.ip ? ` (from ${h.ip})` : ''}`,
    `timing: ${timing}`,
    ...Object.entries(h.headers).map(([k, v]) => `${k}: ${v}`),
    ...(h.cert ? [`certificate: ${h.cert}`] : []),
    ...(h.body ? [`body${h.truncated ? ' (first 2 KB)' : ''}:\n${h.body}`] : []),
  ].join('\n');
}

// ---- tls --------------------------------------------------------------------

function summariseCert(c: PeerCertificate, host: string): string {
  if (!c || !c.valid_to) return 'none presented';
  const days = Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86_400_000);
  const matches = isIP(bare(host)) ? '' : checkServerIdentity(host, c) ? '; DOES NOT match the hostname' : '; matches the hostname';
  return `${c.subject?.CN ?? '?'} issued by ${c.issuer?.O ?? c.issuer?.CN ?? '?'}, expires ${c.valid_to} (${days < 0 ? `EXPIRED ${-days} days ago` : `${days} days left`})${matches}`;
}

function checkTls(a: Args, signal: AbortSignal): Promise<ToolOutput> {
  const host = bare(a.host!);
  const port = a.port ?? 443;
  const refused = literalRefusal(host, mayReachPrivate(a));
  if (refused) return Promise.resolve(refused);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const s = tlsConnect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, lookup: guarded(mayReachPrivate(a)), timeout: 10_000 });
    signal.addEventListener('abort', () => s.destroy(), { once: true });
    s.once('secureConnect', () => {
      const c = s.getPeerCertificate(true);
      const chain: string[] = [];
      for (let cur: PeerCertificate | undefined = c, i = 0; cur && cur.subject && i < 5; i++) {
        chain.push(`${i}: ${cur.subject.CN ?? cur.subject.O ?? '?'} (issuer ${cur.issuer?.CN ?? cur.issuer?.O ?? '?'})`);
        const next: PeerCertificate | undefined = (cur as PeerCertificate & { issuerCertificate?: PeerCertificate }).issuerCertificate;
        if (!next || next === cur) break;
        cur = next;
      }
      const sans = c.subjectaltname ? c.subjectaltname.replace(/DNS:/g, '').split(', ').slice(0, 20).join(', ') : '(none)';
      resolve(ok([
        `${host}:${port} TLS handshake in ${Math.round(performance.now() - t0)}ms from ${s.remoteAddress}`,
        `protocol: ${s.getProtocol()}, cipher: ${s.getCipher()?.name}`,
        `trusted: ${s.authorized ? 'yes' : `NO (${s.authorizationError})`}`,
        `certificate: ${summariseCert(c, host)}`,
        `valid from: ${c.valid_from}`,
        `names (SAN): ${sans}`,
        `chain:\n  ${chain.join('\n  ')}`,
      ].join('\n')));
      s.end();
    });
    s.once('timeout', () => { s.destroy(); resolve(fail(`${host}:${port}: no TLS handshake within 10s`)); });
    s.once('error', (err) => resolve(needsApproval(host, err) ?? fail(`${host}:${port}: ${describeError(err)}`)));
  });
}

// ---- tcp --------------------------------------------------------------------

function checkTcp(a: Args, signal: AbortSignal): Promise<ToolOutput> {
  const host = bare(a.host!);
  const port = a.port!;
  const refused = literalRefusal(host, mayReachPrivate(a));
  if (refused) return Promise.resolve(refused);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const s = netConnect({ host, port, lookup: guarded(mayReachPrivate(a)), timeout: 8_000 });
    signal.addEventListener('abort', () => s.destroy(), { once: true });
    s.once('connect', () => {
      const ms = Math.round(performance.now() - t0);
      const remote = s.remoteAddress;
      let banner = '';
      // Many services greet first (SSH, SMTP, FTP, MySQL, Redis on error): read briefly.
      const done = () => {
        s.destroy();
        const clean = banner.replace(/[^\x20-\x7e\n]/g, '.').trim().slice(0, 300);
        resolve(ok(`${host}:${port} is OPEN (connected in ${ms}ms to ${remote})${clean ? `\nbanner: ${clean}` : '\nno banner within 1.5s (normal for HTTP, TLS and most databases)'}`));
      };
      s.on('data', (d: Buffer) => { banner += d.toString('latin1'); if (banner.length > 300) done(); });
      setTimeout(done, 1500);
    });
    s.once('timeout', () => { s.destroy(); resolve(fail(`${host}:${port}: no answer within 8s (filtered by a firewall, or the host is down)`)); });
    s.once('error', (err) => resolve(needsApproval(host, err) ?? fail(`${host}:${port}: ${describeError(err)}`)));
  });
}

// ---- dns --------------------------------------------------------------------

async function checkDns(a: Args): Promise<ToolOutput> {
  const host = bare(a.host!);
  const r = new dns.Resolver({ timeout: 5000, tries: 2 });
  if (a.resolver) r.setServers([a.resolver]);
  const servers = r.getServers().join(', ');
  const lines: string[] = [];
  if (isIP(host)) {
    try {
      lines.push(`PTR ${host}: ${(await r.reverse(host)).join(', ') || '(none)'}`);
    } catch (err) {
      lines.push(`PTR ${host}: ${describeError(err)}`);
    }
    return ok(`resolver: ${servers}\n${lines.join('\n')}`);
  }
  const types = a.record_type && a.record_type !== 'ANY' ? [a.record_type] : ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT'];
  for (const t of types) {
    try {
      const t0 = performance.now();
      const res = await r.resolve(host, t as 'A');
      const ms = Math.round(performance.now() - t0);
      const fmt = (x: unknown) => (typeof x === 'string' ? x : Array.isArray(x) ? x.join('') : JSON.stringify(x));
      lines.push(`${t} (${ms}ms): ${(res as unknown[]).map(fmt).join(', ') || '(none)'}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENODATA' && types.length > 1) continue;
      lines.push(`${t}: ${code === 'ENODATA' ? 'no records' : code === 'ENOTFOUND' ? 'NXDOMAIN (name does not exist)' : describeError(err)}`);
      if (code === 'ENOTFOUND') break;
    }
  }
  return ok(`${host} via resolver ${servers}\n${lines.join('\n') || 'no records of the usual types'}`);
}

// ---- ping / traceroute (system binaries, no shell) --------------------------

function run(bin: string, argv: string[], timeoutMs: number, signal: AbortSignal): Promise<{ code: number | null; out: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(bin, argv, { timeout: timeoutMs, signal, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      const missing = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) as number : 0, out: `${stdout}${stderr}`.trim(), missing });
    });
  });
}

async function checkPing(a: Args, signal: AbortSignal): Promise<ToolOutput> {
  const host = bare(a.host!);
  let ip: string;
  try {
    ip = await resolveChecked(host, mayReachPrivate(a));
  } catch (err) {
    return needsApproval(host, err) ?? fail(`${host}: ${describeError(err)}`);
  }
  const count = a.count ?? 4;
  const v6 = isIP(ip) === 6;
  const res = await run('ping', [...(v6 ? ['-6'] : []), '-n', '-c', String(count), '-W', '2', ip], (count + 3) * 1000, signal);
  if (!res.missing) {
    const note = res.code === 0 ? '' : '\n(no replies: many hosts and cloud firewalls drop ICMP, so try a tcp check on a known port before concluding it is down)';
    return res.code === 0 || /packets transmitted/.test(res.out) ? ok(`${host}${ip !== host ? ` (${ip})` : ''}\n${res.out}${note}`) : fail(`${host}: ${res.out || 'ping failed'}`);
  }
  // No ping binary (or no raw-socket permission): a TCP handshake is the next best signal.
  const tcp = await checkTcp({ ...a, check: 'tcp', host: ip, port: a.port ?? 443 }, signal);
  return { ...tcp, text: `ping is not available on the SupOps server; checked TCP port ${a.port ?? 443} instead.\n${tcp.text}` };
}

async function checkTraceroute(a: Args, signal: AbortSignal): Promise<ToolOutput> {
  const host = bare(a.host!);
  let ip: string;
  try {
    ip = await resolveChecked(host, mayReachPrivate(a));
  } catch (err) {
    return needsApproval(host, err) ?? fail(`${host}: ${describeError(err)}`);
  }
  const hops = String(a.max_hops ?? 20);
  for (const [bin, argv] of [
    ['traceroute', ['-n', '-q', '1', '-w', '2', '-m', hops, ip]],
    ['tracepath', ['-n', '-m', hops, ip]],
  ] as const) {
    const res = await run(bin, [...argv], 75_000, signal);
    if (!res.missing) return ok(`${host}${ip !== host ? ` (${ip})` : ''} via ${bin}\n${res.out}`);
  }
  return fail('neither traceroute nor tracepath is installed on the SupOps server');
}

// ---- whois (RDAP over HTTPS) ------------------------------------------------

async function checkWhois(a: Args, signal: AbortSignal): Promise<ToolOutput> {
  const host = bare(a.host!).toLowerCase().replace(/\.$/, '');
  // A subdomain has no registration of its own: try the name, then each parent, until
  // a registry answers (www.shop.example.co.uk -> ... -> example.co.uk).
  const labels = host.split('.');
  const candidates = isIP(host) ? [`ip/${host}`] : labels.slice(0, -1).map((_, i) => `domain/${labels.slice(i).join('.')}`).slice(0, 4);
  const rdap = { ...a, check: 'http' as const, method: 'GET' as const, allow_private: false, insecure: false };
  let last = 'no registry answered';
  for (const path of candidates) {
    try {
      // rdap.org redirects to the registry holding the record; follow it through the same guard.
      let url = new URL(`https://rdap.org/${path}`);
      let hop = await httpHop(url, rdap, signal, 200_000);
      for (let i = 0; i < 3 && hop.status >= 300 && hop.status < 400 && hop.headers.location; i++) {
        url = new URL(hop.headers.location, url);
        hop = await httpHop(url, rdap, signal, 200_000);
      }
      if (hop.status === 404) { last = `${path.split('/')[1]}: not found`; continue; }
      if (hop.status !== 200) { last = `HTTP ${hop.status} from ${url.host}`; continue; }
      const j = JSON.parse(hop.body) as Record<string, unknown>;
      const events = ((j.events as Array<{ eventAction: string; eventDate: string }>) ?? []).map((e) => `${e.eventAction}: ${e.eventDate}`);
      const ents = (j.entities as Array<{ roles?: string[]; vcardArray?: unknown[] }>) ?? [];
      const registrar = ents.find((e) => e.roles?.includes('registrar'));
      const name = (registrar?.vcardArray?.[1] as Array<[string, unknown, string, string]> | undefined)?.find((v) => v[0] === 'fn')?.[3];
      const ns = ((j.nameservers as Array<{ ldhName: string }>) ?? []).map((n) => n.ldhName.toLowerCase());
      return ok([
        `${String(j.ldhName ?? j.handle ?? host).toLowerCase()} (from ${url.host})`,
        j.name ? `network: ${String(j.name)} ${String(j.startAddress ?? '')}–${String(j.endAddress ?? '')}` : '',
        name ? `registrar: ${name}` : '',
        `status: ${((j.status as string[]) ?? []).join(', ') || '?'}`,
        ...events,
        ns.length ? `nameservers: ${ns.join(', ')}` : '',
      ].filter(Boolean).join('\n'));
    } catch (err) {
      last = describeError(err);
    }
  }
  return fail(`RDAP lookup for ${host} failed: ${last}`);
}

// ---- the tool ---------------------------------------------------------------

export const netCheckTool: ToolDef<Args> = {
  key: 'net_check',
  kind: 'http',
  description:
    'Run a read-only network check FROM THE SUPOPS SERVER (not from the operator\'s network): ' +
    'http (curl-style GET/HEAD: status, timing, headers, redirects, start of body, certificate), ' +
    'ping, tcp (is host:port open, plus any service banner), dns (A/AAAA/CNAME/MX/NS/TXT/SOA/SRV/CAA, or PTR for an IP; optional resolver), ' +
    'tls (certificate issuer, expiry, hostname match, chain, protocol), traceroute, whois (domain or IP registration via RDAP). ' +
    'Public addresses run immediately. Internal addresses (10.x, 172.16-31.x, 192.168.x, localhost, *.internal) need allow_private: true and a person\'s approval. ' +
    'Check one thing at a time; never sweep ranges or ports.',
  parameters: {
    check: { type: 'string', enum: [...CHECKS], description: 'Which check to run.' },
    url: { type: 'string', description: 'For http: the full http(s) URL.' },
    host: { type: 'string', description: 'For every other check: a hostname or IP address.' },
    port: { type: 'integer', description: 'tcp (required), tls (default 443), ping fallback.' },
    method: { type: 'string', enum: ['GET', 'HEAD'], description: 'http method, default GET.' },
    record_type: { type: 'string', enum: [...RECORDS], description: 'dns record type; default: the common ones.' },
    resolver: { type: 'string', description: 'dns: resolver IP to ask instead of the system one, e.g. 1.1.1.1.' },
    count: { type: 'integer', description: 'ping count, 1-5 (default 4).' },
    max_hops: { type: 'integer', description: 'traceroute hop limit (default 20).' },
    insecure: { type: 'boolean', description: 'http: do not reject an untrusted certificate (it is still reported).' },
    allow_private: { type: 'boolean', description: 'Allow an internal address. Requires a person\'s approval.' },
  },
  required: ['check'],
  argsSchema: args as unknown as z.ZodType<Args>,
  baselineRisk: 'read_only',
  targetKinds: ['http'],
  mutating: false,
  timeoutMs: 90_000,
  render: (a) => {
    const on = a.check === 'http' ? `${a.method ?? 'GET'} ${a.url}` : `${a.host}${a.port ? `:${a.port}` : ''}`;
    const extra = [a.record_type && `type ${a.record_type}`, a.resolver && `@${a.resolver}`, a.insecure && 'insecure', a.allow_private && 'internal address'].filter(Boolean).join(', ');
    return `net_check ${a.check} ${on}${extra ? ` (${extra})` : ''}`;
  },
  classifyArgs: (a) => classify(a),
  execute: async (a, ctx) => {
    const signal = ctx.signal;
    switch (a.check) {
      case 'http': return checkHttp(a, signal);
      case 'tls': return checkTls(a, signal);
      case 'tcp': return checkTcp(a, signal);
      case 'dns': return checkDns(a);
      case 'ping': return checkPing(a, signal);
      case 'traceroute': return checkTraceroute(a, signal);
      case 'whois': return checkWhois(a, signal);
    }
  },
};
