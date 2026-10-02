// Main-thread side of the CAD worker. This module is imported lazily, so the
// OpenCascade engine (~7.6 MB of WebAssembly) only downloads the first time a
// STEP or IGES file is opened.
import occtScript from 'occt-import-js/dist/occt-import-js.js?raw';
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

let worker = null;
let nextRequestId = 1;
const pending = new Map();

function rejectAll(error) {
  pending.forEach(({ reject }) => reject(error));
  pending.clear();
}

function getWorker() {
  if (worker) return worker;

  worker = new Worker(new URL('./occtWorker.js', import.meta.url));
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
  worker.onerror = (event) => {
    rejectAll(new Error(event.message || 'The CAD engine stopped unexpectedly.'));
    worker.terminate();
    worker = null;
  };

  const scriptUrl = URL.createObjectURL(new Blob([occtScript], { type: 'text/javascript' }));
  worker.postMessage({ type: 'init', scriptUrl, wasmUrl: new URL(occtWasmUrl, window.location.href).href });
  return worker;
}

export function readCadFile(buffer, format) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, format, buffer }, [buffer]);
  });
}
