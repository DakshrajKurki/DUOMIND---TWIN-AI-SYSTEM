# Deploy DuoMind on Vercel (key hidden on the server)

In this version the Gemini API key is stored on Vercel as a secret environment variable. Visitors' browsers call `/api/gemini` on your site, and the server adds the key. **The key never reaches anyone's browser.**

## Folder contents

| File | Purpose |
|---|---|
| `index.html` | The DuoMind app |
| `config.js` | Points the app at `/api/gemini`. **No key here.** |
| `api/gemini.js` | Serverless function that holds the key and forwards requests to Gemini |
| `package.json`, `.gitignore` | Project settings for Vercel and Git |

## Steps

1. **Get a Gemini key** at https://aistudio.google.com/apikey. Set a budget or spending limit on the linked Google Cloud project.
2. **Create a GitHub repository** (private is fine) and upload every file in this folder, including the `api` folder. On GitHub, use *Add file → Upload files* and drag everything in. **Do not put the key in any file.**
3. **Import it into Vercel.** Go to https://vercel.com → *Add New… → Project* → select the repository. Set Framework Preset to **Other**, leave the build and output settings empty, and click **Deploy**.
4. **Add the key.** In the Vercel project, open *Settings → Environment Variables*:
   - Name: `GEMINI_API_KEY`
   - Value: your key
   - Environments: Production (and Preview if you use it)
   - Save.
5. **Redeploy.** Go to *Deployments* → the latest deployment → **⋯ → Redeploy**. New environment variables only apply to new deployments.
6. **Check it works.** Open your site and click *Try the live demo*.
   - *Settings → AI engine* should say: "Running on Gemini … through this site’s server, so the key is never sent to your browser."
   - The *Ask Twin* badge should say **AI · GEMINI**.
7. **Confirm the key is hidden.** Press F12 → *Network*, then send a chat message. Requests go to `/api/gemini`, and no request or file contains your key. *View Source* shows no key either.

## Optional settings (Environment Variables)

| Name | Example | What it does |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://duomind.vercel.app,https://duomind.in` | Only these sites can use your AI server. If not set, only the site the server itself runs on is allowed. |
| `RATE_LIMIT` | `40` | Maximum requests per visitor every 10 minutes (default 40). |
| `GEMINI_MODELS` | `gemini-3.8-flash,gemini-3.5-flash-lite` | Models the server accepts. Change this and `config.js` together if Google renames models. |

Redeploy after changing any of these.

## Good to know

- **Other people can still spend your quota** by using your site's chat; that's the point of a public AI app. The origin check, rate limit and a Google spending limit keep this under control. Delete or rotate the key after the hackathon.
- The rate limit is best-effort: it's counted per server instance, which is enough for a demo. A production app would use a shared store such as Vercel KV or Upstash.
- To change the key later: *Settings → Environment Variables* → edit → **Redeploy**.
- If the badge says **AI KEY ERROR**, the key is missing or wrong on Vercel. Fix it and redeploy.
