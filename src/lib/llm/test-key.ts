/**
 * DeepSeek key test (docs/06-llm-integration.md BYOK onboarding UX).
 *
 * Runs in the options page, which is an extension page with host
 * permissions for api.deepseek.com and a CSP connect-src allowing it.
 * A 1-token call validates the key, the model ID, and account balance.
 */

export type TestKeyResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_key' | 'no_balance' | 'rate_limited' | 'bad_request' | 'network_error' };

export async function testDeepSeekKey(apiKey: string, modelId: string): Promise<TestKeyResult> {
  let res: Response;
  try {
    res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    });
  } catch {
    return { ok: false, reason: 'network_error' };
  }

  if (res.ok) return { ok: true };
  switch (res.status) {
    case 401:
      return { ok: false, reason: 'invalid_key' };
    case 402:
      return { ok: false, reason: 'no_balance' };
    case 429:
      return { ok: false, reason: 'rate_limited' };
    default:
      // 400/404/422 usually mean the model ID is unknown; 5xx is transient.
      return { ok: false, reason: 'bad_request' };
  }
}
