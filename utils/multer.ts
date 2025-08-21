import multer from 'multer';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 5,
    fileSize: 10 * 1024 * 1024, // 10MB (adjust as needed)
  },
});
