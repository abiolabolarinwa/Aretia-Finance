# Launch assets: token pictures, descriptions and links

What this is: the Launch page lets a creator add a picture, a short description and website / X / Telegram links to a token. Aretia stores them in one **public Supabase Storage bucket**. This page says what you (the owner) must create for it to work. Until you do, the Launch page says **"Image upload is not set up yet"** next to the picture field, and every other part of the page works as before. Creating a token without a picture, description or links never needs the bucket.

Nothing here needs a key in the repository. The browser never sees the service key.

## What the owner must create (once)

1. In the Supabase dashboard, open **Storage** and create a bucket:
   - **Name:** `launch-assets` (or any other name, then set `LAUNCH_ASSETS_BUCKET` to it)
   - **Public bucket:** **on.** Anyone must be able to read a picture and a details file by its address.
   - **File size limit:** `15 MB` (the picture limit; the page and the server also enforce it)
   - **Allowed MIME types:** `image/png, image/jpeg, image/gif, application/json`
2. **Policies:** add none. Uploads are made with a one-use signed upload link that the server asks Supabase for with the service key, and a public bucket needs no read policy for its public address. Do **not** add any policy that lets `anon` or `authenticated` insert, update or delete in this bucket; with none, a browser cannot write to it except through a link the server issued. (Equivalent SQL, if you prefer to create it that way:)

   ```sql
   insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
   values ('launch-assets', 'launch-assets', true, 15728640,
           array['image/png', 'image/jpeg', 'image/gif', 'application/json'])
   on conflict (id) do update set public = true, file_size_limit = 15728640,
           allowed_mime_types = array['image/png', 'image/jpeg', 'image/gif', 'application/json'];
   ```
3. **Environment variables** (Vercel → Project → Settings → Environment Variables; names only here, never values in the repo):

   | Name | Needed | What |
   |---|---|---|
   | `SUPABASE_URL` | yes (already set for sign-in) | the project address |
   | `SUPABASE_SERVICE_ROLE_KEY` | yes (already set) | signs upload links on the server only |
   | `LAUNCH_ASSETS_BUCKET` | no | bucket name if not `launch-assets` |
   | `SWINGS_SESSION_SECRET` | recommended (already in `.env.example`) | signs the wallet sign-in sessions the upload route requires |

   The project address must be a `*.supabase.co` address: pictures are shown only from `https://<project>.supabase.co/storage/v1/object/public/…`, never from a link a stranger chose.
4. Redeploy. Open the Launch page: the picture field should no longer say it is not set up.

## How it works

- **Route.** No new function file: `api/swings-data.ts` has two more `route=` values, rewritten in `vercel.json`: `/api/swings-upload` (POST) and `/api/swings-meta` (GET). The code is in `api/_swingsUpload.ts`; the rules (types, sizes, names, the details file) are in `src/swings/launchmeta/core.ts`.
- **Sign-in.** `sign` needs the wallet sign-in session the rest of the site uses (one plain message signed once; no transaction, no key). Without a session the answer is 401.
- **What may be uploaded.** A JPG, PNG or GIF up to 15 MB, or a details JSON up to 4 KB. The server refuses anything else before asking Supabase for a link, and Supabase's own bucket limits (above) refuse it again. The page also reads the picture's first bytes, so a renamed file is refused.
- **Limits.** 12 upload links per wallet per hour, 40 per IP per hour, plus the general per-IP limit. These counters are in memory per server instance, like the other limits (see `docs/operations-2026-10-security.md`).
- **Names.** A picture is stored at `img/<sha256 of its bytes>.<png|jpg|gif>` and a Solana token's details file at `meta/<sha256 of its bytes>.json`. Storage never overwrites an existing name, so a stored file cannot be replaced. The hash is computed by the browser and trusted only as a name: the server never sees the bytes.
- **Link lifetime.** Supabase signed upload links are valid for about two hours and for one path only. The server cannot shorten that.
- **Solana.** The details file (name, symbol, description, `image`, `extensions.website/twitter/telegram`) is uploaded when the creator presses Review, before anything is signed. Its address becomes the token's on-chain metadata `uri` (200 characters at most; this one is about 150), which the existing inspector checks like any other uri. A creator who picks "name can never change" makes it permanent. A creator can still use their own link instead (Advanced options), but not both.
- **Ethereum-style networks (BNB Chain, Ethereum, Polygon).** The token contract has no uri, so the picture and details are published **after** the token exists, to `evm/<chain>/<token address>.json`. The server accepts that only from the wallet that created the token: the caller sends the creation transaction hash, and the server reads the receipt from a node and requires Aretia's factory's `TokenCreated` log naming that token and that wallet. If publishing fails after creation, the Done screen says so and offers a retry. Not offered on test networks, or for tokens made through the not-yet-deployed locked-launch factory (its event is not read yet).
- **Showing it.** `/api/swings-meta?chain=…&address=a,b` returns the picture, description and links for up to 20 tokens (cached ~2 minutes). For Solana the server reads the token's metadata `uri` from the chain and follows it only if it points into this bucket under `meta/`; for Ethereum-style tokens it reads `evm/<chain>/<address>.json`. The token page (`/token#/<chain>/<address>`) and Launch Box show the result; the page reads it again with the same strict rules before drawing anything, links open with `noopener noreferrer nofollow`, and text is always shown as text.

## What is not verified here

See the PR description. In short: the upload path was tested against a stand-in for Supabase, not a live bucket, and never with a real wallet signing the sign-in message.
