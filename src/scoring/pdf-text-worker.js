const { parentPort, workerData } = require('node:worker_threads');
const { dirname, join, sep } = require('node:path');

async function extract({ body, maxPages, maxChars }) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const packageDir = dirname(require.resolve('pdfjs-dist/package.json'));
  const loading = getDocument({
    data: new Uint8Array(body), isEvalSupported: false, disableFontFace: true,
    cMapUrl: join(packageDir, 'cmaps') + sep, cMapPacked: true,
    standardFontDataUrl: join(packageDir, 'standard_fonts') + sep,
    useSystemFonts: false, useWorkerFetch: false, useWasm: false, stopAtErrors: true, verbosity: 0,
  });
  try {
    const document = await loading.promise;
    const pages = Math.min(document.numPages, maxPages);
    let text = '';
    for (let index = 1; index <= pages; index++) {
      const page = await document.getPage(index);
      const { items } = await page.getTextContent();
      for (const item of items) {
        if (typeof item.str !== 'string') continue;
        text += item.str.slice(0, maxChars - text.length);
        if (text.length >= maxChars) return { text, partial: true };
        text += item.hasEOL ? '\n' : ' ';
      }
      text += '\n';
      page.cleanup();
    }
    return { text, partial: document.numPages > pages };
  } finally {
    await loading.destroy();
  }
}

extract(workerData).then(result => parentPort.postMessage(result)).catch(() => parentPort.postMessage({ text: '', partial: false }));
