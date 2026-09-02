import JSZip from 'jszip';
import { Plugin, App, requestUrl } from 'obsidian';
import manifest from '../../manifest.json';
import { PathMuteRegistry } from '../vault/PathMuteRegistry.ts';

export type ZipWorkerParams = {
	app: App;
	path: PathMuteRegistry;
};

export class ZipWorker extends Plugin {
	private readonly workerPath: PathMuteRegistry;
	constructor({ app, path }: ZipWorkerParams) {
		super(app, manifest);
		this.workerPath = path;
	}
	onmessage = async () => {
		//add function for the worker be able to unzip the file
		//probably i will just send the path to the worker
		//
		//
		// const response = await requestUrl({
		//   url: `${getApiBaseUrl()}/api/syncfiles`,
		//   method: "",
		//   headers: this.auth.headers(),
		//   body: JSON.stringify(payload),
		// });
		//
		// if (response.status !== 200) {
		//   throw new Error(t("sync.serverReturnedError", { status: response.status }));
		// }
		//
		try {
			// const zip = await JSZip.loadAsync(response.arrayBuffer);
			// const adapter = Plugin.app.vault.adapter;
			//
			// for (const relativePath of Object.keys(zip.files)) {
			//   //entry is the obj value for the respect key relativepath
			//   const entry = zip.files[relativePath];
			//   if (!entry) continue;
			//
			//   if (entry.dir) {
			//     if (!(await adapter.exists(relativePath))) {
			//       mutedPaths.mute(relativePath);
			//       await adapter.mkdir(relativePath);
			//     }
			//   } else {
			//     const content = await entry.async("arraybuffer");
			//     const parentPath = relativePath.substring(0, relativePath.lastIndexOf("/"));
			//
			//     if (parentPath && !(await adapter.exists(parentPath))) {
			//       mutedPaths.mute(parentPath);
			//       await adapter.mkdir(parentPath);
			//     }
			//     if (auth.isAdmin() || !(await adapter.exists(relativePath))) {
			//       mutedPaths.mute(relativePath);
			//       await adapter.writeBinary(relativePath, content);
			//     }
			//   }
			// }
		} catch (error) {
			console.error(error);
		}
	};
}
