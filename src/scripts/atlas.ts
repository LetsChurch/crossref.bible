import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { LocalVerseSearch, type VerseSearchResult } from './verse-search';

interface ChapterData {
	number: number;
	start: number;
	count: number;
	verses: number[];
}

interface BookData {
	code: string;
	id: string;
	name: string;
	shortName: string;
	testament: 'old' | 'new';
	start: number;
	count: number;
	chapters: ChapterData[];
}

interface ScriptureData {
	version: number;
	translation: {
		id: string;
		name: string;
		license: string;
		source: string;
		sha256: string;
	};
	books: BookData[];
	refs: string[];
	texts: string[];
	popularity: number[];
}

interface LinkData {
	version: number;
	attribution: {
		source: string;
		sourceUrl: string;
		license: string;
		licenseUrl: string;
	};
	stats: {
		books: number;
		verses: number;
		crossReferences: number;
		rejectedLinks: number;
	};
	offsets: number[];
	targets: number[];
	ends: number[];
	votes: number[];
	ambient: number[];
}

interface VerseAtlas {
	positions: Float32Array;
	bookForVerse: Uint8Array;
	chapterForVerse: Uint16Array;
	verseNumberForVerse: Uint16Array;
	bookAngles: Array<{ start: number; length: number }>;
}

interface AnimatedConnection {
	curve: THREE.QuadraticBezierCurve3;
	pulse: THREE.Sprite;
	offset: number;
	speed: number;
}

interface ConnectionLinkData {
	target: number;
	targetEnd: number;
	votes: number;
}

interface AtlasSettings {
	exposure: number;
	glow: number;
	ambientConnections: boolean;
	backgroundStars: boolean;
	idleMotion: boolean;
}

const SETTINGS_STORAGE_KEY = 'crossref-atlas-settings-v1';
const MAX_BLOOM_STRENGTH = 0.84;

const root = document.getElementById('scripture-atlas');

if (root) {
	void startAtlas(root);
}

async function startAtlas(atlasRoot: HTMLElement) {
	const canvas = requireElement<HTMLCanvasElement>(atlasRoot, '#atlas-canvas');
	const loadingDetail = requireElement<HTMLElement>(atlasRoot, '#loading-detail');
	const webglError = requireElement<HTMLElement>(atlasRoot, '#webgl-error');
	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	try {
		loadingDetail.textContent = 'Loading 31,086 verses';
		const [scripture, links] = await Promise.all([
			fetchJson<ScriptureData>('/data/scripture.json'),
			fetchJson<LinkData>('/data/links.json'),
		]);

		loadingDetail.textContent = 'Loading 344,794 cross-references';
		await waitForPaint();
		buildScene({ atlasRoot, canvas, scripture, links, reducedMotion });
		atlasRoot.dataset.state = 'ready';
	} catch (error) {
		console.error(error);
		webglError.hidden = false;
		atlasRoot.dataset.state = 'error';
	}
}

