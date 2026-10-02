import type { ResolvedTarget } from '../tools/types.ts';
import type { SimpleCommand } from './shell-lex.ts';
import type { RuleHit } from './rule-kit.ts';
import { catastrophic, hit, worst } from './rule-kit.ts';
import { operands } from './rules-files.ts';

/*
 * Rules for database clients: SQL (psql/mysql/sqlite3/clickhouse), Redis, MongoDB,
 * and the dump/restore tools around them.
 *
 * A database command is judged by what it asks the server to do, which lives in a
 * flag (`-c`, `-e`, `--eval`) or a heredoc, not in the file paths. When that text
 * isn't visible in the command -- a `-f script.sql`, a piped-in file, an interactive
 * session -- we can't read the intent, so we fail closed to `high`. The recurring
 * catastrophe is the one that can't be undone: dropping a database or flushing a
 * cache. On a production target no approval makes that safe, so it is forbidden.
 */

const base = (cmd: SimpleCommand) => cmd.name.split('/').pop()!;

/** A password sitting on the command line ends up in the audit log in clear text. */
function inlinePassword(cmd: SimpleCommand): boolean {
  return cmd.args.some((a) => /^-p.+/.test(a) && !/^-p(ort)?$/.test(a)) // mysql -pSECRET (but not -p alone / -port)
    || cmd.args.some((a) => /^--password=./.test(a))
    || cmd.raw.includes('PGPASSWORD=');
}

// ============================ SQL ==========================================

/** Where the statement text lives for each client, if it's visible at all. */
function sqlStatement(cmd: SimpleCommand): { text: string | null } {
  if (cmd.heredoc !== undefined && cmd.heredoc.trim()) return { text: cmd.heredoc };
  const name = base(cmd);
  const flags = name === 'psql' || name === 'clickhouse-client'
    ? ['-c', '--command', '-q', '--query']
    : ['-e', '--execute'];
  for (let i = 0; i < cmd.args.length; i += 1) {
    const a = cmd.args[i]!;
    for (const f of flags) {
      if (a === f) return { text: cmd.args[i + 1] ?? '' };
      if (a.startsWith(`${f}=`)) return { text: a.slice(f.length + 1) };
    }
    // mysql -e"SELECT 1" / psql -c"..." with no space
    if (/^-[ceq]./.test(a) && !a.startsWith('--')) return { text: a.slice(2) };
  }
  // sqlite3 takes the statement as a positional after the database file.
  if (name === 'sqlite3') {
    const ops = cmd.args.filter((x) => !x.startsWith('-'));
    if (ops.length >= 2) return { text: ops.slice(1).join(' ') };
  }
  return { text: null };
}

