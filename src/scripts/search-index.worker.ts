/// <reference lib="webworker" />

import { Charset, Index } from 'flexsearch';

type BuildRequest = { id: string; texts: string[] };
type BuildResponse = { id: string; parts: Record<string, string> };

self.onmessage = (event: MessageEvent<BuildRequest>) => {
	const { id, texts } = event.data;
	const index = new Index({
		tokenize: 'forward',
		encoder: Charset.LatinAdvanced,
		fastupdate: false,
	});

	for (let verseIndex = 0; verseIndex < texts.length; verseIndex += 1) {
		index.add(verseIndex, texts[verseIndex]);
	}

	const parts: Record<string, string> = {};
	index.export((key: string, data: unknown) => {
		if (data !== null && data !== undefined) {
			parts[key] = typeof data === 'string' ? data : JSON.stringify(data);
		}
	});

	(self as unknown as Worker).postMessage({ id, parts } satisfies BuildResponse);
};
