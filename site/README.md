# SupOps site

Static pages, no server needed. Open `index.html`, `landing.html` or `faq.html`.

`landing.html` uses a compiled stylesheet. After changing its markup or `landing.src.css`, rebuild it:

```bash
npx tailwindcss@3.4.17 -c tailwind.config.js -i landing.src.css -o landing.css --minify
```
