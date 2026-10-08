// Downloads a model file that ships with the app (built-in models, the Station's wrapper).
//
// These come from the server the page was opened from. If that server has stopped (for example
// `npm run dev` was closed while the page stayed open), the browser only says "Failed to fetch" /
// "NetworkError when attempting to fetch resource", so say what happened instead. Imported models
// don't need this: they are read from the user's own disk or browser storage.

const RETRY_DELAY_MS = 1000;

export async function downloadModel(url, name) {
  let response;
  for (let attempt = 0; !response; attempt += 1) {
    try {
      response = await fetch(url);
    } catch {
      // One retry covers a server that is just restarting.
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        throw new Error('the app\'s server couldn\'t be reached. If you run the app with "npm run dev", check that it is still running, then reload the page.');
      }
    }
  }
  if (!response.ok) throw new Error(`could not download ${name} (HTTP ${response.status}).`);
  return response.arrayBuffer();
}
