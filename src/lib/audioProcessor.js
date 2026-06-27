import * as mm from 'music-metadata';
import crypto from 'crypto';
import fs from 'fs';

/**
 * Helper utility to calculate the SHA256 of a file and extract its ID3/metadata tags.
 * @param {string} filePath - Absolute path to the audio file on disk.
 * @returns {Promise<object>} Parsed metadata, file hash, and cover art picture object.
 */
export const processAudioFile = async (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // 1. Calculate SHA256 Hash of the file content
  const hashPromise = new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });

  const fileHash = await hashPromise;

  // 2. Parse ID3 / Vorbis Comments / MP4 tags via music-metadata
  const metadata = await mm.parseFile(filePath);

  const picture = metadata.common.picture && metadata.common.picture.length > 0 
    ? metadata.common.picture[0] 
    : null;

  return {
    fileHash,
    title: metadata.common.title || null,
    artist: metadata.common.artist || null,
    album: metadata.common.album || null,
    duration: metadata.format.duration || 0, // in seconds
    bitrate: metadata.format.bitrate || 0,
    sampleRate: metadata.format.sampleRate || 0,
    picture
  };
};
