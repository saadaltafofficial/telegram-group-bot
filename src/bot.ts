import { Bot, Context, session, InlineKeyboard } from 'grammy';
import { Message } from 'grammy/types';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import { 
  connectToDatabase, 
  getGroupSettings, 
  updateGroupSettings,
  getAbusiveWords as getDbAbusiveWords,
  addAbusiveWord as addDbAbusiveWord,
  removeAbusiveWord as removeDbAbusiveWord,
  getUserWarnings,
  updateUserWarnings,
  getAlertMessage,
  setAlertMessage,
  removeAlertMessage,
  getAlertMessagesToSend,
  updateAlertMessageLastSent,
  getUserWarningsAcrossSessions,
  updateUserWarningsAcrossSessions
} from './db';
import {
  moderateImage,
  moderateVideo,
  getAIResponse as getOpenAIResponse
} from './openai';

// Load environment variables
dotenv.config();

// Define session interface
interface SessionData {
  abusiveWordCount: number;
  lastWarning: number;
  isAdmin: boolean;
  [key: string]: any; // Allow dynamic properties for user tracking
}

// Define context type with session
type BotContext = Context & { session: SessionData };

// Initialize the bot
const bot = new Bot<BotContext>(process.env.BOT_TOKEN || '');

// Configure session middleware
bot.use(session({
  initial: (): SessionData => ({
    abusiveWordCount: 0,
    lastWarning: 0,
    isAdmin: false
  })
}));

// Add session data middleware to track users across messages
bot.use(async (ctx, next) => {
  // Create a unique key for the user in this chat
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  
  if (userId && chatId) {
    const userKey = `user_${userId}_chat_${chatId}`;
    // Initialize user data if not exists
    if (!ctx.session[userKey]) {
      ctx.session[userKey] = {
        abusiveWordCount: 0,
        lastWarning: 0
      };
      console.log(`Initialized session for ${userKey}`);
    }
  }
  
  await next();
});

// Load abusive words list from file (for backward compatibility)
const abusiveWordsPath = path.join(__dirname, '..', 'abusive_words.json');
let abusiveWords: string[] = [];

try {
  const data = fs.readFileSync(abusiveWordsPath, 'utf8');
  abusiveWords = JSON.parse(data);
  console.log(`Loaded ${abusiveWords.length} abusive words from file`);
} catch (error) {
  console.error('Error loading abusive words:', error);
  // Create the file with default words if it doesn't exist
  abusiveWords = [
    'fuck', 'shit', 'asshole', 'bitch', 'dick', 'pussy', 'cunt', 'whore', 'slut', 'bastard'
  ];
  fs.writeFileSync(abusiveWordsPath, JSON.stringify(abusiveWords, null, 2));
  console.log('Created default abusive words file');
}

// Connect to the database
connectToDatabase().catch(error => {
  console.error('Failed to connect to database:', error);
});

// Set up alert message scheduler
setInterval(async () => {
  try {
    const alerts = await getAlertMessagesToSend();
    
    for (const alert of alerts) {
      try {
        await bot.api.sendMessage(alert.chatId, alert.message);
        await updateAlertMessageLastSent(alert.chatId);
        console.log(`Sent scheduled alert to chat ${alert.chatId}`);
      } catch (error) {
        console.error(`Error sending alert to chat ${alert.chatId}:`, error);
      }
    }
  } catch (error) {
    console.error('Error in alert scheduler:', error);
  }
}, 60000); // Check every minute

// Function to check if a message contains abusive words
async function containsAbusiveWord(text: string, chatId?: number): Promise<boolean> {
  try {
    // Validate input
    if (!text || typeof text !== 'string') {
      console.log('Invalid text input for abusive word check');
      return false;
    }
    
    // Convert text to lowercase for case-insensitive matching
    const lowerText = text.toLowerCase();
    
    // Get settings to check if abusive words detection is enabled
    if (chatId) {
      try {
        const settings = await getGroupSettings(chatId);
        if (!settings || !settings.abusiveWordsEnabled) {
          return false;
        }
      } catch (error) {
        console.error('Error getting group settings:', error);
        // Continue checking even if settings retrieval fails
      }
    }
    
    // Check against local abusive words list
    if (Array.isArray(abusiveWords)) {
      for (const word of abusiveWords) {
        if (typeof word !== 'string') continue;
        
        try {
          // Use word boundary check for more accurate matching
          const regex = new RegExp(`\\b${word.toLowerCase()}\\b`, 'i');
          if (regex.test(lowerText)) {
            console.log(`Abusive word detected: ${word}`);
            return true;
          }
        } catch (regexError) {
          // If regex fails for this word, fallback to simple includes check
          console.error(`Regex error for word "${word}":`, regexError);
          if (lowerText.includes(word.toLowerCase())) {
            console.log(`Abusive word detected (fallback method): ${word}`);
            return true;
          }
        }
      }
    }
    
    // If chatId is provided, also check against database
    if (chatId) {
      try {
        // Get group-specific abusive words from database
        const dbWords = await getDbAbusiveWords(chatId);
        
        if (Array.isArray(dbWords)) {
          for (const word of dbWords) {
            if (typeof word !== 'string') continue;
            
            try {
              // Use word boundary check for more accurate matching
              const regex = new RegExp(`\\b${word.toLowerCase()}\\b`, 'i');
              if (regex.test(lowerText)) {
                console.log(`Database abusive word detected: ${word}`);
                return true;
              }
            } catch (regexError) {
              // If regex fails for this word, fallback to simple includes check
              console.error(`Regex error for DB word "${word}":`, regexError);
              if (lowerText.includes(word.toLowerCase())) {
                console.log(`Database abusive word detected (fallback method): ${word}`);
                return true;
              }
            }
          }
        }
      } catch (error) {
        console.error('Error checking database abusive words:', error);
      }
    }
    
    return false;
  } catch (error) {
    console.error('Unexpected error in containsAbusiveWord:', error);
    return false;
  }
}

// Function to add a new abusive word to the list
async function addAbusiveWord(word: string, chatId?: number): Promise<boolean> {
  try {
    // Normalize the word
    const normalizedWord = word.toLowerCase().trim();
    
    // Check if word already exists in local list
    if (!abusiveWords.includes(normalizedWord)) {
      // Add to local list
      abusiveWords.push(normalizedWord);
      
      // Save to file
      fs.writeFileSync(abusiveWordsPath, JSON.stringify(abusiveWords, null, 2));
      console.log(`Added word "${normalizedWord}" to abusive words list`);
    }
    
    // If chatId is provided, also add to database
    if (chatId) {
      await addDbAbusiveWord(chatId, normalizedWord);
      console.log(`Added word "${normalizedWord}" to database for chat ${chatId}`);
    }
    
    return true;
  } catch (error) {
    console.error('Error adding abusive word:', error);
    return false;
  }
}

