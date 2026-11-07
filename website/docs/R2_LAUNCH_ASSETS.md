# Move Launch pictures from Supabase to Cloudflare R2: owner guide

Goal: token pictures and description files live on Cloudflare R2 (your own Cloudflare account), so the Supabase project is no longer needed and can be deleted.

Read "What happens to tokens already created" (the last section) **before** you delete anything. It affects one token today.

You do each step, check the "You should see" line, and only then go on. Nothing here is deleted until the very last section, and you decide that.

## How it works (one paragraph)

The Launch page asks the site for a one-use upload link. The site checks the wallet's sign-in, the file type (PNG, JPG, GIF, or the small details file) and the size (15 MB for a picture, 4 KB for the details file), then signs a link for that one file name that works for 5 minutes. The browser sends the file straight to R2 with that link. People see pictures at `https://assets.aretiafinance.org/...`. If the five `R2_` variables are **not** set the site keeps using Supabase exactly as before, so you can switch over (and back) just by setting or removing the variables.

File names are unchanged: `img/<hash>.png|jpg|gif`, `meta/<hash>.json`, `evm/<chain>/<token address>.json`.

## Step 1. Create the R2 bucket

1. Open https://dash.cloudflare.com and sign in.
2. In the left menu click **Storage & databases**, then **R2 object storage** (the name changes a little between dashboard versions; it is the one with the R2 logo). If it asks you to add a payment method, do that: R2 has a free monthly allowance and Aretia's pictures stay far inside it.
3. Click **Create bucket**.
4. Bucket name: `launch-assets`. Location: leave **Automatic**. Click **Create bucket**.

You should see: the bucket page, empty.

## Step 2. Write down your Account ID

On the R2 overview page, on the right side, you see **Account ID** (32 letters and numbers). Copy it somewhere safe for Step 6. It is not secret, but keep it handy.

## Step 3. Create an API token for that one bucket

1. On the R2 overview page click **Manage** next to "API Tokens" (or **API** then **Manage API tokens**).
2. Click **Create Account API token** (or **Create API token**).
3. Token name: `aretia-launch-assets`.
4. Permissions: choose **Object Read & Write**.
5. Specify bucket: choose **Apply to specific buckets only** and tick **launch-assets**. Do not give it access to all buckets.
6. Leave TTL as forever. Click **Create API token**.
7. The next page shows **Access Key ID** and **Secret Access Key**. The secret is shown only once. Copy both into your password manager now. (You can ignore the "Token value" and the "Jurisdiction endpoint".)

You should see: both values saved. If you lose the secret, delete the token and make a new one.

## Step 4. Put the bucket on your own domain (public address)

1. Open the `launch-assets` bucket, click **Settings**.
2. Find **Custom Domains** and click **Add** (or **Connect Domain**).
3. Type `assets.aretiafinance.org`. Click **Continue**, then **Connect Domain**. Because aretiafinance.org is already on Cloudflare, it adds the DNS record for you.
4. Wait until the domain's status says **Active** (usually a minute or two).
5. Still in Settings, find **R2.dev subdomain**. It must say **Disabled**. If it is enabled, click **Disallow Access** and confirm. Use only the custom domain.

The domain must end in `.aretiafinance.org`. The site refuses to show pictures from any other address, on purpose.

You should see: `assets.aretiafinance.org` listed as Active. (A file address will answer "not found" until there are files; that is fine.)

## Step 5. Set CORS on the bucket (so the browser may upload)

1. In the bucket, **Settings**, find **CORS Policy**, click **Add CORS policy**.
2. Click the **JSON** tab and replace everything with exactly this:

```json
[
  {
    "AllowedOrigins": ["https://aretiafinance.org", "https://www.aretiafinance.org"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

3. Click **Save**.

If you ever test from another address, such as a preview deployment, that address must be added to `AllowedOrigins` too, or the upload fails with a "CORS" error in the browser.

## Step 6. Set the Vercel variables

1. Open https://vercel.com, your **Aretia** project, **Settings**, **Environment Variables**.
2. Add these five, one at a time (**Add New**), for **Production** (tick Preview too only if you test there):

| Name | Value |
|---|---|
| `R2_ACCOUNT_ID` | the Account ID from Step 2 |
| `R2_ACCESS_KEY_ID` | the Access Key ID from Step 3 |
| `R2_SECRET_ACCESS_KEY` | the Secret Access Key from Step 3 (tick **Sensitive**) |
| `R2_BUCKET` | `launch-assets` |
| `R2_PUBLIC_BASE` | `https://assets.aretiafinance.org` (no slash at the end) |

3. Check that `SUPABASE_URL` is `https://data.aretiafinance.org` and `SUPABASE_SERVICE_ROLE_KEY` is your own server's key (the database you moved). Wallet sign-ins for uploads are now checked against **that** database, not against the old Supabase project.
4. Leave `STORAGE_URL` and `STORAGE_SERVICE_ROLE_KEY` as they are for now. When the R2 variables are set they are ignored; they are your way back if something goes wrong (remove the five R2 variables and redeploy, and Supabase is used again).
5. Do **not** redeploy yet. Do Step 7 first so old tokens keep working the moment you switch.

## Step 7. Copy the existing files to R2

You need the old Supabase address (`https://<project>.supabase.co`) and its **service_role** key (you have them saved). Run this on your own Windows PC, in PowerShell, from the `website` folder of the project (Node 22 or newer is needed; `node --version` shows it). Run the lines one at a time. `Read-Host` asks you to paste each value, so nothing is saved in your command history.

