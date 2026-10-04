import type { Attachment } from 'discord.js';
import { DraftError } from '../../domain/errors.js';

const MAX_BYTES = 2 * 1024 * 1024;

/** Downloads a CSV attachment uploaded with a slash command. */
export async function fetchAttachmentText(attachment: Attachment): Promise<string> {
  if (attachment.size > MAX_BYTES) throw new DraftError('VALIDATION', 'The file is larger than 2 MB.');
  const name = attachment.name.toLowerCase();
  const type = (attachment.contentType ?? '').toLowerCase();
  if (!name.endsWith('.csv') && !name.endsWith('.txt') && !type.includes('csv') && !type.startsWith('text/')) {
    throw new DraftError('VALIDATION', 'Please upload a .csv file.');
  }
  const res = await fetch(attachment.url);
  if (!res.ok) throw new DraftError('VALIDATION', `Could not download the attachment (HTTP ${res.status}).`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new DraftError('VALIDATION', 'The file is larger than 2 MB.');
  return buffer.toString('utf8');
}
