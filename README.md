# SafeRoute — Landing Page

Single-file marketing site for SafeRoute. Same brutalist aesthetic as the
privacy and support pages. Built to deploy on GitHub Pages.

```
saferoute-landing/
├── index.html        ← the whole site (HTML + CSS + JS in one file)
├── assets/           ← 15 optimised screenshots (.webp, ~1.2 MB total)
└── README.md         ← this file
```

---

## 1. Before you deploy: connect the email form (2 minutes)

The page has **two** email-capture forms (one in the hero, one in the final
"Launch list" section). Both use **Web3Forms** — a free, no-account service
that emails submissions straight to you. Until you add a key, the forms show
a polite "not connected yet" message instead of silently losing signups.

1. Go to **https://web3forms.com**
2. Enter **minhaj@safe-route.app** and submit — an Access Key arrives in that
   inbox instantly (no account, no password).
3. Open `index.html`, find **both** lines that read:
   ```html
   <input type="hidden" name="access_key" value="YOUR_WEB3FORMS_ACCESS_KEY">
   ```
   Replace `YOUR_WEB3FORMS_ACCESS_KEY` with your key — **in both places**
   (search the file for `YOUR_WEB3FORMS_ACCESS_KEY`, there are 2 hits).
4. Save. Done — signups now land in the safe-route.app inbox.

Free tier is unlimited submissions, so it will comfortably handle launch
traffic. Submissions also include a honeypot field, so most spam is filtered.

---

## 2. Deploy to GitHub Pages

Same process as the privacy/support pages.

1. Create a new public repo, e.g. **`saferoute-landing`**, under the
   `minhajk21` account.
2. Upload the **contents** of this folder (`index.html`, the `assets/`
   folder, this README) to the repo root — keep `assets/` as a subfolder.
3. Repo **Settings → Pages → Build and deployment**:
   - Source: **Deploy from a branch**
   - Branch: **main** · folder: **/ (root)** · Save
4. Wait ~1 minute. The site goes live at:
   **`https://minhajk21.github.io/saferoute-landing/`**

That URL is what you'll put in partnership emails, the press kit, and press
pitches.

### Quick local check first (optional)
Open `index.html` directly in a browser, or:
```
cd saferoute-landing && python3 -m http.server 8000
```
then visit `http://localhost:8000`.

---

## 3. Custom domain (`safe-route.app`) — later, optional

You own `safe-route.app` but it isn't pointed anywhere yet. When you're
ready to use it for the landing page:

1. In the repo: **Settings → Pages → Custom domain** → enter
   `safe-route.app` (or `www.safe-route.app`) → Save. This creates a
   `CNAME` file in the repo.
2. At your domain registrar, add DNS records pointing at GitHub Pages:
   - Apex `safe-route.app` → four `A` records:
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - or `www` → `CNAME` to `minhajk21.github.io`
3. Tick **Enforce HTTPS** once the certificate provisions (can take an hour).
4. Then update the `og:image` URL and the footer links if you want them on
   the apex domain too.

Until then the `github.io` URL works perfectly for launch.

---

## 4. Adding the demo video later

There's a ready-made slot — section **02, "See it work"** (the dark band).
When the video is recorded, open `index.html`, find the comment block:

```html
<!-- VIDEO SLOT — drop the demo video in here when it's ready. -->
```

- **Self-hosted:** drop `demo.mp4` into `assets/` and swap the
  `<div class="video-frame">…</div>` for the `<video>` snippet shown in the
  comment.
- **YouTube/Vimeo:** replace it with a standard 16:9 `<iframe>`.

Keep the file in `assets/` reasonably small (< ~15 MB) so the page stays fast.

---

## 5. What's on the page

Nav · Hero (headline + email capture + "coming soon" badge + hero screenshot)
· trust strip · **01** the wedge (why SafeRoute) · **02** video slot · **03**
transparent scoring · **04** crime heatmap · **05** share my walk · **06**
Apple Watch + Live Activity · **07** find help / Strut Safe · **08** iPad
showcase · **09** privacy by design · **10** launch-list CTA · footer (press
contact, support + privacy links, data attribution).

All copy reflects the marketing strategy positioning: transparent
methodology-led scoring, native Watch/Live Activity, privacy-by-design.

### Notes
- The 15 screenshots in `assets/` were cropped (status bars removed),
  resized and converted to WebP from the simulator captures.
- Fonts (IBM Plex Mono + IBM Plex Sans) load from Google Fonts CDN — no
  local font files needed.
- No build step, no dependencies, no tracking scripts. One file.
- To swap a screenshot, replace the matching file in `assets/` (keep the
  same filename) — or update the `src` in `index.html`.
