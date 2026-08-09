import { TFile } from 'obsidian';
import ObSync from './main.ts';

export async function returnFileByPath(path: string, MyPlugin: ObSync) {
	const getTfile = MyPlugin.app.vault.getAbstractFileByPath(path);
	if (!(getTfile instanceof TFile)) return;
	const file = await MyPlugin.app.vault.read(getTfile);
	return { file: file, name: getTfile.name, path: getTfile.path };
}