/** Strip comments and quoted literals so keyword matching can't be fooled by them. */
function stripSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`[^`]*`/g, '``');
}

const has = (s: string, re: RegExp) => re.test(s);

/** Classify one already-stripped SQL statement. */
function classifyStatement(raw: string, target: ResolvedTarget): RuleHit {
  let s = raw.trim();
  if (!s) return hit('shell.sql.empty', 'read_only', 'empty statement');
  // sqlite3 dot-commands: most read metadata, but a handful run a shell command or
  // write files on the host, which escapes every file/exec rule.
  if (s.startsWith('.')) {
    const dot = s.slice(1).split(/\s+/)[0]!.toLowerCase();
    if (/^(shell|system|import|output|load|read|clone|backup|restore|save|cd|exec|archive)$/.test(dot)) {
      return hit('shell.sql.sqlite-meta', 'high', `sqlite .${dot} runs a command or writes files on the host`, { category: 'code-execution' });
    }
    return hit('shell.sql.read', 'read_only', `sqlite .${dot} reads database metadata`);
  }
  // EXPLAIN ANALYZE actually runs the statement; rate the inner one. Plain EXPLAIN is a read.
  const explain = /^explain\s+(analyze|analyse)\s+(.*)/is.exec(s);
  if (explain) s = explain[2]!;
  else if (/^explain\b/i.test(s) || /^(describe|desc)\b/i.test(s)) return hit('shell.sql.read', 'read_only', 'reads a query plan or schema');

  // Running a shell command from inside the database escapes every file/exec rule.
  if (has(s, /\bCOPY\b[\s\S]*\bFROM\s+PROGRAM\b/i) || has(s, /\bCOPY\b[\s\S]*\bTO\s+PROGRAM\b/i)) {
    return catastrophic(target, 'shell.sql.copy-program', 'COPY … PROGRAM runs a shell command on the database host', 'code-execution');
  }
  if (has(s, /\b(lo_import|lo_export)\s*\(/i) || has(s, /\bINTO\s+(OUTFILE|DUMPFILE)\b/i)) {
    return hit('shell.sql.file', 'high', 'SQL that reads or writes a file on the database host', { category: 'code-execution' });
  }

  // Irreversible destruction.
  if (has(s, /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE)\b/i) || has(s, /\bDROP\b[\s\S]*\bCASCADE\b/i)
    || has(s, /\bRESET\s+MASTER\b/i) || has(s, /\bPURGE\s+(BINARY|MASTER)\s+LOGS\b/i)) {
    return catastrophic(target, 'shell.sql.drop', 'SQL that drops or truncates a table, schema or database');
  }

  // Privilege and server-wide changes.
  if (has(s, /\b(GRANT|REVOKE)\b/i) || has(s, /\b(CREATE|ALTER|DROP)\s+(USER|ROLE)\b/i)) {
    return hit('shell.sql.acl', 'high', 'SQL that changes accounts or privileges', { category: 'privilege' });
  }
  if (has(s, /\bSET\s+GLOBAL\b/i) || has(s, /\bFLUSH\b/i) || has(s, /\bVACUUM\s+FULL\b/i) || has(s, /\bREINDEX\b/i)
    || has(s, /\b(pg_terminate_backend|pg_reload_conf)\s*\(/i) || has(s, /\bKILL\s+\d/i) || has(s, /\bLOAD\s+DATA\b/i)) {
    return hit('shell.sql.admin', 'high', 'SQL that changes server-wide state', { category: 'integrity' });
  }
  if (has(s, /\bALTER\b/i)) return hit('shell.sql.alter', 'high', 'ALTER changes a schema object', { category: 'integrity' });

  // Unqualified DML hits every row.
  if (has(s, /\b(UPDATE|DELETE)\b/i) && !has(s, /\bWHERE\b/i)) {
    return hit('shell.sql.unqualified', 'high', 'DELETE/UPDATE without a WHERE clause affects every row', { category: 'destruction' });
  }
  if (has(s, /\b(INSERT|UPDATE|DELETE|REPLACE|MERGE|UPSERT)\b/i)) {
    return hit('shell.sql.dml', 'medium', 'SQL that modifies rows', { category: 'integrity' });
  }
  if (has(s, /\bCREATE\s+(TABLE|INDEX|VIEW|MATERIALIZED|SEQUENCE|FUNCTION|PROCEDURE|TRIGGER)\b/i)
    || has(s, /\bCOPY\b[\s\S]*\bFROM\b/i) || has(s, /\b(ANALYZE|ANALYSE|VACUUM|CLUSTER)\b/i)
    || has(s, /\b(pg_cancel_backend)\s*\(/i) || has(s, /\bKILL\s+QUERY\b/i)) {
    return hit('shell.sql.ddl', 'medium', 'SQL that creates objects or does maintenance', { category: 'integrity' });
  }
  if (has(s, /\bSET\b/i) && !has(s, /\bGLOBAL\b/i)) return hit('shell.sql.set', 'read_only', 'session SET only affects this connection');
  if (has(s, /^\s*(SELECT|WITH|SHOW|TABLE|VALUES|\\)/i)) {
    // SELECT ... INTO writes a new table; a plain SELECT reads.
    if (has(s, /\bSELECT\b[\s\S]*\bINTO\b/i) && !has(s, /\bINTO\s+(OUTFILE|DUMPFILE)\b/i)) {
      return hit('shell.sql.select-into', 'medium', 'SELECT … INTO writes a new table', { category: 'integrity' });
    }
    return hit('shell.sql.read', 'read_only', 'read-only query');
  }
  // Something we don't recognise -- don't guess it's safe.
  return hit('shell.sql.unknown', 'high', 'SQL whose effect could not be determined from the statement');
}

/** psql / mysql / mariadb / sqlite3 / clickhouse-client */
export function classifySqlClientV2(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { text } = sqlStatement(cmd);
  const secret = inlinePassword(cmd)
    ? hit('shell.sql.inline-password', 'medium', 'a database password on the command line is written to the audit log in clear text', { category: 'secrets' })
    : null;

  if (text === null) {
    // No visible statement: -f file, a piped script, or an interactive shell.
    const fileDriven = cmd.args.some((a) => a === '-f' || a === '--file' || a.startsWith('--file='))
      || cmd.pipedFrom
      || cmd.redirects.some((r) => r.op === '<' || r.op === '<<' || r.op === '<<<');
    const h = fileDriven
      ? hit('shell.sql.scriptfile', 'high', 'SQL run from a file or piped input, whose statements are not visible in the command', { category: 'integrity' })
      : hit('shell.sql.interactive', 'high', 'an interactive database session, whose statements are not visible in the command', { category: 'integrity' });
    return secret ? worst([h, secret]) : h;
  }

  const statements = stripSql(text).split(';').map((x) => x.trim()).filter(Boolean);
  const verdicts = statements.length ? statements.map((s) => classifyStatement(s, target)) : [classifyStatement(text, target)];
  const sqlHit = worst(verdicts);
  return secret ? worst([sqlHit, secret]) : sqlHit;
}

// ============================ dump / restore ================================

const DUMP_TOOLS = new Set(['pg_dump', 'pg_dumpall', 'mysqldump', 'mongodump']);

export function classifyDbTool(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const name = base(cmd);
  const a = cmd.args;
  const secret = inlinePassword(cmd);
  const withSecret = (h: RuleHit): RuleHit => secret
    ? worst([h, hit('shell.db.inline-password', 'medium', 'a database password on the command line is logged in clear text', { category: 'secrets' })])
    : h;

  if (DUMP_TOOLS.has(name)) {
    // A full copy of the data. The exfiltration check in rules-line.ts catches a dump
    // piped off the host; on its own it's a read of everything, so it needs a human.
    return withSecret(hit(`shell.db.dump`, 'medium', `${name} exports a full copy of the database contents`, { category: 'secrets' }));
  }
  if (name === 'createdb') return withSecret(hit('shell.db.createdb', 'medium', 'createdb creates a new database', { category: 'integrity' }));
  if (name === 'dropdb') return withSecret(catastrophic(target, 'shell.db.dropdb', 'dropdb deletes an entire database'));

  if (name === 'pg_restore' || name === 'mongorestore') {
    if (a.some((x) => /^(-c|--clean|--drop)$/.test(x))) {
      return withSecret(catastrophic(target, `shell.db.restore-drop`, `${name} --clean/--drop deletes existing objects before restoring`));
    }
    return withSecret(hit(`shell.db.restore`, 'high', `${name} overwrites database contents from a dump`, { category: 'integrity' }));
  }
  if (name === 'mysqladmin') {
    // Skip connection flags and their values (-u root, -h db1, -P 3306) so the
    // operation word isn't mistaken for a username or host.
    // Only connection flags that reliably take a following value. `-p`/`--password`
    // is deliberately excluded: bare `-p` prompts (its value is not the next token)
    // and `-pSECRET` is one token, so treating it as value-taking would swallow the verb.
    const { ops } = operands(a, ['-u', '--user', '-h', '--host', '-P', '--port', '-S', '--socket']);
    const verb = ops.find((x) => !x.startsWith('-')) ?? '';
    if (/^(status|extended-status|processlist|variables|ping|version|debug)$/.test(verb)) {
      return hit('shell.db.mysqladmin.read', 'read_only', `mysqladmin ${verb} only reads server state`);
    }
    if (verb === 'drop') return withSecret(catastrophic(target, 'shell.db.mysqladmin.drop', 'mysqladmin drop deletes a database'));
    if (verb === 'shutdown') return withSecret(hit('shell.db.mysqladmin.shutdown', 'high', 'mysqladmin shutdown stops the database server', { category: 'availability' }));
    return withSecret(hit('shell.db.mysqladmin', 'medium', `mysqladmin ${verb} changes server state`, { category: 'integrity' }));
  }
  return withSecret(hit(`shell.db.${name}`, 'high', `${name} ${a.join(' ')} operates on a database`, { category: 'integrity' }));
}

// ============================ Redis =========================================

const REDIS_VALUE_FLAGS = ['-h', '-p', '-a', '-n', '-u', '--user', '--pass', '-t', '--timeout', '--scan', '-r', '-i'];
const REDIS_READ = new Set(['GET', 'MGET', 'EXISTS', 'TTL', 'PTTL', 'TYPE', 'STRLEN', 'HGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'LRANGE', 'LLEN', 'LINDEX', 'SMEMBERS', 'SCARD', 'SISMEMBER', 'ZRANGE', 'ZCARD', 'ZSCORE', 'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN', 'INFO', 'PING', 'DBSIZE', 'LOLWUT', 'RANDOMKEY', 'OBJECT', 'MEMORY', 'LATENCY', 'COMMAND', 'ECHO', 'TIME']);
const REDIS_WRITE = new Set(['SET', 'SETEX', 'SETNX', 'MSET', 'GETSET', 'APPEND', 'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'PERSIST', 'RENAME', 'HSET', 'HMSET', 'HDEL', 'HINCRBY', 'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LREM', 'LSET', 'INCR', 'DECR', 'INCRBY', 'DECRBY', 'SADD', 'SREM', 'SPOP', 'ZADD', 'ZREM', 'ZINCRBY', 'SETBIT', 'GETDEL', 'COPY', 'MOVE', 'RESTORE', 'KEYS']);
const REDIS_HIGH = new Set(['EVAL', 'EVALSHA', 'SCRIPT', 'FUNCTION', 'FCALL', 'MODULE', 'ACL', 'REPLICAOF', 'SLAVEOF', 'MIGRATE', 'DEBUG', 'SHUTDOWN', 'BGREWRITEAOF', 'BGSAVE', 'SAVE', 'FAILOVER', 'CLUSTER', 'SWAPDB', 'RESET', 'LASTSAVE']);

export function classifyRedis(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const authed = cmd.args.some((a) => /^-a./.test(a) || a === '-a' || /^--pass(word)?/.test(a) || cmd.raw.includes('REDISCLI_AUTH='));
  const { ops } = operands(cmd.args, REDIS_VALUE_FLAGS);
  const withAuth = (h: RuleHit): RuleHit => authed
    ? worst([h, hit('shell.redis.inline-password', 'medium', 'the Redis password is on the command line, so it lands in the audit log', { category: 'secrets' })])
    : h;

  if (cmd.args.some((a) => a === '--pipe' || a === '-x') || cmd.pipedFrom) {
    return withAuth(hit('shell.redis.pipe', 'high', 'redis-cli --pipe/-x runs commands from its input, which is not visible here', { category: 'integrity' }));
  }
  const verb = (ops[0] ?? '').toUpperCase();
  if (!verb) return withAuth(hit('shell.redis.interactive', 'high', 'an interactive redis-cli session, whose commands are not visible here', { category: 'integrity' }));

  const sub = (ops[1] ?? '').toUpperCase();
  if (verb === 'FLUSHALL' || verb === 'FLUSHDB') {
    return withAuth(catastrophic(target, `shell.redis.flush`, `${verb} erases the entire cache/keyspace`));
  }
  if (verb === 'CONFIG' && sub === 'SET') {
    const key = (ops[2] ?? '').toLowerCase();
    if (key === 'dir' || key === 'dbfilename') {
      return withAuth(hit('shell.redis.config-dir', 'forbidden', 'CONFIG SET dir/dbfilename lets Redis write its dump to any path on disk, a known way to plant files', { category: 'code-execution' }));
    }
    return withAuth(hit('shell.redis.config-set', 'high', 'CONFIG SET changes server configuration at runtime', { category: 'integrity' }));
  }
  if (REDIS_HIGH.has(verb)) {
    if (verb === 'SHUTDOWN') return withAuth(hit('shell.redis.shutdown', 'high', 'SHUTDOWN stops the Redis server', { category: 'availability' }));
    if (verb === 'CONFIG' || verb === 'ACL' || verb === 'CLUSTER' || verb === 'FUNCTION' || verb === 'SCRIPT') {
      if (/^(GET|LIST|INFO|WHOAMI|CAT|GETUSER|SLOTS|SHARDS|NODES|COUNTKEYSINSLOT|DUMP)$/.test(sub)) {
        return withAuth(hit(`shell.redis.${verb.toLowerCase()}.read`, 'read_only', `${verb} ${sub} only reads`));
      }
    }
    return withAuth(hit(`shell.redis.admin`, 'high', `Redis ${verb} runs code or changes server-wide state`, { category: verb === 'EVAL' || verb === 'EVALSHA' || verb === 'FCALL' || verb === 'MODULE' ? 'code-execution' : 'integrity' }));
  }
  if (REDIS_WRITE.has(verb)) {
    if (verb === 'CLIENT' && /^(LIST|INFO|GETNAME|ID|NO-EVICT)$/.test(sub)) return withAuth(hit('shell.redis.client.read', 'read_only', 'CLIENT LIST/INFO only reads'));
    return withAuth(hit('shell.redis.write', 'medium', `Redis ${verb} modifies data`, { category: 'integrity' }));
  }
  if (verb === 'CLIENT' && sub === 'KILL') return withAuth(hit('shell.redis.client.kill', 'medium', 'CLIENT KILL drops a connection', { category: 'availability' }));
  if (REDIS_READ.has(verb) || verb === 'CLIENT' || verb === 'SLOWLOG') return withAuth(hit('shell.redis.read', 'read_only', `Redis ${verb} only reads`));
  return withAuth(hit('shell.redis.unknown', 'high', `unrecognised Redis command "${verb}"`));
}

// ============================ MongoDB ======================================

export function classifyMongo(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const evalIdx = cmd.args.findIndex((a) => a === '--eval' || a === '-e');
  const inlineEval = cmd.args.find((a) => a.startsWith('--eval='))?.slice(7);
  const script = inlineEval ?? (evalIdx >= 0 ? cmd.args[evalIdx + 1] : undefined) ?? (cmd.heredoc?.trim() || undefined);
  const authed = inlinePassword(cmd) || cmd.raw.includes('--password');
  const withAuth = (h: RuleHit): RuleHit => authed
    ? worst([h, hit('shell.mongo.inline-password', 'medium', 'the MongoDB password is on the command line, so it is logged', { category: 'secrets' })])
    : h;

  if (!script) {
    if (cmd.args.some((a) => /\.js$/.test(a)) || cmd.pipedFrom) {
      return withAuth(hit('shell.mongo.scriptfile', 'high', 'a MongoDB script whose contents are not visible in the command', { category: 'integrity' }));
    }
    return withAuth(hit('shell.mongo.interactive', 'high', 'an interactive mongosh session, whose commands are not visible here', { category: 'integrity' }));
  }
  const s = script;
  if (/\.(drop|dropDatabase)\s*\(/.test(s) || /\bdropDatabase\b/.test(s)) {
    return withAuth(catastrophic(target, 'shell.mongo.drop', 'drop()/dropDatabase() deletes a collection or database'));
  }
  if (/\.shutdownServer\s*\(/.test(s) || /\bdb\.shutdownServer\b/.test(s)) {
    return withAuth(hit('shell.mongo.shutdown', 'high', 'shutdownServer() stops the database', { category: 'availability' }));
  }
  if (/\b(createUser|dropUser|grantRolesToUser|revokeRolesFromUser|updateUser|createRole|dropRole)\s*\(/.test(s)) {
    return withAuth(hit('shell.mongo.acl', 'high', 'MongoDB user/role administration', { category: 'privilege' }));
  }
  // deleteMany / updateMany / remove with an empty filter hits the whole collection.
  if (/\.(deleteMany|updateMany|remove)\s*\(\s*(\{\s*\}|)\s*[),]/.test(s) || /\.(deleteMany|updateMany)\s*\(\s*\{\s*\}/.test(s)) {
    return withAuth(hit('shell.mongo.unqualified', 'high', 'deleteMany/updateMany with an empty filter affects every document', { category: 'destruction' }));
  }
  if (/\.(dropIndex|dropIndexes|renameCollection|reIndex)\s*\(/.test(s)) {
    return withAuth(hit('shell.mongo.schema', 'high', 'a schema/index change on a collection', { category: 'integrity' }));
  }
  if (/\.(insert(One|Many)?|update(One|Many)?|delete(One|Many)?|replaceOne|save|remove|findAndModify|findOneAndUpdate|findOneAndDelete|bulkWrite|createIndex)\s*\(/.test(s)
    || /\$out\b|\$merge\b/.test(s)) {
    return withAuth(hit('shell.mongo.write', 'medium', 'a MongoDB write operation', { category: 'integrity' }));
  }
  if (/\.(find|findOne|count(Documents)?|estimatedDocumentCount|distinct|aggregate|getIndexes|stats|serverStatus|listCollections|getCollectionNames)\s*\(/.test(s)
    || /\bshow\s+(dbs|databases|collections|users|roles)\b/.test(s) || /\bdb\.version\s*\(/.test(s)) {
    return withAuth(hit('shell.mongo.read', 'read_only', 'a read-only MongoDB query'));
  }
  return withAuth(hit('shell.mongo.unknown', 'high', 'a MongoDB script whose effect could not be determined', { category: 'integrity' }));
}

/** Commands this module handles, for registration in the dispatcher. */
export const DATA_COMMANDS: Record<string, (cmd: SimpleCommand, target: ResolvedTarget) => RuleHit> = {
  psql: classifySqlClientV2,
  mysql: classifySqlClientV2,
  mariadb: classifySqlClientV2,
  sqlite3: classifySqlClientV2,
  'clickhouse-client': classifySqlClientV2,
  pg_dump: classifyDbTool,
  pg_dumpall: classifyDbTool,
  pg_restore: classifyDbTool,
  mysqldump: classifyDbTool,
  mongodump: classifyDbTool,
  mongorestore: classifyDbTool,
  createdb: classifyDbTool,
  dropdb: classifyDbTool,
  mysqladmin: classifyDbTool,
  'redis-cli': classifyRedis,
  'valkey-cli': classifyRedis,
  mongosh: classifyMongo,
  mongo: classifyMongo,
};

/** Names that read a bulk copy of data, for the exfiltration check in rules-line.ts. */
export const DB_BULK_READERS = ['pg_dump', 'pg_dumpall', 'mysqldump', 'mongodump'];
