/** Reactions allowed on posts (the client shows them in this order). */
export const REACTIONS = ['❤️', '👍', '😂', '🎉', '😮'];

/** Mood keys a post can carry (labels/emoji live in the client too; keep in sync). */
export const MOODS = {
  happy: { emoji: '😊', label: 'happy' },
  excited: { emoji: '🤩', label: 'excited' },
  celebrating: { emoji: '🥳', label: 'celebrating' },
  loved: { emoji: '🥰', label: 'loved' },
  proud: { emoji: '😎', label: 'proud' },
  grateful: { emoji: '🙏', label: 'grateful' },
  relaxed: { emoji: '😌', label: 'relaxed' },
  hungry: { emoji: '😋', label: 'hungry' },
  silly: { emoji: '🤪', label: 'silly' },
  curious: { emoji: '🤔', label: 'curious' },
  tired: { emoji: '😴', label: 'tired' },
  sick: { emoji: '🤒', label: 'under the weather' },
  sad: { emoji: '😢', label: 'sad' },
  adventurous: { emoji: '🏕️', label: 'adventurous' },
};

export const MAX_PHOTOS = 10;
export const MAX_POST_CHARS = 5000;
export const MAX_COMMENT_CHARS = 2000;