```powershell
$env:OLD_STORAGE_URL = Read-Host "Old Supabase address"
$env:OLD_STORAGE_SERVICE_KEY = Read-Host "Old service_role key"
$env:R2_ACCOUNT_ID = Read-Host "R2 Account ID"
$env:R2_ACCESS_KEY_ID = Read-Host "R2 Access Key ID"
$env:R2_SECRET_ACCESS_KEY = Read-Host "R2 Secret Access Key"
$env:R2_BUCKET = "launch-assets"
```

First a dry run, which writes nothing:

```powershell
node scripts/copy-launch-assets-to-r2.ts --dry-run
```

Then the real copy:

```powershell
node scripts/copy-launch-assets-to-r2.ts
```

You should see counts, for example:

```
Files found in the old bucket: 2
  copied now: 2
  already in R2 (skipped): 0
  not an Aretia Launch file (left alone): 0
  failed: 0
```

Run it a second time: it should say `copied now: 0` and `already in R2` equal to the number found. If any file failed, the script lists its name; just run the same command again. It never deletes anything and never prints the keys. When done, close the PowerShell window (that also forgets the values).

Check in Cloudflare: bucket **Objects** tab shows folders `img/`, `meta/` (and `evm/` if any). The number of files should equal "Files found".

(If you prefer rclone, the Supabase side is S3-compatible too, but this script is simpler and checks file names and sizes.)

## Step 8. Switch over and test one upload

1. In Vercel, **Deployments**, open the latest deployment's **...** menu, click **Redeploy**. Wait until it says Ready.
2. Open https://aretiafinance.org, go to the wallet's **Launch** page, connect a wallet and sign the sign-in message.
3. Fill the name and symbol, choose a small PNG as the picture, and press **Review**. The files upload at this point, before anything is signed or paid for. **Do not confirm the creation** unless you want a real token.
4. You should see no red error and no "Image upload is not set up yet". In Cloudflare, open the bucket's **Objects**: a new file under `img/` and one under `meta/`.
5. Open `https://assets.aretiafinance.org/img/` followed by that file's name in a browser: the picture shows.

If the picture field says "not set up yet": a variable is missing or wrong (the `R2_PUBLIC_BASE` must end in `.aretiafinance.org`, start with `https://` and have no path). If the browser console shows "CORS": redo Step 5 and check the origin spelling. If the upload answers an error about a signature or length, set a Vercel variable `R2_SIGN_CONTENT_LENGTH` to `0`, redeploy, try again, and tell the developer (it means R2 does not accept a size-bound link; the file type is still bound).

## Step 9. What can be deleted, and when

Only after Step 8 worked **and** you have decided about old tokens (next section):

- In Vercel delete `STORAGE_URL`, `STORAGE_SERVICE_ROLE_KEY` and `LAUNCH_ASSETS_BUCKET` (if present).
- Delete the old Supabase project: Supabase dashboard, the project, **Settings**, **General**, **Delete project**. This is permanent. First download a backup if you want one (the copy in R2 is already a backup of the Launch files).
- Anything else on your list that still reads the old Supabase project should be gone already, since the database moved to `data.aretiafinance.org`.

Keep the R2 token (Step 3) and bucket; they are the live store.

## What happens to tokens already created

**Fact.** A token made through Launch on Solana stores the address of its details file inside the token itself (the on-chain metadata `uri`), for example `https://<project>.supabase.co/storage/v1/object/public/launch-assets/meta/<hash>.json`, and that file names its picture at a Supabase address too. If the token was created with "name can never change" (no update authority), that address can **never** be changed. Deleting the Supabase project makes every such address stop working.

**How many.** On 2026-11-07 the live list (`https://aretiafinance.org/api/launchbox?kind=new`) shows **one** Launch token: **MAS ("Master")**, Solana, created 2026-10-29 (mint `A48PJPbSzWGTqFrXroXLobv6WqhcMWmFC3xMeWehDQea`), and no BNB, Ethereum or Polygon launches. The list covers tokens Aretia's indexer found; a token made another way would not be on it. Whether MAS's file points at Supabase was reported by the launching session but not re-checked here: `https://aretiafinance.org/api/swings-meta?chain=solana&address=<mint>` answered a server error (502) when asked, which also means the details currently do not show on the site. (To check the real address, look up the mint on Solscan; the metadata uri is on the token page.)

**What still works after the move.** Aretia's own pages: after Step 7 the site reads the copy on R2 and rewrites the old picture address to R2, so the token page and Launch Box still show MAS's description and picture. Nothing needs changing for that.

**What breaks.** Anything outside Aretia that reads the token's own uri: wallets and explorers (Phantom, Solscan, ...) will show no picture and no description for MAS once Supabase is deleted. That cannot be fixed on the token.

**Your options.**

1. **Accept it (recommended for a test token).** MAS is a test token. Delete Supabase as planned. Outside wallets show a blank picture for it; Aretia still shows it. Nothing else is affected.
2. **Keep the old Supabase project only for these files.** The address on the token contains that project's own id, so only the **old** project can serve it; a new project cannot. Free projects pause after about a week without activity, and a paused project does not serve files, so you would have to open it regularly or pay for the plan. This keeps the outside view of MAS alive but leaves you with the Supabase account you wanted to be rid of.
3. **Make a new token** (a real one) when ready, created after the move, and let MAS go.

Whichever you choose, run Step 7 first: it keeps a full copy of every file in R2.

## Costs and cache notes

- R2 charges nothing for files served to the public through the custom domain, and a small amount per million requests beyond a generous free allowance.
- Pictures and hash-named details files never change, so any cache is fine. An Ethereum-style token's details file (`evm/...`) can be replaced by its creator; Cloudflare may serve the older copy for a few hours.

## What is not verified

Written and unit-tested here (the SigV4 signer is checked against AWS's published test vector; upload rules, fallback and reading back are tested against stand-ins). **Not yet run against a real R2 bucket**: the first real upload and the copy script have not been exercised. Step 8 and Step 7's dry run are that test.
