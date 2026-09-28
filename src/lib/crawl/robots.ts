/**
 * robots.txt handling (RFC 9309) for the crawler (docs/03).
 *
 * Only rules from `*` user-agent groups are honored: SiteQA does not
 * declare a crawler user agent and crawls at human-browser cadence.
 * Matching is longest-pattern-wins with ties resolved toward disallow
 * (RFC 9309 2.2.2); `crawl-delay` (seconds) is honored when present.
 */

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  rules: RobotsRule[];
  /** crawl-delay from the `*` group in milliseconds, or null when absent. */
  crawlDelayMs: number | null;
}

export function parseRobotsTxt(text: string): RobotsPolicy {
  const rules: RobotsRule[] = [];
  let crawlDelayMs: number | null = null;
  let groupHasWildcard = false;
  let groupHasRules = false;
  let inGroup = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      inGroup = true;
      if (groupHasRules) {
        // First User-agent line of a new group: reset group scope.
        groupHasRules = false;
        groupHasWildcard = value === '*';
      } else {
        groupHasWildcard = groupHasWildcard || value === '*';
      }
      continue;
    }
    if (!inGroup || !groupHasWildcard) continue;

    if (field === 'disallow' || field === 'allow') {
      groupHasRules = true;
      if (value !== '') rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'crawl-delay') {
      groupHasRules = true;
      const seconds = Number(value);
      if (crawlDelayMs === null && Number.isFinite(seconds) && seconds >= 0) {
        crawlDelayMs = Math.round(seconds * 1000);
      }
    }
  }

  return { rules, crawlDelayMs };
}

/**
 * Whether the crawler may fetch `path` under `policy`. `path` is the
 * candidate URL's pathname plus search; query-bearing paths match so a
 * `Disallow: /search` also covers `/search?q=...`.
 */
export function isAllowedByRobots(path: string, policy: RobotsPolicy): boolean {
  let best: RobotsRule | undefined;
  for (const rule of policy.rules) {
    if (!robotsMatch(path, rule.pattern)) continue;
    if (!best || rule.pattern.length > best.pattern.length) best = rule;
  }
  return best ? best.allow : true;
}

function robotsMatch(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith('$');
  if (anchored) pattern = pattern.slice(0, -1);
  const re = new RegExp(
    '^' + pattern.split('*').map(escapeRegExp).join('.*') + (anchored ? '$' : ''),
  );
  return re.test(path);
}

function escapeRegExp(part: string): string {
  return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