function buildScene({
	atlasRoot,
	canvas,
	scripture,
	links,
	reducedMotion,
}: {
	atlasRoot: HTMLElement;
	canvas: HTMLCanvasElement;
	scripture: ScriptureData;
	links: LinkData;
	reducedMotion: boolean;
}) {
	const passagePanel = requireElement<HTMLElement>(atlasRoot, '#passage-panel');
	const passageBook = requireElement<HTMLElement>(atlasRoot, '#passage-book');
	const passageLink = requireElement<HTMLAnchorElement>(atlasRoot, '#passage-link');
	const passageReference = requireElement<HTMLElement>(atlasRoot, '#passage-reference');
	const passageText = requireElement<HTMLElement>(atlasRoot, '#passage-text');
	const connectionCount = requireElement<HTMLElement>(atlasRoot, '#connection-count');
	const connectionList = requireElement<HTMLElement>(atlasRoot, '#connection-list');
	const connectionToggle = requireElement<HTMLButtonElement>(atlasRoot, '#connection-toggle');
	const passageSearch = requireElement<HTMLFormElement>(atlasRoot, '#passage-search');
	const passageQuery = requireElement<HTMLInputElement>(atlasRoot, '#passage-query');
	const searchResults = requireElement<HTMLElement>(atlasRoot, '#search-results');
	const searchMessage = requireElement<HTMLElement>(atlasRoot, '#search-message');
	const hoverLabel = requireElement<HTMLElement>(atlasRoot, '#hover-label');
	const hoverReference = requireElement<HTMLElement>(atlasRoot, '#hover-reference');
	const gestureHint = requireElement<HTMLElement>(atlasRoot, '#gesture-hint');
	const atlasTotal = requireElement<HTMLElement>(atlasRoot, '#atlas-total');
	const closePanel = requireElement<HTMLButtonElement>(atlasRoot, '#close-panel');
	const resetViewButton = requireElement<HTMLButtonElement>(atlasRoot, '#reset-view');
	const randomVerseButton = requireElement<HTMLButtonElement>(atlasRoot, '#random-verse');
	const settingsButton = requireElement<HTMLButtonElement>(atlasRoot, '#settings-button');
	const settingsDialog = requireElement<HTMLDialogElement>(atlasRoot, '#atlas-settings');
	const settingsExposure = requireElement<HTMLInputElement>(atlasRoot, '#settings-exposure');
	const settingsExposureOutput = requireElement<HTMLOutputElement>(atlasRoot, '#settings-exposure-output');
	const settingsGlow = requireElement<HTMLInputElement>(atlasRoot, '#settings-glow');
	const settingsGlowOutput = requireElement<HTMLOutputElement>(atlasRoot, '#settings-glow-output');
	const settingsConnections = requireElement<HTMLInputElement>(atlasRoot, '#settings-connections');
	const settingsStars = requireElement<HTMLInputElement>(atlasRoot, '#settings-stars');
	const settingsIdleMotion = requireElement<HTMLInputElement>(atlasRoot, '#settings-idle-motion');
	const settingsIdleMotionDescription = requireElement<HTMLElement>(atlasRoot, '#settings-idle-motion-description');
	const settingsReset = requireElement<HTMLButtonElement>(atlasRoot, '#settings-reset');
	let settings = loadAtlasSettings(reducedMotion);
	let mobileLayout = atlasRoot.clientWidth < 700;

	atlasTotal.textContent = `${links.stats.crossReferences.toLocaleString()} cross-references`;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x03050d);
	scene.fog = new THREE.FogExp2(0x03050d, 0.026);

	const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 90);
	const defaultCameraPosition = new THREE.Vector3(0, 3.6, 23.5);
	camera.position.copy(defaultCameraPosition);

	let renderer: THREE.WebGLRenderer;
	try {
		renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: true,
			alpha: false,
			powerPreference: 'high-performance',
		});
	} catch (error) {
		throw new Error('WebGL renderer could not be created', { cause: error });
	}

	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = settings.exposure;
	renderer.setClearColor(0x03050d, 1);

	const composer = new EffectComposer(renderer);
	composer.addPass(new RenderPass(scene, camera));
	const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), settings.glow * MAX_BLOOM_STRENGTH, 0.34, 0.58);
	composer.addPass(bloomPass);
	composer.addPass(new OutputPass());

	const controls = new OrbitControls(camera, canvas);
	controls.enableDamping = true;
	controls.dampingFactor = 0.045;
	controls.enablePan = false;
	controls.minDistance = 9;
	controls.maxDistance = 36;
	controls.minPolarAngle = Math.PI * 0.22;
	controls.maxPolarAngle = Math.PI * 0.78;
	controls.autoRotate = false;
	controls.autoRotateSpeed = 0.14;
	controls.target.set(0, 0, 0);
	controls.update();

	const canonGroup = new THREE.Group();
	canonGroup.rotation.x = -0.34;
	canonGroup.rotation.z = -0.075;
	scene.add(canonGroup);

	const atlas = calculateVerseAtlas(scripture);
	const versePoints = createVersePoints(scripture, links, atlas.positions);
	canonGroup.add(versePoints);
	canonGroup.add(createTestamentFields(atlas.bookAngles));
	canonGroup.add(createBookDividers(scripture, atlas.bookAngles));
	const ambientConnections = createAmbientConnections(scripture, links, atlas.positions, atlas.bookForVerse);
	canonGroup.add(ambientConnections);
	canonGroup.add(createCanonOrbits());
	const starField = new THREE.Group();
	starField.add(createStarField(1800, 34), createStarField(700, 18));
	scene.add(starField);

	const glowTexture = createGlowTexture();
	const selectionGroup = new THREE.Group();
	canonGroup.add(selectionGroup);
	const selectionMarker = createGlowSprite(glowTexture, 0xffe8a6, 0.72);
	selectionMarker.scale.setScalar(0.9);
	selectionMarker.visible = false;
	selectionGroup.add(selectionMarker);

	const core = createGlowSprite(glowTexture, 0xffe8a6, 0.16);
	core.scale.setScalar(1.6);
	canonGroup.add(core);

	const raycaster = new THREE.Raycaster();
	raycaster.params.Points = { threshold: 0.13 };
	const pointer = new THREE.Vector2(2, 2);
	let pointerClientX = 0;
	let pointerClientY = 0;
	let pointerNeedsRaycast = false;
	let hoveredIndex: number | null = null;
	let pointerDownPosition: { x: number; y: number } | null = null;
	let cameraAnimating = false;
	const cameraGoal = defaultCameraPosition.clone();
	const targetGoal = new THREE.Vector3();
	const animatedConnections: AnimatedConnection[] = [];
	const startTime = performance.now();
	let previousFrameTime = startTime;
	let lastInteractionTime = startTime;
	let interactionActive = false;
	let idleTargetOffset = 0;
	const idleDelay = 3500;
	const bookLookup = buildBookLookup(scripture);
	const verseSearch = new LocalVerseSearch({
		id: scripture.translation.id,
		version: scripture.translation.sha256,
		refs: scripture.refs,
		texts: scripture.texts,
		popularity: scripture.popularity,
	});
	let visibleSearchResults: VerseSearchResult[] = [];
	let activeSearchResult = -1;
	let searchPreparationStarted = false;
	let selectedConnectionLinks: ConnectionLinkData[] = [];
	let connectionsExpanded = false;
	const compactConnectionQuery = window.matchMedia('(max-width: 640px)');

	function syncSettingsControls() {
		const exposurePercent = Math.round(settings.exposure * 100);
		const glowPercent = Math.round(settings.glow * 100);
		settingsExposure.value = String(exposurePercent);
		settingsExposureOutput.value = `${settings.exposure.toFixed(2)}×`;
		settingsExposure.setAttribute('aria-valuetext', `${settings.exposure.toFixed(2)} times exposure`);
		settingsExposure.style.setProperty('--range-progress', `${exposurePercent - 35}%`);
		settingsGlow.value = String(glowPercent);
		settingsGlowOutput.value = `${glowPercent}%`;
		settingsGlow.style.setProperty('--range-progress', `${glowPercent}%`);
		settingsConnections.checked = settings.ambientConnections;
		settingsStars.checked = settings.backgroundStars;
		settingsIdleMotion.checked = settings.idleMotion;
		settingsIdleMotion.disabled = reducedMotion;
		settingsIdleMotionDescription.textContent = reducedMotion
			? 'Disabled by your system’s reduced-motion preference.'
			: 'Gently move the atlas after a few seconds.';
	}

	function applySettings(persist = true) {
		renderer.toneMappingExposure = settings.exposure;
		bloomPass.strength = settings.glow * MAX_BLOOM_STRENGTH * (mobileLayout ? 0.72 : 1);
		ambientConnections.visible = settings.ambientConnections;
		starField.visible = settings.backgroundStars;
		syncSettingsControls();
		if (persist) saveAtlasSettings(settings);
	}

	function updateSettings(next: Partial<AtlasSettings>) {
		settings = { ...settings, ...next };
		applySettings();
	}

	applySettings(false);

	function registerInteraction() {
		lastInteractionTime = performance.now();
		controls.autoRotate = false;
		if (idleTargetOffset !== 0) {
			controls.target.y -= idleTargetOffset;
			idleTargetOffset = 0;
		}
	}

	function setActiveSearchResult(index: number) {
		const buttons = [...searchResults.querySelectorAll<HTMLButtonElement>('.search-result')];
		activeSearchResult = index >= 0 && index < visibleSearchResults.length ? index : -1;
		for (const [buttonIndex, button] of buttons.entries()) {
			const active = buttonIndex === activeSearchResult;
			button.classList.toggle('is-active', active);
			button.setAttribute('aria-selected', String(active));
		}

		if (activeSearchResult >= 0) {
			const activeButton = buttons[activeSearchResult];
			passageQuery.setAttribute('aria-activedescendant', activeButton.id);
			activeButton.scrollIntoView({ block: 'nearest' });
		} else {
			passageQuery.removeAttribute('aria-activedescendant');
		}
	}

	function hideSearchResults() {
		searchResults.hidden = true;
		passageQuery.setAttribute('aria-expanded', 'false');
		passageQuery.removeAttribute('aria-activedescendant');
		visibleSearchResults = [];
		activeSearchResult = -1;
	}

	function chooseSearchResult(result: VerseSearchResult) {
		passageQuery.removeAttribute('aria-invalid');
		passageQuery.value = result.reference;
		hideSearchResults();
		passageQuery.blur();
		selectVerse(result.index);
	}

	function collectSearchResults(query: string) {
		const results: VerseSearchResult[] = [];
		const seen = new Set<number>();
		const referenceIndex = findVerse(scripture, bookLookup, query);
		if (referenceIndex !== null) {
			seen.add(referenceIndex);
			results.push({
				index: referenceIndex,
				reference: scripture.refs[referenceIndex],
				text: scripture.texts[referenceIndex],
			});
		}

		if (normalizeSearchQuery(query).length >= 2) {
			for (const result of verseSearch.search(query, 7)) {
				if (seen.has(result.index)) continue;
				seen.add(result.index);
				results.push(result);
				if (results.length === 6) break;
			}
		}
		return results;
	}

	function renderSearchResults() {
		const query = passageQuery.value.trim();
		if (!query) {
			hideSearchResults();
			return;
		}

		visibleSearchResults = collectSearchResults(query);
		activeSearchResult = -1;
		searchResults.replaceChildren();

		if (visibleSearchResults.length === 0) {
			const empty = document.createElement('p');
			empty.className = 'search-results-empty';
			empty.textContent = verseSearch.isReady
				? 'No matching BSB verses.'
				: 'Preparing local BSB search…';
			searchResults.append(empty);
		} else {
			for (const [resultIndex, result] of visibleSearchResults.entries()) {
				const button = document.createElement('button');
				button.id = `search-result-${result.index}`;
				button.className = 'search-result';
				button.type = 'button';
				button.setAttribute('role', 'option');
				button.setAttribute('aria-selected', 'false');

				const reference = document.createElement('span');
				reference.className = 'search-result-reference';
				reference.textContent = result.reference;
				const text = document.createElement('span');
				text.className = 'search-result-text';
				appendHighlightedText(text, result.text, query);
				button.append(reference, text);

				button.addEventListener('pointerdown', (event) => event.preventDefault());
				button.addEventListener('mouseenter', () => setActiveSearchResult(resultIndex));
				button.addEventListener('click', () => chooseSearchResult(result));
				searchResults.append(button);
			}
		}

		searchResults.hidden = false;
		passageQuery.setAttribute('aria-expanded', 'true');
	}

	function prepareLocalSearch() {
		if (searchPreparationStarted) return;
		searchPreparationStarted = true;
		void verseSearch.prepare().then(() => {
			if (document.activeElement === passageQuery && passageQuery.value.trim()) renderSearchResults();
		});
	}

	function clearConnectionGeometry() {
		for (const child of [...selectionGroup.children]) {
			if (child === selectionMarker) continue;
			selectionGroup.remove(child);
			if ('geometry' in child && child.geometry instanceof THREE.BufferGeometry) {
				child.geometry.dispose();
			}
			if ('material' in child) {
				const material = child.material as THREE.Material | THREE.Material[];
				if (Array.isArray(material)) material.forEach((item) => item.dispose());
				else material.dispose();
			}
		}
		animatedConnections.length = 0;
	}

	function closePassagePanel() {
		registerInteraction();
		passagePanel.classList.remove('is-open');
		passagePanel.setAttribute('aria-hidden', 'true');
		passagePanel.inert = true;
		selectionMarker.visible = false;
		clearConnectionGeometry();
		selectedConnectionLinks = [];
		connectionsExpanded = false;
		passageQuery.value = '';
		passageQuery.removeAttribute('aria-invalid');
		searchMessage.textContent = '';
		hideSearchResults();
		passageQuery.blur();
		cameraGoal.copy(defaultCameraPosition);
		targetGoal.set(0, 0, 0);
		cameraAnimating = true;
	}

	function renderConnectionList() {
		const collapsedLimit = compactConnectionQuery.matches ? 4 : 6;
		const displayedLinks = connectionsExpanded
			? selectedConnectionLinks
			: selectedConnectionLinks.slice(0, collapsedLimit);
		const totalConnections = selectedConnectionLinks.length;
		const displayedConnections = displayedLinks.length;

		connectionCount.textContent = displayedConnections < totalConnections
			? `${displayedConnections.toLocaleString()} of ${totalConnections.toLocaleString()} connections`
			: `${totalConnections.toLocaleString()} ${totalConnections === 1 ? 'connection' : 'connections'}`;
		connectionList.classList.toggle('is-expanded', connectionsExpanded);
		connectionList.replaceChildren();

		for (const link of displayedLinks) {
			const item = document.createElement('div');
			item.className = 'connection-item';
			const button = document.createElement('button');
			button.className = 'connection-link';
			button.type = 'button';
			button.innerHTML = `<span>${escapeHtml(formatReferenceRange(scripture.refs, link.target, link.targetEnd))}</span>`;
			button.addEventListener('click', () => selectVerse(link.target));
			const externalLink = document.createElement('a');
			externalLink.className = 'connection-external';
			externalLink.href = buildLetsBibleUrl(scripture, atlas, link.target);
			externalLink.target = '_blank';
			externalLink.rel = 'noopener noreferrer';
			externalLink.setAttribute('aria-label', `Open ${scripture.refs[link.target]} on Lets.Bible`);
			externalLink.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-9 9M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>';
			externalLink.addEventListener('click', registerInteraction);
			item.append(button, externalLink);
			connectionList.append(item);
		}

		if (totalConnections === 0) {
			const empty = document.createElement('p');
			empty.className = 'connection-empty';
			empty.textContent = 'No cross-references are mapped from this verse.';
			connectionList.append(empty);
		}

		connectionToggle.hidden = totalConnections <= collapsedLimit;
		connectionToggle.textContent = connectionsExpanded
			? 'Show fewer'
			: `Show all ${totalConnections.toLocaleString()}`;
		connectionToggle.setAttribute('aria-expanded', String(connectionsExpanded));
	}

	function selectVerse(index: number, travel = true, userInitiated = true) {
		if (index < 0 || index >= scripture.refs.length) return;
		if (userInitiated) registerInteraction();
		gestureHint.style.opacity = '0';
		searchMessage.textContent = '';
		clearConnectionGeometry();

		const point = positionAt(atlas.positions, index);
		selectionMarker.position.copy(point);
		selectionMarker.visible = true;
		selectionGroup.add(selectionMarker);

		const bookIndex = atlas.bookForVerse[index];
		const book = scripture.books[bookIndex];
		passageBook.textContent = `${book.name} · ${sectionForBook(bookIndex)}`;
		passageReference.textContent = scripture.refs[index];
		passageLink.href = buildLetsBibleUrl(scripture, atlas, index);
		passageLink.setAttribute('aria-label', `Open ${scripture.refs[index]} on Lets.Bible`);
		passageText.textContent = scripture.texts[index] || 'Verse text is unavailable.';

		const start = links.offsets[index];
		const end = links.offsets[index + 1];
		selectedConnectionLinks = [];
		connectionsExpanded = false;
		for (let cursor = start; cursor < end; cursor += 1) {
			selectedConnectionLinks.push({
				target: links.targets[cursor],
				targetEnd: links.ends[cursor],
				votes: links.votes[cursor],
			});
		}
		renderConnectionList();

		drawSelectedConnections({
			selectionGroup,
			animatedConnections,
			glowTexture,
			positions: atlas.positions,
			bookForVerse: atlas.bookForVerse,
			source: index,
			links: selectedConnectionLinks.filter((link) => link.votes > 0).slice(0, 26),
		});

		passagePanel.inert = false;
		passagePanel.removeAttribute('aria-hidden');
		passagePanel.classList.add('is-open');

		if (travel) {
			canonGroup.updateMatrixWorld(true);
			const worldPoint = point.clone().applyMatrix4(canonGroup.matrixWorld);
			targetGoal.copy(worldPoint).multiplyScalar(0.24);
			cameraGoal.set(worldPoint.x * 0.12, 3.6 + worldPoint.y * 0.08, 22.4);
			cameraAnimating = true;
		}
	}

	function resetView() {
		registerInteraction();
		cameraGoal.copy(defaultCameraPosition);
		targetGoal.set(0, 0, 0);
		cameraAnimating = true;
	}

	function raycastPointer() {
		pointerNeedsRaycast = false;
		const intersection = intersectVerse(0.13);
		const nextHoveredIndex = typeof intersection?.index === 'number' ? intersection.index : null;

		if (nextHoveredIndex === hoveredIndex) return;
		hoveredIndex = nextHoveredIndex;
		if (hoveredIndex === null) {
			hoverLabel.hidden = true;
			canvas.style.cursor = 'grab';
			return;
		}

		hoverReference.textContent = scripture.refs[hoveredIndex];
		hoverLabel.hidden = false;
		canvas.style.cursor = 'pointer';
		placeHoverLabel(atlasRoot, hoverLabel, pointerClientX, pointerClientY);
	}

	function updatePointer(event: PointerEvent) {
		const rect = canvas.getBoundingClientRect();
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
		pointerClientX = event.clientX;
		pointerClientY = event.clientY;
	}

	function intersectVerse(threshold: number) {
		raycaster.params.Points = { threshold };
		raycaster.setFromCamera(pointer, camera);
		return raycaster.intersectObject(versePoints, false)[0];
	}

	canvas.addEventListener('pointermove', (event) => {
		if (event.pointerType !== 'mouse') return;
		updatePointer(event);
		pointerNeedsRaycast = true;
		if (!hoverLabel.hidden) placeHoverLabel(atlasRoot, hoverLabel, event.clientX, event.clientY);
	});

	canvas.addEventListener('pointerleave', () => {
		hoveredIndex = null;
		hoverLabel.hidden = true;
		canvas.style.cursor = 'grab';
	});

	canvas.addEventListener('pointerdown', (event) => {
		registerInteraction();
		pointerDownPosition = { x: event.clientX, y: event.clientY };
	});

	canvas.addEventListener('pointerup', (event) => {
		if (!pointerDownPosition) return;
		const travel = Math.hypot(event.clientX - pointerDownPosition.x, event.clientY - pointerDownPosition.y);
		pointerDownPosition = null;
		if (travel >= 6) return;
		updatePointer(event);
		const intersection = intersectVerse(event.pointerType === 'touch' ? 0.3 : 0.13);
		if (typeof intersection?.index === 'number') selectVerse(intersection.index, false);
	});

	controls.addEventListener('start', () => {
		registerInteraction();
		interactionActive = true;
		cameraAnimating = false;
		gestureHint.style.opacity = '0';
	});

	controls.addEventListener('end', () => {
		interactionActive = false;
		lastInteractionTime = performance.now();
	});

	passageSearch.addEventListener('submit', (event) => {
		event.preventDefault();
		const selectedResult = visibleSearchResults[activeSearchResult]
			?? collectSearchResults(passageQuery.value)[0];
		if (!selectedResult) {
			searchMessage.textContent = verseSearch.isReady
				? 'No matching reference or BSB verse was found.'
				: 'Local BSB search is still preparing.';
			passageQuery.setAttribute('aria-invalid', 'true');
			prepareLocalSearch();
			renderSearchResults();
			return;
		}
		chooseSearchResult(selectedResult);
	});

	passageQuery.addEventListener('input', () => {
		registerInteraction();
		searchMessage.textContent = '';
		passageQuery.removeAttribute('aria-invalid');
		prepareLocalSearch();
		renderSearchResults();
	});

	passageQuery.addEventListener('focus', () => {
		registerInteraction();
		prepareLocalSearch();
		if (passageQuery.value.trim()) renderSearchResults();
	});

	passageQuery.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			hideSearchResults();
			return;
		}

		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		if (searchResults.hidden) renderSearchResults();
		if (visibleSearchResults.length === 0) return;
		event.preventDefault();
		const direction = event.key === 'ArrowDown' ? 1 : -1;
		const nextIndex = activeSearchResult === -1
			? direction === 1 ? 0 : visibleSearchResults.length - 1
			: (activeSearchResult + direction + visibleSearchResults.length) % visibleSearchResults.length;
		setActiveSearchResult(nextIndex);
	});

	document.addEventListener('pointerdown', (event) => {
		if (event.target instanceof Node && !passageSearch.contains(event.target)) hideSearchResults();
	});

	connectionToggle.addEventListener('click', () => {
		registerInteraction();
		connectionsExpanded = !connectionsExpanded;
		renderConnectionList();
		connectionList.scrollTop = 0;
	});

	compactConnectionQuery.addEventListener('change', () => {
		if (!connectionsExpanded && selectedConnectionLinks.length > 0) renderConnectionList();
	});

	closePanel.addEventListener('pointerdown', (event) => {
		event.stopPropagation();
	});

	closePanel.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		closePassagePanel();
	});

	passageLink.addEventListener('click', registerInteraction);

	resetViewButton.addEventListener('click', resetView);

	settingsButton.addEventListener('click', () => {
		registerInteraction();
		hideSearchResults();
		settingsDialog.showModal();
	});

	settingsDialog.addEventListener('close', () => settingsButton.focus());

	settingsDialog.addEventListener('click', (event) => {
		if (event.target === settingsDialog) settingsDialog.close();
	});

	settingsExposure.addEventListener('input', () => {
		updateSettings({ exposure: Number(settingsExposure.value) / 100 });
	});

	settingsGlow.addEventListener('input', () => {
		updateSettings({ glow: Number(settingsGlow.value) / 100 });
	});

	settingsConnections.addEventListener('change', () => {
		updateSettings({ ambientConnections: settingsConnections.checked });
	});

	settingsStars.addEventListener('change', () => {
		updateSettings({ backgroundStars: settingsStars.checked });
	});

	settingsIdleMotion.addEventListener('change', () => {
		updateSettings({ idleMotion: settingsIdleMotion.checked });
	});

	settingsReset.addEventListener('click', () => {
		settings = getDefaultAtlasSettings(reducedMotion);
		applySettings();
	});

	randomVerseButton.addEventListener('click', () => {
		const connectedSources: number[] = [];
		for (let index = 0; index < scripture.refs.length; index += 1) {
			if (links.offsets[index + 1] - links.offsets[index] >= 3) connectedSources.push(index);
		}
		const randomIndex = connectedSources[Math.floor(Math.random() * connectedSources.length)];
		selectVerse(randomIndex);
	});

	window.addEventListener('keydown', (event) => {
		if (settingsDialog.open) return;
		if (event.key === '/' && document.activeElement !== passageQuery) {
			registerInteraction();
			event.preventDefault();
			passageQuery.focus();
		}
		if (event.key === 'Escape') {
			hideSearchResults();
			closePassagePanel();
			passageQuery.blur();
		}
	});

	function resize() {
		const width = atlasRoot.clientWidth;
		const height = atlasRoot.clientHeight;
		const mobile = width < 700;
		mobileLayout = mobile;
		const pixelRatio = Math.min(window.devicePixelRatio, mobile ? 1.25 : 1.7);
		camera.aspect = width / height;
		camera.fov = mobile ? 52 : 42;
		camera.updateProjectionMatrix();
		renderer.setPixelRatio(pixelRatio);
		renderer.setSize(width, height, false);
		composer.setPixelRatio(pixelRatio);
		composer.setSize(width, height);
		bloomPass.strength = settings.glow * MAX_BLOOM_STRENGTH * (mobile ? 0.72 : 1);
	}

	const resizeObserver = new ResizeObserver(resize);
	resizeObserver.observe(atlasRoot);
	resize();

	function render() {
		const currentTime = performance.now();
		const elapsed = (currentTime - startTime) / 1000;
		const deltaTime = Math.min((currentTime - previousFrameTime) / 1000, 0.05);
		previousFrameTime = currentTime;
		if (pointerNeedsRaycast) raycastPointer();

		if (cameraAnimating) {
			camera.position.lerp(cameraGoal, 0.045);
			controls.target.lerp(targetGoal, 0.055);
			if (camera.position.distanceTo(cameraGoal) < 0.025 && controls.target.distanceTo(targetGoal) < 0.025) {
				cameraAnimating = false;
			}
		}

		if (!reducedMotion) {
			core.material.rotation = elapsed * 0.04;
			const pulse = 1 + Math.sin(elapsed * 1.5) * 0.08;
			selectionMarker.scale.setScalar(0.9 * pulse);
			for (const connection of animatedConnections) {
				const progress = (elapsed * connection.speed + connection.offset) % 1;
				connection.curve.getPoint(progress, connection.pulse.position);
				connection.pulse.material.opacity = Math.sin(progress * Math.PI) * 0.78;
			}
		}

		const idleMotionActive = settings.idleMotion
			&& !reducedMotion
			&& !interactionActive
			&& !cameraAnimating
			&& currentTime - lastInteractionTime >= idleDelay;
		controls.autoRotate = idleMotionActive;
		const nextIdleTargetOffset = idleMotionActive ? Math.sin(elapsed * 0.36) * 0.035 : 0;
		controls.target.y += nextIdleTargetOffset - idleTargetOffset;
		idleTargetOffset = nextIdleTargetOffset;

		controls.update(deltaTime);
		composer.render();
		requestAnimationFrame(render);
	}

	selectVerse(findVerse(scripture, bookLookup, 'Genesis 1:1') ?? 0, false, false);
	requestAnimationFrame(render);
}

