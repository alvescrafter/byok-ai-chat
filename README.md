# BYOK AI Chat — Chrome Extension

A Chrome Extension (Manifest V3) AI chatbot with **Bring Your Own Key** support. Chat with any AI model — cloud or local — directly from your browser's side panel.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-green?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ Features

- **6 AI Providers** — OpenAI, Anthropic, Google Gemini, Ollama, LM Studio, Custom API
- **BYOK** — Bring your own API key for each provider
- **Custom API** — Connect to any OpenAI-compatible endpoint (vLLM, Together AI, etc.)
- **Screenshot Capture** — Grab the current screen and send to vision-capable models
- **Page Context** — Attach the current page's title, URL, selected text, and content
- **Right-click → Send to AI Chat** — Context menu for selected text
- **Streaming Responses** — Real-time token streaming for all providers
- **Dark/Light Theme** — Full theme support with code syntax highlighting
- **Conversation Management** — Create, switch, delete, search conversations
- **System Prompts** — With built-in presets (Default, Coder, Creative Writer, etc.)
- **Message Actions** — Edit, regenerate, copy messages
- **Code Blocks** — Syntax highlighting with one-click copy
- **Export** — JSON, Markdown, or plain text
- **Token Estimation** — Live token counter in input area
- **Keyboard Shortcut** — `Ctrl+Shift+K` to open side panel

## 🚀 Installation

1. Download or clone this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `BYOK AI Chat` folder
6. Click the extension icon in the toolbar (or press `Ctrl+Shift+K`)

## ⚙️ Setup

1. Click the **⚙️ Settings** button (top-right)
2. Select your preferred AI provider
3. Enter your API key (for cloud providers) or base URL (for local providers)
4. Click **Test** to verify the connection
5. Start chatting!

### Provider Configuration

| Provider | Required | Default Base URL |
|----------|----------|-----------------|
| OpenAI | API Key | `https://api.openai.com/v1` |
| Anthropic | API Key | `https://api.anthropic.com` |
| Google Gemini | API Key | — |
| Ollama | Base URL | `http://localhost:11434` |
| LM Studio | Base URL | `http://localhost:1234/v1` |
| Custom API | Base URL | — |

## 📸 Screenshots & Page Context

- **📷 Screenshot** — Click the camera icon in the input area to capture the current tab. The screenshot is sent as an image attachment to vision-capable models (GPT-4o, Claude Sonnet, Gemini).
- **📄 Page Context** — Click the document icon to attach the current page's content. This includes the page title, URL, any selected text, and the page body text (truncated to ~4000 characters).

## 🏗️ Architecture

```
BYOK AI Chat/
├── manifest.json          ← Manifest V3 configuration
├── background.js          ← Service worker (API calls, screenshots, context menu)
├── content.js             ← Content script (page context extraction)
├── sidepanel.html         ← Main chat UI
├── css/style.css          ← Dark/light themes, side panel layout
├── js/
│   ├── storage.js         ← chrome.storage.local adapter (async)
│   ├── api.js             ← 6 provider adapters with streaming
│   ├── markdown.js        ← marked.js + highlight.js wrapper
│   ├── ui.js              ← DOM helpers, toast, modals
│   └── app.js             ← Main app logic, event handling
├── lib/                   ← Bundled libraries (no CDN, CSP-safe)
│   ├── marked.min.js
│   ├── highlight.min.js
│   ├── hljs-theme.min.css
│   └── hljs-theme-light.min.css
└── icons/                 ← Extension icons (16, 48, 128px)
```

### How It Works

- **Side Panel** — The chat UI lives in Chrome's side panel, staying open while you browse
- **Service Worker** — All API calls go through the background service worker (avoids CORS issues)
- **Content Script** — Extracts page context when you click "Attach page"
- **chrome.storage.local** — Conversations and settings persist across browser sessions

## 🛡️ Privacy

- All API keys are stored locally in `chrome.storage.local`
- No data is sent to any third-party servers (only to your configured AI provider)
- No analytics, no tracking, no telemetry
- Conversations are stored locally in your browser

## 💝 Support

If you find this extension useful, consider [donating](https://buy.stripe.com/9B6bJ3gCY5dJ3VH9As9R601) ❤️

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.