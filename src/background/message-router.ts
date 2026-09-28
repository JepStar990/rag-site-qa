/**
 * Message dispatch (docs/03-component-design.md).
 *
 * Every message is sender-checked and schema-validated before dispatch;
 * malformed or foreign messages are rejected without an error oracle (04).
 */

import { isTrustedSender, MSG, parseMessage } from '../shared/msg-protocol';
import type { MessageResponse } from '../shared/msg-protocol';
import { publicSettings } from '../shared/settings';
import { getSiteStatus } from './handlers/site-status';
import { listSources } from './handlers/sources';
import { getStoredSettings, saveStoredSettings } from './storage/settings-store';

export async function handleMessage(
  value: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<MessageResponse> {
  if (!isTrustedSender(sender)) throw new Error('untrusted sender');
  const message = parseMessage(value);
  if (!message) throw new Error('malformed message');

  switch (message.type) {
    case MSG.getSettings:
      return { ok: true, kind: 'settings', settings: publicSettings(await getStoredSettings()) };
    case MSG.saveSettings:
      return { ok: true, kind: 'settings', settings: publicSettings(await saveStoredSettings(message.settings)) };
    case MSG.getSiteStatus:
      return { ok: true, kind: 'status', status: await getSiteStatus(message.origin) };
    case MSG.listSources:
      return { ok: true, kind: 'sources', sources: await listSources(message.origin) };
  }
}
