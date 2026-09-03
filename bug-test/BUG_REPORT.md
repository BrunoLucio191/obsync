## Where to submit
Post this in the **"Developers: Plugin & API"** category on forum.obsidian.md, not "Bug reports" (that category is for core app bugs, and is closed off to reports that come from plugin API usage). Confirmed by moderator WhiteNoise: "The place for API problems/bugs is Developers: Plugin & API. This is already linked in the bug report template."

## Title
Declarative settings crash ("t is not a function" in renderTab) when getSettingDefinitions() returns a different number of top-level items after update()

## Obsidian version
1.13.7 (Desktop)

## OS
macOS

## Steps to reproduce
Minimal plugin (no dependencies, ~30 lines), reproduces with zero app-specific code:

**manifest.json**
```json
{
	"id": "bug-test",
	"name": "Declarative Settings Repro",
	"version": "1.0.0",
	"minAppVersion": "1.13.0",
	"description": "Minimal repro: does getSettingDefinitions() returning a different number of groups after update() crash Obsidian's settings renderer?",
	"author": "obSync debugging",
	"isDesktopOnly": true
}
```

**main.js**
```js
const { Plugin, PluginSettingTab } = require('obsidian');

class BugTestSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions() {
		const first = {
			type: 'group',
			heading: 'Step 1',
			items: [
				{
					name: 'Trigger',
					desc: 'Click Go, then watch the console.',
					render: (setting) => {
						setting.addButton((button) =>
							button
								.setButtonText('Go')
								.setCta()
								.onClick(() => {
									this.plugin.configured = true;
									this.update();
								}),
						);
					},
				},
			],
		};

		if (!this.plugin.configured) return [first];

		const second = {
			type: 'group',
			heading: 'Step 2',
			items: [
				{
					name: 'Second group',
					desc: 'If you can read this without a console error, the bug did not reproduce.',
					render: () => {},
				},
			],
		};

		return [first, second];
	}
}

module.exports = class BugTestPlugin extends Plugin {
	async onload() {
		this.configured = false;
		this.addSettingTab(new BugTestSettingTab(this.app, this));
	}
};
```

1. Copy the two files above into `<vault>/.obsidian/plugins/bug-test/`.
2. Enable "Declarative Settings Repro" under Community plugins.
3. Open the plugin's settings tab.
4. Open DevTools (Cmd+Option+I), click the "Go" button.

## Expected behavior
`getSettingDefinitions()` returns a second group (`items.length` goes from 1 to 2), `update()` re-renders, and "Step 2" appears below "Step 1".

## Actual behavior
The settings pane throws repeatedly (dozens of times in a row) in Obsidian's internal renderer:

```
TypeError: t is not a function
    at r6 (app.js:1:2737261)
    at app.js:1:2736574
    at _y (app.js:1:1099921)
    at n6 (app.js:1:2736372)
    at t6 (app.js:1:2734120)
    at app.js:1:2733792
    at _y (app.js:1:1099921)
    at e6 (app.js:1:2733716)
    at W2 (app.js:1:2731686)
    at e.renderTab (app.js:1:2743943)
```

All frames are inside Obsidian's own `app.js` (minified) — no plugin code appears in the stack. The error repeats on every subsequent render tick (36+ times observed in one session), suggesting a retry/re-render loop rather than a single failed call. Reproduced consistently across 2 separate test runs, with the identical stack trace both times.

## Notes
- This reproduces with the declarative `getSettingDefinitions()`/`update()` API introduced in 1.13.0, in the simplest possible shape: a `render`-style item whose `onClick` calls `this.update()`, changing the length of the array returned by `getSettingDefinitions()` from the previous render.
- This is a documented, intended use case, not a misuse of the API. The migration guide ("Common pitfalls") says: *"To re-render the tab after data changes (interdependent settings, list mutations), call `this.update()`."* — "list mutations" is the docs' own term for the item count changing. The API also ships a dedicated `SettingDefinitionList` type (with `onDelete`/`onReorder`/`addItem`) built specifically around items being added and removed between renders.
- Related, still-unconfirmed report on the same API surface: ["\[BUG\] Settings: getSettingsDefinition is only called once"](https://forum.obsidian.md/t/bug-settings-getsettingsdefinition-is-only-called-once/117735) — documents that `getSettingDefinitions()` isn't reliably re-invoked the way the JSDoc says it should be, which points at the same reconciliation logic between renders.
- Originally found in a real plugin (obSync) where saving a backend URL causes `getSettingDefinitions()` to go from 1 group to 2 groups on success; isolated down to this minimal repro to confirm it wasn't anything specific to that plugin's code.
