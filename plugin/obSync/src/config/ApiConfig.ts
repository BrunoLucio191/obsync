import { t } from '../i18n/i18n.ts';

/** The resolved HTTP and WebSocket base URLs for the configured backend. */
export type ApiEndpoint = {
	httpBaseUrl: string;
	webSocketBaseUrl: string;
};

let endpoint: ApiEndpoint | null = null;

/** @returns Whether a backend endpoint has been configured via {@link configureApiEndpoint}. */
export function isApiEndpointConfigured(): boolean {
	return endpoint !== null;
}

/**
 * Parses and validates a raw backend URL, then stores it as the active
 * endpoint for subsequent {@link getApiBaseUrl}/{@link getWebSocketBaseUrl} calls.
 * @param rawUrl - The URL entered by the user (e.g. from the settings tab).
 * @throws A user-facing (localized) `Error` on an invalid URL; callers that
 * take input directly from a settings field should catch and display it.
 */
export function configureApiEndpoint(rawUrl: string): void {
	endpoint = resolveApiEndpoint(rawUrl);
}

/** Clears the configured backend endpoint, e.g. when the user empties the URL field. */
export function clearApiEndpoint(): void {
	endpoint = null;
}

/**
 * @returns The configured backend's HTTP base URL.
 * @throws A localized `Error` if no endpoint has been configured.
 */
export function getApiBaseUrl(): string {
	return requireEndpoint().httpBaseUrl;
}

/**
 * @returns The configured backend's WebSocket base URL.
 * @throws A localized `Error` if no endpoint has been configured.
 */
export function getWebSocketBaseUrl(): string {
	return requireEndpoint().webSocketBaseUrl;
}

/**
 * Builds the WebSocket subprotocol string that carries a ticket, used to
 * authenticate a WebSocket upgrade since it can't carry an `Authorization` header.
 * @param ticket - A ticket obtained from {@link AuthService.createWebSocketTicket}.
 * @returns The subprotocol value to pass when opening the WebSocket.
 */
export function webSocketTicketProtocol(ticket: string): string {
	return `obsync-ticket.${ticket}`;
}

/**
 * @returns The currently configured endpoint.
 * @throws A localized `Error` if none has been configured yet.
 */
function requireEndpoint(): ApiEndpoint {
	if (!endpoint) {
		throw new Error(t('settings.backend.notConfigured'));
	}
	return endpoint;
}

/**
 * Validates a raw URL string and derives the corresponding HTTP and
 * WebSocket base URLs. HTTPS is required unless the host is a loopback
 * address, so tokens aren't sent in the clear over a network.
 * @param rawUrl - The URL to validate.
 * @returns The resolved endpoint.
 * @throws A localized `Error` if the URL is empty, malformed, using an unsupported scheme, or requires (but lacks) HTTPS.
 */
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
