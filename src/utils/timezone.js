/**
 * Timezone Utility Helper using Node.js native Intl API.
 * This aligns scheduling dates with target market timezones.
 */

import prisma from '../db.js';
import logger from '../logger.js';

/**
 * Fetch the configured station timezone from SystemSettings.
 * Falls back to "Africa/Lagos" if not configured.
 */
export async function getStationTimezone() {
  try {
    const record = await prisma.systemSetting.findUnique({
      where: { key: 'station_info' }
    });
    if (record) {
      const info = JSON.parse(record.value);
      if (info && info.timezone) {
        return info.timezone;
      }
    }
  } catch (error) {
    logger.error('Failed to query station timezone settings: %O', error);
  }
  return 'Africa/Lagos'; // Default fallback timezone
}

/**
 * Converts a date input representing local target timezone time into a UTC Date.
 * E.g., "2026-07-06T09:00:00" in "Africa/Lagos" becomes "2026-07-06T08:00:00.000Z".
 * 
 * @param {string|Date} dateInput 
 * @param {string} timeZone 
 * @returns {Date} UTC Date object
 */
export function convertToUTC(dateInput, timeZone) {
  try {
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) throw new Error('Invalid input date');

    // Get the equivalent date string in the target timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });

    const parts = formatter.formatToParts(date);
    const partValues = {};
    parts.forEach(p => { partValues[p.type] = p.value; });

    // Construct target timezone representation as if it was in UTC
    const tzString = `${partValues.year}-${partValues.month}-${partValues.day}T${partValues.hour}:${partValues.minute}:${partValues.second}.000`;
    const tzDate = new Date(tzString);

    const diff = date.getTime() - tzDate.getTime();
    return new Date(date.getTime() + diff);
  } catch (error) {
    logger.error(`Timezone conversion failed for ${dateInput} using TZ ${timeZone}: %s`, error.message);
    // Safe fallback to input date if conversion fails
    return new Date(dateInput);
  }
}

/**
 * Converts a UTC Date into a local target timezone ISO string (YYYY-MM-DDTHH:mm).
 * Used by the frontend to populate datetime-local inputs.
 * 
 * @param {Date|string} dateUTC 
 * @param {string} timeZone 
 * @returns {string} YYYY-MM-DDTHH:mm formatted string
 */
export function formatUTCToTimezone(dateUTC, timeZone) {
  try {
    const d = typeof dateUTC === 'string' ? new Date(dateUTC) : dateUTC;
    if (isNaN(d.getTime())) return '';
    
    // Swedish locale (sv-SE) output format is YYYY-MM-DD HH:mm:ss
    const formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
    
    const formatted = formatter.format(d);
    return formatted.replace(' ', 'T').substring(0, 16);
  } catch (error) {
    logger.error('Failed formatting UTC to timezone: %s', error.message);
    return '';
  }
}
