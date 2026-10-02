import type { ResolvedTarget } from '../tools/types.ts';
import type { SimpleCommand } from './shell-lex.ts';
import type { RuleHit } from './rule-kit.ts';
import { catastrophic, hit } from './rule-kit.ts';

/*
 * Rules for cloud control-plane CLIs: aws, gcloud/gsutil, az, and the
 * infrastructure-as-code tools terraform/tofu/pulumi.
 *
 * These commands don't touch the target host at all -- they reach out to a cloud API
 * and can delete a database, a bucket or a whole cluster that lives somewhere else
 * entirely. So the target's own env/sensitivity is a weak signal; what matters is the
 * verb. Reads (list/describe/get) are free. Anything that creates or changes needs a
 * human. Anything that deletes a stateful resource -- a bucket, a database, a cluster,
 * a stack, a project -- is catastrophic: forbidden on a production target, high
 * elsewhere. A verb we don't recognise is treated as high, never assumed safe.
 */

const base = (cmd: SimpleCommand) => cmd.name.split('/').pop()!;

/** Positional words (not flags, not flag-values), in order. */
function words(args: string[], valueFlags: RegExp): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--') { out.push(...args.slice(i + 1).filter((x) => !x.startsWith('-'))); break; }
    if (a.startsWith('-')) {
      if (a.includes('=')) continue;
      if (valueFlags.test(a)) i += 1; // this flag consumes the next token
      continue;
    }
    out.push(a);
  }
  return out;
}

const READ_VERB = /^(list|list-[\w-]+|ls|describe|describe-[\w-]+|desc|show|show-[\w-]+|get|get-[\w-]+|read|head|head-[\w-]+|search|find|query|scan|help|version|status|history|preview|output|validate|plan|providers|watch|tail|view|cat|check|lookup|test|test-[\w-]+)$/;
const DESTROY_VERB = /^(delete|delete-[\w-]+|destroy|remove|rm|remove-[\w-]+|terminate|terminate-[\w-]+|purge|erase|drop|deprovision|nuke|down|teardown)$/;
const CHANGE_VERB = /^(create|create-[\w-]+|update|update-[\w-]+|put|put-[\w-]+|set|set-[\w-]+|add|add-[\w-]+|modify|modify-[\w-]+|apply|deploy|run|run-[\w-]+|start|start-[\w-]+|enable|enable-[\w-]+|import|copy|copy-[\w-]+|cp|mv|sync|tag|tag-[\w-]+|attach|associate|register|register-[\w-]+|patch|edit|rollout|scale|restart|reboot|reboot-[\w-]+|stop|stop-[\w-]+|disable|disable-[\w-]+|detach|deregister|revoke|reset)$/;

/** Reading these AWS values hands back a live secret, so they aren't free reads. */
const AWS_SECRET_OP = /^(get-secret-value|get-password-data|get-session-token|get-authorization-token|get-parameter|get-parameters|get-credentials|create-access-key|get-federation-token|get-service-bearer-token)$/;

/** Deleting one of these destroys stateful data or a whole environment. */
const CATASTROPHIC_RESOURCE = /(bucket|db-instance|db-cluster|database|db|cluster|stack|table|filesystem|volume|snapshot|namespace|project|resource-group|storage-account|key|keyspace|instance|disk|repository|registry|distribution|hosted-zone|efs|rds|dynamodb)/i;

// ---- AWS -------------------------------------------------------------------

