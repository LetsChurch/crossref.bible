import { Charset, Index } from 'flexsearch';

export interface VerseSearchResult {
	index: number;
	reference: string;
	text: string;
}

interface CachedIndex {
	version: string;
	parts: Record<string, string>;
}

const indexConfigVersion = 'fwd-latinadv-1';
const popularityWeight = 8;
const databaseName = 'crossrefs-bible-search';
const databaseVersion = 1;
const storeName = 'indexes';

function normalizeText(value: string) {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9 ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function createIndex() {
	return new Index({
		tokenize: 'forward',
		encoder: Charset.LatinAdvanced,
		fastupdate: false,
	});
}

function buildIndexInWorker(id: string, texts: string[]) {
	return new Promise<Record<string, string>>((resolve, reject) => {
		let worker: Worker;
		try {
			worker = new Worker(new URL('./search-index.worker.ts', import.meta.url), { type: 'module' });
		} catch (error) {
			reject(error instanceof Error ? error : new Error('Search worker is unavailable'));
			return;
		}

		const cleanup = () => worker.terminate();
		worker.addEventListener('message', (event: MessageEvent<{ id: string; parts: Record<string, string> }>) => {
			if (event.data.id !== id) return;
			cleanup();
			resolve(event.data.parts);
		});
		worker.addEventListener('error', (event) => {
			cleanup();
			reject(event.error ?? new Error('Search index build failed'));
		});
		worker.postMessage({ id, texts });
	});
}

function buildIndexOnMainThread(texts: string[]) {
	const index = createIndex();
	for (let verseIndex = 0; verseIndex < texts.length; verseIndex += 1) {
		index.add(verseIndex, texts[verseIndex]);
	}
	const parts: Record<string, string> = {};
	index.export((key: string, data: unknown) => {
		if (data !== null && data !== undefined) {
			parts[key] = typeof data === 'string' ? data : JSON.stringify(data);
		}
	});
	return parts;
}

function openDatabase() {
	return new Promise<IDBDatabase | null>((resolve) => {
		if (!('indexedDB' in window)) {
			resolve(null);
			return;
		}

		const request = indexedDB.open(databaseName, databaseVersion);
		request.addEventListener('upgradeneeded', () => {
			if (!request.result.objectStoreNames.contains(storeName)) {
				request.result.createObjectStore(storeName);
			}
		});
		request.addEventListener('success', () => resolve(request.result));
		request.addEventListener('error', () => resolve(null));
	});
}

async function readCachedIndex(id: string, version: string) {
	const database = await openDatabase();
	if (!database) return null;

	return new Promise<Record<string, string> | null>((resolve) => {
		const transaction = database.transaction(storeName, 'readonly');
		const request = transaction.objectStore(storeName).get(id);
		request.addEventListener('success', () => {
			const value = request.result as CachedIndex | undefined;
			resolve(value?.version === version ? value.parts : null);
		});
		request.addEventListener('error', () => resolve(null));
		transaction.addEventListener('complete', () => database.close());
		transaction.addEventListener('abort', () => database.close());
	});
}

async function writeCachedIndex(id: string, version: string, parts: Record<string, string>) {
	const database = await openDatabase();
	if (!database) return;

	await new Promise<void>((resolve) => {
		const transaction = database.transaction(storeName, 'readwrite');
		transaction.objectStore(storeName).put({ version, parts } satisfies CachedIndex, id);
		transaction.addEventListener('complete', () => {
			database.close();
			resolve();
		});
		transaction.addEventListener('abort', () => {
			database.close();
			resolve();
		});
		transaction.addEventListener('error', () => resolve());
	});
}

function scoreCandidate(
	query: string,
	terms: string[],
	normalizedTexts: string[],
	words: string[][],
	popularity: number[],
	index: number,
) {
	const text = normalizedTexts[index];
	const textWords = words[index];
	let score = 0;

	if (text.includes(query)) score += 1000;

	let longestRun = 0;
	for (let windowSize = terms.length; windowSize >= 2 && longestRun === 0; windowSize -= 1) {
		for (let start = 0; start + windowSize <= terms.length; start += 1) {
			if (text.includes(terms.slice(start, start + windowSize).join(' '))) {
				longestRun = windowSize;
				break;
			}
		}
	}
	score += longestRun * 50;

	const wordSet = new Set(textWords);
	const positions: number[] = [];
	let matched = 0;
	for (const term of terms) {
		let position = -1;
		if (wordSet.has(term)) position = textWords.indexOf(term);
		else if (term.length >= 3) position = textWords.findIndex((word) => word.startsWith(term));
		if (position >= 0) {
			matched += 1;
			positions.push(position);
		}
	}

	score += (matched / terms.length) * 150;
	if (matched === terms.length && positions.length > 0) {
		const span = Math.max(...positions) - Math.min(...positions) + 1;
		score += Math.max(0, 120 - 15 * (span - terms.length));
	}
	score += matched * 2 - textWords.length * 0.02;
	// Common Crawl appearance count is deliberately logarithmic and subordinate
	// to phrase, coverage, and proximity relevance.
	score += Math.log10(1 + (popularity[index] ?? 0)) * popularityWeight;
	return score;
}

export class LocalVerseSearch {
	private readonly id: string;
	private readonly version: string;
	private readonly refs: string[];
	private readonly texts: string[];
	private readonly normalizedTexts: string[];
	private readonly words: string[][];
	private readonly popularity: number[];
	private index: Index | null = null;
	private preparation: Promise<void> | null = null;

	constructor({
		id,
		version,
		refs,
		texts,
		popularity,
	}: {
		id: string;
		version: string;
		refs: string[];
		texts: string[];
		popularity: number[];
	}) {
		this.id = id;
		this.version = `${indexConfigVersion}:${version}`;
		this.refs = refs;
		this.texts = texts;
		this.normalizedTexts = texts.map(normalizeText);
		this.words = this.normalizedTexts.map((text) => text.split(' '));
		this.popularity = popularity;
	}

	get isReady() {
		return this.index !== null;
	}

	prepare() {
		if (this.index) return Promise.resolve();
		if (this.preparation) return this.preparation;

		this.preparation = (async () => {
			const cached = await readCachedIndex(this.id, this.version);
			const parts = cached ?? await buildIndexInWorker(this.id, this.texts)
				.catch(() => buildIndexOnMainThread(this.texts));
			const index = createIndex();
			for (const [key, data] of Object.entries(parts)) index.import(key, data);
			this.index = index;
			if (!cached) void writeCachedIndex(this.id, this.version, parts);
		})();

		return this.preparation;
	}

	search(query: string, limit = 6): VerseSearchResult[] {
		const normalizedQuery = normalizeText(query);
		if (!normalizedQuery) return [];
		const terms = normalizedQuery.split(' ').filter(Boolean);
		const candidateIds = new Set<number>();

		if (this.index) {
			for (const id of this.index.search(query, { limit: 200 }) as number[]) candidateIds.add(id);
			for (const id of this.index.search(query, { suggest: true, limit: 200 }) as number[]) candidateIds.add(id);
		} else {
			for (let index = 0; index < this.normalizedTexts.length && candidateIds.size < 500; index += 1) {
				if (this.normalizedTexts[index].includes(normalizedQuery)) candidateIds.add(index);
			}
		}

		return [...candidateIds]
			.map((index) => ({
				index,
				score: scoreCandidate(
					normalizedQuery,
					terms,
					this.normalizedTexts,
					this.words,
					this.popularity,
					index,
				),
			}))
			.sort((left, right) => right.score - left.score)
			.slice(0, limit)
			.map(({ index }) => ({ index, reference: this.refs[index], text: this.texts[index] }));
	}
}