// Function to remove an abusive word from the list
async function removeAbusiveWord(word: string, chatId?: number): Promise<boolean> {
  try {
    // Normalize the word
    const normalizedWord = word.toLowerCase().trim();
    
    // Remove from local list
    const index = abusiveWords.findIndex(w => w.toLowerCase() === normalizedWord);
    if (index !== -1) {
      abusiveWords.splice(index, 1);
      
      // Save to file
      fs.writeFileSync(abusiveWordsPath, JSON.stringify(abusiveWords, null, 2));
      console.log(`Removed word "${normalizedWord}" from abusive words list`);
    }
    
    // If chatId is provided, also remove from database
    if (chatId) {
      await removeDbAbusiveWord(chatId, normalizedWord);
      console.log(`Removed word "${normalizedWord}" from database for chat ${chatId}`);
    }
    
    return true;
  } catch (error) {
    console.error('Error removing abusive word:', error);
    return false;
  }
}

// Function to check if user is an admin in the group
async function isAdmin(ctx: BotContext, userId: number, chatId: number): Promise<boolean> {
  try {
    // Don't use the session for admin status as it might be persisting incorrectly
    // Always check with the API
    console.log(`Checking if user ${userId} is admin in chat ${chatId}`);
    
    const chatMember = await bot.api.getChatMember(chatId, userId);
    console.log(`User status: ${chatMember.status}`);
    
    const isUserAdmin = ['administrator', 'creator'].includes(chatMember.status);
    
    // Log the result
    if (isUserAdmin) {
      console.log(`User ${userId} is confirmed as admin`);
    } else {
      console.log(`User ${userId} is NOT an admin`);
    }
    
    return isUserAdmin;
  } catch (error) {
    console.error('Error checking admin status:', error);
    return false;
  }
}

// Function to check if bot is an admin in the group with necessary permissions
async function isBotAdmin(chatId: number): Promise<boolean> {
  try {
    const botInfo = await bot.api.getMe();
    const chatMember = await bot.api.getChatMember(chatId, botInfo.id);
    
    // Check if bot is admin
    if (!['administrator', 'creator'].includes(chatMember.status)) {
      console.log('Bot is not an administrator in this group');
      return false;
    }
    
    // If bot is admin, check for specific permissions
    if (chatMember.status === 'administrator') {
      const permissions = chatMember as any; // Cast to access permissions
      
      // Log all permissions for debugging
      console.log('Bot permissions:', JSON.stringify(permissions, null, 2));
      
      // Check for delete messages permission
      if (!permissions.can_delete_messages) {
        console.log('Bot does not have permission to delete messages');
        return false;
      }
      
      // Check for ban users permission
      if (!permissions.can_restrict_members) {
        console.log('Bot does not have permission to ban users');
        // We'll still return true since we can at least delete messages
      }
    }
    
    console.log('Bot has necessary admin permissions');
    return true;
  } catch (error) {
    console.error('Error checking bot admin status:', error);
    return false;
  }
}

// Function to interact with OpenAI via Cloudflare worker
async function getAIResponse(userMessage: string): Promise<string> {
  try {
    console.log(`Getting AI response for: "${userMessage}"`);
    const response = await axios.post('https://openai-api-worker.saadbeenco.workers.dev/', {
      messages: [
        {
          role: 'system',
          content: 'You are a helpful and friendly Telegram bot assistant. You help moderate groups and provide concise, friendly responses. Keep your responses short and to the point.'
        },
        {
          role: 'user',
          content: userMessage
        }
      ]
    });
    
    console.log('AI response received');
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('Error getting AI response:', error);
    return 'Sorry, I\'m having trouble processing your request right now.';
  }
}

// Start command handler
bot.command('start', async (ctx) => {
  console.log('Start command received');
  
  // Check if in private chat or group
  if (ctx.chat.type === 'private') {
    // Private chat - show main menu
    const keyboard = new InlineKeyboard()
      .text('Add to Group', 'add_to_group')
      .row()
      .url('Developer', 'https://t.me/saadbeenco');
    
    const firstName = ctx.from?.first_name || 'there';
    
    await ctx.reply(
      `👋 Hello ${firstName}!\n\n` +
      `I'm a group moderation bot that can help manage your groups by detecting and handling abusive language, images, and videos.\n\n` +
      `Add me to a group and make me an admin to get started!`,
      { reply_markup: keyboard }
    );
  } else {
    // Group chat - check if user is admin
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;
    
    if (!userId) return;
    
    const isUserAdmin = await isAdmin(ctx, userId, chatId);
    
    if (isUserAdmin) {
      // Show admin configuration menu
      const settings = await getGroupSettings(chatId);
      
      // Default settings if null
      const safeSettings = settings || {
        chatId,
        abusiveWordsEnabled: false,
        imageModeration: false,
        videoModeration: false,
        createdAt: new Date()
      };
      
      const keyboard = new InlineKeyboard()
        .text(safeSettings.abusiveWordsEnabled ? '✅ Abusive Words' : '❌ Abusive Words', 'toggle_abusive_words')
        .row()
        .text(safeSettings.imageModeration ? '✅ Image Moderation' : '❌ Image Moderation', 'toggle_image_moderation')
        .row()
        .text(safeSettings.videoModeration ? '✅ Video Moderation' : '❌ Video Moderation', 'toggle_video_moderation')
        .row()
        .text('⚙️ Alert Messages', 'alert_messages')
        .row()
        .text('📋 Abusive Words List', 'list_abusive_words')
        .row()
        .text('❓ Help', 'help');
      
      await ctx.reply(
        `⚙️ **Group Configuration**\n\n` +
        `Welcome to the admin configuration panel. Use the buttons below to configure the bot for this group.`,
        { 
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        }
      );
    } else {
      // Not an admin
      await ctx.reply(
        `This command is only available to group administrators.`
      );
    }
  }
});

