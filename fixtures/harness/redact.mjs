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

// Person-identity fields on FreeScout user/customer objects that must never
// reach a committed fixture. The acceptance suite asserts on structure, thread
// type, status, ids, and the token FORMAT — never on who a person actually is.
const IDENTITY_FIELD_REPLACERS = {
  firstName: () => 'Redacted',
  lastName: () => 'Person',
  photoUrl: () => 'https://helpdesk.example.test/avatar.jpg',
  photo_url: () => 'https://helpdesk.example.test/avatar.jpg',
};

/** Domain-level rules: scrub the real helpdesk/customer domains out of any
 * remaining free text — reply-token Message-IDs (<FS_reply-…@domain>), avatar
 * URLs (help.<domain>/storage/…), and bare domain mentions. */
function buildDomainRules(...addresses) {
  const rules = [];
  const seen = new Set();
  for (const address of addresses) {
    const parsed = splitAddress(address);
    if (!parsed || seen.has(parsed.domain)) continue;
    seen.add(parsed.domain);
    rules.push({
      pattern: new RegExp(`([a-z0-9._-]+\\.)?${escapeRegExp(parsed.domain)}`, 'gi'),
      replace: (_m, sub) => (sub ? 'helpdesk.example.test' : 'example.test'),
    });
  }
  return rules;
}

/**
 * Recursively redact `value`. String rules scrub the harness's own addresses
 * and the helpdesk/customer domains; a structural pass neutralizes person
 * identity fields (name, avatar) wherever a person-shaped object appears.
 * IDs, timestamps, statuses, thread types, and structure are left untouched.
 */
export function redact(value, { smtpUser, helpdeskAddr, identityNames = [] }) {
  if (!smtpUser || !helpdeskAddr) {
    throw new Error('harness: redact requires { smtpUser, helpdeskAddr }');
  }

  // Real display names appear in free-text audit-log thread bodies
  // ("<Name> started a new conversation #N") where structural person-field
  // redaction can't reach them. Callers pass any known real names to scrub.
  const nameRules = identityNames
    .filter(Boolean)
    .map((name) => ({ pattern: new RegExp(escapeRegExp(name), 'g'), replace: 'Redacted Person' }));

  const rules = [
    ...buildAddressRules({ address: smtpUser, kind: 'customer' }),
    ...buildAddressRules({ address: helpdeskAddr, kind: 'helpdesk' }),
    ...buildDomainRules(helpdeskAddr, smtpUser),
    ...nameRules,
  ];

  const walk = (node) => {
    if (typeof node === 'string') return redactString(node, rules);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      // A person-shaped object is anything carrying an `email` field.
      const isPerson = Object.prototype.hasOwnProperty.call(node, 'email');
      const out = {};
      for (const [key, val] of Object.entries(node)) {
        if (isPerson && IDENTITY_FIELD_REPLACERS[key]) {
          out[key] = val == null ? val : IDENTITY_FIELD_REPLACERS[key]();
        } else {
          out[key] = walk(val);
        }
      }
      return out;
    }
    return node;
  };

  return walk(value);
}