export function classifyAws(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const w = words(cmd.args, /^(--region|--profile|--output|--endpoint-url|--query|--cli-.*|--page-size|--max-items|--starting-token|--color|--ca-bundle)$/);
  const service = w[0];
  let op = w[1];
  // `aws s3 rm/cp/sync/rb` put the verb where the operation normally is.
  if (!op) return hit('shell.aws', 'read_only', 'aws with no operation prints help');

  if (service === 's3') {
    const sub = op;
    if (sub === 'ls' || sub === 'presign') return hit('shell.aws.s3.read', 'read_only', `aws s3 ${sub} lists objects`);
    if (sub === 'rb' && cmd.args.includes('--force')) return catastrophic(target, 'shell.aws.s3.rb', 'aws s3 rb --force deletes a bucket and everything in it');
    if (sub === 'rb') return hit('shell.aws.s3.rb', 'high', 'aws s3 rb removes a bucket', { category: 'destruction', irreversible: true });
    if (sub === 'rm') {
      const recursive = cmd.args.includes('--recursive');
      const bucketRoot = w.slice(2).find((x) => /^s3:\/\/[^/]+\/?$/.test(x));
      if (recursive && bucketRoot) return catastrophic(target, 'shell.aws.s3.rm-bucket', 'aws s3 rm --recursive on a bucket root deletes every object');
      return hit('shell.aws.s3.rm', 'high', 'aws s3 rm deletes objects', { category: 'destruction', irreversible: true });
    }
    if (['cp', 'mv', 'sync'].includes(sub!)) return hit('shell.aws.s3.write', 'medium', `aws s3 ${sub} transfers objects`, { category: 'integrity' });
  }

  op = op!.toLowerCase();
  // Operations that print live credentials must pause like reading a key file does,
  // otherwise a confused or hijacked agent can dump cloud secrets into the run log.
  if ((service === 'ecr' && op === 'get-login-password')
    || (service === 'configure' && (op === 'export-credentials' || (op === 'get' && /secret|password|token|key/i.test(w[2] ?? ''))))
    || (service === 'sts' && /^(assume-role|assume-role-with-web-identity|assume-role-with-saml|get-session-token|get-federation-token)$/.test(op))) {
    return hit('shell.aws.secret', 'medium', `aws ${service} ${op} returns credential material`, { category: 'secrets' });
  }
  if (AWS_SECRET_OP.test(op)) {
    if (op === 'get-parameter' || op === 'get-parameters') {
      return cmd.args.includes('--with-decryption')
        ? hit('shell.aws.secret', 'medium', `aws ${service} ${op} --with-decryption returns a decrypted secret`, { category: 'secrets' })
        : hit('shell.aws.read', 'read_only', `aws ${service} ${op} reads a parameter`);
    }
    return hit('shell.aws.secret', 'medium', `aws ${service} ${op} returns credential material`, { category: 'secrets' });
  }
  // Turning off the audit trail is anti-forensics whatever else the line claims to do.
  if (/^(stop-logging|delete-trail|update-trail|delete-detector|stop-configuration-recorder|delete-configuration-recorder|delete-flow-logs|delete-log-group|delete-log-stream)$/.test(op)) {
    return hit('shell.aws.audit', 'high', `aws ${service} ${op} disables or deletes audit logging`, { category: 'anti-forensics', irreversible: true });
  }
  if (DESTROY_VERB.test(op) || /^(terminate-instances|delete-object|delete-objects)$/.test(op)) {
    if (CATASTROPHIC_RESOURCE.test(op) && !/delete-object$|delete-objects$|delete-tags$|delete-alarm/.test(op)) {
      return catastrophic(target, `shell.aws.destroy`, `aws ${service} ${op} deletes a stateful cloud resource`);
    }
    return hit('shell.aws.delete', 'high', `aws ${service} ${op} deletes a cloud resource`, { category: 'destruction', irreversible: true });
  }
  if (op === 'stop-instances' || op === 'reboot-instances') return hit('shell.aws.stop', 'high', `aws ${service} ${op} interrupts running instances`, { category: 'availability' });
  if (/policy|attach|put-user|put-role|put-group|revoke|deregister|update-function-code|update-function-configuration/.test(op)) {
    return hit('shell.aws.privilege', 'high', `aws ${service} ${op} changes access, policy or running code`, { category: op.includes('code') ? 'code-execution' : 'privilege' });
  }
  if (READ_VERB.test(op)) return hit('shell.aws.read', 'read_only', `aws ${service} ${op} only reads`);
  if (CHANGE_VERB.test(op) || /^(run-instances)$/.test(op)) return hit('shell.aws.change', 'medium', `aws ${service} ${op} creates or changes a cloud resource`, { category: 'integrity' });
  return hit('shell.aws.unknown', 'high', `unrecognised aws operation "${service} ${op}"`);
}

// ---- gcloud / gsutil -------------------------------------------------------

