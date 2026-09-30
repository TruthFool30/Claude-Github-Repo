/** Mirrors server/src/modules/wall/constants.js. */
export const REACTIONS = [
  { emoji: '❤️', label: 'Love', past: 'Loved' },
  { emoji: '👍', label: 'Like', past: 'Liked' },
  { emoji: '😂', label: 'Haha', past: 'Haha' },
  { emoji: '🎉', label: 'Celebrate', past: 'Celebrated' },
  { emoji: '😮', label: 'Wow', past: 'Wow' },
] as const;

export const reactionMeta = (emoji: string) => REACTIONS.find((r) => r.emoji === emoji) ?? { emoji, label: emoji, past: emoji };

export const MOODS: Record<string, { emoji: string; label: string }> = {
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
