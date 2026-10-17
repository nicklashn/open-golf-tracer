import { describe, expect, it } from 'vitest';
import da from '../src/lib/i18n/da';
import en from '../src/lib/i18n/en';
import { jobMessage } from '../src/lib/jobMessage';

describe('job progress messages', () => {
  it('puts the worker’s English progress text in Danish', () => {
    expect(jobMessage('Queued', da)).toBe(da.jobs.messages.queued);
    expect(jobMessage('Looking for the ball', da)).toBe('Leder efter bolden');
    expect(jobMessage('Analysing shot 3/5', da)).toBe('Analyserer slag 3/5');
    expect(jobMessage('4 shots found', da)).toBe('4 slag fundet indtil nu');
    expect(jobMessage('1 shots found', da)).toBe('1 slag fundet indtil nu');
  });

  it('keeps text it does not know, and empty stays empty', () => {
    expect(jobMessage('Planlægger videoen', da)).toBe('Planlægger videoen');
    expect(jobMessage('', en)).toBe('');
    expect(jobMessage(null, en)).toBe('');
  });

  it('translates the exporter’s steps and errors, and hides ffmpeg’s own text', () => {
    expect(jobMessage('Preparing graphics', da)).toBe('Forbereder grafikken');
    expect(jobMessage('Exporting', da)).toBe('Laver videoen');
    expect(jobMessage('Mixing the sound', da)).toBe('Mixer lyden');
    expect(jobMessage('Finishing the video', en)).toBe('Finishing the video');
    expect(jobMessage('Canceled by the user', da)).toBe('Annulleret');
    expect(jobMessage('Clip 3 is missing its video', da)).toBe(da.jobs.messages.missingVideo);
    expect(jobMessage('ffmpeg failed (1): Invalid data found when processing input', da)).toBe(da.jobs.messages.exportFailed);
  });

  it('reads well in English too', () => {
    expect(jobMessage('Queued', en)).toBe('Queued – starts when there is room');
    expect(jobMessage('2 shots found', en)).toBe('2 shots found so far');
  });
});
