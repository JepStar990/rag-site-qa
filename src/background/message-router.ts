/**
 * Message dispatch (docs/03-component-design.md).
 *
 * Every message is sender-checked and schema-validated before dispatch;
 * malformed or foreign messages are rejected without an error oracle (04).
 */

import { isTrustedSender, MSG, parseMessage } from '../shared/msg-protocol';
import type { MessageResponse } from '../shared/msg-protocol';
import { publicSettings } from '../shared/settings';
import { askSite } from './handlers/ask-site';
import { indexSite } from './handlers/index-site';
import { getSiteStatusInfo } from './handlers/site-status';
import { listSourcesInfo } from './handlers/sources';
import type { ProgressHub } from './progress-hub';
import { getStoredSettings, saveStoredSettings } from './storage/settings-store';

export async function handleMessage(
  value: unknown,
  sender: chrome.runtime.MessageSender,
  hub: ProgressHub,
): Promise<MessageResponse> {
  if (!isTrustedSender(sender)) throw new Error('untrusted sender');
  const message = parseMessage(value);
  if (!message) throw new Error('malformed message');

  switch (message.type) {
    case MSG.getSettings:
      return { ok: true, kind: 'settings', settings: publicSettings(await getStoredSettings()) };
    case MSG.saveSettings:
      return { ok: true, kind: 'settings', settings: publicSettings(await saveStoredSettings(message.settings)) };
    case MSG.getSiteStatus: {
      const { status, meta } = await getSiteStatusInfo(message.origin);
      return { ok: true, kind: 'status', status, meta };
    }
    case MSG.listSources: {
      const { sources, failed } = await listSourcesInfo(message.origin);
      return { ok: true, kind: 'sources', sources, failed };
    }
    case MSG.indexSite: {
      const result = await indexSite(message.origin, message.url, hub);
      if (result === 'permission-denied') return { ok: false, error: 'permission' };
      return { ok: true, kind: 'indexing', origin: message.origin };
    }
    case MSG.ask: {
      const result = await askSite(message.origin, message.question, message.requestId, hub);
      if (result === 'started') return { ok: true, kind: 'asking', origin: message.origin };
      if (result === 'permission-denied') return { ok: false, error: 'permission' };
      return { ok: false, error: result };
    }
  }
}