// Handle callback queries from inline keyboards
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  const userId = ctx.from.id;
  const chatId = ctx.chat?.id;
  
  if (!chatId) {
    await ctx.answerCallbackQuery('Error: Could not determine chat ID');
    return;
  }
  
  // Check if user is admin for admin-only actions
  const adminOnlyActions = [
    'toggle_abusive_words', 
    'toggle_image_moderation', 
    'toggle_video_moderation',
    'alert_messages',
    'list_abusive_words',
    'set_alert',
    'remove_alert',
    'back_to_main'
  ];
  
  if (adminOnlyActions.includes(data)) {
    const isUserAdmin = await isAdmin(ctx, userId, chatId);
    
    if (!isUserAdmin) {
      await ctx.answerCallbackQuery('This action is only available to group administrators');
      return;
    }
  }
  
  // Handle different callback actions
  switch (data) {
    case 'add_to_group':
      await ctx.answerCallbackQuery('Use the "Add to Group" button in Telegram to add me to your group');
      break;
      
    case 'toggle_abusive_words':
      await handleToggleAbusiveWords(ctx, chatId);
      break;
      
    case 'toggle_image_moderation':
      await handleToggleImageModeration(ctx, chatId);
      break;
      
    case 'toggle_video_moderation':
      await handleToggleVideoModeration(ctx, chatId);
      break;
      
    case 'alert_messages':
      await handleAlertMessages(ctx, chatId);
      break;
      
    case 'list_abusive_words':
      await handleListAbusiveWords(ctx, chatId);
      break;
      
    case 'set_alert':
      await ctx.answerCallbackQuery();
      await ctx.reply(
        `To set an alert message, use the command:\n` +
        `/set_alert_message [interval_in_minutes] [message]\n\n` +
        `Example: /set_alert_message 60 Remember to follow the group rules!`
      );
      break;
      
    case 'remove_alert':
      await handleRemoveAlert(ctx, chatId);
      break;
      
    case 'back_to_main':
      await updateConfigKeyboard(ctx);
      await ctx.answerCallbackQuery('Returned to main menu');
      break;
      
    case 'help':
      await handleHelp(ctx);
      break;
      
    default:
      await ctx.answerCallbackQuery('Unknown action');
  }
});

// Handler functions for callback queries
async function handleToggleAbusiveWords(ctx: any, chatId: number) {
  const settings = await getGroupSettings(chatId);
  
  // If settings is null, create default settings
  if (!settings) {
    await updateGroupSettings(chatId, {
      chatId,
      abusiveWordsEnabled: true, // Enable by default
      imageModeration: false,
      videoModeration: false,
      createdAt: new Date()
    });
    return await updateConfigKeyboard(ctx);
  }
  
  const newValue = !settings.abusiveWordsEnabled;
  
  await updateGroupSettings(chatId, { ...settings, abusiveWordsEnabled: newValue });
  
  await ctx.answerCallbackQuery({
    text: `Abusive words detection ${newValue ? 'enabled' : 'disabled'}`
  });
  
  await updateConfigKeyboard(ctx);
}

async function handleToggleImageModeration(ctx: any, chatId: number) {
  const settings = await getGroupSettings(chatId);
  
  // If settings is null, create default settings
  if (!settings) {
    await updateGroupSettings(chatId, {
      chatId,
      abusiveWordsEnabled: false,
      imageModeration: true, // Enable by default
      videoModeration: false,
      createdAt: new Date()
    });
    return await updateConfigKeyboard(ctx);
  }
  
  const newValue = !settings.imageModeration;
  
  await updateGroupSettings(chatId, { ...settings, imageModeration: newValue });
  
  await ctx.answerCallbackQuery({
    text: `Image moderation ${newValue ? 'enabled' : 'disabled'}`
  });
  
  await updateConfigKeyboard(ctx);
}

async function handleToggleVideoModeration(ctx: any, chatId: number) {
  const settings = await getGroupSettings(chatId);
  
  // If settings is null, create default settings
  if (!settings) {
    await updateGroupSettings(chatId, {
      chatId,
      abusiveWordsEnabled: false,
      imageModeration: false,
      videoModeration: true, // Enable by default
      createdAt: new Date()
    });
    return await updateConfigKeyboard(ctx);
  }
  
  const newValue = !settings.videoModeration;
  
  await updateGroupSettings(chatId, { ...settings, videoModeration: newValue });
  
  await ctx.answerCallbackQuery({
    text: `Video moderation ${newValue ? 'enabled' : 'disabled'}`
  });
  
  await updateConfigKeyboard(ctx);
}

async function handleAlertMessages(ctx: any, chatId: number) {
  const alertMessage = await getAlertMessage(chatId);
  
  const keyboard = new InlineKeyboard()
    .text('Set Alert Message', 'set_alert')
    .row()
    .text('Remove Alert Message', 'remove_alert')
    .row()
    .text('Back to Main Menu', 'back_to_main');
  
  let message = `⚙️ **Alert Messages Configuration**\n\n`;
  
  if (alertMessage) {
    message += `Current alert message:\n` +
      `"${alertMessage.message}"\n\n` +
      `Interval: ${alertMessage.interval} minutes`;
  } else {
    message += `No alert message is currently set.\n\n` +
      `Use the buttons below to set or remove an alert message.`;
  }
  
  await ctx.editMessageText(message, {
    reply_markup: keyboard,
    parse_mode: 'Markdown'
  });
}

async function handleListAbusiveWords(ctx: any, chatId: number) {
  // Get words from both local file and database
  const dbWords = await getDbAbusiveWords(chatId);
  
  // Combine and deduplicate
  const allWords = [...new Set([...abusiveWords, ...dbWords])];
  
  if (allWords.length === 0) {
    await ctx.answerCallbackQuery('No abusive words are currently configured');
    return;
  }
  
  // Format the list
  const wordsList = allWords.map(word => `• ${word}`).join('\n');
  
  const keyboard = new InlineKeyboard()
    .text('Back to Main Menu', 'back_to_main');
  
  await ctx.editMessageText(
    `📋 **Abusive Words List**\n\n` +
    `${wordsList}\n\n` +
    `Use /addword [word] to add a word\n` +
    `Use /removeword [word] to remove a word`,
    {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    }
  );
}

async function handleRemoveAlert(ctx: any, chatId: number) {
  const alertMessage = await getAlertMessage(chatId);
  
  if (!alertMessage) {
    await ctx.answerCallbackQuery('No alert message is currently set');
    return;
  }
  
  await removeAlertMessage(chatId);
  await ctx.answerCallbackQuery('Alert message removed');
  
  // Go back to the alert messages menu
  await handleAlertMessages(ctx, chatId);
}

async function handleHelp(ctx: any) {
  const keyboard = new InlineKeyboard()
    .text('Back to Main Menu', 'back_to_main');
  
  await ctx.editMessageText(
    `❓ **Help**\n\n` +
    `**Available Commands:**\n\n` +
    `/start - Show the configuration menu\n` +
    `/help - Show this help message\n` +
    `/addword [word] - Add a new abusive word to the filter\n` +
    `/removeword [word] - Remove a word from the abusive filter\n` +
    `/listwords - List all abusive words in the filter\n` +
    `/set_alert_message [interval_in_minutes] [message] - Set a message to be sent periodically\n` +
    `/activate_images_or_video_detector - Toggle image and video moderation\n\n` +
    `**Features:**\n\n` +
    `• **Abusive Words Monitoring** - Detects and removes messages with abusive language\n` +
    `• **Image Moderation** - Detects and removes inappropriate images\n` +
    `• **Video Moderation** - Detects and removes inappropriate videos\n` +
    `• **Alert Messages** - Sends scheduled messages to the group`,
    {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    }
  );
}

