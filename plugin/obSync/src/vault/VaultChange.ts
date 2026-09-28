/** `originClientId` lets the client that made the change ignore its own echo. */
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
