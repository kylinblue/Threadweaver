# ThreadWeaver

> **⚠️ Work in Progress**: This project is under active development. Code will be published once a stable release is ready.

A Chrome extension that summarizes long forum threads using AI. Instead of reading hundreds of posts manually, ThreadWeaver processes threads in real-time and lets you query the content with natural language.

## What It Does

- **Extracts** posts from forum threads as you browse
- **Summarizes** content using Google Gemini AI
- **Answers** questions about the thread without reading every post
- **Updates** in real-time as more posts are processed

## How It Works

```
Chrome Extension → Local Backend → Gemini API
     ↓                  ↓              ↓
Extracts Posts    Processes &     Summarizes
                  Stores Data     Content
```

**Three Components:**
1. **Extension**: Extracts forum posts from web pages
2. **Backend**: Python FastAPI server with WebSocket for real-time updates
3. **Frontend**: React UI for viewing summaries and querying threads

## Current Status

✅ **MVP Complete** - Basic functionality working:
- Post extraction from phpBB forums (tested on f-16.net)
- Real-time processing with WebSocket communication
- AI-powered summarization with Gemini 2.0 Flash
- Live progress updates in UI

🚧 **Next Steps**:
- Rate limiting and cost controls
- Support for more forum platforms
- Persistent UI panel
- Enhanced summarization prompts
- Chrome Web Store deployment

## Tech Stack

- **Extension**: Chrome Manifest V3, vanilla JavaScript
- **Backend**: Python, FastAPI, WebSockets, SQLite, aiosqlite
- **Frontend**: React, Vite
- **AI**: Google Gemini 2.0 Flash API

## Documentation

- `QUICK_REFERENCE.md` - Quick start guide and common commands
- `PROJECT_STATUS.md` - Current development status
- `TODO.md` - Feature roadmap
- `CLAUDE.md` - Original design document

## Why Local Processing?

- **Privacy**: Your browsing data stays on your machine
- **Control**: Use your own API key, manage costs
- **Flexibility**: Customize summarization, swap AI providers
- **Speed**: No server round-trips for data storage

## License

GNU GPLv3