function calculateVerseAtlas(scripture: ScriptureData): VerseAtlas {
	const verseCount = scripture.refs.length;
	const positions = new Float32Array(verseCount * 3);
	const bookForVerse = new Uint8Array(verseCount);
	const chapterForVerse = new Uint16Array(verseCount);
	const verseNumberForVerse = new Uint16Array(verseCount);
	const bookAngles: Array<{ start: number; length: number }> = [];
	const gap = 0.009;
	const availableAngle = Math.PI * 2 - scripture.books.length * gap;
	let cursorAngle = -Math.PI * 0.5;

	for (const [bookIndex, book] of scripture.books.entries()) {
		const bookLength = availableAngle * (book.count / verseCount);
		bookAngles.push({ start: cursorAngle, length: bookLength });
		let verseWithinBook = 0;

		for (const [chapterIndex, chapter] of book.chapters.entries()) {
			const chapterLane = book.chapters.length === 1
				? 0
				: chapterIndex / (book.chapters.length - 1) - 0.5;

			for (let offset = 0; offset < chapter.count; offset += 1) {
				const index = chapter.start + offset;
				const progress = book.count === 1 ? 0.5 : verseWithinBook / (book.count - 1);
				const angle = cursorAngle + bookLength * progress;
				const hash = hashUnit(index * 17 + bookIndex * 101);
				const radius = 9 + chapterLane * 1.5 + (hash - 0.5) * 0.13;
				const testamentDepth = book.testament === 'old' ? -0.28 : 0.44;
				const depth = testamentDepth + Math.sin(progress * Math.PI * 2 + bookIndex) * 0.16 + (hash - 0.5) * 0.16;

				positions[index * 3] = Math.cos(angle) * radius;
				positions[index * 3 + 1] = Math.sin(angle) * radius;
				positions[index * 3 + 2] = depth;
				bookForVerse[index] = bookIndex;
				chapterForVerse[index] = chapter.number;
				verseNumberForVerse[index] = chapter.verses[offset];
				verseWithinBook += 1;
			}
		}

		cursorAngle += bookLength + gap;
	}

	return { positions, bookForVerse, chapterForVerse, verseNumberForVerse, bookAngles };
}

