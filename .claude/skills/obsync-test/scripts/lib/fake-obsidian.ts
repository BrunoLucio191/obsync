// Runtime stand-in for the `obsidian` module, with only what the plugin's sync, auth and
// settings code touches. env.ts routes every `import ... from "obsidian"` here.

export class Plugin {}
export class App {}
export class Modal {}
export class Setting {}

export const notices: string[] = [];
export class Notice {
  constructor(message: string) {
    notices.push(message);
  }
}

export class TAbstractFile {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
  get name(): string {
    return this.path.slice(this.path.lastIndexOf("/") + 1);
  }
}

export class TFile extends TAbstractFile {
  get extension(): string {
    const dot = this.name.lastIndexOf(".");
    return dot === -1 ? "" : this.name.slice(dot + 1);
  }
}

export class TFolder extends TAbstractFile {}

/** i18n reads the language from moment's locale; English keeps assertions stable. */
export const moment = { locale: () => "en" };

/** Counters every scenario can read. `latencyMs` is the max random network delay added per request. */
export const netStats = {
  requests: 0,
  failed: 0,
  inFlight: 0,
  latencies: [] as number[],
  latencyMs: 20,
};

/**
 * fetch-based requestUrl with a random network delay. Same contract as Obsidian's:
 * throws on status >= 400 unless `throw: false`, and exposes status, headers,
 * arrayBuffer, text and a lazily parsed `json`.
 */
export async function requestUrl(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}) {
  await new Promise((r) => setTimeout(r, Math.random() * netStats.latencyMs));
  netStats.requests++;
  netStats.inFlight++;
  const startedAt = performance.now();
  try {
    const response = await fetch(options.url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
    });
    const arrayBuffer = await response.arrayBuffer();
    netStats.latencies.push(performance.now() - startedAt);
    if (response.status >= 400 && options.throw !== false) {
      netStats.failed++;
      throw new Error(`Request failed, status ${response.status}`);
    }
    const text = new TextDecoder().decode(arrayBuffer);
    return {
      status: response.status,
      arrayBuffer,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      get json() {
        return JSON.parse(text);
      },
    };
  } finally {
    netStats.inFlight--;
  }
}