const IAM_VERB = /^(get-credentials|get-iam-policy|add-iam-policy-binding|set-iam-policy|remove-iam-policy-binding)$/;

/** The action word in a `gcloud/az <group...> <verb> [NAME]` line: the first positional that
 *  looks like a verb, so a trailing resource name isn't taken for the action. */
function findVerb(w: string[]): string {
  const lower = w.map((x) => x.toLowerCase());
  return lower.find((x) => DESTROY_VERB.test(x) || CHANGE_VERB.test(x) || READ_VERB.test(x)
    || IAM_VERB.test(x) || x === 'delete-batch' || x === 'deallocate' || x === 'suspend') ?? '';
}


export function classifyGcloud(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const w = words(cmd.args, /^(--project|--zone|--region|--account|--format|--filter|--configuration|--billing-project|--impersonate-service-account|--verbosity)$/);
  if (!w.length) return hit('shell.gcloud', 'read_only', 'gcloud with no command prints help');
  const groupPath = w.join(' ').toLowerCase();
  const verb = findVerb(w);

  // `gcloud storage rm` deletes objects like `gsutil rm`; recursively over a bucket
  // root it erases everything, which is catastrophic (forbidden on prod).
  if (w[0] === 'storage' && w[1] === 'rm') {
    const recursive = cmd.args.some((a) => /^-[rR]/.test(a) || a === '--recursive');
    const bucketRoot = w.slice(2).find((x) => /^gs:\/\/[^/]+\/?(\*+)?$/.test(x));
    if (recursive && bucketRoot) return catastrophic(target, 'shell.gcloud.storage-rm-bucket', 'gcloud storage rm -r on a bucket root deletes every object');
    return hit('shell.gcloud.storage-rm', 'high', 'gcloud storage rm deletes objects', { category: 'destruction', irreversible: true });
  }

  // `... delete` of a stateful resource type.
  if (DESTROY_VERB.test(verb)) {
    if (/(projects|sql instances|spanner instances|redis instances|bigtable instances|container clusters|compute instances|compute disks|storage buckets|filestore|datastore|firestore|dataproc clusters)/.test(groupPath)) {
      return catastrophic(target, 'shell.gcloud.destroy', `gcloud ${groupPath} deletes a stateful cloud resource`);
    }
    return hit('shell.gcloud.delete', 'high', `gcloud ${groupPath} deletes a cloud resource`, { category: 'destruction', irreversible: true });
  }
  // Printing a token or reading a secret hands back live credentials -- gate it.
  if (/\bauth (print-access-token|print-identity-token|application-default print-access-token)\b/.test(groupPath)
    || /\bsecrets versions access\b/.test(groupPath) || /\bsql generate-login-token\b/.test(groupPath)
    || /\biam service-accounts keys create\b/.test(groupPath)) {
    return hit('shell.gcloud.secret', 'medium', `gcloud ${groupPath} returns credential material`, { category: 'secrets' });
  }
  if (verb === 'stop' || verb === 'reset' || verb === 'suspend') return hit('shell.gcloud.stop', 'high', `gcloud ${groupPath} interrupts a running resource`, { category: 'availability' });
  if (/add-iam-policy-binding|set-iam-policy|remove-iam-policy-binding/.test(groupPath)) {
    return hit('shell.gcloud.iam', 'high', `gcloud ${groupPath} changes IAM access`, { category: 'privilege' });
  }
  if (READ_VERB.test(verb) || /get-iam-policy|get-credentials/.test(verb)) {
    if (/get-credentials/.test(verb)) return hit('shell.gcloud.creds', 'medium', 'gcloud … get-credentials writes cluster credentials to kubeconfig', { category: 'secrets' });
    return hit('shell.gcloud.read', 'read_only', `gcloud ${groupPath} only reads`);
  }
  if (CHANGE_VERB.test(verb)) return hit('shell.gcloud.change', 'medium', `gcloud ${groupPath} creates or changes a cloud resource`, { category: 'integrity' });
  return hit('shell.gcloud.unknown', 'high', `unrecognised gcloud command "${groupPath}"`);
}

