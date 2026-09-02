import { requestUrl } from 'obsidian';
import { getApiBaseUrl } from '../config/ApiConfig.ts';
import { App } from 'obsidian';
const app = new App()

onmessage = async (message) => {

	app.workspace.


	const response = await requestUrl({
		url: `${getApiBaseUrl()}/api/syncfiles`,
		method: 'POST',
		header:

	})
};
