/** Resolved, validated runtime configuration for the backend server. */
export type ServerConfig = {
  host: string;
  port: number;
  /** Whether the server should assume it is only reachable over TLS (usually terminated by a reverse proxy). */
  requireTls: boolean;
  /** Whether the server should trust `X-Forwarded-*` headers from a reverse proxy. */
  trustProxy: boolean;
  tokenSecret: string;
};

/**
 * Reads and validates server configuration from environment variables,
 * applying sane defaults and enforcing the security invariant that any
 * non-loopback host must run behind TLS with proxy trust enabled.
 *
 * @param environment - Source of environment variables; defaults to `process.env`, overridable for testing.
 * @returns The fully resolved {@link ServerConfig}.
 * @throws {Error} If a non-loopback host does not require TLS, or if TLS is required without proxy trust enabled.
 */
export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const host = environment.OBSYNC_HOST?.trim() || "127.0.0.1";
  const port = parsePort(environment.PORT);
  const trustProxy = parseBoolean(environment.OBSYNC_TRUST_PROXY, false);
  const requireTls = parseBoolean(
    environment.OBSYNC_REQUIRE_TLS,
    !isLoopbackHost(host),
  );
  const tokenSecret = environment.OBSYNC_TOKEN_SECRET?.trim() ?? "";

  if (!isLoopbackHost(host) && !requireTls) {
    throw new Error(
      "OBSYNC_REQUIRE_TLS must be true when OBSYNC_HOST is not loopback.",
    );
  }
  if (requireTls && !trustProxy) {
    throw new Error(
      "This version terminates TLS at a reverse proxy. Set OBSYNC_TRUST_PROXY=true and keep the backend port protected from the public network.",
    );
  }

  return { host, port, requireTls, trustProxy, tokenSecret };
}

/**
 * Parses the `PORT` environment value into a valid TCP port number.
 *
 * @param value - Raw environment variable value, or `undefined` to use the default.
 * @returns The port number (defaults to 3000 when `value` is not set).
 * @throws {Error} If `value` is set but is not an integer between 1 and 65535.
 */
function parsePort(value: string | undefined): number {
  if (!value) return 3_000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

/**
 * Parses a strict `"true"`/`"false"` environment variable into a boolean.
 *
 * @param value - Raw environment variable value, or `undefined` to use `fallback`.
 * @param fallback - Value returned when `value` is `undefined`.
 * @returns The parsed boolean.
 * @throws {Error} If `value` is set but is neither `"true"` nor `"false"`.
 */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Environment boolean values must be 'true' or 'false'.");
}

/**
 * Checks whether a host string refers to the local machine.
 *
 * @param host - Hostname or IP to check.
 * @returns `true` if `host` is `127.0.0.1`, `::1`, or `localhost`.
 */
function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
