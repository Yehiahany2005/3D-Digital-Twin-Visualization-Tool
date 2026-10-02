// Classic Web Worker that runs OpenCascade (occt-import-js) off the main thread,
// so converting large STEP/IGES assemblies does not freeze the page.

const TESSELLATION = {
  linearUnit: 'meter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
};

let occtReady = null;

function toTransferable(result) {
  const transfer = [];
  result.meshes.forEach((mesh) => {
    const position = Float32Array.from(mesh.attributes.position.array);
    mesh.attributes.position.array = position;
    transfer.push(position.buffer);
    if (mesh.attributes.normal) {
      const normal = Float32Array.from(mesh.attributes.normal.array);
      mesh.attributes.normal.array = normal;
      transfer.push(normal.buffer);
    }
    if (mesh.index) {
      const index = Uint32Array.from(mesh.index.array);
      mesh.index.array = index;
      transfer.push(index.buffer);
    }
  });
  return transfer;
}

self.onmessage = async (event) => {
  const message = event.data;

  if (message.type === 'init') {
    try {
      importScripts(message.scriptUrl);
      occtReady = self.occtimportjs({ locateFile: () => message.wasmUrl });
    } catch (error) {
      occtReady = Promise.reject(error);
    }
    occtReady.catch(() => {});
    return;
  }

  const { id, format, buffer } = message;
  try {
    if (!occtReady) throw new Error('CAD engine was not initialised.');
    const occt = await occtReady;
    const content = new Uint8Array(buffer);
    const result = format === 'iges'
      ? occt.ReadIgesFile(content, TESSELLATION)
      : occt.ReadStepFile(content, TESSELLATION);
    if (!result?.success) throw new Error(`The file could not be read as ${format.toUpperCase()}.`);
    self.postMessage({ id, result }, toTransferable(result));
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
