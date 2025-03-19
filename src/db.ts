import { MongoClient, Collection, Db } from 'mongodb';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// MongoDB connection string
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'groupmanagerbot';

// MongoDB client and database
let client: MongoClient | null = null;
let db: Db | null = null;

// Collections
let abusiveWords: Collection | null = null;
let groupSettings: Collection | null = null;
let userWarnings: Collection | null = null;
let alertMessages: Collection | null = null;
let userWarningsAcrossSessions: Collection | null = null;

/**
 * Connect to the MongoDB database
 */
export async function connectToDatabase(): Promise<void> {
  try {
    console.log('Connecting to MongoDB...');
    
    // Check if already connected
    if (client && db) {
      console.log('Already connected to MongoDB');
      return;
    }
    
    // Create a new MongoDB client
    client = new MongoClient(MONGODB_URI);
    
    // Connect to the MongoDB server
    await client.connect();
    console.log('Connected to MongoDB server');
    
    // Get the database
    db = client.db(DB_NAME);
    console.log(`Connected to database: ${DB_NAME}`);
    
    // Initialize collections
    await initializeCollections();
    
    console.log('Database connection established successfully');
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
    
    // Clean up on error
    if (client) {
      try {
        await client.close();
      } catch (closeError) {
        console.error('Error closing MongoDB client:', closeError);
      }
    }
    
    client = null;
    db = null;
    
    throw error;
  }
}

/**
 * Initialize database collections
 */
async function initializeCollections(): Promise<void> {
  try {
    if (!db) {
      throw new Error('Database not connected');
    }
    
    // Initialize collections
    abusiveWords = db.collection('abusiveWords');
    groupSettings = db.collection('groupSettings');
    userWarnings = db.collection('userWarnings');
    alertMessages = db.collection('alertMessages');
    userWarningsAcrossSessions = db.collection('userWarningsAcrossSessions');
    
    console.log('Collections initialized');
    
    // Create indexes for better performance
    await createIndexes();
  } catch (error) {
    console.error('Error initializing collections:', error);
    throw error;
  }
}

/**
 * Create indexes for better performance
 */
async function createIndexes(): Promise<void> {
  try {
    if (!db || !abusiveWords || !groupSettings || !userWarnings || !alertMessages || !userWarningsAcrossSessions) {
      throw new Error('Collections not initialized');
    }
    
    // Create indexes
    await abusiveWords.createIndex({ chatId: 1, word: 1 }, { unique: true });
    await groupSettings.createIndex({ chatId: 1 }, { unique: true });
    await userWarnings.createIndex({ chatId: 1, userId: 1 }, { unique: true });
    await alertMessages.createIndex({ chatId: 1 }, { unique: true });
    await userWarningsAcrossSessions.createIndex({ userId: 1, chatId: 1 }, { unique: true });
    
    console.log('Indexes created');
  } catch (error) {
    console.error('Error creating indexes:', error);
    // Don't throw here, just log the error
    // This way, the application can still function even if indexes fail
  }
}

/**
 * Get group settings
 * @param chatId The chat ID
 */
export async function getGroupSettings(chatId: number): Promise<any> {
  try {
    if (!chatId) {
      console.error('Invalid chatId provided to getGroupSettings');
      return getDefaultGroupSettings(chatId);
    }
    
    // Ensure database connection
    await ensureDbConnection();
    
    if (!groupSettings) {
      console.error('Database connection not available');
      return getDefaultGroupSettings(chatId);
    }
    
    // Find the group settings
    const settings = await groupSettings.findOne({ chatId });
    
    if (!settings) {
      console.log(`No settings found for chat ${chatId}, using defaults`);
      return getDefaultGroupSettings(chatId);
    }
    
    return settings;
  } catch (error) {
    console.error('Error getting group settings:', error);
    return getDefaultGroupSettings(chatId);
  }
}

/**
 * Update group settings
 * @param chatId The chat ID
 * @param settings The settings to update
 */
