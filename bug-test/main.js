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
					desc: 'Click Go, then watch the console. This mirrors ObSync\'s backend-url save: one group becomes two, and update() is called from a button onClick.',
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
