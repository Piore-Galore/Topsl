import {
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
  type webcrypto,
} from "node:crypto";

/**
 * ID token verification for the proxy's sign-in flows
 * (docs/Native_Harness_Plan.md §2, "Subscription adapters").
 *
 * Only the two signature algorithms OpenID providers commonly publish are
 * accepted (RS256 and ES256). Everything else, including `none`, is rejected
 * so that a token can never choose a weaker check for itself. Error messages
 * name what failed, never the token or its claims.
 */

/** Why a token or key set was refused. Messages never quote token material. */
export class JwtError extends Error {
  readonly code: JwtErrorCode;
  constructor(code: JwtErrorCode, message: string) {
    super(message);
    this.name = "JwtError";
    this.code = code;
  }
}

export type JwtErrorCode =
  | "malformed"
  | "unsupported-algorithm"
  | "unknown-key"
  | "invalid-signature"
  | "wrong-issuer"
  | "wrong-audience"
  | "expired"
  | "not-yet-valid"
  | "nonce-mismatch"
  | "missing-subject"
  | "jwks-unavailable"
  | "discovery-unavailable";

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
  [name: string]: unknown;
}

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  [name: string]: unknown;
}

export interface DecodedJwt {
  header: JwtHeader;
  claims: JwtClaims;
  /** The `header.payload` text the signature covers. */
  signingInput: string;
  signature: Buffer;
}

const base64url = /^[A-Za-z0-9_-]*$/;

