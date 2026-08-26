import { t } from '../i18n/i18n.ts';

export type ApiEndpoint = {
	httpBaseUrl: string;
	webSocketBaseUrl: string;
};

let endpoint: ApiEndpoint | null = null;

export function isApiEndpointConfigured(): boolean {
	return endpoint !== null;
}

// Throws a user-facing (localized) message on an invalid URL; callers that
// take input directly from a settings field should catch and display it.
export function configureApiEndpoint(rawUrl: string): void {
	endpoint = resolveApiEndpoint(rawUrl);
}

export function clearApiEndpoint(): void {
	endpoint = null;
}

export function getApiBaseUrl(): string {
	return requireEndpoint().httpBaseUrl;
}

export function getWebSocketBaseUrl(): string {
	return requireEndpoint().webSocketBaseUrl;
}

export function webSocketTicketProtocol(ticket: string): string {
	return `obsync-ticket.${ticket}`;
}

function requireEndpoint(): ApiEndpoint {
	if (!endpoint) {
		throw new Error(t('settings.backend.notConfigured'));
	}
	return endpoint;
}

function resolveApiEndpoint(rawUrl: string): ApiEndpoint {
	const trimmed = rawUrl.trim();
	if (!trimmed) {
		throw new Error(t('settings.backend.urlRequired'));
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(t('settings.backend.urlInvalid'));
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(t('settings.backend.urlInvalid'));
	}

	const isLoopback =
		parsed.hostname === '127.0.0.1' ||
		parsed.hostname === '::1' ||
		parsed.hostname === '[::1]' ||
		parsed.hostname === 'localhost';

	if (parsed.protocol !== 'https:' && !isLoopback) {
		throw new Error(t('settings.backend.urlRequiresHttps'));
	}

	parsed.pathname = parsed.pathname.replace(/\/$/, '');
	const httpBaseUrl = parsed.toString().replace(/\/$/, '');

	return {
		httpBaseUrl,
		webSocketBaseUrl: httpBaseUrl.replace(/^http/, 'ws'),
	};
}