export async function updateGroupSettings(chatId: number, settings: any): Promise<boolean> {
  try {
    if (!chatId) {
      console.error('Invalid chatId provided to updateGroupSettings');
      return false;
    }
    
    // Ensure database connection
    await ensureDbConnection();
    
    if (!groupSettings) {
      console.error('Database connection not available');
      return false;
    }
    
    // Ensure settings has chatId
    settings.chatId = chatId;
    settings.updatedAt = new Date();
    
    // Update or insert the group settings
    const result = await groupSettings.updateOne(
      { chatId },
      { $set: settings },
      { upsert: true }
    );
    
    const success = result.acknowledged;
    if (success) {
      console.log(`Successfully updated settings for chat ${chatId}`);
    } else {
      console.error(`Failed to update settings for chat ${chatId}`);
    }
    
    return success;
  } catch (error) {
    console.error('Error updating group settings:', error);
    return false;
  }
}

/**
 * Get abusive words for a group
 * @param chatId The chat ID
 */
export async function getAbusiveWords(chatId: number): Promise<string[]> {
  try {
    if (!chatId) {
      console.error('Invalid chatId provided to getAbusiveWords');
      return [];
    }
    
    // Ensure database connection
    await ensureDbConnection();
    
    if (!abusiveWords) {
      console.error('Database connection not available');
      return [];
    }
    
    // Find all abusive words for this chat
    const words = await abusiveWords.find({ chatId }).toArray();
    
    if (!words || words.length === 0) {
      console.log(`No abusive words found for chat ${chatId}`);
      return [];
    }
    
    // Extract just the words
    const wordList = words.map(item => item.word);
    console.log(`Found ${wordList.length} abusive words for chat ${chatId}`);
    
    return wordList;
  } catch (error) {
    console.error('Error getting abusive words:', error);
    return [];
  }
}

/**
 * Add an abusive word to the database with error handling
 * @param chatId The chat ID
 * @param word The word to add
 * @returns True if successful, false otherwise
 */
export async function addAbusiveWord(chatId: number, word: string): Promise<boolean> {
  try {
    if (!chatId || !word) {
      console.error('Invalid chatId or word provided to addAbusiveWord');
      return false;
    }
    
    // Normalize the word (lowercase, trim)
    word = word.toLowerCase().trim();
    
    if (word.length === 0) {
      console.error('Empty word provided to addAbusiveWord');
      return false;
    }
    
    // Ensure database connection
    await ensureDbConnection();
    
    if (!abusiveWords) {
      console.error('Database connection not available');
      return false;
    }
    
    // Check if word already exists
    const existingWord = await abusiveWords.findOne({ chatId, word });
    
    if (existingWord) {
      console.log(`Word "${word}" already exists for chat ${chatId}`);
      return true; // Consider this a success
    }
    
    // Add the word
    const result = await abusiveWords.insertOne({
      chatId,
      word,
      createdAt: new Date()
    });
    
    const success = result.acknowledged;
    if (success) {
      console.log(`Successfully added word "${word}" for chat ${chatId}`);
    } else {
      console.error(`Failed to add word "${word}" for chat ${chatId}`);
    }
    
    return success;
  } catch (error) {
    console.error('Error adding abusive word:', error);
    return false;
  }
}

/**
 * Remove an abusive word from the database with error handling
 * @param chatId The chat ID
 * @param word The word to remove
 * @returns True if successful, false otherwise
 */
export async function removeAbusiveWord(chatId: number, word: string): Promise<boolean> {
  try {
    if (!chatId || !word) {
      console.error('Invalid chatId or word provided to removeAbusiveWord');
      return false;
    }
    
    // Normalize the word (lowercase, trim)
    word = word.toLowerCase().trim();
    
    if (word.length === 0) {
      console.error('Empty word provided to removeAbusiveWord');
      return false;
    }
    
    // Ensure database connection
    await ensureDbConnection();
    
    if (!abusiveWords) {
      console.error('Database connection not available');
      return false;
    }
    
    // Remove the word
    const result = await abusiveWords.deleteOne({ chatId, word });
    
    const success = result.acknowledged && result.deletedCount > 0;
    if (success) {
      console.log(`Successfully removed word "${word}" for chat ${chatId}`);
    } else {
      console.log(`Word "${word}" not found for chat ${chatId}`);
    }
    
    return success;
  } catch (error) {
    console.error('Error removing abusive word:', error);
    return false;
  }
}

