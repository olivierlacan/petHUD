// Browser polyfills needed before pdf.js loads.
//
// Safari (through 18.x / WebKit 605) does not implement async iteration of
// ReadableStream — `for await (const chunk of stream)`. pdf.js's
// page.getTextContent() relies on exactly that, so text extraction throws
// "undefined is not a function" in Safari while working in Chrome/Firefox.
//
// This adds the standard ReadableStream async iterator (per the WHATWG Streams
// spec). It is feature-detected, so it's a no-op in browsers that already
// support it. Imported first by pdfjs.js so it's in place before pdf.js runs.

if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
  const asyncIterator = function ({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      next() {
        return reader.read().then(
          (result) => { if (result.done) reader.releaseLock(); return result; },
          (reason) => { reader.releaseLock(); throw reason; }
        );
      },
      return(value) {
        if (preventCancel) { reader.releaseLock(); return Promise.resolve({ done: true, value }); }
        return reader.cancel(value).then(() => { reader.releaseLock(); return { done: true, value }; });
      },
      [Symbol.asyncIterator]() { return this; },
    };
  };
  ReadableStream.prototype[Symbol.asyncIterator] = asyncIterator;
  if (!ReadableStream.prototype.values) ReadableStream.prototype.values = asyncIterator;
}
