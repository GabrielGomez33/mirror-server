// ============================================================================
// JOURNAL HELPER UTILITIES
// Validation, sentiment analysis, theme extraction
// ============================================================================

/**
 * Validate journal entry data
 */
export function validateJournalEntry(data: any): string | null {
  // Required fields
  if (!data.entryDate) {
    return 'Entry date is required';
  }

  if (!data.timeOfDay || !['morning', 'afternoon', 'evening', 'night'].includes(data.timeOfDay)) {
    return 'Valid time of day is required (morning, afternoon, evening, night)';
  }

  // Mood rating validation (1-10)
  if (typeof data.moodRating !== 'number' || data.moodRating < 1 || data.moodRating > 10) {
    return 'Mood rating must be between 1 and 10';
  }

  // Primary emotion validation
  if (!data.primaryEmotion || typeof data.primaryEmotion !== 'string') {
    return 'Primary emotion is required';
  }

  // Emotion intensity validation (1-10)
  if (typeof data.emotionIntensity !== 'number' || data.emotionIntensity < 1 || data.emotionIntensity > 10) {
    return 'Emotion intensity must be between 1 and 10';
  }

  // Energy level validation (1-10)
  if (typeof data.energyLevel !== 'number' || data.energyLevel < 1 || data.energyLevel > 10) {
    return 'Energy level must be between 1 and 10';
  }

  // Date format validation (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(data.entryDate)) {
    return 'Entry date must be in YYYY-MM-DD format';
  }

  // At least one content field must be present
  if (!data.promptResponses && !data.freeFormEntry) {
    return 'Entry must contain either prompt responses or free-form text';
  }

  return null; // Valid
}

/**
 * Calculate sentiment score from text
 * Returns value between -1 (negative) and 1 (positive)
 */
export async function calculateSentiment(text: string): Promise<number> {
  if (!text || text.trim().length === 0) {
    return 0;
  }

  // Simple sentiment analysis using keyword matching
  // In production, use a library like 'sentiment' npm package or ML model
  
  const positiveWords = [
    'happy', 'great', 'good', 'excellent', 'wonderful', 'amazing', 'love', 
    'grateful', 'blessed', 'joy', 'excited', 'proud', 'accomplished', 
    'successful', 'peaceful', 'content', 'satisfied', 'motivated', 'inspired',
    'hopeful', 'optimistic', 'confident', 'energized', 'fulfilled'
  ];

  const negativeWords = [
    'sad', 'bad', 'terrible', 'awful', 'hate', 'angry', 'frustrated', 
    'anxious', 'worried', 'stressed', 'depressed', 'lonely', 'tired', 
    'exhausted', 'overwhelmed', 'disappointed', 'regret', 'guilty', 
    'ashamed', 'afraid', 'scared', 'upset', 'miserable', 'hopeless'
  ];

  const lowercaseText = text.toLowerCase();
  const words = lowercaseText.split(/\s+/);

  let positiveCount = 0;
  let negativeCount = 0;

  words.forEach(word => {
    if (positiveWords.includes(word)) positiveCount++;
    if (negativeWords.includes(word)) negativeCount++;
  });

  const totalSentimentWords = positiveCount + negativeCount;
  
  if (totalSentimentWords === 0) {
    return 0; // Neutral
  }

  // Calculate score (-1 to 1)
  const score = (positiveCount - negativeCount) / totalSentimentWords;
  
  return Math.max(-1, Math.min(1, score)); // Clamp between -1 and 1
}

/**
 * Extract dominant themes from text
 */
