export class ws {
	public ws: WebSocket;
	constructor(url: string) {
		this.ws = new WebSocket(url);
		this.wsState();
	}
	private wsState() {
		this.ws.onerror = (error) => {
			console.error('Erro na conexão WebSocket', error);
		};
	}
	get getWebSocket() {
		return this.ws;
	}
}
