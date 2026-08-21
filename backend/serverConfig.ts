export type ServerConfig = {
  host: string;
  port: number;
  requireTls: boolean;
  trustProxy: boolean;
  tokenSecret: string;
};

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
      "OBSYNC_REQUIRE_TLS deve ser true quando OBSYNC_HOST não é loopback.",
    );
  }
  if (requireTls && !trustProxy) {
    throw new Error(
      "Esta versão termina TLS em um proxy reverso. Defina OBSYNC_TRUST_PROXY=true e mantenha a porta do backend protegida da rede pública.",
    );
  }

  return { host, port, requireTls, trustProxy, tokenSecret };
}

function parsePort(value: string | undefined): number {
  if (!value) return 3_000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT deve ser um número inteiro entre 1 e 65535.");
  }
  return port;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Valores booleanos de ambiente devem ser 'true' ou 'false'.");
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
