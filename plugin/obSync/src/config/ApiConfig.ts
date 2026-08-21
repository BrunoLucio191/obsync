const configuredUrl = new URL(__OBSYNC_API_BASE_URL__);
const isLoopback =
	configuredUrl.hostname === '127.0.0.1' ||
	configuredUrl.hostname === '::1' ||
	configuredUrl.hostname === '[::1]' ||
	configuredUrl.hostname === 'localhost';

if (configuredUrl.protocol !== 'https:' && !isLoopback) {
	throw new Error(
		'OBSYNC_API_BASE_URL precisa usar HTTPS fora do ambiente local.',
	);
}

configuredUrl.pathname = configuredUrl.pathname.replace(/\/$/, '');

export const API_BASE_URL = configuredUrl.toString().replace(/\/$/, '');
export const WEB_SOCKET_BASE_URL = API_BASE_URL.replace(/^http/, 'ws');

export function webSocketTicketProtocol(ticket: string): string {
	return `obsync-ticket.${ticket}`;
}
