// fixtures/harness/redact.mjs
//
// Deterministic sanitization applied to every fixture before it's written
// to disk. Real Gmail addresses and the real helpdesk address never end up
// in the committed fixtures — only stable, obviously-fake placeholders.
// IDs, timestamps, statuses, and structure are left untouched: those are
// exactly what the eventual acceptance suite asserts against.

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitAddress(address) {
  const at = address.indexOf('@');
  if (at === -1) return null;
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

/** Build the set of regexes/replacers needed to redact one address family
 * (the harness's Gmail account and its plus-variants, or the helpdesk
 * address) out of arbitrary text. */
function buildAddressRules({ address, kind }) {
  const parsed = splitAddress(address);
  if (!parsed) return [];

  const rules = [];

  if (kind === 'customer') {
    const bareLocal = escapeRegExp(parsed.local.split('+')[0]);
    const domain = escapeRegExp(parsed.domain);

    // "Display Name <local+tag@domain>" -> "Customer <tag> <customer-<tag>@example.test>"
    rules.push({
      pattern: new RegExp(
        `"?[^"<>\\n]*"?\\s*<\\s*${bareLocal}(?:\\+([^@\\s>]+))?@${domain}\\s*>`,
        'gi',
      ),
      replace: (_match, tag) =>
        tag ? `Customer ${tag} <customer-${tag}@example.test>` : 'Customer <customer@example.test>',
    });

    // bare "local+tag@domain" -> "customer-<tag>@example.test"
    rules.push({
      pattern: new RegExp(`${bareLocal}(?:\\+([^@\\s>"',]+))?@${domain}`, 'gi'),
      replace: (_match, tag) => (tag ? `customer-${tag}@example.test` : 'customer@example.test'),
    });
  } else if (kind === 'helpdesk') {
    const local = escapeRegExp(parsed.local);
    const domain = escapeRegExp(parsed.domain);

    rules.push({
      pattern: new RegExp(`"?[^"<>\\n]*"?\\s*<\\s*${local}@${domain}\\s*>`, 'gi'),
      replace: 'Support Agent <support@example.test>',
    });
    rules.push({
      pattern: new RegExp(`${local}@${domain}`, 'gi'),
      replace: 'support@example.test',
    });
  }

  return rules;
}

function redactString(str, rules) {
  let out = str;
  for (const rule of rules) {
    out = out.replace(rule.pattern, rule.replace);
  }
  return out;
}

/**
 * Recursively redact every string in `value` using the address rules
 * derived from {smtpUser, helpdeskAddr}. Non-string primitives, array
 * structure, and object shape are all left exactly as-is.
 */
export function redact(value, { smtpUser, helpdeskAddr }) {
  if (!smtpUser || !helpdeskAddr) {
    throw new Error('harness: redact requires { smtpUser, helpdeskAddr }');
  }

  const rules = [
    ...buildAddressRules({ address: smtpUser, kind: 'customer' }),
    ...buildAddressRules({ address: helpdeskAddr, kind: 'helpdesk' }),
  ];

  const walk = (node) => {
    if (typeof node === 'string') return redactString(node, rules);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(node)) {
        out[key] = walk(val);
      }
      return out;
    }
    return node;
  };

  return walk(value);
}
