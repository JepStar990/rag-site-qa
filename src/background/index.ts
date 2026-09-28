import { browserApi } from '../shared/browser-api';
import { handleMessage } from './message-router';
import { ProgressHub } from './progress-hub';

// Listeners are registered synchronously at top level. Firefox event pages
// only re-launch for listeners registered this way, and both platforms drop
// the service worker after idle, so no state may live at module scope.
const hub = new ProgressHub();

browserApi.runtime.onConnect.addListener((port) => {
  hub.handleConnect(port);
});

browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, hub)
    .then((response) => sendResponse(response))
    .catch(() => sendResponse({ ok: false, error: 'unhandled' }));
  return true; // keep the message channel open for the async response
});
