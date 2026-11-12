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
   npx wrangler r2 bucket create outfits-data  # storage for sync + Claude (free up to 10 GB)
   npx wrangler deploy
   npx wrangler secret put GEMINI_API_KEY      # key from aistudio.google.com/apikey, billing on
   npx wrangler secret put ACCESS_CODE         # optional; users enter it in Me → Try-on
   ```
   Then set `BUILTIN_ENDPOINT` near the top of the script in `index.html` to the Worker URL (`https://outfits-tryon.<you>.workers.dev`). `ALLOWED_ORIGINS` in `wrangler.toml` limits which sites can call it. Uncomment the rate-limit block to cap requests at 10 per IP per minute.
2. **Your own key**: Me → Advanced → paste a Gemini API key. The browser calls Gemini directly.

**Changing one piece** (for example only the shoes) edits your closest earlier try-on instead of starting over: the app sends that photo, your reference photo and only the new pieces. It costs the same per image, but your face and the rest of the outfit stay consistent, so fewer retries are needed. Use ••• → *Try on from scratch* to force a fresh photo.

**Spending**: Me → Try-on shows an estimate for this month and all time, computed from Gemini's token usage at list price. Your exact bill is in Google AI Studio.

**Versions**: Try again never replaces a photo. Every try-on of an outfit is kept, and you can switch between them with the ‹ › arrows or by swiping in full screen.

**Backup**: Me → Storage → *Back up to a file* saves everything (clothes, looks, every try-on version, your photo) in one `.json` file. *Restore from a backup* adds it back on any device without deleting anything. Your API key isn't included. On iPhone, add the app to your Home Screen so Safari doesn't clear its data.

To try a cheaper or newer image model, change `MODEL` in `wrangler.toml`, or the Model field in the app.

## Sync and Claude

With the Worker deployed, **Me → Sync & Claude → Turn on sync** keeps your clothes, looks, try-on photos and your photo in your own R2 bucket and syncs them between devices. Each device links with a private sync code (Use on another device / I have a sync code). Changes merge per item, and deletes sync too.

**Connect to Claude** creates a private connector link (`https://<worker>/mcp/<token>`). In Claude, go to Settings → Connectors → Add custom connector and paste it. Claude can then:

- `list_wardrobe`: see your clothes with small photos
- `describe_item`: label an item (for example "navy wool sweater"); the label shows in the app
- `list_looks`, `get_look`: read your saved looks and their try-on photos
- `save_look`, `remove_look`: add or remove looks, which appear in the app after the next sync
- `try_on`: make a try-on photo (about 4¢, only when you ask)

Anyone with the link can use those tools, so keep it private. *Make a new link* revokes the old one.