async function updateConfigKeyboard(ctx: any) {
  const chatId = ctx.chat?.id;
  
  if (!chatId) return;
  
  const settings = await getGroupSettings(chatId);
  
  if (!settings) return;
  
  const keyboard = new InlineKeyboard()
    .text(settings.abusiveWordsEnabled ? '✅ Abusive Words' : '❌ Abusive Words', 'toggle_abusive_words')
    .row()
    .text(settings.imageModeration ? '✅ Image Moderation' : '❌ Image Moderation', 'toggle_image_moderation')
    .row()
    .text(settings.videoModeration ? '✅ Video Moderation' : '❌ Video Moderation', 'toggle_video_moderation')
    .row()
    .text('⚙️ Alert Messages', 'alert_messages')
    .row()
    .text('📋 Abusive Words List', 'list_abusive_words')
    .row()
    .text('❓ Help', 'help');
  
  await ctx.editMessageText(
    `⚙️ **Group Configuration**\n\n` +
    `Welcome to the admin configuration panel. Use the buttons below to configure the bot for this group.`,
    { 
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    }
  );
}

// Help command handler
bot.command('help', async (ctx) => {
  console.log('Help command received');
  await ctx.reply(
    'Group Manager Bot Commands:\n\n' +
    '/start - Start the bot\n' +
    '/help - Show this help message\n' +
    '/addword <word> - Add a word to the abusive words list\n' +
    '/removeword <word> - Remove a word from the abusive words list\n' +
    '/listwords - List all abusive words in the filter\n' +
    '/ask <question> - Ask the AI assistant a question\n\n' +
    'Note: Admin commands can only be used by group administrators.'
  );
});

// Add abusive word command
bot.command('addword', async (ctx) => {
  console.log('Add word command received');
  // Only allow in groups and only by admins
  if (!ctx.chat || ctx.chat.type === 'private') {
    await ctx.reply('This command can only be used in groups.');
    return;
  }
  
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  
  if (!userId) return;
  
  // Check if user is admin
  const userIsAdmin = await isAdmin(ctx, userId, chatId);
  
  if (!userIsAdmin) {
    await ctx.reply('Only administrators can use this command.');
    return;
  }
  
  const word = ctx.match;
  
  if (!word) {
    await ctx.reply('Please provide a word to add. Usage: /addword <word>');
    return;
  }
  
  const added = await addAbusiveWord(word, chatId);
  
  if (added) {
    await ctx.reply(`Added "${word}" to the abusive words list.`);
  } else {
    await ctx.reply(`"${word}" is already in the abusive words list.`);
  }
});

// Remove abusive word command
bot.command('removeword', async (ctx) => {
  console.log('Remove word command received');
  // Only allow in groups and only by admins
  if (!ctx.chat || ctx.chat.type === 'private') {
    await ctx.reply('This command can only be used in groups.');
    return;
  }
  
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  
  if (!userId) return;
  
  // Check if user is admin
  const userIsAdmin = await isAdmin(ctx, userId, chatId);
  
  if (!userIsAdmin) {
    await ctx.reply('Only administrators can use this command.');
    return;
  }
  
  const word = ctx.match;
  
  if (!word) {
    await ctx.reply('Please provide a word to remove. Usage: /removeword <word>');
    return;
  }
  
  const removed = await removeAbusiveWord(word, chatId);
  
  if (removed) {
    await ctx.reply(`Removed "${word}" from the abusive words list.`);
  } else {
    await ctx.reply(`"${word}" is not in the abusive words list.`);
  }
});

// List abusive words command
bot.command('listwords', async (ctx) => {
  console.log('List words command received');
  // Only allow in groups and only by admins
  if (!ctx.chat || ctx.chat.type === 'private') {
    await ctx.reply('This command can only be used in groups.');
    return;
  }
  
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  
  if (!userId) return;
  
  // Check if user is admin
  const userIsAdmin = await isAdmin(ctx, userId, chatId);
  
  if (!userIsAdmin) {
    await ctx.reply('Only administrators can use this command.');
    return;
  }
  
  if (abusiveWords.length === 0) {
    await ctx.reply('The abusive words list is empty.');
    return;
  }
  
  await ctx.reply(`Abusive Words List:\n\n${abusiveWords.join('\n')}`);
});

// Ask AI command
bot.command('ask', async (ctx) => {
  console.log('Ask command received');
  const question = ctx.match;
  
  if (!question) {
    await ctx.reply('Please provide a question. Usage: /ask <question>');
    return;
  }
  
  // Show typing indicator
  await ctx.api.sendChatAction(ctx.chat.id, 'typing');
  
  const response = await getAIResponse(question);
  await ctx.reply(response);
});

// Command to set alert message
bot.command('set_alert_message', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  
  if (!userId) {
    await ctx.reply('Could not identify user.');
    return;
  }
  
  // Check if user is admin
  const isUserAdmin = await isAdmin(ctx, userId, chatId);
  
  if (!isUserAdmin) {
    await ctx.reply('This command is only available to group administrators.');
    return;
  }
  
  // Parse command arguments
  const text = ctx.message?.text?.trim() || '';
  const parts = text.split(' ');
  
  if (parts.length < 3) {
    await ctx.reply(
      'Please provide both interval and message.\n' +
      'Usage: /set_alert_message [interval_in_minutes] [message]'
    );
    return;
  }
  
  // Extract interval and message
  const interval = parseInt(parts[1]);
  const message = parts.slice(2).join(' ');
  
  if (isNaN(interval) || interval <= 0) {
    await ctx.reply('Please provide a valid interval in minutes (must be a positive number).');
    return;
  }
  
  if (message.length === 0) {
    await ctx.reply('Please provide a message to be sent.');
    return;
  }
  
  // Save the alert message
  await setAlertMessage(chatId, message, interval);
  
  await ctx.reply(
    `✅ Alert message set successfully!\n\n` +
    `Message: "${message}"\n` +
    `Interval: ${interval} minutes`
  );
});

