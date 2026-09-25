// Cursor color: stored in SQLite, changed by each user for themselves through
// PATCH /api/auth/color, adopted by the plugin's AuthService and shown in the Account settings.
import { backend, bundlePlugin, captureLogs, fakeObsidian } from "../lib/env.ts";
import { startBackend } from "../lib/backend.ts";
import { createChecks } from "../lib/check.ts";

const logs = captureLogs();
const { notices } = await fakeObsidian();
const server = await startBackend();
const { dbEvents } = await backend("users/DBEvents.ts");
const checks = createChecks("color", logs.out);
const PALETTE = ["#e74c3c", "#2ecc71", "#3498db", "#9b59b6", "#f39c12"];

const a = await server.createUser(0);
const b = await server.createUser(1);
const patchColor = async (token: string, color: unknown) => {
  const response = await fetch(`${server.baseUrl}/api/auth/color`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-ObSync-Client": "color" },
    body: JSON.stringify(color === undefined ? {} : { color }),
  });
  return { status: response.status, body: await response.json() };
};
const colorOf = async (id: number) => (await server.dbService.getUserById(id)).color;

await checks.check("usuarios novos nascem com cor da paleta", () => {
  for (const u of [a.user, b.user]) if (!PALETTE.includes(u.color)) throw new Error(u.color);
});
await checks.check("CHECK do SQLite recusa cor invalida gravada direto", () => {
  for (const bad of ["blue", "#ABCDEF"]) {
    let threw = false;
    try {
      server.userDB.prepare("UPDATE users SET color = ? WHERE id = ?").run(bad, a.user.id);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`aceitou ${bad}`);
  }
});
const events: number[] = [];
dbEvents().onAuthorizationChanged((id: number) => events.push(id));
const colorB = await colorOf(b.user.id);
const saved = await patchColor(a.token, "#ABCDEF");
await checks.check("PATCH salva normalizado, devolve o usuario e so muda quem pediu", async () => {
  if (saved.status !== 200 || saved.body.user.color !== "#abcdef") throw new Error(JSON.stringify(saved));
  if ((await colorOf(a.user.id)) !== "#abcdef" || (await colorOf(b.user.id)) !== colorB) throw new Error("banco errado");
});
await checks.check("trocar a cor nao emite authorization-changed (nao derruba WebSocket)", () => {
  if (events.length) throw new Error(`emitiu para ${events}`);
});
for (const bad of ["red", "#fff", "#12345g", 123, undefined]) {
  const r = await patchColor(a.token, bad);
  await checks.check(`cor invalida ${JSON.stringify(bad)} -> 400 e nada muda`, async () => {
    if (r.status !== 400 || (await colorOf(a.user.id)) !== "#abcdef") throw new Error(`status ${r.status}`);
  });
}
await checks.check("listUsers traz a cor", async () => {
  const users = await server.dbService.listUsers();
  if (!users.every((u: { color: string }) => /^#[0-9a-f]{6}$/.test(u.color))) throw new Error("sem cor");
});

// ---- plugin side
const plugin = await bundlePlugin({
  AuthService: "auth/AuthService.ts",
  AccountSettingsSection: "settings/AccountSettingsSection.ts",
  getPresenceUser: "collab/collab.utils.ts",
  configureApiEndpoint: "config/ApiConfig.ts",
  initI18n: "i18n/i18n.ts",
});
plugin.initI18n();
plugin.configureApiEndpoint(server.baseUrl);

const startUser = await server.dbService.getUserById(b.user.id);
const config = { backendUrl: server.baseUrl, accessTokenExpiresAt: Date.now() + 3_600_000, user: { ...startUser } };
const sessionChanges: [string | undefined, string | undefined][] = [];
const auth = new plugin.AuthService({
  app: { secretStorage: { getSecret: (id: string) => (id === "obsync-access-token" ? b.token : null), setSecret: () => {} } },
  getConfig: () => config,
  saveConfig: async () => {},
  onSessionChanged: (prev: { color?: string } | null, next: { color?: string } | null) =>
    sessionChanges.push([prev?.color, next?.color]),
});
let result = await auth.changeColor("#123456");
await checks.check("AuthService.changeColor salva e dispara onSessionChanged (reconecta a sala)", async () => {
  if (!result.ok || config.user.color !== "#123456" || (await colorOf(b.user.id)) !== "#123456") throw new Error(JSON.stringify(result));
  if (JSON.stringify(sessionChanges) !== JSON.stringify([[startUser.color, "#123456"]])) throw new Error(JSON.stringify(sessionChanges));
});
result = await auth.changeColor("nope");
await checks.check("cor invalida volta o erro do servidor e nao mexe no usuario local", () => {
  if (result.ok || !/hex/.test(result.error) || config.user.color !== "#123456") throw new Error(JSON.stringify(result));
});
await checks.check("presenca do awareness usa a cor do usuario", () => {
  const p = plugin.getPresenceUser({ name: "B", email: " B@X.com ", role: "user", color: "#123456" });
  if (p.color !== "#123456" || p.colorLight !== "#12345633" || p.id !== "b@x.com") throw new Error(JSON.stringify(p));
});

/** Renders the "Cursor color" item with fake Setting components. */
function renderColorItem(section: any, user: any) {
  const item = section.definition(user).items.find((i: { name: string }) => i.name === "Cursor color");
  const ui: any = {};
  const chain = (target: any, record: Record<string, string>) =>
    new Proxy(target, {
      get: (t, key: string) =>
        key in t ? t[key] : (...args: any[]) => ((t[record[key] ?? key] = args[0]), chain(t, record)),
    });
  const setting = {
    addColorPicker(cb: (c: any) => void) {
      ui.picker = {};
      cb(chain(ui.picker, { setValue: "value", onChange: "onChange" }));
      return setting;
    },
    addButton(cb: (b: any) => void) {
      ui.button = {};
      cb(chain(ui.button, { setButtonText: "text", onClick: "click", setDisabled: "disabled" }));
      return setting;
    },
  };
  item?.render(setting);
  return item ? ui : null;
}
for (const role of ["admin", "user"]) {
  const calls: string[] = [];
  let refreshes = 0;
  let reply: any = { ok: false, error: "server said no" };
  const section = new plugin.AccountSettingsSection(
    { changeColor: async (color: string) => (calls.push(color), reply) },
    { renderEditableName: () => {} },
    () => refreshes++,
  );
  const user = { id: 9, email: "u@x.com", name: "U", role, active: true, color: "#2ecc71" };
  const ui = renderColorItem(section, user);
  await checks.check(`${role}: settings mostra a cor salva, e falha avisa sem recarregar`, async () => {
    if (!ui || ui.picker.value !== "#2ecc71") throw new Error("item de cor ausente ou cor errada");
    ui.picker.onChange("#654321");
    const before = notices.length;
    await ui.button.click();
    if (calls.join() !== "#654321" || notices.slice(before).join() !== "server said no" || refreshes) throw new Error("fluxo de erro");
    if (renderColorItem(section, user).picker.value !== "#654321") throw new Error("perdeu a cor escolhida");
  });
  await checks.check(`${role}: sucesso avisa e recarrega`, async () => {
    reply = { ok: true, value: null };
    const before = notices.length;
    await ui.button.click();
    if (notices.slice(before).join() !== "Cursor color updated." || refreshes !== 1) throw new Error("fluxo de sucesso");
  });
}

const code = checks.finish();
await server.data.cleanup();
process.exit(code);
