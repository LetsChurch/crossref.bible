import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(projectRoot, 'public', 'data');
const crossReferencePath = path.join(projectRoot, 'cross_references.txt');
const bsbUrl = 'https://bible.helloao.org/api/BSB/complete.json';
const popularitySourceRevision = 'bcfc3f58602fd9b1c2f3bc95fa941cec7edde8c9';
const popularityUrl = `https://raw.githubusercontent.com/LetsChurch/lets.church/${popularitySourceRevision}/packages/lets.bible/seed/popularity.json`;
const popularitySha256 = '774e0e16e9738c46520c9ab1b9b9f7340477017f4024aed332bc75924af9567a';

const crossReferenceBookCodes = [
	'Gen', 'Exod', 'Lev', 'Num', 'Deut', 'Josh', 'Judg', 'Ruth', '1Sam', '2Sam',
	'1Kgs', '2Kgs', '1Chr', '2Chr', 'Ezra', 'Neh', 'Esth', 'Job', 'Ps', 'Prov',
	'Eccl', 'Song', 'Isa', 'Jer', 'Lam', 'Ezek', 'Dan', 'Hos', 'Joel', 'Amos',
	'Obad', 'Jonah', 'Mic', 'Nah', 'Hab', 'Zeph', 'Hag', 'Zech', 'Mal', 'Matt',
	'Mark', 'Luke', 'John', 'Acts', 'Rom', '1Cor', '2Cor', 'Gal', 'Eph', 'Phil',
	'Col', '1Thess', '2Thess', '1Tim', '2Tim', 'Titus', 'Phlm', 'Heb', 'Jas',
	'1Pet', '2Pet', '1John', '2John', '3John', 'Jude', 'Rev',
];

const shortBookNames = [
	'Gen', 'Exod', 'Lev', 'Num', 'Deut', 'Josh', 'Judg', 'Ruth', '1 Sam', '2 Sam',
	'1 Kgs', '2 Kgs', '1 Chr', '2 Chr', 'Ezra', 'Neh', 'Esth', 'Job', 'Ps', 'Prov',
	'Eccl', 'Song', 'Isa', 'Jer', 'Lam', 'Ezek', 'Dan', 'Hos', 'Joel', 'Amos',
	'Obad', 'Jonah', 'Mic', 'Nah', 'Hab', 'Zeph', 'Hag', 'Zech', 'Mal', 'Matt',
	'Mark', 'Luke', 'John', 'Acts', 'Rom', '1 Cor', '2 Cor', 'Gal', 'Eph', 'Phil',
	'Col', '1 Thess', '2 Thess', '1 Tim', '2 Tim', 'Titus', 'Phlm', 'Heb', 'Jas',
	'1 Pet', '2 Pet', '1 John', '2 John', '3 John', 'Jude', 'Rev',
];

function flattenContent(value) {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(flattenContent);
	if (!value || typeof value !== 'object') return [];
	if ('noteId' in value) return [];
	if ('lineBreak' in value) return [' '];
	if ('content' in value) return flattenContent(value.content);
	if ('text' in value) return flattenContent(value.text);
	return [];
}

