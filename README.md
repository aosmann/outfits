# Outfits

Mix and match your clothes, then see the outfit on you. A single static page (`index.html`) hosted on GitHub Pages. Everything is stored on the device (IndexedDB). Clothing backgrounds are removed on the device by `bg.js` (@imgly/background-removal), which is free.

## Categories

Tops, Bottoms, Dresses, Outerwear, Shoes, Bags and Accessories (up to 3). A dress replaces the top and bottom, and the reverse also applies. Every swap can be undone.

## Try-on in the app (about $0.04 per look)

Try-on uses Google's `gemini-2.5-flash-image`, the cheapest dependable image model that accepts several input photos. Every result is saved, so each outfit is paid for only once. **Copy outfit image** (in the ••• menu) still works for anyone who prefers to paste the image into the free Gemini app.

There are two ways to turn it on:

1. **Built-in service** (recommended): deploy the Worker in `worker/`. The API key stays on the server.
   ```sh
   cd worker
   npx wrangler deploy
   npx wrangler secret put GEMINI_API_KEY      # key from aistudio.google.com/apikey, billing on
   npx wrangler secret put ACCESS_CODE         # optional; users enter it in Me → Try-on
   ```
   Then set `BUILTIN_ENDPOINT` near the top of the script in `index.html` to the Worker URL (`https://outfits-tryon.<you>.workers.dev`). `ALLOWED_ORIGINS` in `wrangler.toml` limits which sites can call it. Uncomment the rate-limit block to cap requests at 10 per IP per minute.
2. **Your own key**: Me → Advanced → paste a Gemini API key. The browser calls Gemini directly.

To try a cheaper or newer image model, change `MODEL` in `wrangler.toml`, or the Model field in the app.
