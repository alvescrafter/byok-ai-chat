# Chrome Web Store Screenshots

This folder is for the screenshots you'll upload to the Chrome Web Store.

## Requirements

- **Format:** PNG or JPG
- **Size:** 1280×800 or 640×400 pixels (Chrome will display them at 1280×800)
- **Count:** 1 to 5 images
- **First image** is the most important — it appears in search results and at the top of the listing

## Recommended Screenshots (in this order)

1. **Main chat view with a streaming response** — Shows the side panel open, a conversation in progress, code highlighting visible
2. **Settings panel** — Shows the 6 providers and BYOK configuration
3. **Provider dropdown / model selection** — Shows the provider and model pickers
4. **Dark theme chat** — Shows the same chat in dark mode (optional)
5. **Page context or screenshot feature** — Shows the page context/screenshot buttons in use

## How to Capture

1. Open Chrome and load the unpacked extension (see README.md "Installation")
2. Resize the side panel to the recommended width
3. Use Windows Snipping Tool (`Win + Shift + S`) or PowerShell to capture
4. Save as PNG in this folder
5. Repeat for each screenshot

## How to Resize to 1280×800

In PowerShell (with ImageMagick installed):
```powershell
magick mogrify -resize 1280x800 *.png
```

Or use an online tool like https://www.iloveimg.com/resize-image

## Files to Add

- `01-main-chat.png` (1280×800)
- `02-settings.png` (1280×800)
- `03-providers.png` (1280×800)
- `04-dark-theme.png` (1280×800, optional)
- `05-page-context.png` (1280×800, optional)

> **Note:** These files are excluded from git (see `.gitignore`) since they may contain your API keys or personal data. Regenerate them as needed before each store update.

## Promotional Tiles (optional but recommended)

The store also accepts these optional promo tiles (saved in `../promo/`):

- **Small promo tile:** 440×280 PNG
- **Marquee promo tile:** 1400×560 PNG

These appear on the Chrome Web Store homepage and category pages.
