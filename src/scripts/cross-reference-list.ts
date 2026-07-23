interface BookData {
	code: string;
	id: string;
	name: string;
	shortName: string;
	testament: 'old' | 'new';
	start: number;
	count: number;
}

interface ScriptureData {
	books: BookData[];
	refs: string[];
	texts: string[];
}

interface LinkData {
	stats: {
		crossReferences: number;
	};
	offsets: number[];
	targets: number[];
	ends: number[];
}

const BATCH_SIZE = 250;
const root = document.getElementById('reference-browser');

if (root) void startReferenceList(root);

async function startReferenceList(browserRoot: HTMLElement) {
	const referenceList = requireElement<HTMLOListElement>(browserRoot, '#reference-list');
	const filters = requireElement<HTMLFormElement>(browserRoot, '#reference-filters');
	const sourceSelect = requireElement<HTMLSelectElement>(browserRoot, '#source-book');
	const targetSelect = requireElement<HTMLSelectElement>(browserRoot, '#target-book');
	const resetButton = requireElement<HTMLButtonElement>(browserRoot, '#reset-filters');
	const resultSummary = requireElement<HTMLElement>(browserRoot, '#result-summary');
	const listError = requireElement<HTMLElement>(browserRoot, '#list-error');
	const retryButton = requireElement<HTMLButtonElement>(browserRoot, '#retry-load');
	const listSentinel = requireElement<HTMLElement>(browserRoot, '#list-sentinel');

	try {
		const [scripture, links] = await Promise.all([
			fetchJson<ScriptureData>('/data/scripture.json'),
			fetchJson<LinkData>('/data/links.json'),
		]);

		if (links.targets.length !== links.stats.crossReferences) {
			throw new Error('Cross-reference data is incomplete.');
		}

		const bookForVerse = buildBookLookup(scripture);
		const sourceForLink = buildSourceLookup(scripture.refs.length, links);
		let filteredLinks: number[] = [];
		let renderedCount = 0;
		let renderingBatch = false;
		const sentinelObserver = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) appendNextBatch();
		}, { rootMargin: '900px 0px' });
		sentinelObserver.observe(listSentinel);

		populateBookSelect(sourceSelect, scripture.books, 'All source books');
		populateBookSelect(targetSelect, scripture.books, 'All referenced books');
		sourceSelect.disabled = false;
		targetSelect.disabled = false;
		resetButton.disabled = false;
		browserRoot.dataset.state = 'ready';

		function updateFromUrl() {
			const parameters = new URLSearchParams(window.location.search);
			sourceSelect.value = validBookParameter(parameters.get('from'), scripture.books.length);
			targetSelect.value = validBookParameter(parameters.get('to'), scripture.books.length);
			applyFilters(false);
		}

		function applyFilters(updateUrl = true) {
			const sourceBook = parseBookFilter(sourceSelect.value);
			const targetBook = parseBookFilter(targetSelect.value);
			filteredLinks = [];

			for (let linkIndex = 0; linkIndex < links.targets.length; linkIndex += 1) {
				const source = sourceForLink[linkIndex];
				const target = links.targets[linkIndex];
				if (sourceBook !== null && bookForVerse[source] !== sourceBook) continue;
				if (targetBook !== null && bookForVerse[target] !== targetBook) continue;
				filteredLinks.push(linkIndex);
			}

			renderedCount = 0;
			referenceList.replaceChildren();
			renderInitialBatch();
			if (updateUrl) writeUrl();
		}

		function renderInitialBatch() {
			if (filteredLinks.length === 0) {
				const empty = createTextElement(
					'li',
					'empty-list',
					'No cross-references match those books.',
				);
				referenceList.append(empty);
				referenceList.setAttribute('aria-busy', 'false');
				listSentinel.hidden = true;
				resultSummary.textContent = '0 references';
				return;
			}

			listSentinel.hidden = false;
			appendNextBatch();
		}

		function appendNextBatch() {
			if (renderingBatch || renderedCount >= filteredLinks.length) return;
			renderingBatch = true;
			referenceList.setAttribute('aria-busy', 'true');
			const nextCount = Math.min(renderedCount + BATCH_SIZE, filteredLinks.length);
			const batchLinks = filteredLinks.slice(renderedCount, nextCount);
			const fragment = document.createDocumentFragment();

			for (const linkIndex of batchLinks) {
				const source = sourceForLink[linkIndex];
				const target = links.targets[linkIndex];
				const targetEnd = links.ends[linkIndex];
				const item = document.createElement('li');
				item.className = 'reference-row';
				item.append(
					createPassageCell('Source passage', scripture, bookForVerse, source),
					createTextElement('span', 'connection-arrow', '→'),
					createPassageCell(
						'Referenced passage',
						scripture,
						bookForVerse,
						target,
						formatReferenceRange(scripture.refs, target, targetEnd),
					),
				);
				fragment.append(item);
			}

			referenceList.append(fragment);
			renderedCount = nextCount;
			referenceList.setAttribute('aria-busy', 'false');
			resultSummary.textContent = renderedCount === filteredLinks.length
				? `All ${filteredLinks.length.toLocaleString()} references`
				: `${renderedCount.toLocaleString()} of ${filteredLinks.length.toLocaleString()} references`;
			listSentinel.hidden = renderedCount >= filteredLinks.length;
			renderingBatch = false;

			if (!listSentinel.hidden && listSentinel.getBoundingClientRect().top < window.innerHeight + 900) {
				window.requestAnimationFrame(appendNextBatch);
			}
		}

		function writeUrl() {
			const parameters = new URLSearchParams();
			if (sourceSelect.value) parameters.set('from', sourceSelect.value);
			if (targetSelect.value) parameters.set('to', targetSelect.value);
			const query = parameters.toString();
			window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
		}

		sourceSelect.addEventListener('change', () => {
			applyFilters();
		});
		targetSelect.addEventListener('change', () => {
			applyFilters();
		});
		filters.addEventListener('reset', (event) => {
			event.preventDefault();
			sourceSelect.value = '';
			targetSelect.value = '';
			applyFilters();
		});
		window.addEventListener('popstate', updateFromUrl);

		updateFromUrl();
	} catch (error) {
		console.error(error);
		browserRoot.dataset.state = 'error';
		referenceList.hidden = true;
		listError.hidden = false;
		resultSummary.textContent = 'Unable to load references';
		retryButton.addEventListener('click', () => window.location.reload());
	}
}