/**
 * Get user warnings
 * @param chatId The chat ID
 * @param userId The user ID
 */
export async function getUserWarnings(chatId: number, userId: number) {
  try {
    if (!userWarnings) {
      console.error('Database connection not available');
      return { chatId, userId, count: 0, lastWarning: 0 };
    }
    
    const warnings = await userWarnings.findOne({ chatId, userId });
    return warnings || { chatId, userId, count: 0, lastWarning: 0 };
  } catch (error) {
    console.error('Error getting user warnings:', error);
    return { chatId, userId, count: 0, lastWarning: 0 };
  }
}

/**
 * Update user warnings
 * @param chatId The chat ID
 * @param userId The user ID
 * @param count The warning count
 */
export async function updateUserWarnings(chatId: number, userId: number, count: number) {
  try {
    if (!userWarnings) {
      console.error('Database connection not available');
      return false;
    }
    
    const result = await userWarnings.updateOne(
      { chatId, userId },
      { $set: { count, lastWarning: Date.now() } },
      { upsert: true }
    );
    return result.acknowledged;
  } catch (error) {
    console.error('Error updating user warnings:', error);
    return false;
  }
}

/**
 * Get user warnings across sessions from the database
 * @param userId The user ID
 * @param chatId The chat ID
 * @returns The user warnings object or null if not found
 */
export async function getUserWarningsAcrossSessions(userId: number, chatId: number): Promise<{ userId: number, chatId: number, count: number } | null> {
  try {
    if (!userId || !chatId) {
      console.error('Invalid userId or chatId provided to getUserWarningsAcrossSessions');
      return null;
    }
    
    console.log(`Getting warnings for user ${userId} in chat ${chatId}`);
    
    // Ensure database connection
    await ensureDbConnection();
    
    if (!userWarningsAcrossSessions) {
      console.error('Database connection not available');
      return null;
    }
    
    // Find the user warnings
    const userWarnings = await userWarningsAcrossSessions.findOne({ userId, chatId });
    
    if (!userWarnings) {
      console.log(`No warnings found for user ${userId} in chat ${chatId}`);
      return null;
    }
    
    console.log(`Found warnings for user ${userId} in chat ${chatId}: ${userWarnings.count}`);
    return {
      userId: userWarnings.userId as number,
      chatId: userWarnings.chatId as number,
      count: userWarnings.count as number
    };
  } catch (error) {
    console.error('Error getting user warnings:', error);
    return null;
  }
}

/**
 * Update user warnings across sessions
 * @param userId The user ID
 * @param chatId The chat ID
 * @param count The new warning count
 * @returns True if successful, false otherwise
 */
export async function updateUserWarningsAcrossSessions(userId: number, chatId: number, count: number): Promise<boolean> {
  try {
    if (!userId || !chatId || count < 0) {
      console.error('Invalid parameters provided to updateUserWarningsAcrossSessions');
      return false;
    }
    
    console.log(`Updating warnings for user ${userId} in chat ${chatId} to ${count}`);
    
    // Ensure database connection
    await ensureDbConnection();
    
    if (!userWarningsAcrossSessions) {
      console.error('Database connection not available');
      return false;
    }
    
    // Update or insert the user warnings
    const result = await userWarningsAcrossSessions.updateOne(
      { userId, chatId },
      { $set: { count, updatedAt: new Date() } },
      { upsert: true }
    );
    
    const success = result.acknowledged;
    if (success) {
      console.log(`Successfully updated warnings for user ${userId} in chat ${chatId}`);
    } else {
      console.error(`Failed to update warnings for user ${userId} in chat ${chatId}`);
    }
    
    return success;
  } catch (error) {
    console.error('Error updating user warnings:', error);
    return false;
  }
}