// Command to activate/deactivate image and video moderation
bot.command('activate_images_or_video_detector', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  
  if (!userId) {
    await ctx.reply('Could not identify user.');
    return;
  }
  
  // Check if user is admin
  const isUserAdmin = await isAdmin(ctx, userId, chatId);
  
  if (!isUserAdmin) {
    await ctx.reply('This command is only available to group administrators.');
    return;
  }
  
  // Get current settings
  const settings = await getGroupSettings(chatId);
  
  // Handle null settings
  if (!settings) {
    // Create default settings
    const defaultSettings = {
      chatId,
      abusiveWordsEnabled: true,
      imageModeration: false,
      videoModeration: false,
      createdAt: new Date()
    };
    
    await updateGroupSettings(chatId, defaultSettings);
    
    // Show moderation menu with default settings
    const keyboard = new InlineKeyboard()
      .text('❌ Image Moderation', 'toggle_image_moderation')
      .row()
      .text('❌ Video Moderation', 'toggle_video_moderation');
    
    await ctx.reply(
      `⚙️ **Image and Video Moderation Settings**\n\n` +
      `Use the buttons below to toggle image and video moderation.`,
      {
        reply_markup: keyboard,
        parse_mode: 'Markdown'
      }
    );
    return;
  }
  
  // Create inline keyboard for options
  const keyboard = new InlineKeyboard()
    .text(settings.imageModeration ? '✅ Image Moderation' : '❌ Image Moderation', 'toggle_image_moderation')
    .row()
    .text(settings.videoModeration ? '✅ Video Moderation' : '❌ Video Moderation', 'toggle_video_moderation');
  
  await ctx.reply(
    `⚙️ **Image and Video Moderation Settings**\n\n` +
    `Use the buttons below to toggle image and video moderation.`,
    {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    }
  );
});

// Update the help command to include new commands
bot.command('help', async (ctx) => {
  await ctx.reply(
    `🤖 **Group Manager Bot Help**\n\n` +
    `**Admin Commands:**\n` +
    `/start - Show the configuration menu\n` +
    `/addword [word] - Add a new abusive word to the filter\n` +
    `/removeword [word] - Remove a word from the abusive filter\n` +
    `/listwords - List all abusive words in the filter\n` +
    `/set_alert_message [interval] [message] - Set a message to be sent periodically\n` +
    `/activate_images_or_video_detector - Toggle image and video moderation\n\n` +
    `**User Commands:**\n` +
    `/ask [question] - Ask the AI assistant a question\n\n` +
    `**Features:**\n` +
    `• Abusive language detection and removal\n` +
    `• Image and video content moderation\n` +
    `• Scheduled alert messages\n` +
    `• AI assistant for answering questions`,
    { parse_mode: 'Markdown' }
  );
});

// Handle when bot is added to a group or its permissions change
bot.on('my_chat_member', async (ctx) => {
  console.log('Bot chat member status changed:', JSON.stringify(ctx.update.my_chat_member, null, 2));
  
  const chat = ctx.chat;
  const newStatus = ctx.update.my_chat_member.new_chat_member.status;
  const oldStatus = ctx.update.my_chat_member.old_chat_member.status;
  
  // Skip if not in a group
  if (chat.type !== 'group' && chat.type !== 'supergroup') {
    return;
  }
  
  // Bot was added to a group
  if (oldStatus === 'left' && (newStatus === 'member' || newStatus === 'restricted')) {
    console.log(`Bot was added to group: ${chat.title}`);
    
    try {
      await ctx.reply(
        `👋 Hello! I'm a group moderation bot.\n\n` +
        `To function properly, I need the following admin permissions:\n` +
        `- Delete Messages\n` +
        `- Ban Users\n\n` +
        `Please promote me to admin with these permissions to enable moderation features.`
      );
      
      // Also send a message to show commands
      await ctx.reply(
        `Available commands:\n` +
        `/addword [word] - Add a word to the abusive words list\n` +
        `/removeword [word] - Remove a word from the abusive words list\n` +
        `/listwords - List all abusive words\n` +
        `/ask [question] - Ask me a question`
      );
    } catch (error) {
      console.error('Error sending welcome message:', error);
    }
  }
  
  // Bot was promoted to admin
  else if ((oldStatus === 'member' || oldStatus === 'restricted') && newStatus === 'administrator') {
    console.log(`Bot was promoted to admin in group: ${chat.title}`);
    
    // Check if bot has necessary permissions
    const permissions = ctx.update.my_chat_member.new_chat_member as any;
    const canDelete = permissions.can_delete_messages;
    const canBan = permissions.can_restrict_members;
    
    let message = `✅ Thank you for promoting me to admin!\n\n`;
    
    if (canDelete && canBan) {
      message += `I have all the necessary permissions and am ready to moderate this group.`;
    } else {
      message += `However, I'm missing some permissions:\n`;
      if (!canDelete) message += `- ❌ Delete Messages (required for removing abusive content)\n`;
      if (!canBan) message += `- ❌ Ban Users (required for removing repeat offenders)\n\n`;
      message += `Please update my permissions to enable full moderation capabilities.`;
    }
    
    try {
      await ctx.reply(message);
    } catch (error) {
      console.error('Error sending admin promotion message:', error);
    }
  }
  
  // Bot was demoted from admin
  else if (newStatus === 'member' && oldStatus === 'administrator') {
    console.log(`Bot was demoted from admin in group: ${chat.title}`);
    
    try {
      await ctx.reply(
        `⚠️ I've been demoted from admin status.\n` +
        `I can no longer moderate messages or ban users.\n` +
        `Please restore my admin permissions to enable moderation features.`
      );
    } catch (error) {
      console.error('Error sending demotion message:', error);
    }
  }
  
  // Bot was removed from the group
  else if (newStatus === 'left' || newStatus === 'kicked') {
    console.log(`Bot was removed from group: ${chat.title}`);
    // No action needed as bot can't send messages anymore
  }
});

// Handle new members added to the group
bot.on('chat_member', async (ctx) => {
  console.log('chat_member event received:', JSON.stringify(ctx.chatMember));
  
  // Someone was added to the group (not the bot)
  if (ctx.chatMember.new_chat_member.status === 'member' && 
      ctx.chatMember.old_chat_member.status === 'left') {
    
    const newMember = ctx.chatMember.new_chat_member.user;
    console.log(`New member joined: ${newMember.first_name}`);
    
    // Welcome the new member
    await ctx.reply(`Welcome to the group, ${newMember.first_name}! Please follow the group rules and be respectful to others.`);
  }
});