export function classifyGsutil(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const w = words(cmd.args, /^(-o|-h|-p|--project)$/);
  const verb = (w[0] ?? '').toLowerCase();
  if (['ls', 'stat', 'du', 'cat', 'hash', 'version', 'help', 'ver'].includes(verb)) return hit('shell.gsutil.read', 'read_only', `gsutil ${verb} only reads`);
  if (verb === 'rm') {
    const recursive = cmd.args.some((a) => /^-[rR]/.test(a));
    const bucketRoot = w.slice(1).find((x) => /^gs:\/\/[^/]+\/?$/.test(x));
    if (recursive && bucketRoot) return catastrophic(target, 'shell.gsutil.rm-bucket', 'gsutil rm -r on a bucket root deletes every object');
    return hit('shell.gsutil.rm', 'high', 'gsutil rm deletes objects', { category: 'destruction', irreversible: true });
  }
  if (verb === 'rb') return catastrophic(target, 'shell.gsutil.rb', 'gsutil rb removes a bucket');
  if (['cp', 'mv', 'rsync', 'compose'].includes(verb)) return hit('shell.gsutil.write', 'medium', `gsutil ${verb} transfers objects`, { category: 'integrity' });
  if (['mb', 'label', 'acl', 'iam', 'setmeta', 'defstorageclass'].includes(verb)) return hit('shell.gsutil.change', 'medium', `gsutil ${verb} changes bucket configuration`, { category: 'integrity' });
  return hit('shell.gsutil.unknown', 'high', `unrecognised gsutil command "${verb}"`);
}

// ---- az --------------------------------------------------------------------

export function classifyAz(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const w = words(cmd.args, /^(--subscription|--resource-group|-g|--output|-o|--query|--only-show-errors|--verbose)$/);
  if (!w.length) return hit('shell.az', 'read_only', 'az with no command prints help');
  const groupPath = w.join(' ').toLowerCase();
  const verb = findVerb(w);

  if (DESTROY_VERB.test(verb) || verb === 'delete-batch' || verb === 'purge') {
    if (/(group|sql (db|server)|aks|storage account|cosmosdb|postgres|mysql|mariadb|redis|keyvault|disk|vm)/.test(groupPath)) {
      return catastrophic(target, 'shell.az.destroy', `az ${groupPath} deletes a stateful cloud resource`);
    }
    return hit('shell.az.delete', 'high', `az ${groupPath} deletes a cloud resource`, { category: 'destruction', irreversible: true });
  }
  // Reading a secret, listing account keys or fetching credentials must pause.
  if (/\bkeyvault (secret|key|certificate) (show|download)\b/.test(groupPath)
    || /\bstorage account keys list\b/.test(groupPath) || /\bacr credential show\b/.test(groupPath)
    || /\baks get-credentials\b/.test(groupPath) || /\baccount get-access-token\b/.test(groupPath)
    || /\bad sp credential reset\b/.test(groupPath) || /\bdeployment list-publishing-credentials\b/.test(groupPath)) {
    return hit('shell.az.secret', 'medium', `az ${groupPath} returns credential material`, { category: 'secrets' });
  }
  if (verb === 'stop' || verb === 'deallocate' || verb === 'restart') return hit('shell.az.stop', 'high', `az ${groupPath} interrupts a running resource`, { category: 'availability' });
  if (/role assignment (create|delete)|ad (sp|app) (create|credential)/.test(groupPath)) {
    return hit('shell.az.iam', 'high', `az ${groupPath} changes access or credentials`, { category: 'privilege' });
  }
  if (READ_VERB.test(verb)) return hit('shell.az.read', 'read_only', `az ${groupPath} only reads`);
  if (CHANGE_VERB.test(verb)) return hit('shell.az.change', 'medium', `az ${groupPath} creates or changes a cloud resource`, { category: 'integrity' });
  return hit('shell.az.unknown', 'high', `unrecognised az command "${groupPath}"`);
}

// ---- terraform / tofu / pulumi --------------------------------------------

