# Telegram Group Manager Bot

A comprehensive Telegram bot designed to moderate and manage group chats with advanced content moderation, automated alerts, and AI-powered interactions.

## Features

### Content Moderation
- **Text Moderation**: Automatically detects and removes messages containing abusive words
- **Image Moderation**: Uses OpenAI to detect and remove inappropriate images
- **Video Moderation**: Extracts frames from videos and checks for inappropriate content
- **User Warning System**: Tracks user violations across sessions with escalating consequences

### Group Management
- **Customizable Settings**: Each group can have its own moderation settings
- **Admin Controls**: Special commands available only to group administrators
- **Scheduled Alerts**: Set up recurring alert messages for group announcements
- **User Tracking**: Monitors user behavior across multiple sessions

### AI Integration
- **OpenAI Powered**: Uses OpenAI for content moderation and responses
- **Interactive Conversations**: Responds to mentions and replies with AI-generated content
- **Smart Moderation**: Intelligently detects inappropriate content in multiple formats

## Technical Stack

- **Language**: TypeScript
- **Bot Framework**: Grammy (Telegram Bot API)
- **Database**: MongoDB
- **AI Services**: OpenAI API
- **Media Processing**: Sharp, Puppeteer
- **Deployment**: Node.js

## Setup Instructions

1. Clone the repository
2. Install dependencies:
   ```
   pnpm install
   ```
3. Create a `.env` file based on `.env.example` with your credentials:
   - `BOT_TOKEN`: Your Telegram bot token from BotFather
   - `OPENAI_API_KEY`: Your OpenAI API key
   - `MONGODB_URI`: Your MongoDB connection string

4. Start the bot:
   ```
   pnpm start
   ```

## Bot Commands

- `/start` - Initialize the bot
- `/help` - Display help information
- `/config` - Configure group settings (admin only)
- `/add_abusive_word [word]` - Add a word to the abusive words list (admin only)
- `/remove_abusive_word [word]` - Remove a word from the abusive words list (admin only)
- `/list_abusive_words` - List all abusive words configured for the group (admin only)
- `/set_alert_message [message] [interval]` - Set a recurring alert message (admin only)
- `/remove_alert_message` - Remove the recurring alert message (admin only)

## Error Handling

The bot implements comprehensive error handling, input validation, and fallback mechanisms throughout the codebase to prevent any breaking points during operation, including:

- Enhanced frame extraction with timeout prevention
- Multiple fallback methods for media processing
- Thorough cleanup of temporary files
- Robust database connection handling
- Comprehensive logging throughout

## License

ISC

## Author

Created by @saadaltafofficial
