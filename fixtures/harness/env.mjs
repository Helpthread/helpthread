// fixtures/harness/env.mjs
//
// Loads harness configuration from process.env. No dotenv dependency by
// design (charter: minimize deps, verify licenses at adoption) — export the
// vars in your shell, or `source` a local (gitignored) file before running.
//
// Fails fast with one clear error listing every missing var, rather than
// dying on the first `undefined` deep inside a scenario.

const REQUIRED = [
  {
    name: 'HARNESS_SMTP_USER',
    desc: 'Gmail address used to send probe emails (also the IMAP account for reading outbound replies)',
  },
  {
    name: 'HARNESS_SMTP_PASS',
    desc: 'Gmail app password for HARNESS_SMTP_USER (not the account password — https://myaccount.google.com/apppasswords)',
  },
  {
    name: 'HARNESS_HELPDESK_ADDR',
    desc: 'The support mailbox address that probe emails are sent TO (the FreeScout-polled inbox)',
  },
  {
    name: 'HARNESS_FS_BASE_URL',
    desc: 'Base URL of the FreeScout instance, e.g. https://support.example.com',
  },
  {
    name: 'HARNESS_FS_API_KEY',
    desc: 'FreeScout REST API key (sent as X-FreeScout-API-Key)',
  },
];

const OPTIONAL_DEFAULTS = {
  HARNESS_FS_USER_ID: '1',
};

let cached = null;

/**
 * Load and validate harness env config. Throws a single Error listing every
 * missing variable if any required var is absent/empty. Safe to call
 * repeatedly — validated once, then cached.
 */
export function loadEnv() {
  if (cached) return cached;

  const missing = REQUIRED.filter(({ name }) => {
    const v = process.env[name];
    return v === undefined || v === null || v.trim() === '';
  });

  if (missing.length > 0) {
    const lines = missing.map(({ name, desc }) => `  - ${name}: ${desc}`);
    throw new Error(
      [
        'harness: missing required environment variables:',
        ...lines,
        '',
        'Set these in your shell before running fixtures:run. See fixtures/harness/README.md.',
      ].join('\n'),
    );
  }

  const fsUserId = Number(process.env.HARNESS_FS_USER_ID ?? OPTIONAL_DEFAULTS.HARNESS_FS_USER_ID);
  if (!Number.isInteger(fsUserId) || fsUserId <= 0) {
    throw new Error(
      `harness: HARNESS_FS_USER_ID must be a positive integer, got "${process.env.HARNESS_FS_USER_ID}"`,
    );
  }

  const config = {
    smtpUser: process.env.HARNESS_SMTP_USER,
    smtpPass: process.env.HARNESS_SMTP_PASS,
    helpdeskAddr: process.env.HARNESS_HELPDESK_ADDR,
    fsBaseUrl: process.env.HARNESS_FS_BASE_URL.replace(/\/+$/, ''),
    fsApiKey: process.env.HARNESS_FS_API_KEY,
    fsUserId,
    // Optional: comma-separated real display names (e.g. an agent's name that
    // appears in FreeScout audit-log thread bodies) to scrub from fixtures.
    // Free-text names can't be caught structurally, so the operator names them.
    identityNames: (process.env.HARNESS_IDENTITY_NAMES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };

  cached = config;
  return config;
}
