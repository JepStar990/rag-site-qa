import { browserApi } from '../shared/browser-api';
import { handleMessage } from './message-router';

// Listeners are registered synchronously at top level. Firefox event pages
// only re-launch for listeners registered this way, and both platforms drop
// the service worker after idle, so no state may live at module scope.
browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch(() => sendResponse({ ok: false, error: 'unhandled' }));
  return true; // keep the message channel open for the async response
});
