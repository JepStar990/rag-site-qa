/**
 * Popup progress ports (docs/03): popups connect, subscribe to one origin,
 * and receive `index-progress` / `index-ready` / `index-failed` broadcasts
 * while indexing runs. Ports die with the popup; the hub drops them lazily.
 */

import type { ProgressPortEvent } from '../shared/msg-protocol';
import { isTrustedPort, parsePortEvent, PORT } from '../shared/msg-protocol';

export class ProgressHub {
  private readonly portsByOrigin = new Map<string, Set<chrome.runtime.Port>>();

  handleConnect(port: chrome.runtime.Port): void {
    if (port.name !== PORT.progress || !isTrustedPort(port)) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((value: unknown) => {
      const event = parsePortEvent(value);
      if (!event) return;
      let set = this.portsByOrigin.get(event.origin);
      if (!set) {
        set = new Set();
        this.portsByOrigin.set(event.origin, set);
      }
      set.add(port);
      port.onDisconnect.addListener(() => {
        set.delete(port);
        if (set.size === 0) this.portsByOrigin.delete(event.origin);
      });
    });
  }

  broadcast(origin: string, event: ProgressPortEvent): void {
    const set = this.portsByOrigin.get(origin);
    if (!set) return;
    for (const port of set) {
      try {
        port.postMessage(event);
      } catch {
        set.delete(port);
      }
    }
  }
}