export async function extractThemes(text: string, existingTags: string[] = []): Promise<string[]> {
  if (!text || text.trim().length === 0) {
    return existingTags;
  }

  // Theme keywords grouped by category
  const themeCategories = {
    work: ['work', 'job', 'career', 'project', 'meeting', 'deadline', 'boss', 'colleague', 'professional'],
    health: ['health', 'exercise', 'workout', 'gym', 'diet', 'sleep', 'meditation', 'yoga', 'fitness'],
    relationships: ['family', 'friend', 'relationship', 'partner', 'spouse', 'love', 'social', 'connection'],
    mental: ['stress', 'anxiety', 'depression', 'therapy', 'mental', 'emotions', 'feelings', 'mindfulness'],
    growth: ['learning', 'growth', 'goals', 'progress', 'achievement', 'success', 'development', 'skills'],
    finance: ['money', 'finance', 'budget', 'investment', 'savings', 'debt', 'income', 'expenses'],
    hobbies: ['hobby', 'creative', 'art', 'music', 'reading', 'writing', 'travel', 'adventure'],
    home: ['home', 'house', 'cleaning', 'organizing', 'family', 'chores', 'cooking', 'pets']
  };

  const lowercaseText = text.toLowerCase();
  const detectedThemes: Set<string> = new Set(existingTags);

  // Check for theme keywords
  Object.entries(themeCategories).forEach(([theme, keywords]) => {
    const matches = keywords.filter(keyword => lowercaseText.includes(keyword));
    if (matches.length > 0) {
      detectedThemes.add(theme);
    }
  });

  return Array.from(detectedThemes).slice(0, 10); // Limit to 10 themes
}

/**
 * Format entry date for display
 */
export function formatEntryDate(date: string | Date): string {
  const d = new Date(date);
  
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  };

  return d.toLocaleDateString('en-US', options);
}

/**
 * Get time of day greeting
 */
export function getTimeOfDayGreeting(timeOfDay: string): string {
  const greetings = {
    morning: 'Good morning',
    afternoon: 'Good afternoon',
    evening: 'Good evening',
    night: 'Good night'
  };

  return greetings[timeOfDay as keyof typeof greetings] || 'Hello';
}

/**
 * Calculate streak from entries
 */
export function calculateStreak(entries: Array<{ entry_date: string }>): {
  currentStreak: number;
  longestStreak: number;
} {
  if (entries.length === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  // Sort entries by date (most recent first)
  const sortedDates = entries
    .map(e => new Date(e.entry_date).getTime())
    .sort((a, b) => b - a);

  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 1;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTime = today.getTime();

  // Check if most recent entry is today or yesterday
  const mostRecentDate = new Date(sortedDates[0]);
  mostRecentDate.setHours(0, 0, 0, 0);
  const mostRecentTime = mostRecentDate.getTime();

  const daysDiff = Math.floor((todayTime - mostRecentTime) / (1000 * 60 * 60 * 24));

  if (daysDiff > 1) {
    // Streak broken
    currentStreak = 0;
  } else {
    currentStreak = 1;

    // Calculate current streak
    for (let i = 1; i < sortedDates.length; i++) {
      const prevDate = new Date(sortedDates[i - 1]);
      const currDate = new Date(sortedDates[i]);
      prevDate.setHours(0, 0, 0, 0);
      currDate.setHours(0, 0, 0, 0);

      const diff = Math.floor((prevDate.getTime() - currDate.getTime()) / (1000 * 60 * 60 * 24));

      if (diff === 1) {
        currentStreak++;
      } else {
        break;
      }
    }
  }

  // Calculate longest streak
  for (let i = 1; i < sortedDates.length; i++) {
    const prevDate = new Date(sortedDates[i - 1]);
    const currDate = new Date(sortedDates[i]);
    prevDate.setHours(0, 0, 0, 0);
    currDate.setHours(0, 0, 0, 0);

    const diff = Math.floor((prevDate.getTime() - currDate.getTime()) / (1000 * 60 * 60 * 24));

    if (diff === 1) {
      tempStreak++;
      longestStreak = Math.max(longestStreak, tempStreak);
    } else {
      tempStreak = 1;
    }
  }

  longestStreak = Math.max(longestStreak, currentStreak);

  return { currentStreak, longestStreak };
}

/**
 * Sanitize text for security (prevent XSS)
 */
export function sanitizeText(text: string): string {
  if (!text) return '';
  
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Parse markdown for display
 * (Basic implementation - use marked.js or similar in production)
 */
export function parseMarkdown(text: string): string {
  if (!text) return '';

  let html = text;

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}
