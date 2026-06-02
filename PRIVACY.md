# Privacy Policy for BYOK AI Chat

**Last updated:** June 2, 2026

BYOK AI Chat ("the Extension") is a Bring Your Own Key (BYOK) AI chat assistant for the Chrome browser. This policy explains what data the Extension handles and how.

## Summary

- **The Extension does not collect, transmit, or sell any personal data.**
- **All data stays on your device** except for messages you send to AI providers through your own API keys.
- **No analytics, no telemetry, no tracking.**

## Data Stored on Your Device

The Extension uses `chrome.storage.local` to store the following on your device only:

- **API keys and base URLs** for the AI providers you configure (OpenAI, Anthropic, Google, Ollama, LM Studio, or a custom endpoint)
- **Conversations** (messages, timestamps, attached screenshots, attached page context)
- **Settings** (default provider, default model, default system prompt, theme preference)
- **System prompt presets** you create or import

You can clear all stored data at any time by uninstalling the Extension or clearing site data for the Extension on `chrome://extensions`.

## Data Sent Off Your Device

The Extension only sends data off your device when **you explicitly send a message** to an AI provider. In that case:

- Your message text, any attached screenshots, and any attached page context are sent to the **AI provider endpoint you configured** (e.g., `api.openai.com`, your local Ollama server, etc.).
- These transmissions use your own API key and go directly from the Extension to the provider. The Extension developer does not see, log, or store this data.
- The Extension does not proxy your requests through any third-party server operated by the developer.

If you attach the current page's content (via the Page Context button), the Extension reads the page's title, URL, any selected text, and the visible text content, and includes that in the message you send.

If you take a screenshot (via the Screenshot button), the Extension captures the visible area of the active tab and includes it as an image in the message you send.

## Local AI Providers

If you use Ollama or LM Studio, all requests are sent to `http://localhost:<port>` and never leave your machine. No data is transmitted to any external server.

## Third-Party Services

The Extension does not include any third-party analytics, advertising, error reporting, or tracking SDKs. It does not make background requests to any server operated by the developer.

When you choose to use a cloud AI provider (OpenAI, Anthropic, Google), your messages are subject to that provider's own privacy policy and terms of service. The Extension developer is not responsible for how these providers handle your data.

## Permissions Justification

| Permission | Why it's used |
|------------|---------------|
| `sidePanel` | To host the chat UI in Chrome's side panel |
| `activeTab` / `tabs` | To read the current page's URL/title when you attach page context or take a screenshot |
| `storage` | To save your settings, API keys, and conversations locally |
| `scripting` | To extract page content when you click "Attach page context" |
| `contextMenus` | To add the "Send to AI Chat" right-click menu item |
| `<all_urls>` host permission | Required so the content script can read page content for the Page Context feature |

## Children's Privacy

The Extension is not directed to children under 13 and does not knowingly collect any data from children.

## Changes to This Policy

If this policy changes, the updated version will be posted at this URL with a revised "Last updated" date.

## Contact

If you have questions about this privacy policy, open an issue at:
https://github.com/alvescrafter/byok-ai-chat/issues