function decodeSegment(segment: string, what: string): unknown {
  if (!base64url.test(segment))
    throw new JwtError("malformed", `The token ${what} is not base64url.`);
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new JwtError("malformed", `The token ${what} is not JSON.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Splits a compact JWS without checking anything but its shape. Callers must
 * not trust the claims until {@link verifyJwt} has accepted the token.
 */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3)
    throw new JwtError("malformed", "The token is not a signed JWT.");
  const [rawHeader, rawClaims, rawSignature] = parts as [
    string,
    string,
    string,
  ];
  const header = decodeSegment(rawHeader, "header");
  const claims = decodeSegment(rawClaims, "payload");
  if (!isRecord(header) || typeof header.alg !== "string")
    throw new JwtError("malformed", "The token header is incomplete.");
  if (!isRecord(claims))
    throw new JwtError("malformed", "The token payload is not an object.");
  if (!base64url.test(rawSignature) || rawSignature.length === 0)
    throw new JwtError("malformed", "The token signature is missing.");
  return {
    header: header as JwtHeader,
    claims: claims as JwtClaims,
    signingInput: `${rawHeader}.${rawClaims}`,
    signature: Buffer.from(rawSignature, "base64url"),
  };
}

/** A JSON Web Key as a JWKS publishes it. */
export interface Jwk extends webcrypto.JsonWebKey {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
}

type SupportedAlgorithm = "RS256" | "ES256";

function supportedAlgorithm(alg: string): alg is SupportedAlgorithm {
  return alg === "RS256" || alg === "ES256";
}

/** Whether a published key may check a signature made with `alg`. */
function keyFits(jwk: Jwk, alg: SupportedAlgorithm): boolean {
  if (jwk.use !== undefined && jwk.use !== "sig") return false;
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  if (alg === "RS256") return jwk.kty === "RSA";
  return jwk.kty === "EC" && jwk.crv === "P-256";
}

/** Imports a published key, or returns null when it cannot be used safely. */
function importKey(jwk: Jwk, alg: SupportedAlgorithm): KeyObject | null {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return null;
  }
  // A short RSA modulus is forgeable; 2048 bits is the floor RFC 7518 §3.3
  // sets for RS256.
  if (alg === "RS256" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
    return null;
  return key;
}

function signatureMatches(
  decoded: DecodedJwt,
  alg: SupportedAlgorithm,
  key: KeyObject,
): boolean {
  const data = Buffer.from(decoded.signingInput, "ascii");
  try {
    if (alg === "RS256")
      return verifySignature("sha256", data, key, decoded.signature);
    // JWS carries ECDSA signatures as raw r||s, not DER (RFC 7518 §3.4).
    if (decoded.signature.length !== 64) return false;
    return verifySignature(
      "sha256",
      data,
      { key, dsaEncoding: "ieee-p1363" },
      decoded.signature,
    );
  } catch {
    return false;
  }
}

export interface FetchOptions {
  fetch?: typeof fetch;
  /** Per-request budget, so a stalled provider cannot hold a sign-in open. */
  timeoutMs?: number;
}

const defaultTimeoutMs = 30_000;

async function fetchJson(
  url: string,
  options: FetchOptions,
  failure: JwtErrorCode,
  what: string,
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs),
    });
  } catch {
    throw new JwtError(failure, `The ${what} could not be reached.`);
  }
  if (!response.ok)
    throw new JwtError(
      failure,
      `The ${what} answered with HTTP ${response.status}.`,
    );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new JwtError(failure, `The ${what} is not JSON.`);
  }
  if (!isRecord(body))
    throw new JwtError(failure, `The ${what} is not a JSON object.`);
  return body;
}

/**
 * Remote endpoints must use https. Plain http is allowed only on loopback,
 * where local test servers run and nothing crosses the network.
 */
export function assertSecureEndpoint(url: string, what: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new JwtError("discovery-unavailable", `The ${what} is not a URL.`);
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(
    parsed.hostname,
  );
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && loopback) return;
  throw new JwtError(
    "discovery-unavailable",
    `The ${what} does not use https.`,
  );
}

/**
 * Caches one JWKS. A token naming a key the cache does not hold triggers one
 * refetch (providers rotate keys by adding a new `kid`), but no more often
 * than `minRefetchMs`, so a stream of forged `kid`s cannot turn the proxy
 * into a request amplifier against the provider.
 */
export class JwksCache {
  private keys: Jwk[] | null = null;
  private fetchedAt = 0;
  private pending: Promise<Jwk[]> | null = null;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly minRefetchMs: number;
  constructor(
    readonly jwksUri: string,
    private readonly options: FetchOptions & {
      now?: () => number;
      maxAgeMs?: number;
      minRefetchMs?: number;
    } = {},
  ) {
    assertSecureEndpoint(jwksUri, "signing key set address");
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000;
    this.minRefetchMs = options.minRefetchMs ?? 60 * 1000;
  }

  private load(): Promise<Jwk[]> {
    this.pending ??= (async () => {
      try {
        const body = await fetchJson(
          this.jwksUri,
          this.options,
          "jwks-unavailable",
          "signing key set",
        );
        if (!Array.isArray(body.keys))
          throw new JwtError(
            "jwks-unavailable",
            "The signing key set has no keys.",
          );
        const keys = body.keys.filter(
          (key): key is Jwk => isRecord(key) && typeof key.kty === "string",
        );
        this.keys = keys;
        this.fetchedAt = this.now();
        return keys;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  /** Warms the cache, so later verification needs no network. */
  async prefetch(): Promise<void> {
    if (!this.keys || this.now() - this.fetchedAt > this.maxAgeMs)
      await this.load();
  }

  /** Keys that could have signed a token with this header. */
  async candidates(header: JwtHeader): Promise<Jwk[]> {
    if (!supportedAlgorithm(header.alg))
      throw new JwtError(
        "unsupported-algorithm",
        "The token uses an unsupported signature algorithm.",
      );
    const alg = header.alg;
    const select = (keys: Jwk[]) =>
      keys.filter(
        (key) =>
          keyFits(key, alg) &&
          (header.kid === undefined || key.kid === header.kid),
      );
    const keys =
      this.keys && this.now() - this.fetchedAt <= this.maxAgeMs
        ? this.keys
        : await this.load();
    let found = select(keys);
    if (found.length === 0 && this.now() - this.fetchedAt >= this.minRefetchMs)
      found = select(await this.load());
    if (found.length === 0)
      throw new JwtError(
        "unknown-key",
        "The token names a signing key the provider does not publish.",
      );
    return found;
  }
}

export interface VerifyOptions {
  jwks: JwksCache;
  issuer: string;
  /** The client ID the token must be issued to. */
  audience: string;
  /** The nonce sent with this sign-in attempt; omitted for refreshed tokens. */
  nonce?: string;
  now?: () => number;
  /** Allowed clock difference in seconds (at most 60). */
  skewSeconds?: number;
}

/**
 * Verifies an OpenID Connect ID token: signature against the provider's key
 * set, then issuer, audience, authorized party, lifetime and nonce
 * (OpenID Connect Core §3.1.3.7). Returns the claims only when all hold; the
 * caller's identity is the returned `sub` together with `audience`.
 */
export async function verifyJwt(
  token: string,
  options: VerifyOptions,
): Promise<JwtClaims & { sub: string }> {
  const decoded = decodeJwt(token);
  const { header, claims } = decoded;
  const alg = header.alg as SupportedAlgorithm;
  const keys = (await options.jwks.candidates(header))
    .map((jwk) => importKey(jwk, alg))
    .filter((key): key is KeyObject => key !== null);
  if (keys.length === 0)
    throw new JwtError(
      "unknown-key",
      "The provider's matching signing keys are unusable.",
    );
  const valid = keys.some((key) => signatureMatches(decoded, alg, key));
  if (!valid)
    throw new JwtError(
      "invalid-signature",
      "The token signature does not match the provider's keys.",
    );
  if (claims.iss !== options.issuer)
    throw new JwtError(
      "wrong-issuer",
      "The token was issued by a different provider.",
    );
  const audiences =
    typeof claims.aud === "string"
      ? [claims.aud]
      : Array.isArray(claims.aud)
        ? claims.aud
        : [];
  if (!audiences.includes(options.audience))
    throw new JwtError(
      "wrong-audience",
      "The token was issued to a different client.",
    );
  if (claims.azp !== undefined && claims.azp !== options.audience)
    throw new JwtError(
      "wrong-audience",
      "The token was authorized for a different client.",
    );
  const skew = Math.min(Math.max(options.skewSeconds ?? 60, 0), 60);
  const nowSeconds = (options.now ?? Date.now)() / 1000;
  if (typeof claims.exp !== "number")
    throw new JwtError("malformed", "The token has no expiry.");
  if (nowSeconds > claims.exp + skew)
    throw new JwtError("expired", "The token has expired.");
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== "number")
      throw new JwtError("malformed", "The token start time is not a number.");
    if (nowSeconds < claims.nbf - skew)
      throw new JwtError("not-yet-valid", "The token is not valid yet.");
  }
  if (claims.iat !== undefined && typeof claims.iat !== "number")
    throw new JwtError("malformed", "The token issue time is not a number.");
  if (options.nonce !== undefined && claims.nonce !== options.nonce)
    throw new JwtError(
      "nonce-mismatch",
      "The token does not belong to this sign-in attempt.",
    );
  if (typeof claims.sub !== "string" || claims.sub.length === 0)
    throw new JwtError("missing-subject", "The token names no account.");
  return claims as JwtClaims & { sub: string };
}

/** The discovery fields the proxy uses (OpenID Connect Discovery §3). */
export interface OidcDiscovery {
  issuer: string;
  jwks_uri: string;
  revocation_endpoint: string | null;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
}

/**
 * Reads `<issuer>/.well-known/openid-configuration`. The document must name
 * the same issuer it was fetched from (Discovery §4.3); otherwise a
 * misdirected request could hand Topsl another provider's keys.
 */
export async function discoverOidc(
  issuer: string,
  options: FetchOptions = {},
): Promise<OidcDiscovery> {
  assertSecureEndpoint(issuer, "issuer");
  const body = await fetchJson(
    `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
    options,
    "discovery-unavailable",
    "provider discovery document",
  );
  if (body.issuer !== issuer)
    throw new JwtError(
      "discovery-unavailable",
      "The provider discovery document names a different issuer.",
    );
  if (typeof body.jwks_uri !== "string")
    throw new JwtError(
      "discovery-unavailable",
      "The provider discovery document has no signing key set.",
    );
  const optional = (name: string): string | null => {
    const value = body[name];
    if (typeof value !== "string") return null;
    assertSecureEndpoint(value, name.replace(/_/g, " "));
    return value;
  };
  assertSecureEndpoint(body.jwks_uri, "signing key set address");
  return {
    issuer,
    jwks_uri: body.jwks_uri,
    revocation_endpoint: optional("revocation_endpoint"),
    authorization_endpoint: optional("authorization_endpoint"),
    token_endpoint: optional("token_endpoint"),
  };
}

