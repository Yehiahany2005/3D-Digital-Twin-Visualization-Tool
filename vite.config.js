import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';

const SCENES_DIR = fileURLToPath(new URL('./src/scenes/', import.meta.url));
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

// "Save to project" in the scene editor (npm run dev only): POST /__scenes { slug, scene } writes
// the scene to src/scenes/<slug>.json, where it ships as a built-in scene (src/scenes/index.js).
function saveScenesToProject() {
  let justWritten = new Set();
  return {
    name: 'save-scenes-to-project',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__scenes', (request, response) => {
        const reply = (status, body) => {
          response.statusCode = status;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(body));
        };
        if (request.method !== 'POST') return reply(405, { error: 'Use POST.' });
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', async () => {
          try {
            const { slug, scene } = JSON.parse(body);
            if (!SLUG.test(slug || '')) return reply(400, { error: 'The scene name gives no usable file name.' });
            if (scene?.format !== 'digital-twin-scene' || !Array.isArray(scene.items)) return reply(400, { error: 'That is not a scene.' });
            await mkdir(SCENES_DIR, { recursive: true });
            const file = path.join(SCENES_DIR, `${slug}.json`);
            justWritten.add(file);
            await writeFile(file, `${JSON.stringify(scene, null, 2)}\n`);
            return reply(200, { path: `src/scenes/${slug}.json` });
          } catch (error) {
            return reply(500, { error: error.message });
          }
        });
        return undefined;
      });
    },
    // A scene file the editor just saved is already what the page shows: don't reload the page.
    handleHotUpdate({ file }) {
      if (!justWritten.has(file)) return undefined;
      justWritten = new Set([...justWritten].filter((other) => other !== file));
      return [];
    },
  };
}

export default defineConfig({
  plugins: [saveScenesToProject()],
});
