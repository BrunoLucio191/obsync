import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const VAULT_DIR = join(import.meta.dirname, "..", "data", "vault");
const FOLDER_COUNT = 50;
const MAX_FILES_PER_FOLDER = 4;

const NAME_WORDS = [
	"Projeto", "Notas", "Ideias", "Rascunho", "Referencias", "Estudo", "Reuniao",
	"Pesquisa", "Arquivo", "Anotacoes", "Resumo", "Plano", "Diario", "Tarefas",
	"Ideias Soltas", "Backlog", "Draft", "Sprint", "Revisao", "Inbox", "Arquivo Morto",
	"Leituras", "Livros", "Artigos", "Clientes", "Financas", "Viagem", "Receitas",
	"Saude", "Trabalho", "Pessoal", "Familia", "Estudos", "Cursos", "Anexos",
];

const LOREM_WORDS = (
	"lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor " +
	"incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud " +
	"exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute " +
	"irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur " +
	"excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt " +
	"mollit anim id est laborum"
).split(" ");

function randomInt(min: number, max: number): number {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
	return arr[randomInt(0, arr.length - 1)];
}

function randomName(): string {
	const base = pick(NAME_WORDS);
	return Math.random() < 0.5 ? `${base} ${randomInt(1, 999)}` : base;
}

function loremSentence(): string {
	const len = randomInt(6, 16);
	const words = Array.from({ length: len }, () => pick(LOREM_WORDS));
	const sentence = words.join(" ");
	return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".";
}

function loremParagraph(): string {
	const sentences = randomInt(3, 7);
	return Array.from({ length: sentences }, loremSentence).join(" ");
}

function loremMarkdown(title: string): string {
	const paragraphs = randomInt(2, 5);
	const body = Array.from({ length: paragraphs }, loremParagraph).join("\n\n");
	return `# ${title}\n\n${body}\n`;
}

async function uniquePath(dir: string, name: string, ext: string): Promise<string> {
	let candidate = join(dir, `${name}${ext}`);
	let suffix = 2;
	while (existingPaths.has(candidate)) {
		candidate = join(dir, `${name} ${suffix}${ext}`);
		suffix++;
	}
	existingPaths.add(candidate);
	return candidate;
}

const existingPaths = new Set<string>();

async function main() {
	await mkdir(VAULT_DIR, { recursive: true });

	const dirs = [VAULT_DIR];

	for (let i = 0; i < FOLDER_COUNT; i++) {
		const parent = pick(dirs);
		const name = randomName();
		const dirPath = await uniquePath(parent, name, "");
		await mkdir(dirPath, { recursive: true });
		dirs.push(dirPath);
	}

	let fileCount = 0;
	for (const dir of dirs) {
		const filesHere = dir === VAULT_DIR ? randomInt(0, 2) : randomInt(1, MAX_FILES_PER_FOLDER);
		for (let i = 0; i < filesHere; i++) {
			const title = randomName();
			const filePath = await uniquePath(dir, title, ".md");
			await writeFile(filePath, loremMarkdown(title), "utf-8");
			fileCount++;
		}
	}

	console.log(`Criadas ${dirs.length - 1} pastas e ${fileCount} arquivos .md em ${VAULT_DIR}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
