/**
 * Injects internal and affiliate links into already-rendered article HTML.
 *
 * Two kinds of link, first occurrence only:
 *  - a provider name -> its affiliate link (rel="noopener nofollow sponsored")
 *  - a few key phrases -> the site's core pages
 *
 * Each destination is linked at most once per article, so the anchor text
 * pointing at a page varies from one article to the next instead of every page
 * repeating the same exact-match anchor.
 *
 * The PureVPN URL below must stay identical to providers.ts; it is duplicated
 * here because this runs in the page-render pipeline, not in the component.
 */
import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';

const SITE = 'https://www.topvpn.top';
const AFFILIATE_PUREVPN = 'https://billing.purevpn.com/aff.php?aff=49385888';
const AFFILIATE_REL = 'noopener nofollow sponsored';
const MAX_LINKS = 4;

// Ordered: a phrase must appear before any phrase it contains, because regex
// alternation takes the first alternative that matches at a given position
// ("VPN protocol" must be tried before "VPN").
const TARGETS = [
  { re: /dedicated IP VPNs?/i, href: `${SITE}/vpn-types-guide` },
  { re: /VPN protocols?/i, href: `${SITE}/connection-guide` },
  { re: /VPN comparison/i, href: `${SITE}/order-vpn` },
  { re: /compare VPNs?/i, href: `${SITE}/order-vpn` },
  // Proton VPN is a brand name; linking only the "VPN" half of it looks broken.
  { re: /(?<!Proton )VPNs?/i, href: `${SITE}/` },
  { re: /WireGuard/i, href: `${SITE}/connection-guide` },
  { re: /PureVPN/i, href: AFFILIATE_PUREVPN, affiliate: true },
];

const combined = new RegExp(
  TARGETS.map((t) => `(${t.re.source})`).join('|'),
  'gi',
);

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

interface LinkState {
  used: Set<string>;
  count: number;
}

/** Split a text node into text + link nodes around the first matches. */
function splitText(value: string, state: LinkState): HastNode[] | null {
  const nodes = [];
  let last = 0;
  combined.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = combined.exec(value)) !== null) {
    const target = TARGETS.find((t, i) => match![i + 1]);
    // Affiliate links are exempt from the per-article cap: the partner link is
    // required wherever the provider is named. Internal links are capped so
    // a page never repeats the same exact-match anchor ad nauseam.
    if (!target || state.used.has(target.href) || (!target.affiliate && state.count >= MAX_LINKS)) {
      continue;
    }
    if (match.index > last) {
      nodes.push({ type: 'text', value: value.slice(last, match.index) });
    }
    nodes.push({
      type: 'element',
      tagName: 'a',
      properties: {
        href: target.href,
        ...(target.affiliate ? { rel: AFFILIATE_REL } : {}),
      },
      children: [{ type: 'text', value: match[0] }],
    });
    state.used.add(target.href);
    if (!target.affiliate) state.count += 1;
    last = match.index + match[0].length;
  }
  if (last === 0) return null;
  if (last < value.length) nodes.push({ type: 'text', value: value.slice(last) });
  return nodes;
}

/**
 * Walk the HAST tree. Only direct text children of a <p> are linked, which
 * skips headings, list items, code blocks, inline code, links and alt text.
 * Nested paragraphs are covered because we recurse into every element.
 */
function walk(node: HastNode, state: LinkState) {
  if (node.type === 'element') {
    if (node.tagName === 'p' && node.children) {
      const children = [];
      for (const child of node.children) {
        // splitText returns an array of nodes (or null if nothing matched).
        const split = child.type === 'text' && child.value ? splitText(child.value, state) : null;
        if (split) children.push(...split);
        else children.push(child);
      }
      node.children = children;
      // Do not recurse into the paragraph's own children; nested <a>/<code>
      // inside it are already handled by the split above.
      return;
    }
    if (node.children) node.children.forEach((c) => walk(c, state));
  } else if (node.type === 'root' && node.children) {
    node.children.forEach((c) => walk(c, state));
  }
}

export async function injectArticleLinks(html: string): Promise<string> {
  const state: LinkState = { used: new Set<string>(), count: 0 };
  const file = await unified()
    .use(rehypeParse, { fragment: true })
    .use(() => (tree) => walk(tree, state))
    .use(rehypeStringify)
    .process(html);
  return String(file);
}