export function classifyIac(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const name = base(cmd);
  const w = words(cmd.args, /^(-var|-var-file|-target|-state|-backup|-out|-lock-timeout|-parallelism|--stack|-s|--cwd|-C|-chdir)$/);
  const sub = (w[0] ?? '').toLowerCase();
  const sub2 = (w[1] ?? '').toLowerCase();
  const autoApprove = cmd.args.some((a) => a === '-auto-approve' || a === '--yes' || a === '-f' || a === '--skip-preview');

  if (name === 'pulumi') {
    if (['preview', 'stack', 'config', 'about', 'whoami', 'plugin', 'state', 'version', 'logs'].includes(sub) && sub2 !== 'rm' && sub2 !== 'delete') {
      return hit('shell.pulumi.read', 'read_only', `pulumi ${sub} only reads`);
    }
    if (sub === 'destroy') return catastrophic(target, 'shell.pulumi.destroy', 'pulumi destroy tears down every managed resource');
    if (sub === 'up' || sub === 'update') return hit('shell.pulumi.up', 'high', 'pulumi up applies infrastructure changes (create/replace/destroy)', { category: 'integrity' });
    if (sub === 'cancel' || (sub === 'stack' && sub2 === 'rm')) return hit('shell.pulumi.state', 'high', `pulumi ${sub} ${sub2} changes stack state`, { category: 'integrity' });
    return hit('shell.pulumi', 'high', `pulumi ${sub} changes infrastructure`, { category: 'integrity' });
  }

  // terraform / tofu
  if (['plan', 'show', 'output', 'validate', 'version', 'providers', 'fmt', 'graph', 'get', 'workspace', 'login', 'logout', 'test', 'console'].includes(sub)) {
    if (sub === 'workspace' && (sub2 === 'delete' || sub2 === 'rm')) return catastrophic(target, 'shell.tf.workspace-delete', `${name} workspace delete removes a workspace and its state`);
    if (sub === 'workspace' && !['select', 'show', 'list'].includes(sub2)) return hit('shell.tf.workspace', 'medium', `${name} workspace ${sub2}`, { category: 'integrity' });
    return hit(`shell.tf.read`, 'read_only', `${name} ${sub} only reads or plans`);
  }
  if (sub === 'destroy') return catastrophic(target, 'shell.tf.destroy', `${name} destroy deletes every resource it manages`);
  if (sub === 'apply') {
    if (cmd.args.some((a) => a === '-destroy')) return catastrophic(target, 'shell.tf.apply-destroy', `${name} apply -destroy tears down managed resources`);
    // apply with a saved plan file only does what was already reviewed in `plan`.
    const planFile = w.slice(1).find((x) => !x.startsWith('-'));
    if (planFile && !autoApprove) return hit('shell.tf.apply-plan', 'medium', `${name} apply of a saved plan file`, { category: 'integrity' });
    return hit('shell.tf.apply', 'high', `${name} apply creates, replaces or destroys real infrastructure`, { category: 'integrity' });
  }
  if (sub === 'state') {
    if (['rm', 'mv', 'replace-provider', 'push'].includes(sub2)) return hit('shell.tf.state', 'high', `${name} state ${sub2} rewrites tracked state and can orphan real resources`, { category: 'integrity' });
    return hit('shell.tf.state.read', 'read_only', `${name} state ${sub2 || 'list'} reads state`);
  }
  if (['taint', 'untaint', 'import', 'force-unlock', 'refresh', 'unlock'].includes(sub)) {
    return hit('shell.tf.mutate', 'high', `${name} ${sub} changes state or forces the next apply to replace resources`, { category: 'integrity' });
  }
  if (sub === 'init') return hit('shell.tf.init', 'medium', `${name} init downloads providers and configures the backend`, { category: 'code-execution' });
  return hit('shell.tf.unknown', 'high', `unrecognised ${name} command "${sub}"`);
}

/** Commands this module handles, for registration in the dispatcher. */
export const CLOUD_COMMANDS: Record<string, (cmd: SimpleCommand, target: ResolvedTarget) => RuleHit> = {
  aws: classifyAws,
  gcloud: classifyGcloud,
  gsutil: classifyGsutil,
  az: classifyAz,
  terraform: classifyIac,
  tofu: classifyIac,
  pulumi: classifyIac,
};

/** Cloud commands that copy data out, for the exfiltration check in rules-line.ts. */
export const CLOUD_EGRESS = ['aws', 'gcloud', 'gsutil', 'az'];
