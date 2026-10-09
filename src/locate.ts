import type { Locator, Page } from 'playwright';
import type { Target } from './script.js';

// Roles people usually mean when they say "click X".
const CLICKABLE = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'option'] as const;

export const isSelector = (s: string) => /^[#.[]|^[a-z][\w-]*[#.[:>]|^(css|xpath|text)=|^\/\//i.test(s);

export interface Match {
  locator: Locator;
  // How many equally good matches there were (more than 1 means the target was ambiguous).
  count: number;
}

export class NotFound extends Error {}

// Matching rules, in order. The first rule that finds something visible wins:
//   exact beats partial, and within each: buttons/links, then form fields, then any text.
function rules(root: Page | Locator, text: string): Locator[] {
  const roles = (exact: boolean) =>
    CLICKABLE.map((role) => root.getByRole(role, { name: text, exact })).reduce((a, b) => a.or(b));
  const fields = (exact: boolean) => root.getByLabel(text, { exact }).or(root.getByPlaceholder(text, { exact }));
  return [
    roles(true),
    fields(true),
    root.getByText(text, { exact: true }),
    roles(false),
    fields(false),
    root.getByText(text),
  ];
}

// For each element, how many levels up we have to go before reaching an
// ancestor that contains `needle`. -1 if none does. Smaller = closer.
async function distancesTo(loc: Locator, needle: string): Promise<number[]> {
  return loc.evaluateAll((els, n) => {
    return els.map((el) => {
      let node: Element | null = el;
      for (let d = 0; node; d++, node = node.parentElement) {
        if ((node.textContent ?? '').toLowerCase().includes(n)) return d;
      }
      return -1;
    });
  }, needle.toLowerCase());
}

export async function findOnce(page: Page, target: Target): Promise<Match | null> {
  let root: Page | Locator = page;
  const scopeIsSelector = target.in !== undefined && isSelector(target.in);
  if (scopeIsSelector) {
    root = page.locator(target.in!).filter({ visible: true }).first();
    if ((await root.count()) === 0) return null;
  }

  const candidates = isSelector(target.text) ? [root.locator(target.text)] : rules(root, target.text);
  for (const candidate of candidates) {
    const loc = candidate.filter({ visible: true });
    const total = await loc.count();
    if (total === 0) continue;

    let order = [...Array(total).keys()];
    let count = total;
    if (target.in && !scopeIsSelector) {
      const dist = await distancesTo(loc, target.in);
      order = order.filter((i) => dist[i] >= 0).sort((a, b) => dist[a] - dist[b]);
      if (order.length === 0) continue;
      count = order.filter((i) => dist[i] === dist[order[0]]).length;
    }

    if (target.nth !== undefined) {
      if (target.nth > order.length) {
        throw new NotFound(`asked for match #${target.nth} but only found ${order.length}`);
      }
      return { locator: loc.nth(order[target.nth - 1]), count: 1 };
    }
    return { locator: loc.nth(order[0]), count };
  }
  return null;
}

export async function find(page: Page, target: Target, timeoutMs: number): Promise<Match> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = await findOnce(page, target);
    if (match) return match;
    if (Date.now() > deadline) {
      const where = target.in ? ` near "${target.in}"` : '';
      throw new NotFound(`couldn't find anything on the page matching "${target.text}"${where}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