// Handle message text to detect abusive language
bot.on('message:text', async (ctx) => {
  try {
    console.log(`Message received in chat type: ${ctx.chat.type}`);
    
    // Skip processing in private chats
    if (ctx.chat.type === 'private') {
      return;
    }
    
    const text = ctx.message.text;
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    
    if (!userId) {
      console.log('No user ID found, skipping message processing');
      return;
    }
    
    console.log(`Message from ${ctx.from?.first_name} (${userId}): ${text}`);
    
    // Get group settings
    let settings;
    try {
      settings = await getGroupSettings(chatId);
      
      // Skip if settings is null or abusive words detection is disabled
      if (!settings || !settings.abusiveWordsEnabled) {
        console.log('Abusive words detection is disabled for this group');
        return;
      }
    } catch (settingsError) {
      console.error('Error getting group settings:', settingsError);
      // Continue with default behavior if settings retrieval fails
    }
    
    // Create a unique key for this user in this chat
    const userKey = `user_${userId}_chat_${chatId}`;
    
    // Initialize user data if not exists
    if (!ctx.session[userKey]) {
      ctx.session[userKey] = {
        abusiveWordCount: 0,
        lastWarning: 0
      };
    }
    
    // Check if message contains abusive words
    let containsAbusive = false;
    try {
      containsAbusive = await containsAbusiveWord(text, chatId);
    } catch (abusiveCheckError) {
      console.error('Error checking for abusive words:', abusiveCheckError);
      return; // Skip further processing if check fails
    }
    
    if (containsAbusive) {
      console.log('Abusive language detected');
      
      // Check if bot is admin with necessary permissions
      let botCanManage = false;
      try {
        botCanManage = await isBotAdmin(chatId);
      } catch (adminCheckError) {
        console.error('Error checking bot admin status:', adminCheckError);
        return; // Skip further processing if check fails
      }
      
      if (!botCanManage) {
        // Bot is not an admin or doesn't have necessary permissions
        console.log('Bot cannot moderate: missing admin status or permissions');
        try {
          await ctx.reply('⚠️ I detected abusive language but cannot moderate because I am not an admin or lack necessary permissions.');
        } catch (error) {
          console.error('Error sending permissions message:', error);
        }
        return;
      }
      
      // Check if user is admin
      let userIsAdmin = false;
      try {
        userIsAdmin = await isAdmin(ctx, userId, chatId);
      } catch (userAdminCheckError) {
        console.error('Error checking user admin status:', userAdminCheckError);
        // Assume user is not an admin if check fails
        userIsAdmin = false;
      }
      
      if (userIsAdmin) {
        // Don't moderate admins
        console.log('User is an admin, not moderating');
        return;
      }
      
      console.log('User is not an admin, proceeding with moderation');
      
      // Get current warnings from database
      let warningCount = 0;
      try {
        const warnings = await getUserWarningsAcrossSessions(userId, chatId);
        warningCount = (warnings?.count || 0) + 1;
        
        // Update warnings in database
        await updateUserWarningsAcrossSessions(userId, chatId, warningCount);
        console.log(`Updated user warnings in database: ${warningCount}`);
      } catch (dbError) {
        console.error('Error updating user warnings in database:', dbError);
        // Fallback to session-based count if database fails
        ctx.session[userKey].abusiveWordCount = (ctx.session[userKey].abusiveWordCount || 0) + 1;
        warningCount = ctx.session[userKey].abusiveWordCount;
      }
      
      // Also update session count for redundancy
      ctx.session[userKey].abusiveWordCount = warningCount;
      
      console.log(`User now has ${warningCount} warnings`);
      
      // Delete the message - with better error handling
      let messageDeleted = false;
      try {
        console.log(`Attempting to delete message ${messageId} from chat ${chatId}`);
        await ctx.api.deleteMessage(chatId, messageId);
        console.log('Message deleted successfully');
        messageDeleted = true;
      } catch (error) {
        console.error('Error deleting message:', error);
        
        // Try to send a message about the failure
        try {
          await ctx.reply('⚠️ I detected abusive language but could not delete the message. Please check my permissions.');
        } catch (replyError) {
          console.error('Error sending error message:', replyError);
        }
      }
      
      // Decide action based on count
      if (warningCount >= 3) {
        // Ban user after 3 violations
        try {
          console.log(`Banning user ${ctx.from?.first_name}`);
          await ctx.api.banChatMember(chatId, userId);
          await ctx.reply(`User ${ctx.from?.first_name} has been banned for repeated use of abusive language.`);
          
          // Reset count after ban
          await updateUserWarningsAcrossSessions(userId, chatId, 0);
          ctx.session[userKey].abusiveWordCount = 0;
        } catch (error) {
          console.error('Error banning user:', error);
          
          // Try to send a message about the failure
          try {
            await ctx.reply('⚠️ I tried to ban a user but failed. Please check my permissions.');
          } catch (replyError) {
            console.error('Error sending error message:', replyError);
          }
        }
      } else if (messageDeleted) {
        // Only warn if message was successfully deleted
        // Warn user
        const now = Date.now();
        // Only send warning if last warning was more than 1 minute ago
        if (!ctx.session[userKey].lastWarning || now - ctx.session[userKey].lastWarning > 60000) {
          try {
            console.log(`Warning user ${ctx.from?.first_name}`);
            await ctx.reply(
              `⚠️ Warning to ${ctx.from?.first_name}: Abusive language is not allowed in this group.\n` +
              `This is warning ${warningCount}/3. You will be banned after 3 warnings.`
            );
            ctx.session[userKey].lastWarning = now;
          } catch (error) {
            console.error('Error sending warning message:', error);
          }
        }
      }
    }
    
    // Check if message is directed at the bot (mentions or replies)
    const isMentioned = text.includes(`@${bot.botInfo.username}`);
    const isReply = ctx.message.reply_to_message?.from?.id === bot.botInfo.id;
    
    if (isMentioned || isReply) {
      console.log('Bot was mentioned or replied to');
      
      // Extract the question (remove the mention if present)
      let question = text;
      if (isMentioned) {
        question = question.replace(`@${bot.botInfo.username}`, '').trim();
      }
      
      // Skip if the question is empty
      if (!question) return;
      
      try {
        // Show typing indicator
        await ctx.api.sendChatAction(ctx.chat.id, 'typing');
        
        // Get AI response
        const response = await getOpenAIResponse(question);
        await ctx.reply(response, {
          reply_to_message_id: messageId
        });
      } catch (error) {
        console.error('Error getting or sending AI response:', error);
        try {
          await ctx.reply('Sorry, I encountered an error while processing your request.');
        } catch (replyError) {
          console.error('Error sending error message:', replyError);
        }
      }
    }
  } catch (error) {
    console.error('Unexpected error in message:text handler:', error);
  }
});

