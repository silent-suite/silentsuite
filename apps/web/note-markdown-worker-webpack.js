// The Notes preview parses Markdown in a Web Worker first (see
// app/(app)/notes/note-markdown-probe.worker.ts). Markdown's parser decodes named
// character references (`&amp;`) with decode-named-character-reference, whose
// "browser" entry builds an element with `document.createElement` when the
// module loads. A worker has no `document`, so the worker would die at load and
// every note would show as plain text. The package's own plain entry (what Node
// and the "worker" condition get) needs no DOM and gives the same answers.
//
// The same request is also made from the page's own bundle, which gets the plain
// entry too (a larger table of names instead of the browser's own parser, loaded
// with the Preview chunk only).

const REQUEST = /^decode-named-character-reference$/

/** The plain entry of the package, as the importing file at `context` resolves it under Node's rules. */
function plainEntryFrom(context) {
  return require.resolve('decode-named-character-reference', { paths: [context] })
}

/** @param {typeof import('webpack')} webpack */
function plainDecodeEntityPlugin(webpack) {
  return new webpack.NormalModuleReplacementPlugin(REQUEST, (resource) => {
    resource.request = plainEntryFrom(resource.context)
  })
}

module.exports = { REQUEST, plainEntryFrom, plainDecodeEntityPlugin }
