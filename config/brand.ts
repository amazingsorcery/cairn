/**
 * Single source of truth for user-facing brand strings. Renaming the product should only
 * touch this file for anything a user can see. Internal identifiers (`__cairnDb__`,
 * `cairn_dev`, the `cairn_csp` cache key, package.json `name`) still use the name; they
 * are never shown to users.
 *
 * Don't hardcode the product name in components, content or CSS token names; import it.
 * The logo wordmark is the exception and must be redrawn on a rename.
 *
 * The social handles and legal entity are unregistered. The UI gates links on the
 * `*Registered` flags; flip them when the identifiers are real.
 */

/* ------------------------------------------------------------------ *
 * Primitives: the only lines that change on a rename
 * ------------------------------------------------------------------ */

const NAME = 'Cairn';
const NAME_LOWER = 'cairn';
const DOMAIN = 'wrath.rip';
const COPYRIGHT_YEAR = 2026;

/* ------------------------------------------------------------------ */

export const brand = {
  /** Display name. Capitalised exactly as it should appear to a user. */
  name: NAME,

  /**
   * Lowercase form for slugs, URL segments, package names, CSS-safe identifiers,
   * social handles, and anywhere a machine-readable token is needed.
   */
  nameLower: NAME_LOWER,

  /** Entity named in the legal pages. Not incorporated; replace before launch. */
  legalEntity: `${NAME} (unincorporated project)`,
  legalEntityIncorporated: false,

  /** Short line for the header and social cards. Sentence case, no full stop. */
  tagline: 'Open sources, checked and dated',

  /** One-line pitch. */
  pitch:
    'A vetted directory of OSINT tools, the playbooks that use them, and a workspace ' +
    'to run your case in.',

  /** Meta description. The first sentence (158 chars) stands alone if truncated. */
  description:
    `${NAME} is a curated directory of open-source intelligence tools and data sources, ` +
    'paired with step-by-step investigative playbooks and private case workspaces. ' +
    'Every entry states its cost, jurisdiction, and when a human last verified it.',

  /**
   * Domain this deployment serves from (an interim host, not the launch domain).
   * Changing it also means updating `APP_URL` and `DOMAIN` in `.env`.
   */
  domainPlaceholder: DOMAIN,
  domainRegistered: true,

  /** Contact addresses. */
  email: {
    support: `support@${DOMAIN}`,
    security: `security@${DOMAIN}`,
    press: `press@${DOMAIN}`,
    privacy: `privacy@${DOMAIN}`,
    legal: `legal@${DOMAIN}`,
  },

  /** Proposed social handles; don't link them while `socialsRegistered` is false. */
  social: {
    mastodon: `@${NAME_LOWER}`,
    bluesky: `@${NAME_LOWER}`,
    github: NAME_LOWER,
  },
  socialsRegistered: false,

  /** Source repository. */
  repoUrl: `https://github.com/${NAME_LOWER}/${NAME_LOWER}`,

  /**
   * Legal facts interpolated into `content/legal/`. Unknown until legal review, so they
   * are `null` rather than guessed. While `reviewComplete` is false the legal pages show a
   * pre-launch banner and render unresolved values as visible markers.
   */
  legal: {
    reviewComplete: false,
    /** Where the operating entity is established. Determines the supervisory authority. */
    governingLaw: null,
    /** Where user data physically rests. Required by the privacy notice. */
    dataRegion: null,
    /** Effective date of the current policy version. Set when counsel signs off. */
    policyEffectiveDate: null,
    /** Billing currency. Nothing is charged yet. */
    currency: null,
  },

  /** Copyright. */
  copyrightHolder: `The ${NAME} maintainers`,
  copyrightYear: COPYRIGHT_YEAR,
  copyright: `© ${COPYRIGHT_YEAR} The ${NAME} maintainers`,
} as const;

/** The shape of the brand configuration. */
export type Brand = typeof brand;

/** Keys of the contact-address map, for typing mail helpers. */
export type BrandEmailKey = keyof Brand['email'];

/** Keys of the social-handle map. */
export type BrandSocialKey = keyof Brand['social'];

export default brand;