// Handle photos for moderation
bot.on('message:photo', async (ctx) => {
  try {
    console.log('Photo received');
    
    // Skip processing in private chats
    if (ctx.chat.type === 'private') {
      console.log('Skipping photo moderation in private chat');
      return;
    }
    
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    
    if (!userId) return;
    
    // Get group settings
    let settings;
    try {
      settings = await getGroupSettings(chatId);
      
      // Skip if settings is null or image moderation is disabled
      if (!settings || !settings.imageModeration) {
        console.log('Image moderation is disabled for this group');
        return;
      }
    } catch (settingsError) {
      console.error('Error getting group settings:', settingsError);
      // Continue with default behavior if settings retrieval fails
    }
    
    // Check if bot is admin with necessary permissions
    let botCanManage = false;
    try {
      botCanManage = await isBotAdmin(chatId);
    } catch (adminCheckError) {
      console.error('Error checking bot admin status:', adminCheckError);
      return; // Skip further processing if check fails
    }
    
    if (!botCanManage) {
      // Bot is not an admin or doesn't have necessary permissions
      console.log('Bot cannot moderate: missing admin status or permissions');
      try {
        await ctx.reply('⚠️ I cannot moderate images because I am not an admin or lack necessary permissions.');
      } catch (error) {
        console.error('Error sending permissions message:', error);
      }
      return;
    }
    
    // Check if user is admin
    let userIsAdmin = false;
    try {
      userIsAdmin = await isAdmin(ctx, userId, chatId);
    } catch (userAdminCheckError) {
      console.error('Error checking user admin status:', userAdminCheckError);
      // Assume user is not an admin if check fails
      userIsAdmin = false;
    }
    
    if (userIsAdmin) {
      // Don't moderate admins
      console.log('User is an admin, not moderating photo');
      return;
    }
    
    // Get the photo file
    const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    
    try {
      console.log('Getting photo file');
      const file = await ctx.api.getFile(photoId);
      
      if (!file || !file.file_path) {
        console.error('Failed to get file path for photo');
        return;
      }
      
      // Download the photo
      const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
      console.log(`Downloading photo from ${fileUrl}`);
      
      let imageBuffer: Buffer;
      try {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(response.data, 'binary');
        
        if (!imageBuffer || imageBuffer.length === 0) {
          console.error('Downloaded image buffer is empty or invalid');
          return;
        }
      } catch (downloadError) {
        console.error('Error downloading photo:', downloadError);
        return;
      }
      
      // Moderate the image
      console.log('Moderating image');
      const moderationResult = await moderateImage(imageBuffer);
      
      if (moderationResult.isInappropriate) {
        console.log(`Inappropriate image detected: ${moderationResult.reason}`);
        
        // Delete the message
        try {
          await ctx.api.deleteMessage(chatId, messageId);
          console.log('Deleted inappropriate image');
          
          // Handle the inappropriate content
          await handleInappropriateContent(ctx, userId, chatId, 'image');
          
          // Log the detection
          console.log(`Inappropriate image from ${ctx.from?.first_name} (${userId}) deleted. Reason: ${moderationResult.reason}`);
        } catch (deleteError) {
          console.error('Error deleting inappropriate image:', deleteError);
          
          // Try to send a message about the failure
          try {
            await ctx.reply('⚠️ I detected inappropriate content but could not delete the message. Please check my permissions.');
          } catch (replyError) {
            console.error('Error sending error message:', replyError);
          }
        }
      } else {
        console.log('Image is appropriate');
      }
    } catch (error) {
      console.error('Error in photo moderation:', error);
    }
  } catch (error) {
    console.error('Unexpected error in message:photo handler:', error);
  }
});

// Handle videos for moderation
bot.on('message:video', async (ctx) => {
  try {
    console.log('Video received');
    
    // Skip processing in private chats
    if (ctx.chat.type === 'private') {
      console.log('Skipping video moderation in private chat');
      return;
    }
    
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    
    if (!userId) return;
    
    // Get group settings
    let settings;
    try {
      settings = await getGroupSettings(chatId);
      
      // Skip if settings is null or video moderation is disabled
      if (!settings || !settings.videoModeration) {
        console.log('Video moderation is disabled for this group');
        return;
      }
    } catch (settingsError) {
      console.error('Error getting group settings:', settingsError);
      // Continue with default behavior if settings retrieval fails
    }
    
    // Check if bot is admin with necessary permissions
    let botCanManage = false;
    try {
      botCanManage = await isBotAdmin(chatId);
    } catch (adminCheckError) {
      console.error('Error checking bot admin status:', adminCheckError);
      return; // Skip further processing if check fails
    }
    
    if (!botCanManage) {
      // Bot is not an admin or doesn't have necessary permissions
      console.log('Bot cannot moderate: missing admin status or permissions');
      try {
        await ctx.reply('⚠️ I cannot moderate videos because I am not an admin or lack necessary permissions.');
      } catch (error) {
        console.error('Error sending permissions message:', error);
      }
      return;
    }
    
    // Check if user is admin
    let userIsAdmin = false;
    try {
      userIsAdmin = await isAdmin(ctx, userId, chatId);
    } catch (userAdminCheckError) {
      console.error('Error checking user admin status:', userAdminCheckError);
      // Assume user is not an admin if check fails
      userIsAdmin = false;
    }
    
    if (userIsAdmin) {
      // Don't moderate admins
      console.log('User is an admin, not moderating video');
      return;
    }
    
    // Get the video file
    const videoId = ctx.message.video.file_id;
    
    try {
      console.log('Getting video file');
      const file = await ctx.api.getFile(videoId);
      
      if (!file || !file.file_path) {
        console.error('Failed to get file path for video');
        return;
      }
      
      // Download the video
      const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
      console.log(`Downloading video from ${fileUrl}`);
      
      let videoBuffer: Buffer;
      try {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        videoBuffer = Buffer.from(response.data, 'binary');
        
        if (!videoBuffer || videoBuffer.length === 0) {
          console.error('Downloaded video buffer is empty or invalid');
          return;
        }
      } catch (downloadError) {
        console.error('Error downloading video:', downloadError);
        return;
      }
      
      // Moderate the video
      console.log('Moderating video');
      const moderationResult = await moderateVideo(videoBuffer);
      
      if (moderationResult.isInappropriate) {
        console.log(`Inappropriate video detected: ${moderationResult.reason}`);
        
        // Delete the message
        try {
          await ctx.api.deleteMessage(chatId, messageId);
          console.log('Deleted inappropriate video');
          
          // Handle the inappropriate content
          await handleInappropriateContent(ctx, userId, chatId, 'video');
          
          // Log the detection
          console.log(`Inappropriate video from ${ctx.from?.first_name} (${userId}) deleted. Reason: ${moderationResult.reason}`);
        } catch (deleteError) {
          console.error('Error deleting inappropriate video:', deleteError);
          
          // Try to send a message about the failure
          try {
            await ctx.reply('⚠️ I detected inappropriate content but could not delete the message. Please check my permissions.');
          } catch (replyError) {
            console.error('Error sending error message:', replyError);
          }
        }
      } else {
        console.log('Video is appropriate');
      }
    } catch (error) {
      console.error('Error in video moderation:', error);
    }
  } catch (error) {
    console.error('Unexpected error in message:video handler:', error);
  }
});

