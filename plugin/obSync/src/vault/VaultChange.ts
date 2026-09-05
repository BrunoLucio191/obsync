/**
 * A vault change event as sent/received over the system channel, describing a
 * file or folder create, delete, modify, or rename. `originClientId`, when
 * present, identifies the client that produced the change so it can be
 * ignored by that same client when echoed back from the server.
 */
export type VaultChange =
	| {
			type: 'create';
			path: string;
			isFolder: boolean;
			content?: string;
			isBinary?: boolean;
			originClientId?: string;
	  }
	| {
			type: 'delete';
			path: string;
			isFolder: boolean;
			originClientId?: string;
	  }
	| {
			type: 'modify';
			path: string;
			content: string;
			originClientId?: string;
	  }
	| {
			type: 'rename';
			oldPath: string;
			newPath: string;
			originClientId?: string;
			isFolder: boolean;
	  };
