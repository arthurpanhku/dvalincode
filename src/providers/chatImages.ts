import { z } from 'zod';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const imageSchema = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  data: z.string().min(1).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
}).strict().refine(image => {
  const decoded = Buffer.from(image.data, 'base64');
  if (decoded.byteLength > MAX_IMAGE_BYTES || decoded.toString('base64') !== image.data) return false;
  switch (image.mediaType) {
    case 'image/png': return decoded.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    case 'image/jpeg': return decoded.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    case 'image/gif': return /^GIF8[79]a$/.test(decoded.toString('ascii', 0, 6));
    case 'image/webp': return decoded.toString('ascii', 0, 4) === 'RIFF' && decoded.toString('ascii', 8, 12) === 'WEBP';
  }
}, 'Image bytes do not match the declared media type');

export const chatImagesSchema = z.array(imageSchema).max(4);
export type ChatImage = z.infer<typeof imageSchema>;
