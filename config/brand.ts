/**
 * BRAND STRINGS — THE RENAMING CONTRACT
 * =====================================
 *
 * This file is the single source of truth for every user-facing brand string in the
 * product. The contract it enforces:
 *
 *   Renaming the product must be a change to THIS FILE AND NO OTHER FILE
 *   for every string a user can see.
 *
 * That qualifier is load-bearing and was added after QA measured the claim rather than
 * reading it. Roughly ten files hardcode the name in identifiers a user never sees:
 * `__cairnMapSourceCache`, `__cairnDb__`, `__cairnConnectorCache__`, the `cairn_dev`
 * database name, the `cairn_csp` cache key, and `package.json`'s private `name` field.
 * None is rendered, logged to a user, or sent to a third party — the one that WAS sent to a
 * third party, an outbound User-Agent, was found and fixed.
 *
 * They are left alone deliberately: renaming a globalThis handle or a local database has no
 * user-visible effect and carries real risk of breaking a running deployment's cache or
 * connection string for no benefit. But the unqualified sentence was not true, and this file
 * of all files should not assert something it does not do.
 *
 * That means:
 *
 *   1. No component, route, page title, email template, test, seed row, migration,
 *      CSS token name, or piece of content may contain the product name as a literal.
 *      Import it from here. A grep for the product name outside this file and
 *      `docs/brand/` is a bug, and `docs/qa/` should assert that.
 *   2. Design-token names are brand-neutral by the same rule (`--surface-base`, never
 *      `--<product>-surface-base`). See `docs/brand/colour.md` §0.
 *   3. The two logo files under `docs/brand/logo/` are the deliberate exception. The
 *      wordmark *is* the name drawn as geometry, so it cannot be parameterised; it must
 *      be redrawn on a rename. That cost is documented in `docs/brand/alternates.md`.
 *
 * Everything below is derived from the four constants in the PRIMITIVES block, so a
 * rename is a handful of edits in one place rather than a search across the object.
 *
 * PROVENANCE
 *   Name chosen in `docs/brand/naming.md` (8 candidates scored, cut to 3, one chosen).
 *   Runners-up held in `docs/brand/alternates.md`.
 *
 * UNCONFIRMED IDENTIFIERS — READ BEFORE SHIPPING
 *   The domain, the contact addresses, the social handles, and the legal entity below are
 *   *proposed and unregistered*. Nobody has verified that any of them are available, and
 *   this codebase cannot check.
 *
 *   The domain placeholder therefore uses `.example`, which RFC 2606 reserves and
 *   guarantees can never be registered or resolve. This is chosen so that a placeholder
 *   which escapes to production fails loudly and locally instead of silently delivering
 *   a user's mail to a stranger who happens to own the real domain.
 *
 *   `domainRegistered` and `socialsRegistered` are `false`. The UI MUST gate rendering of
 *   any link or address on those flags rather than on a hardcoded condition, so that
 *   "if it isn't built, it isn't linked" (product-brief §8) is enforced by the type system
 *   and not by memory. Flip them in the same commit that registers the real identifiers.
 */

/* ------------------------------------------------------------------ *
 * PRIMITIVES — the only lines that change on a rename
 * ------------------------------------------------------------------ */

const NAME = 'Cairn';
const NAME_LOWER = 'cairn';
const DOMAIN = 'cairn.example';
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

  /**
   * The entity that would appear on a privacy policy, terms of service, or DPA.
   * No company has been incorporated. This string must be replaced with the registered
   * entity name before any public launch — the legal pages cannot be finalised without it.
   * See `docs/decisions/0002-scope-boundary.md` and `docs/content/legal-review.md`.
   */
  legalEntity: `${NAME} (unincorporated project)`,
  legalEntityIncorporated: false,

  /** Short line for the header and social cards. Sentence case, no full stop. */
  tagline: 'Open sources, checked and dated',

  /** One-line pitch. Names all three pillars. From `docs/brand/positioning.md` §2. */
  pitch:
    'A vetted directory of OSINT tools, the playbooks that use them, and a workspace ' +
    'to run your case in.',

  /**
   * Meta description. 236 characters total, of which the first sentence is 158 — so the
   * portion search engines typically render stands alone, and the trailing sentence (the
   * one our audience actually cares about) is a bonus rather than a truncated fragment.
   * From `docs/brand/positioning.md` §3.
   */
  description:
    `${NAME} is a curated directory of open-source intelligence tools and data sources, ` +
    'paired with step-by-step investigative playbooks and private case workspaces. ' +
    'Every entry states its cost, jurisdiction, and when a human last verified it.',

  /**
   * Placeholder domain. RFC 2606 reserved TLD — cannot be registered, cannot resolve.
   * Replace together with `domainRegistered` when a real domain is acquired.
   */
  domainPlaceholder: DOMAIN,
  domainRegistered: false,

  /** Contact addresses. All on the placeholder domain; none of these mailboxes exist yet. */
  email: {
    support: `support@${DOMAIN}`,
    security: `security@${DOMAIN}`,
    press: `press@${DOMAIN}`,
    privacy: `privacy@${DOMAIN}`,
    legal: `legal@${DOMAIN}`,
  },

  /**
   * Proposed social handles. None are registered or claimed.
   * Do not render a link to any of these while `socialsRegistered` is false.
   */
  social: {
    mastodon: `@${NAME_LOWER}`,
    bluesky: `@${NAME_LOWER}`,
    github: NAME_LOWER,
  },
  socialsRegistered: false,

  /** Source repository. */
  repoUrl: `https://github.com/${NAME_LOWER}/${NAME_LOWER}`,

  /**
   * Legal facts the policy documents in `content/legal/` interpolate.
   *
   * These are NOT known. No entity is incorporated, no jurisdiction of establishment is
   * chosen, and no lawyer has reviewed anything — see `docs/content/legal-review.md`.
   *
   * They are deliberately `null` rather than filled with a plausible guess. A privacy
   * policy that names a governing law we invented is worse than one that admits the gap:
   * it is a false statement of fact in the one document a user is entitled to rely on,
   * and it would mislead exactly the people least able to absorb the consequences.
   *
   * `reviewComplete` gates the rendering. While it is false the legal pages render with a
   * pre-launch banner and show unresolved values as a visible marker, never as prose that
   * reads as settled. Flip it in the same commit that records counsel's answers.
   */
  legal: {
    reviewComplete: false,
    /** Where the operating entity is established. Determines the supervisory authority. */
    governingLaw: null,
    /** Where user data physically rests. Required by the privacy notice. */
    dataRegion: null,
    /** Effective date of the current policy version. Set when counsel signs off. */
    policyEffectiveDate: null,
    /** Billing currency. Nothing is charged in v1, so this is unresolved by design. */
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
