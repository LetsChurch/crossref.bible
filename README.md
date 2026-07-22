# Bible Cross-Reference Atlas

An interactive Three.js visualization of the Bible's cross-reference network. The visualization places each BSB verse in canonical order. Selecting a verse displays its text and cross-references. Reference and phrase search run locally over the BSB text with a worker-built FlexSearch index that is cached in IndexedDB after its first build. Closely matched search results use a logarithmic Common Crawl appearance count as a secondary popularity tie-breaker, following Lets.Bible's ranking model.

## Development

```sh
pnpm install
pnpm exec astro dev --background
```

The site is available at `http://localhost:4321`. Manage the background server with:

```sh
pnpm exec astro dev status
pnpm exec astro dev logs
pnpm exec astro dev stop
```

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm check` | Run Astro and TypeScript diagnostics |
| `pnpm build` | Create the static production build in `dist/` |
| `pnpm prepare-data` | Rebuild the local visualization data from `cross_references.txt` and the BSB source |

## Data

### Cross-reference file

[`cross_references.txt`](./cross_references.txt) is an unmodified copy of the file in OpenBible.info's official [`cross-references.zip`](https://a.openbible.info/data/cross-references.zip) download. OpenBible.info publishes the [Bible Cross References dataset](https://www.openbible.info/labs/cross-references/) under the [Creative Commons Attribution 4.0 International license](https://creativecommons.org/licenses/by/4.0/). This project attributes the file and its cross-reference data to OpenBible.info.

The `pnpm prepare-data` command reads `cross_references.txt` and generates `public/data/links.json`. The site loads the generated JSON at runtime.

### Other data

Verse text comes from the public-domain [Berean Standard Bible](https://berean.bible/). The search popularity signal uses Common Crawl verse appearance counts pinned to a specific [Lets.Bible dataset revision](https://github.com/LetsChurch/lets.church/blob/bcfc3f58602fd9b1c2f3bc95fa941cec7edde8c9/packages/lets.bible/seed/popularity.json). Generated browser data lives in `public/data/`, so the site does not call a Bible API at runtime.