function createVersePoints(scripture: ScriptureData, links: LinkData, positions: Float32Array) {
	const colors = new Float32Array(scripture.refs.length * 3);
	const sizes = new Float32Array(scripture.refs.length);
	const oldColor = new THREE.Color(0xefc16f);
	const newColor = new THREE.Color(0x86c9ef);
	const highlight = new THREE.Color(0xfff3d1);

	for (const [bookIndex, book] of scripture.books.entries()) {
		for (let index = book.start; index < book.start + book.count; index += 1) {
			const degree = links.offsets[index + 1] - links.offsets[index];
			const color = (bookIndex < 39 ? oldColor : newColor).clone();
			color.lerp(highlight, 0.08 + hashUnit(index * 31) * 0.13);
			colors[index * 3] = color.r;
			colors[index * 3 + 1] = color.g;
			colors[index * 3 + 2] = color.b;
			sizes[index] = 1.45 + Math.min(2.9, Math.log2(degree + 1) * 0.38);
		}
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
	geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
	geometry.computeBoundingSphere();

	const material = new THREE.ShaderMaterial({
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		vertexColors: true,
		vertexShader: `
			attribute float aSize;
			varying vec3 vColor;
			void main() {
				vColor = color;
				vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
				gl_PointSize = aSize * (48.0 / max(6.0, -mvPosition.z));
				gl_Position = projectionMatrix * mvPosition;
			}
		`,
		fragmentShader: `
			varying vec3 vColor;
			void main() {
				float distanceToCenter = distance(gl_PointCoord, vec2(0.5));
				float core = smoothstep(0.5, 0.04, distanceToCenter);
				float halo = smoothstep(0.5, 0.18, distanceToCenter) * 0.16;
				float alpha = max(core * 0.72, halo);
				if (alpha < 0.01) discard;
				gl_FragColor = vec4(vColor * (0.86 + core * 0.18), alpha);
			}
		`,
	});

	return new THREE.Points(geometry, material);
}

function createTestamentFields(bookAngles: Array<{ start: number; length: number }>) {
	const group = new THREE.Group();
	const oldStart = bookAngles[0].start;
	const oldEnd = bookAngles[38].start + bookAngles[38].length;
	const newStart = bookAngles[39].start;
	const newEnd = bookAngles[65].start + bookAngles[65].length;
	const fields: Array<[number, number, number]> = [
		[oldStart, oldEnd - oldStart, 0xefc16f],
		[newStart, newEnd - newStart, 0x86c9ef],
	];

	for (const [start, length, color] of fields) {
		const geometry = new THREE.RingGeometry(7.95, 10.05, 320, 1, start, length);
		const material = new THREE.MeshBasicMaterial({
			color,
			transparent: true,
			opacity: 0.018,
			depthWrite: false,
			side: THREE.DoubleSide,
			blending: THREE.AdditiveBlending,
		});
		const mesh = new THREE.Mesh(geometry, material);
		mesh.position.z = -0.42;
		group.add(mesh);
	}

	return group;
}

function createBookDividers(scripture: ScriptureData, bookAngles: Array<{ start: number; length: number }>) {
	const positions: number[] = [];
	const colors: number[] = [];
	const oldColor = new THREE.Color(0xefc16f);
	const newColor = new THREE.Color(0x86c9ef);

	for (const [bookIndex, angles] of bookAngles.entries()) {
		const angle = angles.start - 0.0045;
		const color = scripture.books[bookIndex].testament === 'old' ? oldColor : newColor;
		positions.push(
			Math.cos(angle) * 7.75, Math.sin(angle) * 7.75, -0.4,
			Math.cos(angle) * 10.28, Math.sin(angle) * 10.28, -0.4,
		);
		colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
	const material = new THREE.LineBasicMaterial({
		vertexColors: true,
		transparent: true,
		opacity: 0.1,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});
	return new THREE.LineSegments(geometry, material);
}

function createCanonOrbits() {
	const group = new THREE.Group();
	for (const [radius, opacity, color] of [
		[7.78, 0.1, 0xefc16f],
		[10.22, 0.08, 0x86c9ef],
		[5.7, 0.035, 0xefc16f],
	] as Array<[number, number, number]>) {
		const points: THREE.Vector3[] = [];
		for (let index = 0; index <= 256; index += 1) {
			const angle = (index / 256) * Math.PI * 2;
			points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, -0.45));
		}
		const geometry = new THREE.BufferGeometry().setFromPoints(points);
		const material = new THREE.LineBasicMaterial({
			color,
			transparent: true,
			opacity,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		group.add(new THREE.Line(geometry, material));
	}
	return group;
}

function createAmbientConnections(
	scripture: ScriptureData,
	links: LinkData,
	versePositions: Float32Array,
	bookForVerse: Uint8Array,
) {
	const positions: number[] = [];
	const colors: number[] = [];
	const oldColor = new THREE.Color(0xd9a952);
	const newColor = new THREE.Color(0x64add8);
	const segments = 5;

	for (let cursor = 0; cursor < links.ambient.length; cursor += 3) {
		const source = links.ambient[cursor];
		const target = links.ambient[cursor + 1];
		const votes = links.ambient[cursor + 2];
		const start = positionAt(versePositions, source);
		const end = positionAt(versePositions, target);
		const distance = start.distanceTo(end);
		const middle = start.clone().add(end).multiplyScalar(0.5);
		middle.z += 0.6 + distance * 0.14;
		const curve = new THREE.QuadraticBezierCurve3(start, middle, end);
		const base = scripture.books[bookForVerse[target]].testament === 'old' ? oldColor : newColor;
		const strength = THREE.MathUtils.clamp(Math.log2(Math.max(votes, 1)) / 10, 0.25, 1);
		const color = base.clone().multiplyScalar(0.34 + strength * 0.22);

		for (let segment = 0; segment < segments; segment += 1) {
			const a = curve.getPoint(segment / segments);
			const b = curve.getPoint((segment + 1) / segments);
			positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
			colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
		}
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
	const material = new THREE.LineBasicMaterial({
		vertexColors: true,
		transparent: true,
		opacity: 0.04,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});
	return new THREE.LineSegments(geometry, material);
}

function drawSelectedConnections({
	selectionGroup,
	animatedConnections,
	glowTexture,
	positions,
	bookForVerse,
	source,
	links,
}: {
	selectionGroup: THREE.Group;
	animatedConnections: AnimatedConnection[];
	glowTexture: THREE.Texture;
	positions: Float32Array;
	bookForVerse: Uint8Array;
	source: number;
	links: Array<{ target: number; targetEnd: number; votes: number }>;
}) {
	const sourcePoint = positionAt(positions, source);
	const maxVotes = Math.max(1, ...links.map((link) => Math.max(link.votes, 0)));

	links.forEach((link, index) => {
		const targetPoint = positionAt(positions, link.target);
		const distance = sourcePoint.distanceTo(targetPoint);
		const midpoint = sourcePoint.clone().add(targetPoint).multiplyScalar(0.5);
		midpoint.z += 1.1 + distance * 0.18;
		const curve = new THREE.QuadraticBezierCurve3(sourcePoint, midpoint, targetPoint);
		const strength = THREE.MathUtils.clamp(Math.max(link.votes, 0) / maxVotes, 0.12, 1);
		const color = new THREE.Color(bookForVerse[link.target] < 39 ? 0xefc16f : 0x86c9ef);
		const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(30));
		const material = new THREE.LineBasicMaterial({
			color,
			transparent: true,
			opacity: 0.16 + strength * 0.4,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		selectionGroup.add(new THREE.Line(geometry, material));

		const pulse = createGlowSprite(glowTexture, color.getHex(), 0.8);
		pulse.scale.setScalar(0.16 + strength * 0.12);
		curve.getPoint((index * 0.173) % 1, pulse.position);
		selectionGroup.add(pulse);
		animatedConnections.push({
			curve,
			pulse,
			offset: (index * 0.173) % 1,
			speed: 0.052 + strength * 0.045,
		});
	});
}

function createStarField(count: number, radius: number) {
	const positions = new Float32Array(count * 3);
	const colors = new Float32Array(count * 3);
	const warm = new THREE.Color(0xd8b57a);
	const cool = new THREE.Color(0x7097b7);

	for (let index = 0; index < count; index += 1) {
		const u = hashUnit(index * 19 + radius * 100);
		const v = hashUnit(index * 41 + radius * 200);
		const distance = radius * (0.55 + hashUnit(index * 73) * 0.45);
		const theta = u * Math.PI * 2;
		const phi = Math.acos(2 * v - 1);
		positions[index * 3] = distance * Math.sin(phi) * Math.cos(theta);
		positions[index * 3 + 1] = distance * Math.sin(phi) * Math.sin(theta);
		positions[index * 3 + 2] = distance * Math.cos(phi);
		const color = (index % 4 === 0 ? warm : cool).clone().multiplyScalar(0.36 + hashUnit(index) * 0.3);
		colors[index * 3] = color.r;
		colors[index * 3 + 1] = color.g;
		colors[index * 3 + 2] = color.b;
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
	const material = new THREE.PointsMaterial({
		size: radius > 20 ? 0.035 : 0.025,
		vertexColors: true,
		transparent: true,
		opacity: radius > 20 ? 0.3 : 0.13,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		sizeAttenuation: true,
	});
	return new THREE.Points(geometry, material);
}

function createGlowTexture() {
	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Unable to create glow texture');
	const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	gradient.addColorStop(0, 'rgba(255,255,255,1)');
	gradient.addColorStop(0.11, 'rgba(255,255,255,0.95)');
	gradient.addColorStop(0.3, 'rgba(255,255,255,0.35)');
	gradient.addColorStop(1, 'rgba(255,255,255,0)');
	context.fillStyle = gradient;
	context.fillRect(0, 0, size, size);
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	return texture;
}

function createGlowSprite(texture: THREE.Texture, color: number, opacity: number) {
	return new THREE.Sprite(new THREE.SpriteMaterial({
		map: texture,
		color,
		opacity,
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	}));
}

function buildBookLookup(scripture: ScriptureData) {
	const lookup = new Map<string, number>();
	for (const [index, book] of scripture.books.entries()) {
		for (const name of [book.name, book.shortName, book.code, book.id]) {
			lookup.set(normalizeBookName(name), index);
		}
	}
	lookup.set('psalm', 18);
	lookup.set('psalms', 18);
	lookup.set('songofsolomon', 21);
	lookup.set('songofsongs', 21);
	lookup.set('canticles', 21);
	lookup.set('revelations', 65);
	return lookup;
}

function findVerse(scripture: ScriptureData, bookLookup: Map<string, number>, query: string) {
	const cleaned = query
		.trim()
		.toLowerCase()
		.replace(/[.]/g, '')
		.replace(/\s+/g, ' ');
	const match = /^(.+?)\s*(\d+)(?:\s*:\s*(\d+))?$/.exec(cleaned);
	if (!match) return null;
	const bookIndex = resolveBookIndex(bookLookup, normalizeBookName(match[1]));
	if (bookIndex === null) return null;
	const chapterNumber = Number(match[2]);
	const chapter = scripture.books[bookIndex].chapters.find((item) => item.number === chapterNumber);
	if (!chapter) return null;
	const verseNumber = match[3] ? Number(match[3]) : chapter.verses[0];
	const verseOffset = chapter.verses.indexOf(verseNumber);
	return verseOffset === -1 ? null : chapter.start + verseOffset;
}

function resolveBookIndex(bookLookup: Map<string, number>, query: string) {
	const exact = bookLookup.get(query);
	if (exact !== undefined) return exact;
	const matches = new Set<number>();
	for (const [name, bookIndex] of bookLookup) {
		if (name.startsWith(query)) matches.add(bookIndex);
	}
	return matches.size === 1 ? [...matches][0] : null;
}

function normalizeBookName(name: string) {
	return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeSearchQuery(query: string) {
	return query
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9 ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function appendHighlightedText(container: HTMLElement, text: string, query: string) {
	const terms = [...new Set(
		normalizeSearchQuery(query)
			.split(' ')
			.filter((term) => term.length >= 2),
	)].sort((left, right) => right.length - left.length);

	if (terms.length === 0) {
		container.textContent = text;
		return;
	}

	const expression = new RegExp(`\\b(${terms.map(escapeRegularExpression).join('|')})`, 'gi');
	let cursor = 0;
	for (const match of text.matchAll(expression)) {
		const index = match.index;
		if (index > cursor) container.append(document.createTextNode(text.slice(cursor, index)));
		const mark = document.createElement('mark');
		mark.textContent = match[0];
		container.append(mark);
		cursor = index + match[0].length;
	}
	if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
}

function escapeRegularExpression(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function sectionForBook(bookIndex: number) {
	if (bookIndex <= 4) return 'The Law';
	if (bookIndex <= 16) return 'History';
	if (bookIndex <= 21) return 'Wisdom & Poetry';
	if (bookIndex <= 26) return 'Major Prophets';
	if (bookIndex <= 38) return 'Minor Prophets';
	if (bookIndex <= 42) return 'The Gospels';
	if (bookIndex === 43) return 'The Early Church';
	if (bookIndex <= 56) return 'Pauline Letters';
	if (bookIndex <= 64) return 'General Letters';
	return 'Apocalypse';
}

function buildLetsBibleUrl(scripture: ScriptureData, atlas: VerseAtlas, verseIndex: number) {
	const book = scripture.books[atlas.bookForVerse[verseIndex]];
	const bookName = book.name === 'Psalms'
		? 'Psalm'
		: book.name === 'Song'
			? 'Song of Solomon'
			: book.name;
	const bookSlug = bookName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
	const chapter = atlas.chapterForVerse[verseIndex];
	const verse = atlas.verseNumberForVerse[verseIndex];
	const reference = `${bookName} ${chapter}:${verse}`;
	const parameters = new URLSearchParams({
		v: String(verse),
		fromSearch: reference,
		fromTranslation: 'BSB',
	});
	return `https://lets.bible/bible/${bookSlug}/${chapter}?${parameters}`;
}

function positionAt(positions: Float32Array, index: number) {
	return new THREE.Vector3(
		positions[index * 3],
		positions[index * 3 + 1],
		positions[index * 3 + 2],
	);
}

function placeHoverLabel(root: HTMLElement, label: HTMLElement, clientX: number, clientY: number) {
	const rootRect = root.getBoundingClientRect();
	const x = THREE.MathUtils.clamp(clientX - rootRect.left, 12, rootRect.width - label.offsetWidth - 24);
	const y = THREE.MathUtils.clamp(clientY - rootRect.top, label.offsetHeight + 20, rootRect.height - 12);
	label.style.left = `${x}px`;
	label.style.top = `${y}px`;
}

function hashUnit(seed: number) {
	const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
	return value - Math.floor(value);
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}

function getDefaultAtlasSettings(reducedMotion: boolean): AtlasSettings {
	return {
		exposure: 0.72,
		glow: 0.5,
		ambientConnections: true,
		backgroundStars: true,
		idleMotion: !reducedMotion,
	};
}

function loadAtlasSettings(reducedMotion: boolean) {
	const defaults = getDefaultAtlasSettings(reducedMotion);
	try {
		const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
		if (!stored) return defaults;
		const parsed = JSON.parse(stored) as Record<string, unknown>;
		return {
			exposure: clampSetting(parsed.exposure, 0.35, 1.35, defaults.exposure),
			glow: clampSetting(parsed.glow, 0, 1, defaults.glow),
			ambientConnections: typeof parsed.ambientConnections === 'boolean'
				? parsed.ambientConnections
				: defaults.ambientConnections,
			backgroundStars: typeof parsed.backgroundStars === 'boolean'
				? parsed.backgroundStars
				: defaults.backgroundStars,
			idleMotion: reducedMotion
				? false
				: typeof parsed.idleMotion === 'boolean' ? parsed.idleMotion : defaults.idleMotion,
		};
	} catch {
		return defaults;
	}
}

function saveAtlasSettings(settings: AtlasSettings) {
	try {
		window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// The atlas remains usable when storage is unavailable or blocked.
	}
}

function clampSetting(value: unknown, minimum: number, maximum: number, fallback: number) {
	return typeof value === 'number' && Number.isFinite(value)
		? THREE.MathUtils.clamp(value, minimum, maximum)
		: fallback;
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Unable to load ${url}: ${response.status}`);
	return response.json() as Promise<T>;
}

function requireElement<T extends Element>(parent: ParentNode, selector: string): T {
	const element = parent.querySelector<T>(selector);
	if (!element) throw new Error(`Missing required element: ${selector}`);
	return element;
}

function waitForPaint() {
	return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
