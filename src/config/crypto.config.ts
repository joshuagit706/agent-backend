import { registerAs } from '@nestjs/config';

export default registerAs('crypto', () => ({
  encryptionKey: process.env.ENCRYPTION_KEY || 'default-32-char-key-change-this!!',
}));