// Handle inappropriate content (images or videos)
async function handleInappropriateContent(ctx: any, userId: number, chatId: number, contentType: string): Promise<void> {
  try {
    // Create a unique key for this user in this chat
    const userKey = `user_${userId}_chat_${chatId}`;
    
    // Initialize user data if not exists
    if (!ctx.session[userKey]) {
      ctx.session[userKey] = {
        abusiveWordCount: 0,
        lastWarning: 0
      };
    }
    
    // Get current warnings from database
    let warningCount = 0;
    try {
      const warnings = await getUserWarningsAcrossSessions(userId, chatId);
      warningCount = (warnings?.count || 0) + 1;
      
      // Update warnings in database
      await updateUserWarningsAcrossSessions(userId, chatId, warningCount);
      console.log(`Updated user warnings in database: ${warningCount}`);
    } catch (dbError) {
      console.error('Error updating user warnings in database:', dbError);
      // Fallback to session-based count if database fails
      ctx.session[userKey].abusiveWordCount = (ctx.session[userKey].abusiveWordCount || 0) + 1;
      warningCount = ctx.session[userKey].abusiveWordCount;
    }
    
    // Also update session count for redundancy
    ctx.session[userKey].abusiveWordCount = warningCount;
    
    console.log(`User now has ${warningCount} warnings`);
    
    // Decide action based on count
    if (warningCount >= 3) {
      // Ban user after 3 violations
      try {
        console.log(`Banning user ${ctx.from?.first_name} for inappropriate ${contentType}`);
        await ctx.api.banChatMember(chatId, userId);
        await ctx.reply(`User ${ctx.from?.first_name} has been banned for sharing inappropriate ${contentType} content.`);
        
        // Reset count after ban
        await updateUserWarningsAcrossSessions(userId, chatId, 0);
        ctx.session[userKey].abusiveWordCount = 0;
      } catch (error) {
        console.error('Error banning user:', error);
      }
    } else {
      // Warn user
      const now = Date.now();
      // Only send warning if last warning was more than 1 minute ago
      if (!ctx.session[userKey].lastWarning || now - ctx.session[userKey].lastWarning > 60000) {
        try {
          console.log(`Warning user ${ctx.from?.first_name}`);
          await ctx.reply(
            `⚠️ Warning to ${ctx.from?.first_name}: Sharing inappropriate ${contentType} content is not allowed in this group.\n` +
            `This is warning ${warningCount}/3. You will be banned after 3 warnings.`
          );
          ctx.session[userKey].lastWarning = now;
        } catch (error) {
          console.error('Error sending warning message:', error);
        }
      }
    }
  } catch (error) {
    console.error('Error handling inappropriate content:', error);
  }
}

// Handle all messages (for debugging)
bot.on('message', async (ctx) => {
  // This will catch all messages that weren't handled by more specific handlers
  console.log('Received message:', ctx.message);
});

// Error handler
bot.catch((err) => {
  console.error('Bot error:', err);
});

// Start the bot
console.log('Starting bot...');
bot.start({
  onStart: (botInfo) => {
    console.log(`Bot @${botInfo.username} started successfully!`);
  }
});

bot.command('config', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  
  if (!userId) return;
  
  // Check if in group
  if (ctx.chat.type === 'private') {
    await ctx.reply('This command is only available in groups.');
    return;
  }
  
  // Check if user is admin
  const isUserAdmin = await isAdmin(ctx, userId, chatId);
  
  if (!isUserAdmin) {
    await ctx.reply('This command is only available to group administrators.');
    return;
  }
  
  // Get current settings
  const settings = await getGroupSettings(chatId);
  
  // Check if settings is null
  if (!settings) {
    // Create default settings
    await updateGroupSettings(chatId, {
      chatId,
      abusiveWordsEnabled: true,
      imageModeration: false,
      videoModeration: false,
      createdAt: new Date()
    });
    
    // Show config menu with default settings
    const keyboard = new InlineKeyboard()
      .text('❌ Image Moderation', 'toggle_image_moderation')
      .row()
      .text('❌ Video Moderation', 'toggle_video_moderation')
      .row()
      .text('✅ Abusive Words', 'toggle_abusive_words')
      .row()
      .text('⚙️ Alert Messages', 'alert_messages')
      .row()
      .text('📋 Abusive Words List', 'list_abusive_words');
    
    await ctx.reply(
      '⚙️ **Group Configuration**\n\n' +
      'Use the buttons below to configure the bot for this group.',
      { 
        reply_markup: keyboard,
        parse_mode: 'Markdown'
      }
    );
    return;
  }
  
  // Create inline keyboard for options
  const keyboard = new InlineKeyboard()
    .text(settings.imageModeration ? '✅ Image Moderation' : '❌ Image Moderation', 'toggle_image_moderation')
    .row()
    .text(settings.videoModeration ? '✅ Video Moderation' : '❌ Video Moderation', 'toggle_video_moderation')
    .row()
    .text(settings.abusiveWordsEnabled ? '✅ Abusive Words' : '❌ Abusive Words', 'toggle_abusive_words')
    .row()
    .text('⚙️ Alert Messages', 'alert_messages')
    .row()
    .text('📋 Abusive Words List', 'list_abusive_words');
  
  await ctx.reply(
    '⚙️ **Group Configuration**\n\n' +
    'Use the buttons below to configure the bot for this group.',
    { 
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    }
  );
});

bot.command('moderation', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id;
  
  if (!userId) return;
  
  // Check if in group
  if (ctx.chat.type === 'private') {
    await ctx.reply('This command is only available in groups.');
    return;
  }
  
  // Check if user is admin
  const isUserAdmin = await isAdmin(ctx, userId, chatId);
  
  if (!isUserAdmin) {
    await ctx.reply('This command is only available to group administrators.');
    return;
  }
  
  // Get current settings
  const settings = await getGroupSettings(chatId);
  
  // Handle null settings
  if (!settings) {
    // Create default settings
    const defaultSettings = {
      chatId,
      abusiveWordsEnabled: true,
      imageModeration: false,
      videoModeration: false,
      createdAt: new Date()
    };
    
    await updateGroupSettings(chatId, defaultSettings);
    
    // Create inline keyboard for options with default settings
    const keyboard = new InlineKeyboard()
      .text('❌ Image Moderation', 'toggle_image_moderation')
      .row()
      .text('❌ Video Moderation', 'toggle_video_moderation');
    
    await ctx.reply(
      `⚙️ **Image and Video Moderation Settings**\n\n` +
      `Use the buttons below to toggle image and video moderation.`,
      {
        reply_markup: keyboard,
        parse_mode: 'Markdown'
      }
    );
    return;
  }
  
  // Create inline keyboard for options
  const keyboard = new InlineKeyboard()
    .text(settings.imageModeration ? '✅ Image Moderation' : '❌ Image Moderation', 'toggle_image_moderation')
    .row()
    .text(settings.videoModeration ? '✅ Video Moderation' : '❌ Video Moderation', 'toggle_video_moderation');
  
  await ctx.reply(
    `⚙️ **Image and Video Moderation Settings**\n\n` +
    `Use the buttons below to toggle image and video moderation.`,
    {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    }
  );
});