/**
 * Reset user warnings across sessions
 * @param userId The user ID
 * @param chatId The chat ID
 * @returns True if successful, false otherwise
 */
export async function resetUserWarningsAcrossSessions(userId: number, chatId: number): Promise<boolean> {
  try {
    return await updateUserWarningsAcrossSessions(userId, chatId, 0);
  } catch (error) {
    console.error('Error resetting user warnings:', error);
    return false;
  }
}

/**
 * Get alert message for a group
 * @param chatId The chat ID
 */
export async function getAlertMessage(chatId: number) {
  try {
    if (!alertMessages) {
      console.error('Database connection not available');
      return null;
    }
    
    return await alertMessages.findOne({ chatId });
  } catch (error) {
    console.error('Error getting alert message:', error);
    return null;
  }
}

/**
 * Set alert message for a group
 * @param chatId The chat ID
 * @param message The message to set
 * @param interval The interval in minutes
 */
export async function setAlertMessage(chatId: number, message: string, interval: number) {
  try {
    if (!alertMessages) {
      console.error('Database connection not available');
      return false;
    }
    
    const result = await alertMessages.updateOne(
      { chatId },
      { 
        $set: { 
          chatId, 
          message, 
          interval, 
          lastSent: 0,
          createdAt: new Date() 
        } 
      },
      { upsert: true }
    );
    return result.acknowledged;
  } catch (error) {
    console.error('Error setting alert message:', error);
    return false;
  }
}

/**
 * Remove alert message for a group
 * @param chatId The chat ID
 */
export async function removeAlertMessage(chatId: number) {
  try {
    if (!alertMessages) {
      console.error('Database connection not available');
      return false;
    }
    
    const result = await alertMessages.deleteOne({ chatId });
    return result.acknowledged;
  } catch (error) {
    console.error('Error removing alert message:', error);
    return false;
  }
}

/**
 * Get all alert messages that need to be sent
 */
export async function getAlertMessagesToSend() {
  try {
    if (!alertMessages) {
      console.error('Database connection not available');
      return [];
    }
    
    const now = Date.now();
    const alerts = await alertMessages.find({
      $expr: {
        $gt: [now, { $add: ['$lastSent', { $multiply: ['$interval', 60000] }] }]
      }
    }).toArray();
    
    return alerts;
  } catch (error) {
    console.error('Error getting alert messages to send:', error);
    return [];
  }
}

/**
 * Update last sent time for an alert message
 * @param chatId The chat ID
 */
export async function updateAlertMessageLastSent(chatId: number) {
  try {
    if (!alertMessages) {
      console.error('Database connection not available');
      return false;
    }
    
    const result = await alertMessages.updateOne(
      { chatId },
      { $set: { lastSent: Date.now() } }
    );
    return result.acknowledged;
  } catch (error) {
    console.error('Error updating alert message last sent:', error);
    return false;
  }
}

/**
 * Close the database connection
 */
export async function closeDatabase() {
  try {
    if (!client) {
      console.log('Database connection not available');
      return true;
    }
    
    await client.close();
    console.log('Disconnected from MongoDB');
    return true;
  } catch (error) {
    console.error('Error closing MongoDB connection:', error);
    return false;
  }
}

/**
 * Ensure database connection
 * @returns True if connected, false otherwise
 */
async function ensureDbConnection(): Promise<boolean> {
  try {
    // Check if client exists and is connected
    if (!client || !db) {
      console.log('Database not connected, attempting to connect...');
      await connectToDatabase();
    }
    
    return true;
  } catch (error) {
    console.error('Error ensuring database connection:', error);
    return false;
  }
}

/**
 * Get default group settings
 * @param chatId The chat ID
 * @returns Default group settings
 */
function getDefaultGroupSettings(chatId: number): any {
  return {
    chatId,
    abusiveWordsEnabled: true,
    imageModeration: true,
    videoModeration: true,
    createdAt: new Date()
  };
}

/**
 * Get database
 * @returns The database object
 */
function getDb(): Db | null {
  return db;
}