function cleanVerseText(content) {
	return flattenContent(content)
		.join(' ')
		.replace(/\s+/g, ' ')
		.replace(/\s+([,.;:!?…\)\]”’])/g, '$1')
		.replace(/([\(\[“‘])\s+/g, '$1')
		.trim();
}

function parseReference(reference) {
	const match = /^(\d?[A-Za-z]+)\.(\d+)\.(\d+)$/.exec(reference);
	if (!match) return null;
	return { book: match[1], chapter: Number(match[2]), verse: Number(match[3]) };
}

function displayReference(reference) {
	const parsed = parseReference(reference);
	if (!parsed) return reference;
	const bookIndex = crossReferenceBookCodes.indexOf(parsed.book);
	return `${shortBookNames[bookIndex] ?? parsed.book} ${parsed.chapter}:${parsed.verse}`;
}

async function getBsb() {
	const response = await fetch(bsbUrl);
	if (!response.ok) throw new Error(`Unable to download BSB data: ${response.status}`);
	return response.json();
}

async function getPopularity() {
	const response = await fetch(popularityUrl);
	if (!response.ok) throw new Error(`Unable to download popularity data: ${response.status}`);
	const data = Buffer.from(await response.arrayBuffer());
	const digest = createHash('sha256').update(data).digest('hex');
	if (digest !== popularitySha256) {
		throw new Error(`Popularity data checksum mismatch: expected ${popularitySha256}, received ${digest}`);
	}
	return JSON.parse(data.toString('utf8'));
}

const [bsb, popularityByReference, rawCrossReferences] = await Promise.all([
	getBsb(),
	getPopularity(),
	readFile(crossReferencePath, 'utf8'),
]);

if (bsb.books.length !== crossReferenceBookCodes.length) {
	throw new Error(`Expected 66 BSB books, received ${bsb.books.length}`);
}

const books = [];
const refs = [];
const texts = [];
const popularity = [];
const referenceToIndex = new Map();

for (const [bookIndex, sourceBook] of bsb.books.entries()) {
	const code = crossReferenceBookCodes[bookIndex];
	const bookStart = refs.length;
	const chapters = [];

	for (const sourceChapter of sourceBook.chapters) {
		const chapterStart = refs.length;
		const verseNumbers = [];
		const verseItems = sourceChapter.chapter.content.filter((item) => item.type === 'verse');

		for (const verseItem of verseItems) {
			const reference = `${code}.${sourceChapter.chapter.number}.${verseItem.number}`;
			const usfmReference = `${sourceBook.id}.${sourceChapter.chapter.number}.${verseItem.number}`;
			const index = refs.length;
			refs.push(displayReference(reference));
			texts.push(cleanVerseText(verseItem.content));
			popularity.push(popularityByReference[usfmReference] ?? 0);
			verseNumbers.push(verseItem.number);
			referenceToIndex.set(reference, index);
		}

		chapters.push({
			number: sourceChapter.chapter.number,
			start: chapterStart,
			count: verseItems.length,
			verses: verseNumbers,
		});
	}

	books.push({
		code,
		id: sourceBook.id,
		name: sourceBook.name,
		shortName: shortBookNames[bookIndex],
		testament: bookIndex < 39 ? 'old' : 'new',
		start: bookStart,
		count: refs.length - bookStart,
		chapters,
	});
}

const linksBySource = Array.from({ length: refs.length }, () => []);
let rejectedLinkCount = 0;

for (const line of rawCrossReferences.split(/\r?\n/).slice(1)) {
	if (!line) continue;
	const [fromRaw, toRaw, voteRaw] = line.split('\t');
	const fromReference = fromRaw.split('-')[0];
	const [toStartReference, toEndReference = toStartReference] = toRaw.split('-');
	const source = referenceToIndex.get(fromReference);
	const target = referenceToIndex.get(toStartReference);
	const end = referenceToIndex.get(toEndReference);
	const votes = Number.parseInt(voteRaw, 10);

	if (source === undefined || target === undefined || end === undefined || !Number.isFinite(votes)) {
		rejectedLinkCount += 1;
		continue;
	}

	linksBySource[source].push({ target, end, votes });
}

const offsets = new Array(refs.length + 1).fill(0);
const targets = [];
const ends = [];
const votes = [];
const ambientCandidates = [];

for (let source = 0; source < linksBySource.length; source += 1) {
	const sourceLinks = linksBySource[source];
	sourceLinks.sort((a, b) => b.votes - a.votes);
	offsets[source] = targets.length;

	for (const link of sourceLinks) {
		targets.push(link.target);
		ends.push(link.end);
		votes.push(link.votes);
		if (link.votes > 0) ambientCandidates.push([source, link.target, link.votes]);
	}
}
offsets[refs.length] = targets.length;

ambientCandidates.sort((a, b) => b[2] - a[2]);
const ambient = ambientCandidates.slice(0, 5000).flat();

const scripture = {
	version: 2,
	translation: {
		id: 'BSB',
		name: 'Berean Standard Bible',
		license: 'Public Domain',
		source: 'https://berean.bible/',
		sha256: bsb.translation.sha256,
	},
	searchRanking: {
		popularitySource: 'Common Crawl verse appearance counts',
		sourceUrl: `https://github.com/LetsChurch/lets.church/blob/${popularitySourceRevision}/packages/lets.bible/seed/popularity.json`,
		sourceRevision: popularitySourceRevision,
		sourceSha256: popularitySha256,
		method: 'log10(1 + count) with weight 8 as a secondary relevance tie-breaker',
	},
	books,
	refs,
	texts,
	popularity,
};

const links = {
	version: 1,
	attribution: {
		source: 'OpenBible.info Cross References',
		sourceUrl: 'https://www.openbible.info/labs/cross-references/',
		license: 'CC BY 4.0',
		licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
	},
	stats: {
		books: books.length,
		verses: refs.length,
		crossReferences: targets.length,
		rejectedLinks: rejectedLinkCount,
	},
	offsets,
	targets,
	ends,
	votes,
	ambient,
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
	writeFile(path.join(outputDirectory, 'scripture.json'), JSON.stringify(scripture)),
	writeFile(path.join(outputDirectory, 'links.json'), JSON.stringify(links)),
]);

console.log(`Prepared ${refs.length.toLocaleString()} BSB verses.`);
console.log(`Prepared ${targets.length.toLocaleString()} cross references (${rejectedLinkCount} skipped).`);