/**
 * One provider's discovery document and key set, fetched on first use and
 * reused afterwards. A failed fetch is not cached, so the next sign-in or
 * refresh tries again.
 */
export class OidcProvider {
  private discovery: Promise<OidcDiscovery> | null = null;
  private jwksCache: JwksCache | null = null;
  constructor(
    readonly issuer: string,
    private readonly options: FetchOptions & { now?: () => number } = {},
  ) {}

  metadata(): Promise<OidcDiscovery> {
    if (!this.discovery) {
      const pending = discoverOidc(this.issuer, this.options);
      this.discovery = pending;
      pending.catch(() => {
        if (this.discovery === pending) this.discovery = null;
      });
    }
    return this.discovery;
  }

  async jwks(): Promise<JwksCache> {
    const { jwks_uri } = await this.metadata();
    if (!this.jwksCache || this.jwksCache.jwksUri !== jwks_uri)
      this.jwksCache = new JwksCache(jwks_uri, this.options);
    return this.jwksCache;
  }

  async verifyIdToken(
    token: string,
    expected: { audience: string; nonce?: string },
  ): Promise<JwtClaims & { sub: string }> {
    return verifyJwt(token, {
      jwks: await this.jwks(),
      issuer: this.issuer,
      audience: expected.audience,
      nonce: expected.nonce,
      now: this.options.now,
    });
  }
}
