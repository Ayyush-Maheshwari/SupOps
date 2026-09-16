import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { and, eq } from 'drizzle-orm';
import { alertSubscriptions } from '@supops/db';
import { db } from '../context.ts';
import { resolveSlackSettings } from './settings.ts';
import { ingestSlackAlert } from './router.ts';
import type { SlackMessage } from './parse.ts';

/** Slack message subtypes that are edits, deletions, or channel noise -- not alerts. */
const SKIP_SUBTYPES = new Set([
  'message_changed',
  'message_deleted',
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'thread_broadcast',
]);

/**
 * One outbound Socket Mode connection for the whole install. No inbound port is
 * opened -- the client dials Slack. Per-project routing is decided downstream by
 * `alert_subscriptions`, so this class only cares about "is a message in a channel
 * anyone subscribes to, and if so, hand it to the router".
 */
export class SlackListener {
  private client: SocketModeClient | null = null;
  private web: WebClient | null = null;
  private readonly channelNames = new Map<string, string>();
  private connected = false;

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    const { appToken, botToken, enabled } = resolveSlackSettings();
    if (!enabled || !appToken || !botToken) {
      console.log('  slack            not connected (disabled or tokens unset)');
      return;
    }

    this.web = new WebClient(botToken);
    this.client = new SocketModeClient({ appToken });

    this.client.on('message', async (args: { ack?: () => Promise<void>; event?: SlackEvent }) => {
      // Ack immediately; Slack redelivers anything we do not acknowledge in time.
      try {
        await args.ack?.();
      } catch {
        /* ack best-effort */
      }
      if (args.event) void this.handle(args.event).catch((e) => console.error('slack handle error:', e));
    });

    try {
      await this.client.start();
      this.connected = true;
      console.log('  slack            connected (socket mode)');
    } catch (err) {
      this.connected = false;
      console.error('  slack            failed to connect:', err instanceof Error ? err.message : err);
    }
  }

  async stop(): Promise<void> {
    try {
      await this.client?.disconnect();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.web = null;
    this.connected = false;
    this.channelNames.clear();
  }

  /** Apply a settings change without a full process restart. */
  async reload(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async handle(event: SlackEvent): Promise<void> {
    if (event.type !== 'message') return;
    if (event.subtype && SKIP_SUBTYPES.has(event.subtype)) return;
    if (!event.channel) return;

    // Only Alertmanager-shaped posts: a bot message, or one carrying attachments or
    // blocks. This drops human chatter in the same channel without a config toggle.
    const looksLikeAlert =
      !!event.bot_id || (event.attachments?.length ?? 0) > 0 || (event.blocks?.length ?? 0) > 0;
    if (!looksLikeAlert) return;

    // Gate on subscriptions before spending any Web API calls resolving the channel.
    const subscribed = db
      .select({ id: alertSubscriptions.id })
      .from(alertSubscriptions)
      .where(and(eq(alertSubscriptions.channelId, event.channel), eq(alertSubscriptions.enabled, true)))
      .get();
    if (!subscribed) return;

    const channelName = await this.channelName(event.channel);
    const permalink = await this.permalink(event.channel, event.ts);

    ingestSlackAlert({
      channelId: event.channel,
      channelName,
      slackTs: event.ts,
      permalink,
      message: event as SlackMessage,
      rawPayload: event,
    });
  }

  private async channelName(channelId: string): Promise<string> {
    const cached = this.channelNames.get(channelId);
    if (cached) return cached;
    try {
      const info = await this.web?.conversations.info({ channel: channelId });
      const name = (info?.channel as { name?: string } | undefined)?.name;
      const label = name ? `#${name}` : channelId;
      this.channelNames.set(channelId, label);
      return label;
    } catch {
      return channelId;
    }
  }

  private async permalink(channel: string, ts?: string): Promise<string | null> {
    if (!ts) return null;
    try {
      const res = await this.web?.chat.getPermalink({ channel, message_ts: ts });
      return (res?.permalink as string | undefined) ?? null;
    } catch {
      return null;
    }
  }
}

interface SlackEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  ts?: string;
  text?: string;
  bot_id?: string;
  attachments?: unknown[];
  blocks?: unknown[];
}

export const slackListener = new SlackListener();
