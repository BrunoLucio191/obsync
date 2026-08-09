export type VaultChange =
	| {
			type: 'create';
			path: string;
			isFolder: boolean;
			content: string;
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