function buildBookLookup(scripture: ScriptureData) {
	const lookup = new Uint8Array(scripture.refs.length);
	for (let bookIndex = 0; bookIndex < scripture.books.length; bookIndex += 1) {
		const book = scripture.books[bookIndex];
		lookup.fill(bookIndex, book.start, book.start + book.count);
	}
	return lookup;
}

function buildSourceLookup(verseCount: number, links: LinkData) {
	const lookup = new Uint32Array(links.targets.length);
	for (let source = 0; source < verseCount; source += 1) {
		lookup.fill(source, links.offsets[source], links.offsets[source + 1]);
	}
	return lookup;
}

function populateBookSelect(select: HTMLSelectElement, books: BookData[], allLabel: string) {
	const all = new Option(allLabel, '');
	const oldTestament = document.createElement('optgroup');
	const newTestament = document.createElement('optgroup');
	oldTestament.label = 'Old Testament';
	newTestament.label = 'New Testament';
	for (const [index, book] of books.entries()) {
		const option = new Option(book.name, String(index));
		(book.testament === 'old' ? oldTestament : newTestament).append(option);
	}
	select.replaceChildren(all, oldTestament, newTestament);
}

function createPassageCell(
	label: string,
	scripture: ScriptureData,
	bookForVerse: Uint8Array,
	verseIndex: number,
	displayReference = scripture.refs[verseIndex],
) {
	const cell = document.createElement('div');
	cell.className = 'passage-cell';
	cell.append(createTextElement('span', 'column-label', label));
	const link = document.createElement('a');
	link.className = 'passage-reference';
	link.href = buildLetsBibleUrl(scripture, bookForVerse, verseIndex);
	link.target = '_blank';
	link.rel = 'noopener noreferrer';
	link.textContent = displayReference;
	link.setAttribute('aria-label', `Open ${displayReference} on Lets.Bible`);
	const text = createTextElement('p', 'passage-text', scripture.texts[verseIndex] || 'Verse text is unavailable.');
	cell.append(link, text);
	return cell;
}

function createTextElement<K extends keyof HTMLElementTagNameMap>(
	tagName: K,
	className: string,
	text: string,
) {
	const element = document.createElement(tagName);
	element.className = className;
	element.textContent = text;
	return element;
}

function formatReferenceRange(refs: string[], start: number, end: number) {
	const startReference = refs[start];
	const endReference = refs[end];
	if (!endReference || start === end) return startReference;
	const startMatch = /^(.*?\s\d+):(\d+)$/.exec(startReference);
	const endMatch = /^(.*?\s\d+):(\d+)$/.exec(endReference);
	if (startMatch && endMatch && startMatch[1] === endMatch[1]) {
		return `${startReference}–${endMatch[2]}`;
	}
	return `${startReference}–${endReference}`;
}

function buildLetsBibleUrl(scripture: ScriptureData, bookForVerse: Uint8Array, verseIndex: number) {
	const book = scripture.books[bookForVerse[verseIndex]];
	const match = /^(.*?)\s(\d+):(\d+)$/.exec(scripture.refs[verseIndex]);
	if (!match) return 'https://lets.bible/';
	const bookName = book.name === 'Psalms'
		? 'Psalm'
		: book.name === 'Song'
			? 'Song of Solomon'
			: book.name;
	const bookSlug = bookName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
	const chapter = match[2];
	const verse = match[3];
	const parameters = new URLSearchParams({
		v: verse,
		fromSearch: `${bookName} ${chapter}:${verse}`,
		fromTranslation: 'BSB',
	});
	return `https://lets.bible/bible/${bookSlug}/${chapter}?${parameters}`;
}

function parseBookFilter(value: string) {
	if (value === '') return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function validBookParameter(value: string | null, bookCount: number) {
	if (value === null) return '';
	const book = Number.parseInt(value, 10);
	return Number.isInteger(book) && book >= 0 && book < bookCount ? String(book) : '';
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Request failed with ${response.status}: ${url}`);
	return response.json() as Promise<T>;
}

function requireElement<T extends Element>(rootElement: ParentNode, selector: string) {
	const element = rootElement.querySelector<T>(selector);
	if (!element) throw new Error(`Missing required element: ${selector}`);
	return element;
}
